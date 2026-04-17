/**
 * User Context Resolution for Database Operations
 *
 * Resolves the current user's database UUID at call time, not at DI
 * construction time. This is what enables multi-tenant HTTP transport:
 *
 *   - Every MCP tool call is already wrapped in ContextTracker.runAsync()
 *     (see src/server/ServerSetup.ts). The SessionContext carried in
 *     AsyncLocalStorage has a userId field.
 *   - Storage layers get a `UserIdResolver` callback instead of a frozen
 *     userId string. The callback reads the session's userId each time.
 *   - In stdio mode the session is static (one per process), so every call
 *     returns the same UUID. In HTTP mode each request's ContextTracker
 *     scope resolves to its own session's userId.
 *
 * The resolver treats an absent context as a fatal bug. That is intentional:
 * every DB operation MUST run inside a ContextTracker.runAsync scope (either
 * stdio's top-level session or an HTTP request handler). Falling back to a
 * "default user" would silently cross-contaminate tenants.
 *
 * @since v2.2.0 — Phase 4, Step 4.3
 */

import type { ContextTracker } from '../security/encryption/ContextTracker.js';
import { validateUserId } from '../state/db-persistence-utils.js';
import { logger } from '../utils/logger.js';

/**
 * Sentinel thrown when a DB operation runs outside any ContextTracker scope.
 * Kept as a small named class so MCP handlers can catch it and convert to a
 * generic client-facing error (no implementation details) while operators
 * still see the full diagnostic in logs.
 */
export class UserContextMissingError extends Error {
  readonly code = 'USER_CONTEXT_MISSING';
  constructor(message: string) {
    super(message);
    this.name = 'UserContextMissingError';
  }
}

/**
 * Function returning the current user's database UUID.
 *
 * Storage layers accept this callback in their constructor and call it on
 * every query. The indirection keeps the layer agnostic to WHERE the userId
 * lives (AsyncLocalStorage in production, a fixture in tests).
 */
export type UserIdResolver = () => string;

/**
 * Build a UserIdResolver that reads the current userId from the given
 * ContextTracker's SessionContext.
 *
 * Throws when called outside any ContextTracker scope, or when the active
 * session has an empty/invalid userId. This is loud by design — a silent
 * fallback would break tenant isolation.
 */
export function createUserIdResolver(contextTracker: ContextTracker): UserIdResolver {
  return () => {
    const session = contextTracker.getSessionContext();
    if (!session) {
      // Log the full diagnostic for operators — includes the architectural
      // reason and a hint for common root causes. The thrown error body is
      // deliberately terse so MCP handlers that surface it to clients don't
      // leak implementation details (OWASP A09:2021).
      logger.error(
        '[UserContext] No session context is active. Every database operation must run inside ' +
        'ContextTracker.runAsync() — the per-session scope that carries the user identity. ' +
        'In stdio transport this is wired at server setup time; in HTTP transport it is ' +
        'established per request. A missing context usually means the operation was invoked ' +
        'from a background task or a test harness that forgot to establish one.',
      );
      throw new UserContextMissingError('No active user context for database operation');
    }
    const userId = session.userId;
    validateUserId(userId);
    return userId;
  };
}
