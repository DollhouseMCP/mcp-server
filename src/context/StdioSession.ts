/**
 * Stdio Session Factory for DollhouseMCP
 *
 * Creates a SessionContext for stdio transport (the default MCP transport
 * used by Claude Desktop, Claude Code CLI, and local development).
 *
 * Environment variable sources:
 * - DOLLHOUSE_USER: userId (default: 'local-user')
 * - DOLLHOUSE_SESSION_ID: sessionId (default: 'default')
 *
 * The sessionId default 'default' matches existing ActivationStore behavior,
 * preserving the activations-default.json persistence file across restarts.
 *
 * @module context/StdioSession
 */

import type { SessionContext } from './SessionContext.js';

/**
 * Creates a frozen SessionContext for the current stdio session.
 *
 * Reads DOLLHOUSE_USER and DOLLHOUSE_SESSION_ID from the environment.
 * Falls back to 'local-user' and 'default' respectively when unset.
 *
 * @returns Frozen SessionContext for stdio transport
 */
export function createStdioSession(): Readonly<SessionContext> {
  const userId =
    process.env['DOLLHOUSE_USER']?.trim() || 'local-user';
  const sessionId =
    process.env['DOLLHOUSE_SESSION_ID']?.trim() || 'default';

  return Object.freeze<SessionContext>({
    userId,
    sessionId,
    tenantId: null,
    transport: 'stdio',
    createdAt: Date.now(),
  });
}
