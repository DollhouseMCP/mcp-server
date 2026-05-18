/**
 * verifyInteractionCookieMatches — H12 keygrip signature verification.
 *
 * The earlier implementation only compared the cookie value against
 * the expected uid; it did NOT verify the signature, relying instead
 * on oidc-provider's downstream check. An attacker who planted
 * `_interaction=<victim-uid>` without a valid signature companion
 * could pass our check and reach interactionDetails.
 *
 * The hardened implementation independently verifies the keygrip
 * HMAC-SHA1 signature against the AS's cookie signing keys.
 */

import { describe, it, expect } from '@jest/globals';
import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import { verifyInteractionCookieMatches } from '../../../../src/auth/embedded-as/interactionCookieBinding.js';

const COOKIE_KEY = 'dGVzdC1jb29raWUtc2lnbmluZy1zZWNyZXQ='; // any 32-byte base64
const COOKIE_KEYS = [COOKIE_KEY];

/** Replicate keygrip's signing format: HMAC-SHA1, base64url-no-padding. */
function keygripSign(data: string, key: string): string {
  return createHmac('sha1', key)
    .update(data)
    .digest('base64')
    .replace(/\//g, '_')
    .replace(/\+/g, '-')
    .replace(/=+$/, ''); // NOSONAR — anchored single-quantifier on bounded base64 digest; no backtracking
}

function makeReq(cookieHeader: string | undefined): Request {
  return { headers: cookieHeader ? { cookie: cookieHeader } : {} } as unknown as Request;
}

function signedCookie(uid: string, key: string): string {
  const sig = keygripSign(`_interaction=${uid}`, key);
  return `_interaction=${uid}; _interaction.sig=${sig}`;
}

describe('verifyInteractionCookieMatches — H12 signature verification', () => {
  const expectedUid = 'i-test-uid-1234';

  it('accepts a properly-signed cookie matching the expected uid', () => {
    const req = makeReq(signedCookie(expectedUid, COOKIE_KEY));
    expect(verifyInteractionCookieMatches(req, expectedUid, COOKIE_KEYS)).toEqual({ ok: true });
  });

  it('rejects with missing-cookie when no Cookie header present', () => {
    const req = makeReq(undefined);
    const result = verifyInteractionCookieMatches(req, expectedUid, COOKIE_KEYS);
    expect(result).toEqual({ ok: false, reason: 'missing-cookie' });
  });

  it('rejects with missing-cookie when _interaction is absent', () => {
    const req = makeReq('other_cookie=foo');
    expect(verifyInteractionCookieMatches(req, expectedUid, COOKIE_KEYS)).toEqual({
      ok: false, reason: 'missing-cookie',
    });
  });

  it('rejects with missing-cookie when _interaction is present but .sig is absent (forged unsigned)', () => {
    // H12 attacker scenario: plant `_interaction=<victim-uid>` without
    // the `.sig` companion. Prior shape would have accepted this.
    const req = makeReq(`_interaction=${expectedUid}`);
    expect(verifyInteractionCookieMatches(req, expectedUid, COOKIE_KEYS)).toEqual({
      ok: false, reason: 'missing-cookie',
    });
  });

  it('rejects with cookie-mismatch when uid does not equal expected', () => {
    const req = makeReq(signedCookie('different-uid', COOKIE_KEY));
    expect(verifyInteractionCookieMatches(req, expectedUid, COOKIE_KEYS)).toEqual({
      ok: false, reason: 'cookie-mismatch',
    });
  });

  it('rejects with invalid-signature when .sig is wrong (forged)', () => {
    const tampered = `_interaction=${expectedUid}; _interaction.sig=this-is-not-a-valid-signature`;
    const req = makeReq(tampered);
    expect(verifyInteractionCookieMatches(req, expectedUid, COOKIE_KEYS)).toEqual({
      ok: false, reason: 'invalid-signature',
    });
  });

  it('rejects with invalid-signature when .sig was signed with a different key', () => {
    const wrongKey = 'd3JvbmctY29va2llLXNpZ25pbmcta2V5';
    const req = makeReq(signedCookie(expectedUid, wrongKey));
    expect(verifyInteractionCookieMatches(req, expectedUid, COOKIE_KEYS)).toEqual({
      ok: false, reason: 'invalid-signature',
    });
  });

  it('accepts when signature was made with any of the configured keys (rotation grace)', () => {
    const oldKey = 'b2xkLWNvb2tpZS1zaWduaW5nLWtleQ==';
    const newKey = COOKIE_KEY;
    const keys = [newKey, oldKey];
    // Cookie signed with the OLD key — still accepted while it's in the
    // active rotation set.
    const req = makeReq(signedCookie(expectedUid, oldKey));
    expect(verifyInteractionCookieMatches(req, expectedUid, keys)).toEqual({ ok: true });
  });

  // Cycle-10 BLOCKER regression: a malformed percent-encoded cookie
  // value used to throw URIError unhandled, surfacing as a 500 with a
  // stack trace via Express's default error handler. Public callback
  // URLs (GitHub callback, magic-link verify POST) were exposed.
  // After the fix, malformed cookies are treated as missing.
  it('treats a malformed percent-encoded cookie value as missing (does not throw URIError)', () => {
    const req = makeReq(`_interaction=%GG; _interaction.sig=anything`);
    // Must not throw. Must return a structured rejection.
    expect(() =>
      verifyInteractionCookieMatches(req, expectedUid, COOKIE_KEYS),
    ).not.toThrow();
    expect(verifyInteractionCookieMatches(req, expectedUid, COOKIE_KEYS)).toEqual({
      ok: false, reason: 'missing-cookie',
    });
  });

  it('treats a malformed percent-encoded sig as missing (does not throw URIError)', () => {
    // The unsigned part is fine but the .sig has bad encoding.
    const req = makeReq(`_interaction=${expectedUid}; _interaction.sig=%ZZ`);
    expect(() =>
      verifyInteractionCookieMatches(req, expectedUid, COOKIE_KEYS),
    ).not.toThrow();
    const result = verifyInteractionCookieMatches(req, expectedUid, COOKIE_KEYS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Either treated as missing or as invalid-signature, depending on
      // which decode short-circuits first. Both are acceptable —
      // critical thing is no URIError leak.
      expect(['missing-cookie', 'invalid-signature']).toContain(result.reason);
    }
  });
});
