/**
 * Express middleware for console Bearer token authentication (#1780).
 *
 * Checks the `Authorization: Bearer <token>` header on requests to protected
 * endpoints, with a `?token=<token>` query parameter fallback for SSE streams
 * (EventSource cannot set custom headers).
 *
 * Behavior is gated on the `DOLLHOUSE_WEB_AUTH_ENABLED` env var. When the flag
 * is false (the default during Phase 1 rollout) the middleware is a no-op —
 * requests pass through unconditionally. When true, every protected request
 * must carry a valid token or receive a 401.
 *
 * Phase 1 design notes:
 * - Every valid token is treated as admin-scoped. Scope enforcement is a
 *   stubbed hook (`authorizeScope`) that always returns true. Phase 2 swaps
 *   in real scope checks without touching any route handler.
 * - Element boundaries and tenant filtering are similarly stubbed for Phase 3.
 * - The middleware attaches the matched token entry to `res.locals.tokenEntry`
 *   so downstream handlers can inspect it (audit logs, scope decisions, etc.).
 *
 * @since v2.1.0 — Issue #1780
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ConsoleTokenStore, ConsoleTokenEntry } from '../console/consoleToken.js';
import { logger } from '../../utils/logger.js';

/** Query parameter name used as a fallback for SSE streams. */
const TOKEN_QUERY_PARAM = 'token';

/** Header name we look at for Bearer tokens. */
const AUTH_HEADER = 'authorization';

/** Prefix expected on the Authorization header value. */
const BEARER_PREFIX = 'Bearer ';

/**
 * Extract a Bearer token from a request.
 * Checks Authorization header first, then query parameter.
 * Returns the raw token string, or null if none was found.
 */
function extractToken(req: Request): string | null {
  // Preferred: Authorization: Bearer <token>
  const header = req.headers[AUTH_HEADER];
  if (typeof header === 'string' && header.startsWith(BEARER_PREFIX)) {
    const value = header.slice(BEARER_PREFIX.length).trim();
    if (value) return value;
  }

  // Fallback for EventSource: ?token=<token>
  const q = req.query[TOKEN_QUERY_PARAM];
  if (typeof q === 'string' && q.length > 0) {
    return q;
  }
  if (Array.isArray(q) && q.length > 0 && typeof q[0] === 'string') {
    return q[0] as string;
  }

  return null;
}

/**
 * Options for the auth middleware factory.
 */
export interface AuthMiddlewareOptions {
  /** The token store holding valid tokens. */
  store: ConsoleTokenStore;
  /** Whether auth is enforced. When false, middleware is a no-op. */
  enabled: boolean;
  /**
   * Path prefixes that are never protected. A request whose URL path starts
   * with any of these strings will skip auth and be passed through to the
   * next handler. Used to exempt health checks, version info, client detection,
   * and similar public metadata endpoints.
   *
   * Paths are compared against `req.path` (the route-relative path), so include
   * the full pathname starting with `/` — e.g. `/api/health`, `/api/setup/version`.
   */
  publicPathPrefixes?: string[];
  /** Optional label for log messages (e.g. "api" or "sse"). */
  label?: string;
}

/**
 * Create the core authentication middleware.
 *
 * The returned handler enforces Bearer token auth on every request it sees.
 * Mount it with `app.use(createAuthMiddleware(...))` before protected routers,
 * or attach it to individual routes that need protection.
 *
 * When `enabled: false`, the handler immediately calls `next()` — allowing
 * the infrastructure to land with the default-off feature flag without
 * breaking existing traffic.
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions): RequestHandler {
  const { store, enabled, label = 'console' } = options;
  const publicPaths = options.publicPathPrefixes ?? [];

  return (req: Request, res: Response, next: NextFunction) => {
    if (!enabled) {
      return next();
    }

    // Public path allowlist — skip auth for whitelisted prefixes.
    // Use originalUrl.pathname so we match regardless of mount point.
    const pathToCheck = req.originalUrl.split('?')[0];
    for (const prefix of publicPaths) {
      if (pathToCheck === prefix || pathToCheck.startsWith(prefix + '/')) {
        return next();
      }
    }

    const presented = extractToken(req);
    if (!presented) {
      return respondUnauthorized(res, 'missing_token', label, store);
    }

    const entry = store.verify(presented);
    if (!entry) {
      return respondUnauthorized(res, 'invalid_token', label, store);
    }

    // Stubbed authorization hook — Phase 2 flips real scope checks on here.
    if (!authorizeScope(entry, req)) {
      return respondForbidden(res, 'scope_denied', label, entry);
    }

    // Stash the matched entry for downstream handlers.
    res.locals.tokenEntry = entry;
    return next();
  };
}

/**
 * Scope authorization hook.
 *
 * Phase 1: every valid token is treated as admin — returns true unconditionally.
 * Phase 2: this function will check `entry.scopes` against the route's required
 * scopes (which can be attached via `res.locals.requiredScope` or a route
 * metadata system).
 */
function authorizeScope(_entry: ConsoleTokenEntry, _req: Request): boolean {
  return true;
}

/**
 * Respond with 401 Unauthorized and a helpful hint about where to find the token.
 */
function respondUnauthorized(
  res: Response,
  reason: 'missing_token' | 'invalid_token',
  label: string,
  store: ConsoleTokenStore,
): void {
  logger.debug(`[Auth:${label}] 401 ${reason}`);
  res.status(401).json({
    error: 'Authentication required',
    reason,
    hint: `Token file: ${store.getFilePath()}. Send 'Authorization: Bearer <token>' header, or append ?token=<token> for SSE streams.`,
  });
}

/**
 * Respond with 403 Forbidden — token was valid but scope did not permit this route.
 * Phase 1 never reaches here because `authorizeScope` always returns true, but
 * the code path exists so Phase 2 can wire it up without changing the middleware shape.
 */
function respondForbidden(
  res: Response,
  reason: string,
  label: string,
  entry: ConsoleTokenEntry,
): void {
  logger.debug(`[Auth:${label}] 403 ${reason}`, { tokenId: entry.id, scopes: entry.scopes });
  res.status(403).json({
    error: 'Token scope does not permit this action',
    reason,
  });
}
