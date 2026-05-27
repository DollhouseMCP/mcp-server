/**
 * securityHeaders
 *
 * Middleware that emits the four security headers every response from
 * the embedded AS should carry (must-fix #7 + Phase 7 follow-ups):
 *
 *   - `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`
 *   - `X-Frame-Options: DENY`
 *     Both prevent the consent page (and any future login forms) from
 *     being embedded in an attacker-controlled iframe — which would
 *     otherwise allow clickjacking the "Approve Connector" button.
 *
 *   - `Cache-Control: no-store`
 *     Auth pages MUST NOT be cached by intermediaries or browser back-
 *     button history. Without it, the magic-link confirmation page (which
 *     embeds the single-use token in a hidden form input) lingers in
 *     view-source / disk cache; the trivial-consent confirmation page is
 *     similarly sensitive. Pairs with `Pragma: no-cache` for HTTP/1.0
 *     proxies.
 *
 *   - `Referrer-Policy: no-referrer`
 *     The magic-link GET URL contains the token in `?token=`. Browser
 *     extensions, bookmarklets, and outbound links from the auth page
 *     would otherwise leak the URL via Referer headers. `no-referrer`
 *     suppresses Referer entirely on outbound navigation.
 *
 * Mounted on every route the embedded AS exposes — interaction pages,
 * `/auth/*` callbacks, and oidc-provider's own routes.
 *
 * @module auth/embedded-as/securityHeaders
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

export function securityHeaders(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    );
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };
}
