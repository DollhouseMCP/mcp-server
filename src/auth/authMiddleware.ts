/**
 * Unified Authentication Middleware
 *
 * Express middleware that validates Bearer tokens via IAuthProvider.
 * Mounted on both the MCP HTTP transport and the web console — one
 * middleware, two surfaces, same identity model.
 *
 * On success, attaches AuthClaims to res.locals.authClaims for
 * downstream handlers. On failure, responds with 401.
 *
 * Supports:
 * - Authorization: Bearer <token> header (primary)
 * - ?token=<token> query parameter (fallback for SSE/EventSource)
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
  const { provider, publicPaths = [] } = options;
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
      res.status(401).json({ error: `Authentication failed: ${result.reason}` });
      return;
    }

    // Attach claims for downstream handlers
    res.locals.authClaims = result.claims;
    next();
  };
}

/** Extract Bearer token from header or query parameter. */
function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (match) return match[1];
  }

  // Fallback: query parameter (for SSE/EventSource which can't set headers)
  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }

  return null;
}
