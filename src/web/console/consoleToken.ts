/**
 * Console session token storage and verification (#1780).
 *
 * Manages the file at `~/.dollhouse/run/console-token.json` which holds
 * the Bearer tokens that authenticate requests to the web console on
 * port 3939. The file is created on first leader election and persists
 * across restarts — tokens only rotate when explicitly requested.
 *
 * Schema is forward-compatible with multi-device, multi-tenant, and
 * scope-restricted tokens for Phase 2+. Phase 1 uses a single "console"
 * kind token and stubs the scope/boundary checks.
 *
 * File format (version 1):
 * ```json
 * {
 *   "version": 1,
 *   "tokens": [
 *     {
 *       "id": "018e1a2b-...",
 *       "name": "Kermit on mick-MacBook-Pro",
 *       "kind": "console",
 *       "token": "<64-hex>",
 *       "scopes": ["admin"],
 *       "elementBoundaries": null,
 *       "tenant": null,
 *       "platform": "local",
 *       "labels": {},
 *       "createdAt": "2026-04-04T20:00:00.000Z",
 *       "lastUsedAt": null,
 *       "createdVia": "initial-setup"
 *     }
 *   ],
 *   "totp": { "enrolled": false, "secret": null, "backupCodes": [] }
 * }
 * ```
 *
 * @since v2.1.0 — Issue #1780
 */

import { homedir, hostname, platform } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile, chmod, unlink, copyFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';

/** Directory for runtime state files — same as LeaderElection. */
const RUN_DIR = join(homedir(), '.dollhouse', 'run');

/** Default path to the console token file. */
const DEFAULT_TOKEN_FILE = join(RUN_DIR, 'console-token.json');

/** Current token file schema version. */
const TOKEN_FILE_VERSION = 1 as const;

/** Token length in bytes (produces a 64-character hex string). */
const TOKEN_BYTES = 32;

/** File mode for the token file — owner read/write only. */
const TOKEN_FILE_MODE = 0o600;

/**
 * TOTP configuration — RFC 6238 defaults. These are compiled-in so the
 * otpauth URI is deterministic and compatible with every common authenticator
 * app (Google Authenticator, 1Password, Authy, Bitwarden, etc.).
 */
const TOTP_ISSUER = 'DollhouseMCP';
const TOTP_ALGORITHM = 'SHA1' as const;
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_SECRET_SIZE_BYTES = 20; // 160 bits — the RFC 6238 recommendation
/** ±1 time step tolerance (±30s drift) when validating codes. */
const TOTP_VALIDATE_WINDOW = 1;
/** Pending enrollments expire this long after begin() to limit in-memory secret lifetime. */
const TOTP_PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Number of backup codes generated on enrollment. */
const BACKUP_CODE_COUNT = 10;
/** Characters per backup code — Crockford base32-ish, no ambiguous chars. */
const BACKUP_CODE_LENGTH = 8;
/**
 * Backup code alphabet — Crockford base32 (32 chars, excludes I/L/O/U).
 * 5 bits per char × 8 chars = 40 bits per code, plenty for one-shot use.
 */
const BACKUP_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Strict format for console tokens — 64 lowercase hex characters.
 * Used as a defense-in-depth check in verify(): even if the caller forgot
 * to sanitize the presented value, we reject anything that isn't a legitimate
 * 256-bit hex token before reaching the constant-time comparison.
 * DMCP-SEC-004 mitigation.
 */
const TOKEN_FORMAT = /^[0-9a-f]{64}$/;

/**
 * Element visibility boundary — Phase 3 enterprise feature.
 * Phase 1 always stores `null`; the field exists so the schema is stable.
 */
export interface ElementBoundary {
  allowCategories?: string[];
  denyCategories?: string[];
  allowTypes?: string[];
  denyTypes?: string[];
}

