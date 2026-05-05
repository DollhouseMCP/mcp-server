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
 *   2. If oidc-provider's cookie-binding behavior ever loosens, our
 *      callback routes still refuse to drive interactionFinished against
 *      an interaction the calling browser doesn't own.
 *
 * Threat model: an attacker who obtains a magic-link token (forwarded
 * email, leaked URL) or a GitHub `state` value cannot complete the
 * interaction in their own browser because they lack the original
 * session's `_interaction` cookie. Without this check, oidc-provider
 * would still throw — but routing through this helper makes the
 * intent explicit and the failure UX better.
 *
 * @module auth/embedded-as/interactionCookieBinding
 */

import type { Request } from 'express';

const INTERACTION_COOKIE_NAME = '_interaction';

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
  | { ok: false; reason: 'missing-cookie' | 'cookie-mismatch' };

/**
 * Verify the request's `_interaction` cookie value matches the expected
 * interaction uid. The cookie format oidc-provider uses is `value.signature`;
 * we compare only the value portion. Signature verification happens later
 * inside provider.interactionDetails(req, res).
 */
export function verifyInteractionCookieMatches(
  req: Request,
  expectedInteractionId: string,
): CookieBindingResult {
  const raw = req.headers.cookie;
  if (!raw) return { ok: false, reason: 'missing-cookie' };

  const cookieValue = parseCookieValue(raw, INTERACTION_COOKIE_NAME);
  if (!cookieValue) return { ok: false, reason: 'missing-cookie' };

  // Cookie value is `<uid>.<signature>` when signed; sometimes the signature
  // is stored in a sibling `_interaction.sig` cookie. Either way, the part
  // before the first dot (or the whole value when unsigned) is the uid.
  const uid = cookieValue.split('.')[0];

  if (uid !== expectedInteractionId) {
    return { ok: false, reason: 'cookie-mismatch' };
  }

  return { ok: true };
}

/**
 * Minimal cookie-header parser. Returns the value for `name` or undefined.
 * Header format per RFC 6265: `name1=value1; name2=value2`.
 */
function parseCookieValue(header: string, name: string): string | undefined {
  const pairs = header.split(';');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) continue;
    const k = pair.slice(0, eqIdx).trim();
    const v = pair.slice(eqIdx + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return undefined;
}
