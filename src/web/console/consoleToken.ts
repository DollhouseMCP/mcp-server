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

import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile, chmod, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
 * TOTP enrollment state. Phase 2 populates this.
 */
export interface TotpState {
  enrolled: boolean;
  secret: string | null;
  backupCodes: string[];
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
  private tokenBuffers = new Map<string, Buffer>();

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
    const existing = await this.read();
    if (existing && existing.tokens.length > 0) {
      this.data = existing;
      this.rebuildTokenBuffers();
      logger.debug('[ConsoleToken] Loaded existing token file', {
        path: this.filePath,
        count: existing.tokens.length,
      });
      return existing.tokens[0];
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
      totp: { enrolled: false, secret: null, backupCodes: [] },
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

    // Only the presented side is allocated per-request; stored buffers are
    // pre-converted in the tokenBuffers cache so the hot loop is allocation-free.
    const presentedBuf = Buffer.from(presented, 'utf8');

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

  /**
   * Read the token file from disk and validate it. Returns null if missing
   * or corrupt (caller decides whether to recreate).
   */
  private async read(): Promise<ConsoleTokenFile | null> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content);
      return validateTokenFile(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      logger.warn('[ConsoleToken] Failed to read token file, will recreate', {
        path: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Atomically write the token file with owner-only permissions.
   * Uses temp+rename to avoid partial writes on crash.
   */
  private async write(file: ConsoleTokenFile): Promise<void> {
    await mkdir(RUN_DIR, { recursive: true });
    const tmpFile = `${this.filePath}.${process.pid}.tmp`;
    try {
      await writeFile(tmpFile, JSON.stringify(file, null, 2), 'utf8');
      await chmod(tmpFile, TOKEN_FILE_MODE);
      await rename(tmpFile, this.filePath);
    } catch (err) {
      try { await unlink(tmpFile); } catch { /* ignore */ }
      throw err;
    }
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
