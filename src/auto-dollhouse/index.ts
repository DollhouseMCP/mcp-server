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
 * Waits for deferred setup to complete, then starts the web console
 * with permission routes, log viewer, and metrics dashboard.
 */
export async function registerAutoDollhouse(options: {
  deferredSetupPromise: Promise<void>;
  resolveHandler: () => unknown;
  resolveService: (name: string) => unknown;
}): Promise<void> {
  logger.info('[auto-dollhouse] Registering fork-only extensions');

  // Wait for deferred setup (portfolio indexing) before starting the web server
  try {
    await options.deferredSetupPromise;
  } catch (err) {
    logger.error('[auto-dollhouse] Deferred setup failed, starting web server anyway:', err);
  }

  logger.info('[auto-dollhouse] Deferred setup complete, starting web console');

  try {
    const { startPermissionServer } = await import('./webAutoStart.js');
    const handler = options.resolveHandler();

    // Resolve optional sinks for log/metrics routes
    let memorySink: unknown;
    let metricsSink: unknown;
    try { memorySink = options.resolveService('MemoryLogSink'); } catch { logger.warn('[auto-dollhouse] MemoryLogSink not available'); }
    try { metricsSink = options.resolveService('MemoryMetricsSink'); } catch { logger.warn('[auto-dollhouse] MemoryMetricsSink not available'); }

    logger.info(`[auto-dollhouse] Sinks resolved: logs=${!!memorySink}, metrics=${!!metricsSink}`);

    await startPermissionServer(
      handler as import('../handlers/mcp-aql/MCPAQLHandler.js').MCPAQLHandler,
      memorySink,
      metricsSink,
      options.resolveService,
    );
  } catch (err) {
    logger.error('[auto-dollhouse] Permission server startup FAILED:', err);
  }
}