/**
 * A single token entry in the console token file.
 *
 * Enterprise-ready fields (`scopes`, `elementBoundaries`, `tenant`, `platform`,
 * `labels`) are present from Phase 1 but not enforced — the middleware treats
 * every valid token as admin-scoped, single-tenant, all-elements for now.
 * Phase 2+ flips enforcement on without requiring a schema migration.
 */
export interface ConsoleTokenEntry {
  /** Stable unique identifier for this token (UUID v4). */
  id: string;
  /** Human-readable name shown in the Security tab. */
  name: string;
  /** What kind of client this token is for. */
  kind: 'console' | 'device' | 'automation';
  /** The secret Bearer value. 64 hex chars (256 bits of entropy). */
  token: string;
  /** Scopes granted to this token. Phase 1 = always `["admin"]`. */
  scopes: string[];
  /** Element visibility restriction. Phase 1 = always `null`. */
  elementBoundaries: ElementBoundary | null;
  /** Tenant identifier for multi-tenant deployments. Phase 1 = always `null`. */
  tenant: string | null;
  /** Where this token is used. Phase 1 = always `"local"`. */
  platform: string;
  /** Opaque metadata for enterprise tooling. Phase 1 = always `{}`. */
  labels: Record<string, string>;
  /** ISO timestamp of token creation. */
  createdAt: string;
  /** ISO timestamp of most recent use, or null if never used. */
  lastUsedAt: string | null;
  /** How this token was created — "initial-setup", "pairing", "rotation", etc. */
  createdVia: string;
}

/**
 * TOTP enrollment state.
 *
 * Populated by Phase 2 (#1794). The `secret` field holds the base32-encoded
 * RFC 6238 secret in plaintext — the surrounding file is 0600, which matches
 * standard file-based TOTP storage practice (SSH keys, age identity files,
 * 1Password vault backups). Encrypting the secret at rest with an OS keychain
 * is a future enhancement.
 *
 * Backup codes are stored as **sha256 hex hashes**, never plaintext. The
 * plaintext codes are shown to the user exactly once at enrollment confirm
 * time. Each backup code is single-use: consuming one removes its hash from
 * this array.
 *
 * `enrolledAt` is optional for backward compatibility with Phase 1 files,
 * which were written with only `{enrolled, secret, backupCodes}`.
 */
export interface TotpState {
  enrolled: boolean;
  secret: string | null;
  backupCodes: string[];
  enrolledAt?: string | null;
}

/**
 * Public-safe view of TOTP state — never leaks secret material.
 * Returned from the status endpoint and from store methods that need to
 * report enrollment state to callers.
 */
export interface TotpStatus {
  enrolled: boolean;
  enrolledAt: string | null;
  backupCodesRemaining: number;
}

/**
 * Result of `beginTotpEnrollment` — the caller needs all of these to show a
 * QR code and manual-entry fallback in the UI. None of this is persisted;
 * the pending state only lives in-memory until confirmed.
 */
export interface TotpEnrollmentBegin {
  pendingId: string;
  /** Base32-encoded TOTP secret for manual entry (grouped display is caller's job). */
  secret: string;
  /** Full `otpauth://` URI for authenticator apps to import. */
  otpauthUri: string;
  /** Timestamp (ms since epoch) when this pending enrollment expires. */
  expiresAt: number;
}

/**
 * Result of `confirmTotpEnrollment` — the plaintext backup codes are
 * returned to the caller exactly once, at this point, and then only their
 * hashes are retained. The caller must display them to the user immediately
 * and never log them.
 */
export interface TotpEnrollmentConfirm {
  backupCodes: string[];
  enrolledAt: string;
}

/** Internal pending-enrollment state — secret held in memory only. */
interface PendingEnrollment {
  secret: string;
  label: string;
  expiresAt: number;
}

/**
 * The full on-disk token file structure.
 */
export interface ConsoleTokenFile {
  version: typeof TOKEN_FILE_VERSION;
  tokens: ConsoleTokenEntry[];
  totp: TotpState;
}

