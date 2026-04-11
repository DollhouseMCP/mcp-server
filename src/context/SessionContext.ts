/**
 * Session Context for DollhouseMCP
 *
 * Provides identity and transport information for the current MCP session.
 * Used by ContextTracker to associate execution contexts with authenticated
 * sessions, enabling per-user audit trails and future multi-tenant support.
 *
 * All fields are readonly. Instances are Object.freeze()'d at creation time
 * by ContextTracker.createSessionContext() and StdioSession.createStdioSession().
 *
 * @module context/SessionContext
 */

/**
 * Immutable identity and transport metadata for an MCP session.
 *
 * Created once at session initialization and propagated via AsyncLocalStorage
 * through ContextTracker.
 */
export interface SessionContext {
  /** Stable user identifier. 'local-user' for stdio, JWT sub for HTTP. */
  readonly userId: string;

  /** Per-session correlation ID. 'default' for stdio, UUID for HTTP. */
  readonly sessionId: string;

  /**
   * Tenant identifier for multi-tenant HTTP deployments.
   * Always null for stdio transport and single-tenant deployments.
   */
  readonly tenantId: string | null;

  /** Transport layer this session is running over. */
  readonly transport: 'stdio' | 'http';

  /** Unix timestamp (ms) when the session was created. */
  readonly createdAt: number;

  /** Human-readable display name, if available. */
  readonly displayName?: string;

  /** Email address, if available from auth provider. */
  readonly email?: string;
}

/**
 * Resolves a SessionContext for an incoming MCP request.
 *
 * For stdio transport: a constant function returning the single stdio session.
 * For HTTP transport (future): extracts session from authenticated connection metadata.
 *
 * The parameter type uses `unknown` rather than a concrete MCP SDK type to keep
 * the context module free of MCP SDK dependencies.
 */
export type SessionResolver = (request: unknown) => SessionContext;
