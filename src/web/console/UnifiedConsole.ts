/**
 * Unified web console orchestrator.
 *
 * Ties together leader election, console startup, follower wiring,
 * and session lifecycle management. This is the main entry point
 * called by the DI container during deferred setup.
 *
 * Flow:
 * 1. Run leader election (read lock file, claim or follow)
 * 2. If leader: start web server on fixed port, mount ingest routes, start heartbeat
 * 3. If follower: register forwarding sinks with LogManager, start session heartbeat
 *
 * @since v2.1.0 — Issue #1700
 */

import type { UnifiedLogEntry } from '../../logging/types.js';
import type { MetricSnapshot } from '../../metrics/types.js';
import type { MemoryLogSink } from '../../logging/sinks/MemoryLogSink.js';
import type { MemoryMetricsSink } from '../../metrics/sinks/MemoryMetricsSink.js';
import { logger } from '../../utils/logger.js';
import {
  electLeader,
  startHeartbeat,
  registerLeaderCleanup,
  type ElectionResult,
} from './LeaderElection.js';
import { createIngestRoutes, type IngestRoutesResult } from './IngestRoutes.js';
import {
  LeaderForwardingLogSink,
  SessionHeartbeat,
} from './LeaderForwardingSink.js';

/** Fixed port for the unified console leader */
const CONSOLE_PORT = 3939;

/**
 * Options for starting the unified console.
 */
export interface UnifiedConsoleOptions {
  /** This process's unique session ID */
  sessionId: string;
  /** Portfolio base directory (for startWebServer) */
  portfolioDir: string;
  /** Log memory sink (for console history) */
  memorySink: MemoryLogSink;
  /** Metrics memory sink */
  metricsSink?: MemoryMetricsSink;
  /** MCP-AQL handler for permission routes (typed as any to avoid circular imports) */
  mcpAqlHandler?: any;
  /** Callback to register a log sink with the LogManager */
  registerLogSink: (sink: { write(entry: UnifiedLogEntry): void; flush(): Promise<void>; close(): Promise<void> }) => void;
  /** Callback to wire SSE broadcasts after web server starts */
  wireSSEBroadcasts: (webResult: { logBroadcast?: (entry: UnifiedLogEntry) => void; metricsOnSnapshot?: (snapshot: MetricSnapshot) => void }, metricsSink?: MemoryMetricsSink) => void;
}

/**
 * Result of starting the unified console.
 */
export interface UnifiedConsoleResult {
  role: 'leader' | 'follower';
  election: ElectionResult;
  /** Port the console is running on (leader only) */
  port?: number;
  /** Cleanup function to call on shutdown */
  cleanup: () => Promise<void>;
}

/**
 * Start the unified web console.
 *
 * Runs leader election, then either starts the full console (leader)
 * or sets up event forwarding (follower).
 */
export async function startUnifiedConsole(options: UnifiedConsoleOptions): Promise<UnifiedConsoleResult> {
  const election = await electLeader(options.sessionId, CONSOLE_PORT);

  if (election.role === 'leader') {
    return startAsLeader(options, election);
  } else {
    return startAsFollower(options, election);
  }
}

/**
 * Start as the console leader.
 * Binds port 3939, mounts all routes including ingestion, starts heartbeat.
 */
async function startAsLeader(
  options: UnifiedConsoleOptions,
  election: ElectionResult,
): Promise<UnifiedConsoleResult> {
  const { startWebServer } = await import('../server.js');

  // Pre-create a placeholder broadcast that we'll wire up after the server starts
  let liveBroadcast: ((entry: UnifiedLogEntry) => void) | undefined;
  let liveMetricsOnSnapshot: ((snapshot: MetricSnapshot) => void) | undefined;

  // Create ingestion routes with a deferred broadcast (wired after server starts)
  const ingestResult = createIngestRoutes({
    logBroadcast: (entry) => liveBroadcast?.(entry),
    metricsOnSnapshot: (snapshot) => liveMetricsOnSnapshot?.(snapshot),
  });

  // Register the leader as a session
  ingestResult.registerLeaderSession(options.sessionId, process.pid);

  // Start the web server with ingest routes mounted before the SPA fallback
  const webResult = await startWebServer({
    portfolioDir: options.portfolioDir,
    memorySink: options.memorySink,
    metricsSink: options.metricsSink,
    port: CONSOLE_PORT,
    additionalRouters: [ingestResult.router],
    ...(options.mcpAqlHandler ? { mcpAqlHandler: options.mcpAqlHandler } : {}),
  });

  // Wire SSE broadcasts for this leader's own events
  options.wireSSEBroadcasts(webResult, options.metricsSink);

  // Now wire the live broadcast functions into the ingest routes
  if (webResult.logBroadcast) {
    const originalBroadcast = webResult.logBroadcast;
    // Stamp leader's own entries with session ID
    liveBroadcast = (entry: UnifiedLogEntry) => {
      const stamped: UnifiedLogEntry = {
        ...entry,
        data: { ...entry.data, _sessionId: options.sessionId },
      };
      originalBroadcast(stamped);
    };
  }
  liveMetricsOnSnapshot = webResult.metricsOnSnapshot;

  logger.info('[UnifiedConsole] Ingestion routes mounted for follower event forwarding');

  // Start heartbeat and register cleanup
  const stopHeartbeat = startHeartbeat(election.leaderInfo);
  registerLeaderCleanup();

  logger.info(`[UnifiedConsole] Leader started: session=${options.sessionId} port=${CONSOLE_PORT}`);

  return {
    role: 'leader',
    election,
    port: CONSOLE_PORT,
    cleanup: async () => {
      stopHeartbeat();
    },
  };
}

/**
 * Start as a follower.
 * Registers forwarding sinks with the LogManager, starts session heartbeat.
 */
async function startAsFollower(
  options: UnifiedConsoleOptions,
  election: ElectionResult,
): Promise<UnifiedConsoleResult> {
  const leaderUrl = `http://127.0.0.1:${election.leaderInfo.port}`;

  // Register a forwarding log sink
  const forwardingSink = new LeaderForwardingLogSink(leaderUrl, options.sessionId);
  options.registerLogSink(forwardingSink);

  // Start session heartbeat to the leader
  const sessionHeartbeat = new SessionHeartbeat(leaderUrl, options.sessionId, process.pid);
  await sessionHeartbeat.start();

  logger.info(
    `[UnifiedConsole] Follower started: session=${options.sessionId} → leader=${election.leaderInfo.sessionId} port=${election.leaderInfo.port}`
  );

  return {
    role: 'follower',
    election,
    cleanup: async () => {
      await sessionHeartbeat.stop();
      await forwardingSink.close();
    },
  };
}