/**
 * A safe-to-log view of a token entry — the secret `token` field is
 * replaced with a masked preview so it never appears in logs or API responses.
 */
export interface MaskedTokenEntry extends Omit<ConsoleTokenEntry, 'token'> {
  tokenPreview: string;
}

/**
 * Generate a cryptographically random token.
 * Returns 64 hex characters (256 bits of entropy).
 */
function generateTokenValue(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Mask a token for display — shows first 8 chars only.
 */
function maskToken(token: string): string {
  if (token.length <= 8) return '••••••••';
  return `${token.slice(0, 8)}${'•'.repeat(Math.min(56, token.length - 8))}`;
}

/**
 * Build a human-readable default name from a puppet name and the machine hostname.
 * Example: "Kermit on mick-MacBook-Pro".
 *
 * The puppet name is passed in rather than imported to avoid a circular dependency
 * with SessionNames (which only generates per-process names).
 */
function defaultTokenName(puppetName: string): string {
  const host = hostname() || 'localhost';
  return `${puppetName} on ${host}`;
}

/**
 * Generate a batch of random backup codes. Each code is `BACKUP_CODE_LENGTH`
 * characters drawn uniformly from `BACKUP_CODE_ALPHABET` (Crockford base32,
 * 32 characters, 5 bits per char). Uses rejection sampling against 256-bit
 * random bytes to avoid modulo bias.
 */
function generateBackupCodes(): string[] {
  // 32-char alphabet divides 256 evenly (256 / 32 = 8), so the simple
  // mod-32 mapping has no bias. Generate one byte per character.
  const codes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const bytes = randomBytes(BACKUP_CODE_LENGTH);
    let code = '';
    for (let j = 0; j < BACKUP_CODE_LENGTH; j++) {
      code += BACKUP_CODE_ALPHABET[bytes[j] & 0x1f];
    }
    codes.push(code);
  }
  return codes;
}

/**
 * Hash a backup code for storage. sha256 hex is plenty — these codes are
 * high-entropy (40 bits) and we only need to detect a tamper, not resist
 * password-cracking on a leaked hash.
 */
function hashBackupCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Normalize a user-entered backup code before hashing: uppercase, strip
 * whitespace, strip dashes (users often type codes in groups like
 * "XXXX-XXXX"). Returns the canonical form that matches what we stored.
 */
function normalizeBackupCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Build the full otpauth:// URI for a given secret and display label.
 * The label is URI-encoded by `otpauth` internally via URIComponent.
 */
function buildTotpUri(secret: Secret, label: string): string {
  const totp = new TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret,
  });
  return totp.toString();
}

/**
 * Validate a single token entry object. Returns true if the entry has all
 * required fields with the correct types. Extracted from validateTokenFile
 * to keep the top-level validator's cognitive complexity manageable.
 */
function isValidTokenEntry(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.id === 'string' && e.id.length > 0 &&
    typeof e.name === 'string' &&
    typeof e.token === 'string' && e.token.length > 0 &&
    typeof e.kind === 'string' &&
    Array.isArray(e.scopes) &&
    typeof e.createdAt === 'string'
  );
}

/**
 * Validate that a parsed JSON object conforms to the expected token file schema.
 * Returns a typed ConsoleTokenFile or null if invalid.
 *
 * Strict validation — an unrecognized version or missing required fields
 * causes the file to be treated as corrupt so a fresh one can be written.
 */
function validateTokenFile(raw: unknown): ConsoleTokenFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  if (obj.version !== TOKEN_FILE_VERSION) return null;
  if (!Array.isArray(obj.tokens)) return null;
  if (!obj.totp || typeof obj.totp !== 'object') return null;
  if (!obj.tokens.every(isValidTokenEntry)) return null;

  return raw as ConsoleTokenFile;
}

