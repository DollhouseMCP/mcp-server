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
 * Default userId when DOLLHOUSE_USER is not set.
 * Used by identity migration (Step 1.5) to distinguish default stdio sessions
 * from sessions with explicitly-set identity. Temporary — removed in Phase 3
 * when SessionContext becomes the sole identity authority.
 */
export const STDIO_DEFAULT_USER_ID = 'local-user';

/**
 * Creates a frozen SessionContext for the current stdio session.
 *
 * Reads DOLLHOUSE_USER and DOLLHOUSE_SESSION_ID from the environment.
 * Falls back to STDIO_DEFAULT_USER_ID and 'default' respectively when unset.
 *
 * @returns Frozen SessionContext for stdio transport
 */
export function createStdioSession(): Readonly<SessionContext> {
  const userId =
    process.env['DOLLHOUSE_USER']?.trim() || STDIO_DEFAULT_USER_ID;
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
