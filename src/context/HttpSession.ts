/**
 * HTTP Session Factory for DollhouseMCP
 *
 * Creates a SessionContext for Streamable HTTP transport sessions.
 * Each HTTP session gets a unique UUID sessionId for correlation across
 * the request lifecycle.
 *
 * Phase 2: userId defaults to 'http-user' (single-user identity).
 * Phase 3 will wire JWT authentication to populate userId, tenantId,
 * displayName, and email from the auth provider.
 *
 * @module context/HttpSession
 */

import { randomUUID } from 'node:crypto';
import type { SessionContext } from './SessionContext.js';

/**
 * Default userId for HTTP sessions when no authentication is configured.
 * Phase 3 replaces this with JWT-derived identity.
 */
export const HTTP_DEFAULT_USER_ID = 'http-user';

/**
 * Options for creating an HTTP session context.
 * All fields are optional — defaults produce a valid single-user session.
 */
export interface HttpSessionOptions {
  /** User identifier from auth provider. Default: 'http-user'. */
  userId?: string;
  /** Tenant identifier for multi-tenant deployments. Default: null. */
  tenantId?: string | null;
  /** Human-readable display name from auth provider. */
  displayName?: string;
  /** Email address from auth provider. */
  email?: string;
}

/**
 * Creates a frozen SessionContext for a new HTTP session.
 *
 * Each call generates a unique sessionId (UUID v4) for request correlation,
 * logging attribution, and session lifecycle tracking.
 *
 * @param options - Optional identity fields from authentication
 * @returns Frozen SessionContext for HTTP transport
 */
export function createHttpSession(options: HttpSessionOptions = {}): Readonly<SessionContext> {
  return Object.freeze<SessionContext>({
    userId: options.userId ?? HTTP_DEFAULT_USER_ID,
    sessionId: randomUUID(),
    tenantId: options.tenantId ?? null,
    transport: 'http',
    createdAt: Date.now(),
    displayName: options.displayName,
    email: options.email,
  });
}