/**
 * Stateful store that owns the console token file and verifies presented tokens.
 *
 * Designed to live on the leader process. Followers should not construct this —
 * they read the file directly via `readTokenFileRaw()` for their own HTTP calls.
 */
export class ConsoleTokenStore {
  private readonly filePath: string;
  private data: ConsoleTokenFile | null = null;
  /**
   * Pre-converted Buffer cache keyed by entry id. Populated whenever `this.data`
   * is assigned (load, create, future rotation). Verify() reuses the stored
   * buffers so the hot path doesn't re-allocate per-token on every request.
   * Negligible win with 1 token today; meaningful with Phase 2 multi-token
   * lookups. Not serialized — buffers are never written to disk.
   */
  private readonly tokenBuffers = new Map<string, Buffer>();
  /**
   * In-memory pending TOTP enrollments, keyed by opaque pendingId. Nothing
   * lives on disk until confirmTotpEnrollment() succeeds, which limits the
   * window in which a half-completed enrollment leaks a secret via file read.
   * Entries expire after TOTP_PENDING_TTL_MS (#1794).
   */
  private readonly pendingEnrollments = new Map<string, PendingEnrollment>();

  constructor(filePath: string = DEFAULT_TOKEN_FILE) {
    this.filePath = filePath;
  }

  /**
   * Rebuild the token buffer cache after a data load, create, or mutation.
   * Keeps the hot verify() path allocation-free for the stored side.
   */
  private rebuildTokenBuffers(): void {
    this.tokenBuffers.clear();
    if (!this.data) return;
    for (const entry of this.data.tokens) {
      this.tokenBuffers.set(entry.id, Buffer.from(entry.token, 'utf8'));
    }
  }

  /**
   * Read the existing token file, or create a new one with a single initial
   * token if none exists. Idempotent — safe to call on every leader election.
   *
   * @param puppetName - A puppet name picked by the caller (e.g. from SessionNames)
   *                     used to build the default display name on first run.
   * @returns The primary (first) token entry — convenient for server startup
   *          to inject into HTML and stamp on followers.
   */
  async ensureInitialized(puppetName: string): Promise<ConsoleTokenEntry> {
    const readResult = await this.readWithStatus();
    if (readResult.status === 'ok' && readResult.data.tokens.length > 0) {
      this.data = readResult.data;
      this.rebuildTokenBuffers();
      logger.debug('[ConsoleToken] Loaded existing token file', {
        path: this.filePath,
        count: readResult.data.tokens.length,
      });
      return readResult.data.tokens[0];
    }

    // If the file existed but was corrupt, back it up before overwriting.
    // Users may have hand-edited the file with custom names/labels — don't
    // destroy their data silently. A timestamped copy lets them recover.
    if (readResult.status === 'corrupt') {
      await this.backupCorruptFile();
    }

    // Create a fresh file with one initial token
    const now = new Date().toISOString();
    const initial: ConsoleTokenEntry = {
      id: randomUUID(),
      name: defaultTokenName(puppetName),
      kind: 'console',
      token: generateTokenValue(),
      scopes: ['admin'],
      elementBoundaries: null,
      tenant: null,
      platform: 'local',
      labels: {},
      createdAt: now,
      lastUsedAt: null,
      createdVia: 'initial-setup',
    };

    const file: ConsoleTokenFile = {
      version: TOKEN_FILE_VERSION,
      tokens: [initial],
      totp: { enrolled: false, secret: null, backupCodes: [], enrolledAt: null },
    };

    await this.write(file);
    this.data = file;
    this.rebuildTokenBuffers();
    logger.info('[ConsoleToken] Created new token file', {
      path: this.filePath,
      id: initial.id,
      name: initial.name,
    });
    return initial;
  }

