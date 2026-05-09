/**
 * inviteTokens
 *
 * Single-use, short-TTL signed tokens for two §8.1 flows:
 *   - Local-account first-credential delivery (must-fix #17): operator runs
 *     `dollhouse-create-user`, gets a one-time URL with a token, hand-
 *     delivers it. User clicks, sets their own argon2id password.
 *   - Magic link login (must-fix #1 anti-pre-fetch): user requests a link,
 *     receives email, clicks to confirm (GET shows confirmation page),
 *     submits to consume (POST sets login). GET twice = no consumption;
 *     POST after a successful POST = rejected.
 *
 * Tokens are HMAC-SHA256 signed payloads. The payload carries:
 *   - sub:     subject identifier
 *   - email:   email being verified / set up
 *   - purpose: 'invite' | 'magic-link' | 'password-reset'
 *   - jti:     unique id (random); used by the consumed-set for single-use
 *   - exp:     expiry epoch ms
 *
 * Single-use enforcement is durable: the consumed-jti record is written
 * via `storage.genericInsertIfAbsent('ConsumedInvite', jti, ...)`, which
 * is atomic INSERT-IF-NOT-PRESENT on every backend. The earlier shape
 * used an in-memory Set; after restart the set evaporated, letting a
 * captured invite URL replay within its TTL — which for local accounts
 * meant an attacker could re-upsert a fresh password hash. With storage
 * persistence the consumed marker survives restart on filesystem and
 * Postgres backends and is lost only on the in-memory backend (which is
 * dev/test only and gated behind an explicit env opt-in).
 *
 * @module auth/embedded-as/inviteTokens
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolveDataDirectory } from '../../paths/resolveDataDirectory.js';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 min
const CONSUMED_INVITE_MODEL = 'ConsumedInvite';
/**
 * Maximum length of a token string accepted by verify/consume (H11).
 *
 * Without this cap an attacker can send an arbitrarily large blob to the
 * /auth/email/verify or /auth/local/invite routes and the server will
 * HMAC-SHA256 the entire payload before noticing the signature doesn't
 * match. 4096 chars is comfortably above the largest legitimate token
 * (≈250 chars for a payload with provider, email, jti, exp, optional
 * interactionId — base64url-encoded — plus the 43-char signature) and
 * cuts off the cheap-DoS amplification.
 */
const MAX_TOKEN_LENGTH = 4096;

export type InviteTokenPurpose = 'invite' | 'magic-link' | 'password-reset';

export interface InviteTokenPayload {
  sub: string;
  email: string;
  purpose: InviteTokenPurpose;
  jti: string;
  exp: number;
  /**
   * Optional interaction context. The magic-link flow stamps this with the
   * oidc-provider interaction uid that started the flow, so the
   * /auth/email/verify route can find the right interaction to complete
   * even when the user clicks the link in a different tab. Invite tokens
   * issued by the CLI omit this field.
   */
  interactionId?: string;
}

export interface IssueInviteInput {
  sub: string;
  email: string;
  purpose: InviteTokenPurpose;
  /** TTL override; default 15 min. Capped at 1 hour. */
  ttlMs?: number;
  /** Optional interaction uid; embedded into the token payload. */
  interactionId?: string;
}

export type ConsumeResult =
  | { ok: true; payload: InviteTokenPayload }
  | { ok: false; reason: 'invalid' | 'expired' | 'already-consumed' | 'rate-exceeded' };

/**
 * Token store. Holds the HMAC secret; consumed-jti durability is delegated
 * to IAuthStorageLayer (`ConsumedInvite` model). One instance per AS
 * deployment; bind via DI.
 */
export class InviteTokenStore {
  private readonly secret: Buffer;
  private readonly storage: IAuthStorageLayer | undefined;

  /**
   * @param secret  Raw HMAC key (≥32 bytes recommended). Caller is responsible
   *                for persistence — typically the same persisted bytes used
   *                for other process-local secrets (e.g. derive from the AS
   *                signing-key file).
   * @param storage Optional storage layer used to record consumed jti markers
   *                so single-use enforcement survives restart. The CLI
   *                `dollhouse-create-user` only issues tokens (the AS
   *                consumes them) and may construct without storage; the
   *                running AS always wires storage in via AuthProviderFactory.
   */
  constructor(secret: Buffer, storage?: IAuthStorageLayer) {
    if (secret.length < 16) {
      throw new Error('InviteTokenStore requires a secret of at least 16 bytes');
    }
    this.secret = secret;
    this.storage = storage;
  }

  /**
   * Issue a token. Returns the encoded string (base64url payload + '.' +
   * base64url HMAC). Verify by passing the same string to verify().
   */
  issue(input: IssueInviteInput): string {
    const ttl = Math.min(input.ttlMs ?? DEFAULT_TTL_MS, 60 * 60 * 1000);
    const payload: InviteTokenPayload = {
      sub: input.sub,
      email: input.email,
      purpose: input.purpose,
      jti: randomBytes(16).toString('base64url'),
      exp: Date.now() + ttl,
      ...(input.interactionId ? { interactionId: input.interactionId } : {}),
    };
    const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
    const signature = sign(this.secret, payloadEncoded);
    return `${payloadEncoded}.${signature}`;
  }

