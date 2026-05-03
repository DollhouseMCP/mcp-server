/**
 * securityHeaders
 *
 * Middleware that emits CSP frame-ancestors + X-Frame-Options DENY on
 * embedded AS responses (must-fix #7). Mounted only on the interaction
 * routes and the OAuth endpoints we control directly — oidc-provider's
 * own routes also pass through this since createRouter() uses the same
 * Express router.
 *
 * The headers prevent the consent page (and any future login forms) from
 * being embedded in an attacker-controlled iframe — which would otherwise
 * allow clickjacking the "Approve Connector" button.
 *
 * @module auth/embedded-as/securityHeaders
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

export function securityHeaders(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  };
}
