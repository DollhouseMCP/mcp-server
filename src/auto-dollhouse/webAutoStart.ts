/**
 * auto-dollhouse#5: Automatic web server startup for agentic sessions.
 *
 * Extracted from index.ts deferred setup. Starts the HTTP permission
 * evaluation server after portfolio indexing completes, so PreToolUse
 * hooks have an endpoint to call immediately.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { findAvailablePort, writePortFile, registerPortCleanup } from './portDiscovery.js';
import { logger } from '../utils/logger.js';
import type { MCPAQLHandler } from '../handlers/mcp-aql/MCPAQLHandler.js';

/**
 * Start the web server with dynamic port allocation and port file discovery.
 * Called after deferred setup completes to ensure portfolio is indexed.
 */
export async function startPermissionServer(mcpAqlHandler: MCPAQLHandler): Promise<void> {
  try {
    const portfolioDir = path.join(os.homedir(), '.dollhouse', 'portfolio');

    // Find an available port (handles concurrent sessions)
    const port = await findAvailablePort(3939);

    // Start the web server
    const { startWebServer } = await import('../web/server.js');
    await startWebServer({ portfolioDir, port, openBrowser: false, mcpAqlHandler });

    // Write port file for PreToolUse hook discovery
    await writePortFile(port);
    registerPortCleanup();

    logger.info(`[auto-dollhouse] Permission evaluation HTTP server started on port ${port}`);
  } catch (err) {
    logger.warn('[auto-dollhouse] Permission HTTP server failed to start (non-fatal):', err);
  }
}
