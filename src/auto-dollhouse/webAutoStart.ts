/**
 * auto-dollhouse#5: Automatic web server startup for agentic sessions.
 *
 * Extracted from index.ts deferred setup. Starts the HTTP permission
 * evaluation server after portfolio indexing completes, so PreToolUse
 * hooks have an endpoint to call immediately.
 *
 * Wires up Todd's log viewer SSE and metrics dashboard by registering
 * WebSSELogSink and WebSSEMetricsSink with the respective managers,
 * mirroring the Container.deferredWebConsole() pattern.
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
export async function startPermissionServer(
  mcpAqlHandler: MCPAQLHandler,
  memorySink?: unknown,
  metricsSink?: unknown,
  resolveService?: (name: string) => unknown,
): Promise<void> {
  try {
    const portfolioDir = path.join(os.homedir(), '.dollhouse', 'portfolio');

    // Find an available port (handles concurrent sessions)
    const port = await findAvailablePort(3939);

    // Start the web server with all available sinks
    const { startWebServer } = await import('../web/server.js');
    const result = await startWebServer({
      portfolioDir,
      port,
      openBrowser: false,
      mcpAqlHandler,
      memorySink: memorySink as any,
      metricsSink: metricsSink as any,
    });

    // Wire up SSE broadcast sinks (mirrors Container.deferredWebConsole pattern)
    if (result?.logBroadcast && resolveService) {
      try {
        const { WebSSELogSink } = await import('../web/sinks/WebSSELogSink.js');
        const { LogManager } = await import('../logging/LogManager.js');
        const logManager = resolveService('LogManager') as InstanceType<typeof LogManager>;
        logManager.registerSink(new WebSSELogSink(result.logBroadcast));
        logger.debug('[auto-dollhouse] Log SSE broadcast sink registered');
      } catch (err) {
        logger.debug('[auto-dollhouse] Log SSE sink not available:', err);
      }
    }

    if (result?.metricsOnSnapshot && metricsSink && resolveService) {
      try {
        const { WebSSEMetricsSink } = await import('../web/sinks/WebSSEMetricsSink.js');
        const { MetricsManager } = await import('../metrics/MetricsManager.js');
        const metricsManager = resolveService('MetricsManager') as InstanceType<typeof MetricsManager>;
        metricsManager.registerSink(new WebSSEMetricsSink(result.metricsOnSnapshot));
        logger.debug('[auto-dollhouse] Metrics SSE broadcast sink registered');
      } catch (err) {
        logger.debug('[auto-dollhouse] Metrics SSE sink not available:', err);
      }
    }

    // Write port file for PreToolUse hook discovery
    await writePortFile(port);
    registerPortCleanup();

    logger.info(`[auto-dollhouse] Permission evaluation HTTP server started on port ${port}`);
  } catch (err) {
    logger.warn('[auto-dollhouse] Permission HTTP server failed to start (non-fatal):', err);
  }
}