  /**
   * Verify a presented Bearer token against the stored entries.
   * Uses timing-safe comparison to prevent side-channel attacks.
   *
   * Updates `lastUsedAt` on the matched entry (in memory only; disk write
   * is debounced to avoid disk thrash on every request — Phase 2 feature).
   *
   * @returns The matching entry, or null if no match.
   */
  verify(presented: string): ConsoleTokenEntry | null {
    if (!this.data || !presented) return null;

    // DMCP-SEC-004: Normalize the presented token to NFC and validate the
    // strict hex format before any comparison. This blocks Unicode abuse
    // (homographs, zero-width, bidi overrides) from reaching timingSafeEqual.
    // Defense-in-depth — the middleware already sanitizes, but verify() is a
    // public API that any future caller could invoke directly.
    const normalized = UnicodeValidator.normalize(presented).normalizedContent;
    if (!TOKEN_FORMAT.test(normalized)) return null;

    // Only the presented side is allocated per-request; stored buffers are
    // pre-converted in the tokenBuffers cache so the hot loop is allocation-free.
    const presentedBuf = Buffer.from(normalized, 'utf8');

    for (const entry of this.data.tokens) {
      const storedBuf = this.tokenBuffers.get(entry.id);
      if (!storedBuf || storedBuf.length !== presentedBuf.length) continue;
      if (timingSafeEqual(presentedBuf, storedBuf)) {
        entry.lastUsedAt = new Date().toISOString();
        return entry;
      }
    }

    return null;
  }

  /**
   * Get the primary token value for injection into HTML or forwarder config.
   * Returns the first entry's token string, or null if uninitialized.
   */
  getPrimaryTokenValue(): string | null {
    if (!this.data || this.data.tokens.length === 0) return null;
    return this.data.tokens[0].token;
  }

  /**
   * Return all tokens with the secret value masked — safe to serialize for
   * the Security tab UI or `GET /api/console/token/info` responses.
   */
  listMasked(): MaskedTokenEntry[] {
    if (!this.data) return [];
    return this.data.tokens.map(({ token, ...rest }) => ({
      ...rest,
      tokenPreview: maskToken(token),
    }));
  }

  /**
   * Get the path to the token file on disk.
   */
  getFilePath(): string {
    return this.filePath;
  }

  // --------------------------------------------------------------------
  // TOTP — Phase 2 (#1794)
  // --------------------------------------------------------------------

  /**
   * Returns a safe-to-serialize view of TOTP enrollment state. Never leaks
   * the secret or any backup code material.
   */
  getTotpStatus(): TotpStatus {
    const totp = this.data?.totp;
    if (!totp || !totp.enrolled) {
      return { enrolled: false, enrolledAt: null, backupCodesRemaining: 0 };
    }
    return {
      enrolled: true,
      enrolledAt: totp.enrolledAt ?? null,
      backupCodesRemaining: totp.backupCodes.length,
    };
  }

  /** Convenience: true if the user has a confirmed TOTP secret. */
  isTotpEnrolled(): boolean {
    return Boolean(this.data?.totp?.enrolled && this.data.totp.secret);
  }

  /**
   * Begin a TOTP enrollment. Generates a fresh secret, holds it in the
   * in-memory pending map, and returns the data the UI needs to render a
   * QR code and manual-entry fallback. Nothing is persisted until
   * `confirmTotpEnrollment` succeeds.
   *
   * Callers may call this multiple times; each call produces a new pendingId
   * and secret. Old pending entries expire after TOTP_PENDING_TTL_MS.
   *
   * @throws Error if TOTP is already enrolled — callers must disable first.
   */
  beginTotpEnrollment(label?: string): TotpEnrollmentBegin {
    if (this.isTotpEnrolled()) {
      throw new Error('TOTP is already enrolled — disable existing enrollment before enrolling again');
    }
    this.sweepExpiredEnrollments();

    // Derive a display label from the primary token name if the caller
    // didn't provide one. Authenticator apps show "<Issuer>:<label>", so
    // including the token name gives multi-device users a way to tell
    // enrollments apart.
    const displayLabel = label
      ?? this.data?.tokens[0]?.name
      ?? 'console';

    const secret = new Secret({ size: TOTP_SECRET_SIZE_BYTES });
    const pendingId = randomUUID();
    const expiresAt = Date.now() + TOTP_PENDING_TTL_MS;
    this.pendingEnrollments.set(pendingId, {
      secret: secret.base32,
      label: displayLabel,
      expiresAt,
    });

    logger.debug('[ConsoleToken] TOTP enrollment begun', { pendingId, label: displayLabel });

    return {
      pendingId,
      secret: secret.base32,
      otpauthUri: buildTotpUri(secret, displayLabel),
      expiresAt,
    };
  }

