/**
 * interactionCookieBinding
 *
 * Defense-in-depth check for the magic-link and GitHub-social callback
 * routes. The callbacks restore `req.url = /interaction/${id}` and call
 * oidc-provider's interactionDetails — which itself reads and verifies
 * the `_interaction` cookie. We add an explicit pre-check so:
 *
 *   1. Mismatch / missing-cookie errors render an explainable page,
 *      not the opaque "invalid_request" oidc-provider returns.
 *   2. The check independently verifies the keygrip signature against
 *      the AS's cookie signing keys — so even if oidc-provider's cookie-
 *      binding behavior ever loosens, our callback routes refuse to
 *      drive interactionFinished against a forged or unsigned cookie.
 *      (H12 hardening: an attacker who plants `_interaction=<victim-uid>`
 *      without a valid `.sig` companion cookie is rejected here.)
 *
 * Threat model: an attacker who obtains a magic-link token (forwarded
 * email, leaked URL) or a GitHub `state` value cannot complete the
 * interaction in their own browser because they lack the original
 * session's `_interaction` cookie + matching `_interaction.sig`. The
 * keygrip signature is HMAC-SHA1 of the cookie value under one of the
 * AS's cookie signing keys (oidc-provider's `cookies.keys`).
 *
 * @module auth/embedded-as/interactionCookieBinding
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const INTERACTION_COOKIE_NAME = '_interaction';
const INTERACTION_SIG_COOKIE_NAME = '_interaction.sig';

/**
 * Shared HTML error page rendered when the cookie-binding check fails.
 * Lives alongside `verifyInteractionCookieMatches` because the page text
 * directly maps to that helper's failure modes — keep the message in
 * sync with the threat model documented at the top of this file.
 */
export function renderInteractionBindingError(flowLabel: string): string {
  const safe = flowLabel.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Continue in your original browser</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f4;color:#181816}main{max-width:480px;margin:12vh auto;padding:32px;background:white;border:1px solid #d8d6cc;border-radius:8px}</style>
</head><body><main>
<h1>Continue in your original browser</h1>
<p>This ${safe} link must be opened in the same browser where you started the sign-in flow.</p>
<p>Return to that browser and re-open the link, or restart sign-in from your application.</p>
</main></body></html>`;
}

export type CookieBindingResult =
  | { ok: true }
  | { ok: false; reason: 'missing-cookie' | 'cookie-mismatch' | 'invalid-signature' };

/**
 * Verify the request's `_interaction` cookie matches the expected
 * interaction uid AND carries a valid keygrip signature.
 *
 * oidc-provider uses cookies-keygrip: the cookie value is the raw uid
 * and a sibling `<name>.sig` cookie holds the HMAC-SHA1 signature
 * (base64url-encoded) of `<name>=<value>` under one of the configured
 * `cookies.keys`. We try each configured key in turn and accept the
 * first signature match, comparing in constant time. The verify-loop
 * is multi-key by design even though `cookies.keys` is currently
 * single-key (Phase 4 B6) — keeping the loop ready for a future
 * rotation runbook avoids a structural change at that point.
 */
export function verifyInteractionCookieMatches(
  req: Request,
  expectedInteractionId: string,
  cookieKeys: readonly string[],
): CookieBindingResult {
  const raw = req.headers.cookie;
  if (!raw) return { ok: false, reason: 'missing-cookie' };

  const cookieValue = parseCookieValue(raw, INTERACTION_COOKIE_NAME);
  if (!cookieValue) return { ok: false, reason: 'missing-cookie' };
  const sigValue = parseCookieValue(raw, INTERACTION_SIG_COOKIE_NAME);
  if (!sigValue) return { ok: false, reason: 'missing-cookie' };

  // value-portion check: strict uid match.
  if (cookieValue !== expectedInteractionId) {
    return { ok: false, reason: 'cookie-mismatch' };
  }

  // H12: independently verify the keygrip signature so a forged
  // _interaction=<victim-uid> without a valid signature companion is
  // rejected here, not at oidc-provider's downstream check.
  const signedData = `${INTERACTION_COOKIE_NAME}=${cookieValue}`;
  const sigBuf = Buffer.from(sigValue);
  for (const key of cookieKeys) {
    const expected = keygripSign(signedData, key);
    const expectedBuf = Buffer.from(expected);
    // Cycle-16 sibling-fix (security LOW-3): pad-and-compare so a
    // length mismatch doesn't take a different code path from a
    // content mismatch. Signature length is fixed (HMAC-SHA1 → 27
    // base64url chars) so a length difference always means forgery.
    if (sigBuf.length !== expectedBuf.length) {
      timingSafeEqual(expectedBuf, Buffer.alloc(expectedBuf.length));
      continue;
    }
    if (timingSafeEqual(sigBuf, expectedBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'invalid-signature' };
}

/**
 * keygrip's signing algorithm: HMAC-SHA1 of the data, base64-encoded,
 * then converted to base64url-without-padding (the "/" → "_", "+" → "-",
 * "=" stripped).
 *
 * SHA-1 here is dictated by keygrip's wire format — oidc-provider's
 * cookie signatures use the keygrip npm package, which has emitted
 * HMAC-SHA1 since version 1.x; we have to match that to verify
 * cookies it produces. HMAC-SHA1 is not affected by the SHA-1
 * collision attacks (HMAC's security depends on the key, not the
 * collision-resistance of the underlying hash), so this is acceptable
 * here, but a third-party audit will flag the algorithm name. Upgrading
 * would require coordinating a keygrip wire-format change upstream
 * AND a synchronized rotation across all running instances; not §8.1
 * scope. See `package.json` for the pinned keygrip dependency.
 */
function keygripSign(data: string, key: string): string {
  return createHmac('sha1', key)
    .update(data)
    .digest('base64')
    .replace(/\//g, '_')
    .replace(/\+/g, '-')
    .replace(/=+$/, ''); // NOSONAR — anchored single-quantifier on a bounded base64 digest; no backtracking possible
}

/**
 * Minimal cookie-header parser. Returns the value for `name` or undefined.
 * Header format per RFC 6265: `name1=value1; name2=value2`.
 *
 * Cycle-10 BLOCKER fix: a malformed percent-encoded value (e.g.
 * `_interaction=%GG`) makes `decodeURIComponent` throw URIError. The
 * exception propagated through public callback URLs (GitHub
 * callback, magic-link verify POST), surfacing as a 500 with a stack
 * trace via Express's default error handler — leaking internal file
 * paths to anyone willing to send a malformed cookie. Treat any
 * decode failure as "no cookie" (the cookie is unverifiable, which
 * is the same outcome as missing) and return undefined.
 */
function parseCookieValue(header: string, name: string): string | undefined {
  const pairs = header.split(';');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) continue;
    const k = pair.slice(0, eqIdx).trim();
    const v = pair.slice(eqIdx + 1).trim();
    if (k === name) {
      try {
        return decodeURIComponent(v);
      } catch {
        // Malformed percent-encoding — treat as missing cookie.
        return undefined;
      }
    }
  }
  return undefined;
}
