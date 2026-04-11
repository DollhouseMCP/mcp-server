/**
 * Context Policy Helpers for DollhouseMCP
 *
 * Provides safe access patterns for SessionContext throughout the codebase.
 * Consumers should prefer getSessionOrSystem() for non-critical paths and
 * requireSessionContext() (via ContextTracker) for paths that must have a
 * real session.
 *
 * STRICT MODE: When NODE_ENV !== 'production' OR DOLLHOUSE_STRICT_CONTEXT
 * is 'true', getSessionOrSystem() emits a warning when it falls back to
 * SYSTEM_CONTEXT. This helps detect missing session wiring during development
 * without breaking production behaviour.
 *
 * @module context/ContextPolicy
 */

import type { SessionContext } from './SessionContext.js';
import type { ContextTracker } from '../security/encryption/ContextTracker.js';
import { logger } from '../utils/logger.js';

/**
 * Sentinel SessionContext used when no real session is active.
 *
 * Represents an internal system operation with no user identity.
 * Returned by getSessionOrSystem() when called outside a session context.
 */
export const SYSTEM_CONTEXT: Readonly<SessionContext> = Object.freeze({
  userId: 'system',
  sessionId: 'system',
  tenantId: null,
  transport: 'stdio' as const,
  createdAt: 0,
});

/**
 * Thrown by ContextTracker.requireSessionContext() when called outside
 * an active session context.
 */
export class SessionContextRequiredError extends Error {
  /** Caller name provided at construction, if any. */
  public readonly caller: string | undefined;

  /**
   * @param caller - Optional caller identifier for debugging (e.g. 'PersonaManager.activate')
   */
  constructor(caller?: string) {
    const detail = caller ? ` (called from: ${caller})` : '';
    super(`SessionContext required but no session is active${detail}`);
    this.name = 'SessionContextRequiredError';
    this.caller = caller;
  }
}

/**
 * Determines whether strict context checking is active.
 *
 * Strict mode is enabled in all non-production environments and
 * in production when DOLLHOUSE_STRICT_CONTEXT=true is explicitly set.
 *
 * @returns true when strict mode warnings should be emitted
 */
export function isStrictMode(): boolean {
  return (
    process.env['NODE_ENV'] !== 'production' ||
    process.env['DOLLHOUSE_STRICT_CONTEXT'] === 'true'
  );
}

/**
 * Returns the current SessionContext from the tracker, or SYSTEM_CONTEXT
 * if no session is active.
 *
 * In strict mode, emits a warning when falling back to SYSTEM_CONTEXT so
 * that missing session wiring is visible during development.
 *
 * @param tracker - The ContextTracker instance to query
 * @param caller - Optional caller name for warning messages
 * @returns The active SessionContext, or SYSTEM_CONTEXT as fallback
 */
export function getSessionOrSystem(
  tracker: ContextTracker,
  caller?: string
): SessionContext {
  const session = tracker.getSessionContext();
  if (session !== undefined) {
    return session;
  }

  if (isStrictMode()) {
    const callerInfo = caller ? ` [${caller}]` : '';
    logger.warn(
      `[ContextPolicy]${callerInfo} No SessionContext active — falling back to SYSTEM_CONTEXT`
    );
  }

  return SYSTEM_CONTEXT;
}
