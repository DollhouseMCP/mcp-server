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
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { logger } from '../../utils/logger.js';
import {
  electLeader,
  isLeaderWebConsoleReachable,
  forceClaimLeadership,
  startHeartbeat,
  registerLeaderCleanup,
  detectLegacyLeader,
  readLeaderLock,
  deleteLeaderLock,
  LOCK_VERSION,
  CONSOLE_PROTOCOL_VERSION,
  LEGACY_SERVER_VERSION,
  type ElectionResult,
  type ConsoleLeaderInfo,
} from './LeaderElection.js';
import { createIngestRoutes } from './IngestRoutes.js';
import {
  LeaderForwardingLogSink,
  SessionHeartbeat,
} from './LeaderForwardingSink.js';
import { PromotionManager } from './PromotionManager.js';
import { ConsoleTokenStore } from './consoleToken.js';
import { findPidOnPort } from './StaleProcessRecovery.js';
import { env } from '../../config/env.js';

/**
 * Default console port from the env var. Used as fallback when no port
 * is provided via config file or options. The resolution hierarchy is:
 *   1. options.port (from config file, resolved by the DI container)
 *   2. DOLLHOUSE_WEB_CONSOLE_PORT env var
 *   3. 41715 (hardcoded default in env.ts)
 */
const DEFAULT_CONSOLE_PORT = env.DOLLHOUSE_WEB_CONSOLE_PORT;
const LEGACY_CONSOLE_FALLBACK_PORT = 3939;
const SYNTHETIC_PORT_OWNER_SESSION_PREFIX = 'port-owner-';