  /**
   * Verify the signature + expiry without consuming. Used by the GET handler
   * for the anti-pre-fetch confirmation page (must-fix #1).
   */
  verify(token: string): { ok: true; payload: InviteTokenPayload } | { ok: false; reason: 'invalid' | 'expired' } {
    // H11: reject oversize input before paying the HMAC cost. Otherwise
    // an attacker could send a 100MB token and force the server to HMAC
    // the entire blob before discovering the signature is wrong.
    if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'invalid' };
    const parts = token.split('.');
    if (parts.length !== 2) return { ok: false, reason: 'invalid' };
    const [payloadEncoded, signature] = parts;

    const expectedSig = sign(this.secret, payloadEncoded);
    if (!constantTimeStrEq(signature, expectedSig)) {
      return { ok: false, reason: 'invalid' };
    }

    let payload: InviteTokenPayload;
    try {
      payload = JSON.parse(base64UrlDecode(payloadEncoded)) as InviteTokenPayload;
    } catch {
      return { ok: false, reason: 'invalid' };
    }

    if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
      return { ok: false, reason: 'expired' };
    }

    return { ok: true, payload };
  }

  /**
   * Verify + atomically mark consumed. Called by the POST handler.
   * Returns `already-consumed` if the jti has been seen before. The
   * record is written via `genericInsertIfAbsent` so two concurrent
   * consumes of the same jti cannot both succeed; the first wins.
   *
   * Cleanup of the consumed-jti record is TTL-driven by the underlying
   * storage backend — once `exp` has passed, verify() rejects the
   * token before consume even reaches the storage check, so the
   * persistent record only needs to outlive the token's exp.
   */
  async consume(token: string): Promise<ConsumeResult> {
    if (!this.storage) {
      throw new Error(
        'InviteTokenStore.consume() requires a storage layer. ' +
        'Construct with `new InviteTokenStore(secret, storage)`.',
      );
    }
    const verified = this.verify(token);
    if (!verified.ok) return verified;

    const ttlSec = Math.max(1, Math.ceil((verified.payload.exp - Date.now()) / 1000));
    const inserted = await this.storage.genericInsertIfAbsent(
      CONSUMED_INVITE_MODEL,
      verified.payload.jti,
      { exp: verified.payload.exp },
      ttlSec,
    );
    if (!inserted) {
      return { ok: false, reason: 'already-consumed' };
    }
    return { ok: true, payload: verified.payload };
  }
}

function sign(secret: Buffer, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Resolves to `<run-dir>/invite-secret.bin`. The run directory is
 * platform-correct (XDG / Library / LOCALAPPDATA) and respects
 * `DOLLHOUSE_RUN_DIR` / `DOLLHOUSE_HOME_DIR` env overrides via the central
 * resolver — no hardcoded `~/.dollhouse/` paths.
 */
export function defaultInviteSecretFilePath(legacyRoot?: string): string {
  return path.join(
    resolveDataDirectory('run', legacyRoot ? { legacyRoot } : {}),
    'invite-secret.bin',
  );
}

/**
 * Load an existing invite-token HMAC secret from disk, or generate + persist
 * a new 32-byte one. Mode 0600. Used by both the AS runtime (so all issued
 * tokens stay valid across restarts) and the `dollhouse-create-user` CLI
 * (so CLI-issued invites verify against the runtime's secret).
 *
 * If `DOLLHOUSE_INVITE_TOKEN_SECRET` env var is set (hex-encoded), it
 * overrides the file — useful for multi-instance deployments where all
 * instances need to share the secret.
 */
export function loadOrGenerateInviteSecret(filePath?: string): Buffer {
  // Re-read at call time so tests and runtime reconfiguration observe
  // the current env (Zod schema in env.ts validates the shape at load).
  const envSecret = process.env.DOLLHOUSE_INVITE_TOKEN_SECRET?.trim();
  if (envSecret && envSecret.length > 0) {
    const buf = Buffer.from(envSecret, 'hex');
    if (buf.length < 16) {
      throw new Error('DOLLHOUSE_INVITE_TOKEN_SECRET must decode to at least 16 bytes (hex)');
    }
    return buf;
  }

  const target = filePath ?? defaultInviteSecretFilePath();
  try {
    const buf = fs.readFileSync(target);
    if (buf.length >= 16) return buf;
    // File exists but is too short — corrupt or partial write. Treat
    // as missing and regenerate; logging the truncation so operators
    // can investigate.
    console.warn(
      `[inviteTokens] secret file at ${target} is shorter than 16 bytes; regenerating.`,
    );
  } catch (err) {
    // Cycle-16 fix: only fall through to generation on ENOENT. A
    // permission-denied or I/O error means the file probably exists
    // but we can't read it — silently generating a new secret would
    // invalidate every previously-issued invite token without operator
    // awareness. Re-throw so the operator sees the actual error.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const fresh = randomBytes(32);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fresh, { mode: 0o600 });
  return fresh;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function constantTimeStrEq(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Pad-and-compare: an early-return on length mismatch leaks
  // length-differs-from-expected via timing. The signature length is
  // public and constant (HMAC-SHA256 → 43 base64url chars) so the leak
  // is informational only, but keep the helper actually constant-time.
  if (bufA.length !== bufB.length) {
    const padded = Buffer.alloc(bufA.length);
    timingSafeEqual(bufA, padded);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
