import type { RequestHandler } from 'express';

const CONSOLE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/**
 * The policy for the console's own pages and assets under /ui.
 *
 * Everything the page loads is its own: scripts, styles, fonts, and its calls
 * to the API. The one addition to the API's policy is `data:` images, for an
 * icon drawn inline in the stylesheet. Scripts allow neither inline code nor
 * `eval`, so the page must keep its scripts in files and attach its handlers
 * from them. Images from other sites are not loaded, which also means
 * portfolio content cannot make the viewer's browser call one.
 */
export const CONSOLE_UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export function createConsoleSecurityHeadersMiddleware(): RequestHandler {
  return securityHeaders(CONSOLE_CSP);
}

/** The same headers the API sends, with the page's own content policy. */
export function createConsoleUiSecurityHeadersMiddleware(): RequestHandler {
  return securityHeaders(CONSOLE_UI_CSP);
}

function securityHeaders(contentSecurityPolicy: string): RequestHandler {
  return (_req, res, next): void => {
    res.setHeader('Content-Security-Policy', contentSecurityPolicy);
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  };
}