  /**
   * Confirm a pending TOTP enrollment. Verifies the code against the pending
   * secret; on success, generates 10 plaintext backup codes, hashes them for
   * storage, and persists the enrollment. Returns the plaintext backup codes
   * exactly once — the caller is responsible for showing them to the user
   * and then discarding them.
   *
   * Wrong codes do NOT consume or invalidate the pending enrollment — the
   * user can retry until it expires. This matches user expectations for
   * "oops, typed the wrong code" and limits the damage from a fat-fingered
   * first attempt.
   *
   * @throws Error if pendingId is unknown, expired, or code invalid.
   */
  async confirmTotpEnrollment(pendingId: string, code: string): Promise<TotpEnrollmentConfirm> {
    if (!this.data) {
      throw new Error('Token store not initialized');
    }
    this.sweepExpiredEnrollments();
    const pending = this.pendingEnrollments.get(pendingId);
    if (!pending) {
      throw new Error('Pending enrollment not found or expired');
    }

    // Verify the presented code against the pending secret. `validate` returns
    // the time-step delta (a number, possibly 0) on match, or null on mismatch.
    const totp = new TOTP({
      issuer: TOTP_ISSUER,
      label: pending.label,
      algorithm: TOTP_ALGORITHM,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      secret: Secret.fromBase32(pending.secret),
    });
    const sanitized = code.replace(/\s/g, '');
    const delta = totp.validate({ token: sanitized, window: TOTP_VALIDATE_WINDOW });
    if (delta === null) {
      throw new Error('Invalid TOTP code');
    }

    // Code is valid — commit enrollment.
    const plaintextCodes = generateBackupCodes();
    const hashedCodes = plaintextCodes.map(hashBackupCode);
    const enrolledAt = new Date().toISOString();

    this.data.totp = {
      enrolled: true,
      secret: pending.secret,
      backupCodes: hashedCodes,
      enrolledAt,
    };
    await this.write(this.data);
    this.pendingEnrollments.delete(pendingId);

    logger.info('[ConsoleToken] TOTP enrollment confirmed', {
      enrolledAt,
      backupCodes: hashedCodes.length,
    });
    SecurityMonitor.logSecurityEvent({
      type: 'TOTP_ENROLLED',
      severity: 'MEDIUM',
      source: 'ConsoleTokenStore.confirmTotpEnrollment',
      details: 'Console TOTP second factor enrolled',
      additionalData: { enrolledAt, backupCodes: hashedCodes.length },
    });

    return { backupCodes: plaintextCodes, enrolledAt };
  }

