/**
 * inviteTokens
 *
 * Single-use, short-TTL signed tokens for two §8.1 flows:
 *   - Local-account first-credential delivery (must-fix #17): operator runs
 *     `dollhousemcp create-user`, gets a one-time URL with a token, hand-
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
 * Single-use enforcement is via an in-memory consumed-set. The token's jti
 * is added to the set when consumed; subsequent consumes for the same jti
 * are rejected. The set is process-local (acceptable for solo / small-team
 * dev; the future SqliteAuthStorageLayer will persist this).
 *
 * @module auth/embedded-as/inviteTokens
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 min
// Bound the consumed-set memory. Eviction is TTL-driven (see consume): once a
// jti's `exp` has passed the underlying token can no longer pass verify(),
// so retaining it in the consumed-set is unnecessary. The count cap is a
// last-resort backstop — when reached without any expirable entries, the
// new consume is rejected rather than evicting a still-replayable jti.
const MAX_CONSUMED = 10_000;

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
 * Token store. Holds the HMAC secret and the consumed-jti set in-memory.
 * One instance per AS deployment; bind via DI.
 */
export class InviteTokenStore {
  private readonly secret: Buffer;
  /** jti → exp epoch ms. Map preserves insertion order for FIFO sweep. */
  private readonly consumed = new Map<string, number>();

  /**
   * @param secret Raw HMAC key (≥32 bytes recommended). Caller is responsible
   *               for persistence — typically the same persisted bytes used
   *               for other process-local secrets (e.g. derive from the AS
   *               signing-key file).
   */
  constructor(secret: Buffer) {
    if (secret.length < 16) {
      throw new Error('InviteTokenStore requires a secret of at least 16 bytes');
    }
    this.secret = secret;
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
   * Verify + atomically mark consumed. Called by the POST handler. Returns
   * already-consumed if the jti has been seen before, rate-exceeded if the
   * consumed-set is at capacity with no expired entries to prune (see
   * MAX_CONSUMED comment).
   */
  consume(token: string): ConsumeResult {
    const verified = this.verify(token);
    if (!verified.ok) return verified;

    if (this.consumed.has(verified.payload.jti)) {
      return { ok: false, reason: 'already-consumed' };
    }

    const now = Date.now();
    this.pruneExpiredConsumed(now);

    if (this.consumed.size >= MAX_CONSUMED) {
      // Cap reached and pruning yielded nothing — the only entries left are
      // still-replayable. Refuse the new consume rather than evict one of
      // them, which would let the evicted jti be replayed.
      return { ok: false, reason: 'rate-exceeded' };
    }

    this.consumed.set(verified.payload.jti, verified.payload.exp);
    return { ok: true, payload: verified.payload };
  }

  /**
   * Drop entries whose underlying token has already expired. Once exp has
   * passed, verify() rejects the token before consume even checks the set,
   * so the entry is no longer load-bearing.
   */
  private pruneExpiredConsumed(now: number): void {
    for (const [jti, exp] of this.consumed) {
      if (exp <= now) this.consumed.delete(jti);
    }
  }
}

function sign(secret: Buffer, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function defaultInviteSecretFilePath(): string {
  const homeDir = process.env.DOLLHOUSE_HOME_DIR || os.homedir();
  return path.join(homeDir, '.dollhouse', 'run', 'invite-secret.bin');
}

/**
 * Load an existing invite-token HMAC secret from disk, or generate + persist
 * a new 32-byte one. Mode 0600. Used by both the AS runtime (so all issued
 * tokens stay valid across restarts) and the `dollhousemcp create-user` CLI
 * (so CLI-issued invites verify against the runtime's secret).
 *
 * If `DOLLHOUSE_INVITE_TOKEN_SECRET` env var is set (hex-encoded), it
 * overrides the file — useful for multi-instance deployments where all
 * instances need to share the secret.
 */
export function loadOrGenerateInviteSecret(filePath?: string): Buffer {
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
  } catch {
    // Fall through to generation.
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
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
