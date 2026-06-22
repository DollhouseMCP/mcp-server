import type { RequestHandler } from 'express';

const CONSOLE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export function createConsoleSecurityHeadersMiddleware(): RequestHandler {
  return (_req, res, next): void => {
    res.setHeader('Content-Security-Policy', CONSOLE_CSP);
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  };
}