  /**
   * Verify a user-presented code. Accepts either a live TOTP code or a
   * single-use backup code. On successful backup-code match, the consumed
   * code's hash is removed from storage and the file is re-written.
   *
   * Returns a discriminated result so the caller can distinguish "consumed
   * a backup code" (which the UI should surface with a warning about
   * remaining count) from "valid TOTP code" (normal case). Returns
   * `{ ok: false }` on any failure — the caller should not retry within
   * the same request lifecycle.
   */
  async verifyTotp(code: string): Promise<{ ok: true; method: 'totp' | 'backup'; backupCodesRemaining: number } | { ok: false }> {
    if (!this.data?.totp?.enrolled || !this.data.totp.secret) {
      return { ok: false };
    }
    const sanitized = code.replace(/\s/g, '');
    if (!sanitized) return { ok: false };

    // Try live TOTP first — fast path, no disk write.
    const totp = new TOTP({
      issuer: TOTP_ISSUER,
      label: this.data.tokens[0]?.name ?? 'console',
      algorithm: TOTP_ALGORITHM,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      secret: Secret.fromBase32(this.data.totp.secret),
    });
    if (totp.validate({ token: sanitized, window: TOTP_VALIDATE_WINDOW }) !== null) {
      return { ok: true, method: 'totp', backupCodesRemaining: this.data.totp.backupCodes.length };
    }

    // Fall back to backup code — normalize, hash, constant-time search.
    const normalizedInput = normalizeBackupCode(sanitized);
    const inputHash = hashBackupCode(normalizedInput);
    const inputHashBuf = Buffer.from(inputHash, 'hex');
    let matchIndex = -1;
    for (let i = 0; i < this.data.totp.backupCodes.length; i++) {
      const storedBuf = Buffer.from(this.data.totp.backupCodes[i], 'hex');
      if (storedBuf.length === inputHashBuf.length && timingSafeEqual(inputHashBuf, storedBuf)) {
        matchIndex = i;
        break;
      }
    }
    if (matchIndex === -1) return { ok: false };

    // Consume the matched backup code — remove from storage and persist.
    this.data.totp.backupCodes.splice(matchIndex, 1);
    await this.write(this.data);
    logger.info('[ConsoleToken] Backup code consumed', {
      remaining: this.data.totp.backupCodes.length,
    });
    SecurityMonitor.logSecurityEvent({
      type: 'TOTP_BACKUP_CODE_CONSUMED',
      severity: 'MEDIUM',
      source: 'ConsoleTokenStore.verifyTotp',
      details: 'TOTP backup code consumed for console authentication',
      additionalData: { remaining: this.data.totp.backupCodes.length },
    });
    return { ok: true, method: 'backup', backupCodesRemaining: this.data.totp.backupCodes.length };
  }

  /**
   * Disable TOTP. Requires a valid code (TOTP or backup) as confirmation so
   * an attacker who momentarily has access to a live session can't silently
   * strip the second factor.
   *
   * @throws Error if not enrolled or code invalid.
   */
  async disableTotp(code: string): Promise<void> {
    if (!this.data) {
      throw new Error('Token store not initialized');
    }
    if (!this.isTotpEnrolled()) {
      throw new Error('TOTP is not currently enrolled');
    }
    const result = await this.verifyTotp(code);
    if (!result.ok) {
      throw new Error('Invalid TOTP code');
    }
    this.data.totp = {
      enrolled: false,
      secret: null,
      backupCodes: [],
      enrolledAt: null,
    };
    await this.write(this.data);
    logger.info('[ConsoleToken] TOTP disabled');
    SecurityMonitor.logSecurityEvent({
      type: 'TOTP_DISABLED',
      severity: 'HIGH',
      source: 'ConsoleTokenStore.disableTotp',
      details: 'Console TOTP second factor disabled — single-factor auth restored',
    });
  }

  /** Remove any pending enrollments whose TTL has passed. */
  private sweepExpiredEnrollments(): void {
    const now = Date.now();
    for (const [id, pending] of this.pendingEnrollments) {
      if (pending.expiresAt <= now) {
        this.pendingEnrollments.delete(id);
      }
    }
  }

  // --------------------------------------------------------------------
  // end TOTP
  // --------------------------------------------------------------------