function currentTimestamp(): string {
  return new Date().toISOString();
}

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
  /** Console port override from config file. Falls back to env var if not provided. */
  port?: number;
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
 * Check for a running legacy (pre-authentication) DollhouseMCP console and
 * log a WARN-level message if one is found (#1794).
 *
 * Extracted from `startUnifiedConsole` so the wiring can be integration-
 * tested in isolation without spinning up a full web server and leader
 * election. The implementation is fire-and-forget: detection failures
 * are logged at DEBUG and never propagate, because a failure here must
 * not block leader election of the authenticated console.
 *
 * @param currentPort - The port the authenticated console intends to
 *                      bind to. Used in the warning message to help the
 *                      user tell the two consoles apart.
 * @param detect      - Optional injection point for the detection
 *                      function. Defaults to `detectLegacyLeader`. Tests
 *                      pass a stub.
 * @param log         - Optional injection point for the logger. Defaults
 *                      to the module logger. Tests pass a spy.
 * @returns The legacy leader info from `detect()`, or null if detection
 *          threw. Exposed so tests can assert the full result shape.
 */
export async function warnIfLegacyConsolePresent(
  currentPort: number,
  detect: typeof detectLegacyLeader = detectLegacyLeader,
  log: typeof logger = logger,
): Promise<Awaited<ReturnType<typeof detectLegacyLeader>> | null> {
  try {
    const legacy = await detect();
    if (legacy.legacyRunning) {
      log.warn(
        `[UnifiedConsole] Legacy (pre-authentication) DollhouseMCP console detected ` +
        `(pid=${legacy.pid}, port=${legacy.port}). Both consoles will run ` +
        `independently on different ports with different security posture. ` +
        `The authenticated console (this process) uses port ${currentPort}; ` +
        `the legacy console uses port ${legacy.port ?? LEGACY_CONSOLE_FALLBACK_PORT}. ` +
        `For consistent security, update the legacy installation to a ` +
        `version with the authenticated console.`,
      );
    }
    return legacy;
  } catch (err) {
    // Best-effort — never block election on a detection failure
    log.debug('[UnifiedConsole] Legacy leader detection failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

interface SessionApiRecord {
  sessionId: string;
  pid: number;
  startedAt?: string;
  lastHeartbeat?: string;
  status?: string;
  isLeader?: boolean;
  kind?: string;
  serverVersion?: string;
  consoleProtocolVersion?: number;
}

export interface PortLeaderDiscovery {
  leaderInfo: ConsoleLeaderInfo | null;
  ownerPid: number | null;
  source: 'api' | 'lock' | 'synthetic' | 'none';
}

export interface BindFailureRecoveryResult extends PortLeaderDiscovery {
  lockCleanupAttempted: boolean;
  lockCleanupPerformed: boolean;
}

interface DiscoveryDependencies {
  fetchImpl?: typeof fetch;
  findPidOnPortImpl?: typeof findPidOnPort;
  readLeaderLockImpl?: typeof readLeaderLock;
}

export async function discoverLeaderServingPort(
  port: number,
  authToken: string | null,
  deps: DiscoveryDependencies = {},
): Promise<PortLeaderDiscovery> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const findPidOnPortImpl = deps.findPidOnPortImpl ?? findPidOnPort;
  const readLeaderLockImpl = deps.readLeaderLockImpl ?? readLeaderLock;
  const ownerPid = await findPidOnPortImpl(port);

  if (ownerPid !== null) {
    try {
      const headers: Record<string, string> = {};
      if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
      }
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/sessions`, { headers });
      if (response.ok) {
        const payload = await response.json() as { sessions?: SessionApiRecord[] };
        const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        const leaderSession = sessions.find((session) =>
          session.pid === ownerPid &&
          session.isLeader === true &&
          session.kind === 'mcp' &&
          session.status !== 'stopped'
        );
        if (leaderSession) {
          const normalizedSessionId = UnicodeValidator.normalize(leaderSession.sessionId).normalizedContent;
          return {
            ownerPid,
            source: 'api',
            leaderInfo: {
              version: LOCK_VERSION,
              pid: ownerPid,
              port,
              sessionId: normalizedSessionId,
              startedAt: leaderSession.startedAt ?? currentTimestamp(),
              heartbeat: leaderSession.lastHeartbeat ?? currentTimestamp(),
              serverVersion: leaderSession.serverVersion ?? LEGACY_SERVER_VERSION,
              consoleProtocolVersion: leaderSession.consoleProtocolVersion ?? CONSOLE_PROTOCOL_VERSION,
            },
          };
        }
      }
    } catch (err) {
      logger.debug('[UnifiedConsole] Failed to query active leader sessions', {
        port,
        ownerPid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const lock = await readLeaderLockImpl();
  if (lock && lock.port === port && (ownerPid === null || lock.pid === ownerPid)) {
    return {
      ownerPid: ownerPid ?? lock.pid,
      source: 'lock',
      leaderInfo: {
        ...lock,
        sessionId: UnicodeValidator.normalize(lock.sessionId).normalizedContent,
      },
    };
  }

  if (ownerPid !== null) {
    const now = currentTimestamp();
    return {
      ownerPid,
      source: 'synthetic',
      leaderInfo: {
        version: LOCK_VERSION,
        pid: ownerPid,
        port,
        sessionId: `${SYNTHETIC_PORT_OWNER_SESSION_PREFIX}${ownerPid}`,
        startedAt: now,
        heartbeat: now,
        serverVersion: LEGACY_SERVER_VERSION,
        consoleProtocolVersion: CONSOLE_PROTOCOL_VERSION,
      },
    };
  }

  return { leaderInfo: null, ownerPid: null, source: 'none' };
}

interface BindFailureRecoveryDependencies extends DiscoveryDependencies {
  deleteLeaderLockImpl?: typeof deleteLeaderLock;
}

export async function recoverLeaderBindFailure(
  provisionalLeader: ConsoleLeaderInfo,
  port: number,
  authToken: string | null,
  deps: BindFailureRecoveryDependencies = {},
): Promise<BindFailureRecoveryResult> {
  const readLeaderLockImpl = deps.readLeaderLockImpl ?? readLeaderLock;
  const deleteLeaderLockImpl = deps.deleteLeaderLockImpl ?? deleteLeaderLock;
  logger.info('[UnifiedConsole] Leader bind recovery initiated', {
    provisionalSessionId: provisionalLeader.sessionId,
    provisionalPid: provisionalLeader.pid,
    port,
  });

  let fallback = await discoverLeaderServingPort(port, authToken, deps);
  let lockCleanupAttempted = false;
  let lockCleanupPerformed = false;
  const currentLock = await readLeaderLockImpl();
  const provisionalLockMatches = Boolean(
    currentLock &&
    currentLock.pid === provisionalLeader.pid &&
    currentLock.port === provisionalLeader.port &&
    currentLock.sessionId === provisionalLeader.sessionId,
  );
  const fallbackPointsToProvisionalLeader = Boolean(
    fallback.leaderInfo &&
    fallback.leaderInfo.pid === provisionalLeader.pid &&
    fallback.leaderInfo.port === provisionalLeader.port &&
    fallback.leaderInfo.sessionId === provisionalLeader.sessionId,
  );

  if (provisionalLockMatches) {
    lockCleanupAttempted = true;
    await deleteLeaderLockImpl();
    lockCleanupPerformed = true;
    logger.info('[UnifiedConsole] Removed provisional leader lock after bind failure', {
      provisionalSessionId: provisionalLeader.sessionId,
      provisionalPid: provisionalLeader.pid,
      port,
    });
    if (fallbackPointsToProvisionalLeader) {
      fallback = await discoverLeaderServingPort(port, authToken, deps);
    }
  }

  logger.info('[UnifiedConsole] Leader bind recovery completed', {
    provisionalSessionId: provisionalLeader.sessionId,
    provisionalPid: provisionalLeader.pid,
    port,
    discoverySource: fallback.source,
    ownerPid: fallback.ownerPid,
    lockCleanupAttempted,
    lockCleanupPerformed,
  });

  return {
    ...fallback,
    lockCleanupAttempted,
    lockCleanupPerformed,
  };
}

/**
 * Start the unified web console.
 *
 * Runs leader election, then either starts the full console (leader)
 * or sets up event forwarding (follower).
 */
export async function startUnifiedConsole(options: UnifiedConsoleOptions): Promise<UnifiedConsoleResult> {
  // Resolve port: options (config file) → env var → default
  const consolePort = options.port || DEFAULT_CONSOLE_PORT;
  logger.debug(`[UnifiedConsole] Port resolved: ${consolePort}` +
    (options.port ? ' (from config file)' : ` (from env/default)`));

  // Legacy-leader detection (#1794) — warn the user if a pre-auth
  // DollhouseMCP console is running alongside this authenticated one.
  // They will coexist fine because of port + lock + token file isolation,
  // but the user should know both exist so the differing security posture
  // between them doesn't look like a bug.
  await warnIfLegacyConsolePresent(consolePort);

  let election = await electLeader(options.sessionId, consolePort);

  // If we lost the election, check if the leader is actually running a web console.
  // An MCP stdio process may hold leadership but not serve web routes.
  // In that case, force a takeover so the web console works properly.
  if (election.role === 'follower') {
    const reachable = await isLeaderWebConsoleReachable(election.leaderInfo);
    if (!reachable) {
      election = await forceClaimLeadership(options.sessionId, consolePort);
    }
  }

  if (election.role === 'leader') {
    return startAsLeader(options, election, consolePort);
  } else {
    return startAsFollower(options, election, consolePort);
  }
}

/**
 * Start as the console leader.
 * Binds the resolved console port (config file → env var → default),
 * mounts all routes including ingestion, starts heartbeat.
 */
async function startAsLeader(
  options: UnifiedConsoleOptions,
  election: ElectionResult,
  consolePort: number = DEFAULT_CONSOLE_PORT,
): Promise<UnifiedConsoleResult> {
  const { startWebServer } = await import('../server.js');
  const { pickRandomTokenName } = await import('./SessionNames.js');

  // Initialize the console token store (#1780). Creates the token file on
  // first run, reads the existing tokens on subsequent runs. The token is
  // persistent across restarts — only rotated on explicit request (Phase 2).
  // Feature flag DOLLHOUSE_WEB_AUTH_ENABLED controls enforcement; the file
  // is generated regardless so consumers can attach tokens preemptively.
  const tokenStore = new ConsoleTokenStore(env.DOLLHOUSE_CONSOLE_TOKEN_FILE);
  const primaryToken = await tokenStore.ensureInitialized(pickRandomTokenName());
  logger.info('[UnifiedConsole] Console token store initialized', {
    tokenId: primaryToken.id,
    tokenName: primaryToken.name,
    file: tokenStore.getFilePath(),
    authEnforced: env.DOLLHOUSE_WEB_AUTH_ENABLED,
  });

  // Pre-create a placeholder broadcast that we'll wire up after the server starts
  let liveBroadcast: ((entry: UnifiedLogEntry) => void) | undefined;
  let liveMetricsOnSnapshot: ((snapshot: MetricSnapshot) => void) | undefined;

  // Create ingestion routes with a deferred broadcast (wired after server starts)
  const ingestResult = createIngestRoutes({
    logBroadcast: (entry) => liveBroadcast?.(entry),
    metricsOnSnapshot: (snapshot) => liveMetricsOnSnapshot?.(snapshot),
    storeMetricsSnapshot: (snapshot) => options.metricsSink?.onSnapshot(snapshot),
  });

  // Start the web server with ingest routes mounted before the SPA fallback.
  // If the port is occupied by a stale process, retry with exponential backoff.
  const serverOpts = {
    portfolioDir: options.portfolioDir,
    memorySink: options.memorySink,
    metricsSink: options.metricsSink,
    port: consolePort,
    additionalRouters: [ingestResult.router],
    tokenStore,
    ...(options.mcpAqlHandler ? { mcpAqlHandler: options.mcpAqlHandler } : {}),
  };
  // bindAndListen now handles EADDRINUSE by finding and killing the stale
  // process on the port, then retrying. No external retry loop needed.
  const webResult = await startWebServer(serverOpts);

  if (webResult.bindResult && !webResult.bindResult.success) {
    const fallback = await recoverLeaderBindFailure(election.leaderInfo, consolePort, primaryToken.token);
    if (fallback.leaderInfo) {
      logger.warn('[UnifiedConsole] Leader role aborted: bind failed, falling back to follower', {
        port: consolePort,
        bindError: webResult.bindResult.error,
        bindDetail: webResult.bindResult.detail,
        provisionalLeaderPid: election.leaderInfo.pid,
        provisionalLeaderSessionId: election.leaderInfo.sessionId,
        ownerPid: fallback.ownerPid,
        source: fallback.source,
        lockCleanupAttempted: fallback.lockCleanupAttempted,
        lockCleanupPerformed: fallback.lockCleanupPerformed,
      });
      const followerElection: ElectionResult = { role: 'follower', leaderInfo: fallback.leaderInfo };
      return startAsFollower(options, followerElection, consolePort, primaryToken.token);
    }

    logger.error('[UnifiedConsole] Leader failed to bind and no active leader could be identified', {
      port: consolePort,
      provisionalLeaderPid: election.leaderInfo.pid,
      bindError: webResult.bindResult.error,
      bindDetail: webResult.bindResult.detail,
    });
    throw new Error(`Leader failed to bind port ${consolePort} and no active leader was discoverable`);
  }

  // Register the leader only after the HTTP listener is actually serving the port.
  ingestResult.registerLeaderSession(options.sessionId, process.pid);

  // Register the web console itself so the session indicator is never empty (#1805)
  ingestResult.registerConsoleSession();

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

  logger.info('[UnifiedConsole] Ingestion routes mounted');

  // Start heartbeat and register cleanup
  const stopHeartbeat = startHeartbeat(election.leaderInfo);
  registerLeaderCleanup();

  logger.info('[UnifiedConsole] Leader started', {
    sessionId: options.sessionId, port: consolePort, pid: process.pid,
    role: 'leader', ingestRoutes: ['/api/ingest/logs', '/api/ingest/metrics', '/api/ingest/session', '/api/sessions'],
  });

  return {
    role: 'leader',
    election,
    port: consolePort,
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
  consolePort: number = DEFAULT_CONSOLE_PORT,
  initialAuthToken?: string | null,
): Promise<UnifiedConsoleResult> {
  const leaderUrl = `http://127.0.0.1:${election.leaderInfo.port}`;

  // Read the console auth token (#1780) written by the leader. May be null
  // if the file doesn't exist yet — the sinks handle that gracefully and
  // simply omit the Bearer header, which is fine when auth is not enforced.
  let authToken = initialAuthToken ?? null;
  if (authToken === null || authToken === undefined) {
    const { getPrimaryTokenFromFile } = await import('./consoleToken.js');
    authToken = await getPrimaryTokenFromFile(env.DOLLHOUSE_CONSOLE_TOKEN_FILE);
  }
  if (authToken) {
    logger.debug('[UnifiedConsole] Follower loaded console auth token');
  } else {
    logger.debug('[UnifiedConsole] No console auth token file found; follower will POST without Bearer header');
  }

  // Per-instance promotion manager — tracks its own attempt counter so
  // multiple followers don't interfere with each other's promotion budgets.
  const promotionMgr = new PromotionManager(options, consolePort, startAsLeader, startAsFollower);

  // Declare sessionHeartbeat before the sink so the closure can capture it.
  // Both are initialized before the callback could possibly fire (needs 5+ failed flushes).
  let sessionHeartbeat: SessionHeartbeat;

  // Register a forwarding log sink with leader-death callback (#1850).
  const forwardingSink = new LeaderForwardingLogSink(leaderUrl, options.sessionId, authToken, () => {
    promotionMgr.promote(forwardingSink, sessionHeartbeat)
      .catch(err => logger.error('[UnifiedConsole] Promotion crashed', { error: String(err) }));
  });
  options.registerLogSink(forwardingSink);

  // Start session heartbeat to the leader
  sessionHeartbeat = new SessionHeartbeat(leaderUrl, options.sessionId, process.pid, authToken);
  await sessionHeartbeat.start();

  logger.info('[UnifiedConsole] Follower started', {
    sessionId: options.sessionId, pid: process.pid, role: 'follower',
    leaderSession: election.leaderInfo.sessionId, leaderPid: election.leaderInfo.pid,
    leaderPort: election.leaderInfo.port, leaderUrl,
  });

  return {
    role: 'follower',
    election,
    cleanup: async () => {
      await sessionHeartbeat.stop();
      await forwardingSink.close();
    },
  };
}
