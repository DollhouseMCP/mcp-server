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

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 min
const MAX_CONSUMED = 10_000; // bound the consumed-set memory

export type InviteTokenPurpose = 'invite' | 'magic-link' | 'password-reset';

export interface InviteTokenPayload {
  sub: string;
  email: string;
  purpose: InviteTokenPurpose;
  jti: string;
  exp: number;
}

export interface IssueInviteInput {
  sub: string;
  email: string;
  purpose: InviteTokenPurpose;
  /** TTL override; default 15 min. Capped at 1 hour. */
  ttlMs?: number;
}

export type ConsumeResult =
  | { ok: true; payload: InviteTokenPayload }
  | { ok: false; reason: 'invalid' | 'expired' | 'already-consumed' };

/**
 * Token store. Holds the HMAC secret and the consumed-jti set in-memory.
 * One instance per AS deployment; bind via DI.
 */
export class InviteTokenStore {
  private readonly secret: Buffer;
  private readonly consumed = new Set<string>();
  private readonly consumedOrder: string[] = [];

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
   * already-consumed if the jti has been seen before.
   */
  consume(token: string): ConsumeResult {
    const verified = this.verify(token);
    if (!verified.ok) return verified;

    if (this.consumed.has(verified.payload.jti)) {
      return { ok: false, reason: 'already-consumed' };
    }

    this.consumed.add(verified.payload.jti);
    this.consumedOrder.push(verified.payload.jti);
    if (this.consumedOrder.length > MAX_CONSUMED) {
      const evict = this.consumedOrder.shift();
      if (evict) this.consumed.delete(evict);
    }

    return { ok: true, payload: verified.payload };
  }
}

function sign(secret: Buffer, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
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