  /**
   * Read the token file and distinguish missing from corrupt.
   *
   * Returning a tagged union lets `ensureInitialized()` back up corrupt files
   * before overwriting them — users who hand-edited their tokens with custom
   * names or labels deserve a recovery path instead of a silent destroy.
   */
  private async readWithStatus(): Promise<
    | { status: 'ok'; data: ConsoleTokenFile }
    | { status: 'missing' }
    | { status: 'corrupt'; reason: string }
  > {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      return { status: 'corrupt', reason: err instanceof Error ? err.message : String(err) };
    }
    try {
      const parsed = JSON.parse(content);
      const validated = validateTokenFile(parsed);
      if (!validated) return { status: 'corrupt', reason: 'schema validation failed' };
      return { status: 'ok', data: validated };
    } catch (err) {
      return { status: 'corrupt', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Copy the current (presumed corrupt) token file to a timestamped backup
   * alongside it so the user can recover hand-edited data after an accidental
   * syntax error. Best-effort — failure to back up does not block creating
   * a fresh file, since the primary goal is keeping the console usable.
   */
  private async backupCorruptFile(): Promise<void> {
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const backupPath = `${this.filePath}.corrupt-${timestamp}`;
    try {
      await copyFile(this.filePath, backupPath);
      logger.warn(`[ConsoleToken] Corrupt token file backed up to ${backupPath} — a fresh token will be created`);
    } catch (err) {
      logger.warn('[ConsoleToken] Could not back up corrupt token file, will overwrite in place', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Atomically write the token file with owner-only permissions.
   * Uses temp+rename to avoid partial writes on crash.
   *
   * On Windows, `chmod(0o600)` is effectively a no-op because the file
   * system uses ACLs instead of POSIX modes. We log a one-time warning so
   * users on Windows know the token file does not have OS-enforced access
   * control and can decide whether to use additional tooling (icacls, NTFS
   * permissions, or a different storage location).
   */
  private async write(file: ConsoleTokenFile): Promise<void> {
    await mkdir(RUN_DIR, { recursive: true });
    const tmpFile = `${this.filePath}.${process.pid}.tmp`;
    try {
      await writeFile(tmpFile, JSON.stringify(file, null, 2), 'utf8');
      await chmod(tmpFile, TOKEN_FILE_MODE);
      await rename(tmpFile, this.filePath);
      this.warnIfWindowsPermissions();
    } catch (err) {
      try { await unlink(tmpFile); } catch { /* ignore */ }
      throw err;
    }
  }

  /** One-shot flag so the Windows permissions warning is logged at most once. */
  private windowsWarningLogged = false;

  private warnIfWindowsPermissions(): void {
    if (this.windowsWarningLogged) return;
    if (platform() !== 'win32') return;
    this.windowsWarningLogged = true;
    logger.warn(
      `[ConsoleToken] Token file at ${this.filePath} has no OS-enforced access control on Windows ` +
      `(chmod 0o600 is a no-op on this platform). Any process running as the same user can read the file. ` +
      `Consider using NTFS ACLs via 'icacls' for stronger isolation in multi-user environments.`,
    );
  }
}

/**
 * Read the raw token file from disk without constructing a store.
 * Intended for follower processes that need the primary token to attach
 * to their ingest POSTs. Returns null if the file does not exist or is invalid.
 *
 * @param filePath - Optional override for the token file location
 */
export async function readTokenFileRaw(filePath: string = DEFAULT_TOKEN_FILE): Promise<ConsoleTokenFile | null> {
  try {
    const content = await readFile(filePath, 'utf8');
    return validateTokenFile(JSON.parse(content));
  } catch {
    return null;
  }
}

/**
 * Get the primary token value from the token file on disk.
 * Convenience helper for followers and external consumers.
 */
export async function getPrimaryTokenFromFile(filePath: string = DEFAULT_TOKEN_FILE): Promise<string | null> {
  const file = await readTokenFileRaw(filePath);
  if (!file || file.tokens.length === 0) return null;
  return file.tokens[0].token;
}

/** Export the default file path so callers can reference it in logs/docs. */
export { DEFAULT_TOKEN_FILE };
