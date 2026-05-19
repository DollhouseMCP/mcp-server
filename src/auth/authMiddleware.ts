/**
 * Unified Authentication Middleware
 *
 * Express middleware that validates Bearer tokens via IAuthProvider.
 * Mounted on the MCP HTTP transport. The web console has its own
 * middleware (src/web/middleware/authMiddleware.ts) with a separate
 * ?token= EventSource fallback that the upcoming console rewrite will
 * replace with the per-stream ticket pattern in src/server/sseTickets.ts.
 *
 * On success, attaches AuthClaims to res.locals.authClaims for
 * downstream handlers. On failure, responds with 401 and a
 * WWW-Authenticate header pointing at the protected-resource doc.
 *
 * Header-only: Authorization: Bearer <token>. The previous
 * ?token=<token> query-string fallback was removed (§8.1 compliance);
 * MCP clients always set the Authorization header.
 *
 * @module auth/authMiddleware
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { IAuthProvider, AuthClaims } from './IAuthProvider.js';

export interface AuthMiddlewareOptions {
  /** The auth provider to validate tokens against. */
  provider: IAuthProvider;
  /** Paths that bypass authentication (e.g. health checks). */
  publicPaths?: string[];
  /** RFC 9728 protected resource metadata URL for WWW-Authenticate discovery. */
  protectedResourceMetadataUrl?: string;
}

/**
 * Augment Express locals with auth claims. Consumers access via
 * res.locals.authClaims after the middleware runs.
 */
declare module 'express' {
  interface Locals {
    authClaims?: AuthClaims;
  }
}

/**
 * Create an Express middleware that validates Bearer tokens.
 *
 * Usage:
 *   app.use('/mcp', createAuthMiddleware({ provider }));
 *   app.use('/api', createAuthMiddleware({ provider, publicPaths: ['/api/health'] }));
 */
export function createUnifiedAuthMiddleware(options: AuthMiddlewareOptions): RequestHandler {
  const { provider, publicPaths = [], protectedResourceMetadataUrl } = options;
  const publicSet = new Set(publicPaths);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Public paths bypass auth.
    // Check both the relative path (for mount-point-relative middleware)
    // and the full path (for app-level middleware).
    if (publicSet.has(req.baseUrl + req.path) || publicSet.has(req.originalUrl)) {
      next();
      return;
    }

    const token = extractToken(req);
    if (!token) {
      SecurityMonitor.logSecurityEvent({
        type: 'OPERATION_FAILED',
        severity: 'LOW',
        source: `auth:${provider.name}`,
        details: 'Missing authentication token',
        additionalData: { path: req.path, method: req.method },
      });
      setAuthenticateHeader(res, protectedResourceMetadataUrl);
      res.status(401).json({ error: 'Authentication required. Provide a Bearer token in the Authorization header.' });
      return;
    }

    const result = await provider.validate(token);

    if (!result.ok) {
      SecurityMonitor.logSecurityEvent({
        type: 'OPERATION_FAILED',
        severity: 'MEDIUM',
        source: `auth:${provider.name}`,
        details: `Token validation failed: ${result.reason}`,
        additionalData: { path: req.path, method: req.method, reason: result.reason },
      });
      logger.warn(`[AuthMiddleware] Token rejected: ${result.reason}`, {
        provider: provider.name,
        path: req.path,
      });
      setAuthenticateHeader(res, protectedResourceMetadataUrl);
      res.status(401).json({ error: `Authentication failed: ${result.reason}` });
      return;
    }

    // Attach claims for downstream handlers
    res.locals.authClaims = result.claims;
    next();
  };
}

/**
 * Wrap a strict unified-auth middleware so it falls through to next()
 * (instead of 401) when the request has no Bearer token OR has a Bearer
 * token that doesn't look like a JWT. This lets a co-mounted route (the
 * web console's `/api`) chain a second middleware behind it that handles
 * non-JWT bearers (e.g. 64-hex console tokens).
 *
 * Decision matrix when the decorator runs:
 *   - No Authorization header               → next() (let next middleware try)
 *   - Bearer header, token NOT JWT-shaped   → next() (probably console token)
 *   - Bearer header, token IS JWT-shaped    → delegate to strict middleware,
 *                                              which validates and may 401
 *
 * "JWT-shaped" = three base64url segments separated by dots. A 64-hex
 * console token has no dots and fails the test cleanly. A forged or
 * expired JWT IS shaped like a JWT, so the decorator passes it through;
 * the strict middleware then 401s with a precise reason. No path lets a
 * forged JWT bypass authentication.
 *
 * Without this wrapper, mounting unified auth on `/api` before the
 * console-token middleware made the unified middleware reject any
 * non-JWT bearer (incl. the legitimate console token the browser injects)
 * with 401 before the console-token middleware ever ran — breaking the
 * documented coexistence at `web/server.ts:277-280`.
 */
export function withJwtFallthrough(strict: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      next();
      return;
    }
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (!match) {
      next();
      return;
    }
    const token = match[1]!;
    // Three base64url segments separated by dots. RFC 7519 §3 — JWS
    // Compact Serialization. Anything else (64-hex console tokens, raw
    // strings, opaque tokens) falls through to the next middleware.
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      next();
      return;
    }
    strict(req, res, next);
  };
}

function setAuthenticateHeader(res: Response, protectedResourceMetadataUrl: string | undefined): void {
  if (protectedResourceMetadataUrl) {
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${protectedResourceMetadataUrl}"`);
    return;
  }

  res.setHeader('WWW-Authenticate', 'Bearer');
}

/** Extract Bearer token from the Authorization header. Header-only by design. */
function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
  return match ? match[1] : null;
}
