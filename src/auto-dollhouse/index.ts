/**
 * Auto-Dollhouse Registration Entry Point
 *
 * Conditional registration of all fork-only features. Called from src/index.ts
 * when running in auto-dollhouse mode (DOLLHOUSE_AUTONOMOUS_MODE env var or
 * .auto-dollhouse marker file).
 *
 * This module wires up:
 * - evaluate_permission MCP-AQL operation (route + schema + handler)
 * - Permission evaluation HTTP routes (POST /evaluate_permission, GET /permissions/status)
 * - Web server auto-start with dynamic port discovery
 * - Permissions dashboard assets (served via static file overlay)
 *
 * @see https://github.com/DollhouseMCP/auto-dollhouse/issues/8
 */

import { logger } from '../utils/logger.js';

/**
 * Register all auto-dollhouse extensions.
 *
 * @param options.deferredSetupPromise - Promise that resolves when deferred setup (indexing) completes
 * @param options.resolveHandler - Function to resolve MCPAQLHandler from the DI container
 */
export async function registerAutoDollhouse(options: {
  deferredSetupPromise: Promise<void>;
  resolveHandler: () => unknown;
}): Promise<void> {
  logger.info('[auto-dollhouse] Registering fork-only extensions');

  // Start the permission server after deferred setup completes
  // (portfolio must be indexed before evaluate_permission can query active elements)
  options.deferredSetupPromise.then(async () => {
    try {
      const { startPermissionServer } = await import('./webAutoStart.js');
      const handler = options.resolveHandler();
      await startPermissionServer(handler as import('../handlers/mcp-aql/MCPAQLHandler.js').MCPAQLHandler);
    } catch (err) {
      logger.warn('[auto-dollhouse] Permission server startup failed (non-fatal):', err);
    }
  }).catch(() => { /* deferred setup error already logged */ });

  logger.info('[auto-dollhouse] Extensions registered');
}
