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
import type { WebServerOptions, WebServerResult } from '../server.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { logger } from '../../utils/logger.js';
import type { MCPAQLHandler } from '../../handlers/mcp-aql/MCPAQLHandler.js';
import {
  electLeader,
  isLeaderWebConsoleReachable,
  forceClaimLeadership,
  startHeartbeat,
  registerLeaderCleanup,
  detectLegacyLeader,
  readLeaderLock,
  deleteLeaderLock,
  claimLeadership,
  createLeaderInfo,
  LOCK_VERSION,
  CONSOLE_PROTOCOL_VERSION,
  LEGACY_SERVER_VERSION,
  evaluateLeaderPreference,
  type ElectionResult,
  type ConsoleLeaderInfo,
  type LeaderPreferenceDecision,
} from './LeaderElection.js';
import { createIngestRoutes } from './IngestRoutes.js';
import {
  LeaderForwardingLogSink,
  SessionLeaseState,
  SessionHeartbeat,
} from './LeaderForwardingSink.js';
import { PromotionManager } from './PromotionManager.js';
import { ConsoleTokenStore } from './consoleToken.js';
import {
  findPidOnPort,
} from './StaleProcessRecovery.js';
import { env } from '../../config/env.js';
import type {
  ConsoleLeadershipHandoffDecision,
  SessionInfo,
} from './IngestRoutes.js';

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
const LEADER_DISCOVERY_TIMEOUT_MS = env.DOLLHOUSE_CONSOLE_LEADER_DISCOVERY_TIMEOUT_MS;
const LEADER_LEASE_RECONCILE_INTERVAL_MS = 2_000;
const LEADER_LEASE_RECONCILE_MAX_INTERVAL_MS = 30_000;
const LEADER_HANDOFF_REQUEST_TIMEOUT_MS = 2_000;
const LEADER_HANDOFF_RELEASE_WAIT_MS = 5_000;
const LEADER_HANDOFF_RELEASE_POLL_MS = 100;
const FOLLOWER_AUTHORITY_MONITOR_CONFIG = {
  intervalMs: env.DOLLHOUSE_CONSOLE_AUTHORITY_RECHECK_MS,
  jitterMs: env.DOLLHOUSE_CONSOLE_AUTHORITY_RECHECK_JITTER_MS,
  failureThreshold: env.DOLLHOUSE_CONSOLE_AUTHORITY_RECHECK_FAILURE_THRESHOLD,
  failureCooldownMs: env.DOLLHOUSE_CONSOLE_AUTHORITY_RECHECK_FAILURE_COOLDOWN_MS,
} as const;

function currentTimestamp(): string {
  return new Date().toISOString();
}

function computeFollowerAuthorityRecheckInterval(sessionId: string): number {
  const normalizedSessionId = UnicodeValidator.normalize(sessionId).normalizedContent;
  let hash = 0;
  for (let index = 0; index < normalizedSessionId.length; index += 1) {
    const codePoint = normalizedSessionId.codePointAt(index) ?? 0;
    hash = (hash * 31 + codePoint) >>> 0;
    if (codePoint > 0xffff) {
      index += 1;
    }
  }
  return FOLLOWER_AUTHORITY_MONITOR_CONFIG.intervalMs + (hash % (FOLLOWER_AUTHORITY_MONITOR_CONFIG.jitterMs + 1));
}

/**
 * Options for starting the unified console.
 */
export interface UnifiedConsoleOptions {
  /** This process's unique session ID */
  sessionId: string;
  /** Stable Dollhouse session identity shown to humans and used for persistence. */
  stableSessionId: string;
  /** Portfolio base directory (for startWebServer) */
  portfolioDir: string;
  /** Log memory sink (for console history) */
  memorySink: MemoryLogSink;
  /** Metrics memory sink */
  metricsSink?: MemoryMetricsSink;
  /** MCP-AQL handler for permission and gateway routes when the console is leader. */
  mcpAqlHandler?: MCPAQLHandler;
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

export interface PortOwnerReplacementDecision {
  shouldEvict: boolean;
  ownerPid: number | null;
  preference: LeaderPreferenceDecision | null;
}

interface ForceTakeoverAttemptResult {
  webResult: WebServerResult;
  election: ElectionResult;
  fallback: PortLeaderDiscovery;
  replacement: PortOwnerReplacementDecision;
  recoveredSessions: SessionInfo[];
  handoff: ConsoleLeadershipHandoffDecision | null;
  takeoverAttempted: boolean;
  reboundLockClaimed: boolean;
}

interface FollowerAuthorityResolution {
  election: ElectionResult;
  discovery: PortLeaderDiscovery | null;
  replacement: PortOwnerReplacementDecision | null;
  forcedClaim: boolean;
}

interface LeaderPreflightResolution {
  election: ElectionResult;
  discovery: PortLeaderDiscovery | null;
  replacement: PortOwnerReplacementDecision | null;
  demotedToFollower: boolean;
}

interface FollowerAuthorityDependencies {
  isLeaderWebConsoleReachableImpl?: typeof isLeaderWebConsoleReachable;
  discoverLeaderServingPortImpl?: typeof discoverLeaderServingPort;
  forceClaimLeadershipImpl?: typeof forceClaimLeadership;
  deleteLeaderLockImpl?: typeof deleteLeaderLock;
}

interface LeaderPreflightDependencies extends DiscoveryDependencies {
  discoverLeaderServingPortImpl?: typeof discoverLeaderServingPort;
  readLeaderLockImpl?: typeof readLeaderLock;
  deleteLeaderLockImpl?: typeof deleteLeaderLock;
}

interface FollowerAuthorityMonitorDependencies extends FollowerAuthorityDependencies {
  resolveFollowerAuthorityImpl?: typeof resolveFollowerAuthority;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  nowImpl?: () => number;
}

interface LeaderLeaseReconciliationDependencies {
  readLeaderLockImpl?: typeof readLeaderLock;
  findPidOnPortImpl?: typeof findPidOnPort;
  claimLeadershipImpl?: typeof claimLeadership;
  deleteLeaderLockImpl?: typeof deleteLeaderLock;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

interface DiscoveryDependencies {
  fetchImpl?: typeof fetch;
  findPidOnPortImpl?: typeof findPidOnPort;
  readLeaderLockImpl?: typeof readLeaderLock;
}

function buildDiscoveryHeaders(authToken: string | null): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

export interface LeaderHandoffDependencies {
  fetchImpl?: typeof fetch;
  findPidOnPortImpl?: typeof findPidOnPort;
  setTimeoutImpl?: typeof setTimeout;
}

export async function requestLeaderHandoff(
  port: number,
  authToken: string | null,
  candidateLeader: ConsoleLeaderInfo,
  deps: LeaderHandoffDependencies = {},
): Promise<ConsoleLeadershipHandoffDecision | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LEADER_HANDOFF_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/console/handoff`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildDiscoveryHeaders(authToken),
      },
      body: JSON.stringify({ candidateLeader }),
      signal: controller.signal,
    });

    if (!response.ok && response.status !== 409) {
      return null;
    }

    const payload = await response.json() as Partial<ConsoleLeadershipHandoffDecision>;
    if (!payload || typeof payload !== 'object' || typeof payload.accepted !== 'boolean' || !payload.leaderInfo) {
      return null;
    }

    return {
      accepted: payload.accepted,
      reason: payload.reason ?? 'handoff-in-progress',
      leaderInfo: payload.leaderInfo as ConsoleLeaderInfo,
    };
  } catch (err) {
    logger.debug('[UnifiedConsole] Leader handoff request failed', {
      port,
      candidateSessionId: candidateLeader.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForLeaderRelease(
  port: number,
  previousOwnerPid: number,
  deps: LeaderHandoffDependencies = {},
): Promise<boolean> {
  const findPidOnPortImpl = deps.findPidOnPortImpl ?? findPidOnPort;
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const deadline = Date.now() + LEADER_HANDOFF_RELEASE_WAIT_MS;

  while (Date.now() < deadline) {
    const ownerPid = await findPidOnPortImpl(port);
    if (ownerPid === null || ownerPid !== previousOwnerPid) {
      return true;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeoutImpl(resolve, LEADER_HANDOFF_RELEASE_POLL_MS);
      timer.unref?.();
    });
  }

  return false;
}

export async function fetchLeaderSessionsSnapshot(
  port: number,
  authToken: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionInfo[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LEADER_DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/sessions`, {
      headers: buildDiscoveryHeaders(authToken),
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.debug('[UnifiedConsole] Leader session snapshot request returned non-OK response', {
        port,
        status: response.status,
        statusText: response.statusText,
      });
      return [];
    }

    const data = await response.json() as { sessions?: SessionInfo[] };
    if (!Array.isArray(data.sessions)) {
      logger.debug('[UnifiedConsole] Leader session snapshot response missing sessions array', { port });
      return [];
    }

    logger.debug('[UnifiedConsole] Leader session snapshot fetched', {
      port,
      sessions: data.sessions.length,
      authMode: authToken ? 'bearer' : 'anonymous',
    });
    return data.sessions;
  } catch (err) {
    const errorName = err instanceof Error ? err.name : 'UnknownError';
    const debugMessage = errorName === 'AbortError'
      ? '[UnifiedConsole] Leader session snapshot request timed out'
      : '[UnifiedConsole] Failed to fetch leader session snapshot';
    logger.debug(debugMessage, {
      port,
      errorName,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function buildLeaderInfoFromSession(port: number, ownerPid: number, leaderSession: SessionApiRecord): ConsoleLeaderInfo {
  return {
    version: LOCK_VERSION,
    pid: ownerPid,
    port,
    sessionId: UnicodeValidator.normalize(leaderSession.sessionId).normalizedContent,
    startedAt: leaderSession.startedAt ?? currentTimestamp(),
    heartbeat: leaderSession.lastHeartbeat ?? currentTimestamp(),
    serverVersion: leaderSession.serverVersion ?? LEGACY_SERVER_VERSION,
    consoleProtocolVersion: leaderSession.consoleProtocolVersion ?? CONSOLE_PROTOCOL_VERSION,
  };
}

function buildSyntheticLeaderInfo(port: number, ownerPid: number): ConsoleLeaderInfo {
  const now = currentTimestamp();
  return {
    version: LOCK_VERSION,
    pid: ownerPid,
    port,
    sessionId: `${SYNTHETIC_PORT_OWNER_SESSION_PREFIX}${ownerPid}`,
    startedAt: now,
    heartbeat: now,
    serverVersion: LEGACY_SERVER_VERSION,
    consoleProtocolVersion: CONSOLE_PROTOCOL_VERSION,
  };
}

async function discoverLeaderViaSessionsApi(
  port: number,
  ownerPid: number,
  authToken: string | null,
  fetchImpl: typeof fetch,
): Promise<ConsoleLeaderInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LEADER_DISCOVERY_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/sessions`, {
      headers: buildDiscoveryHeaders(authToken),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as { sessions?: SessionApiRecord[] };
    const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    const leaderSession = sessions.find((session) =>
      session.pid === ownerPid &&
      session.isLeader === true &&
      session.kind === 'mcp' &&
      session.status !== 'stopped'
    );
    return leaderSession ? buildLeaderInfoFromSession(port, ownerPid, leaderSession) : null;
  } finally {
    clearTimeout(timeout);
  }
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
      const leaderInfo = await discoverLeaderViaSessionsApi(port, ownerPid, authToken, fetchImpl);
      if (leaderInfo) {
        return { ownerPid, source: 'api', leaderInfo };
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
  if (lock?.port === port && (ownerPid === null || lock.pid === ownerPid)) {
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
    return {
      ownerPid,
      source: 'synthetic',
      leaderInfo: buildSyntheticLeaderInfo(port, ownerPid),
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
  const provisionalLockMatches = (
    currentLock?.pid === provisionalLeader.pid &&
    currentLock.port === provisionalLeader.port &&
    currentLock.sessionId === provisionalLeader.sessionId
  );
  const fallbackPointsToProvisionalLeader = (
    fallback.leaderInfo?.pid === provisionalLeader.pid &&
    fallback.leaderInfo.port === provisionalLeader.port &&
    fallback.leaderInfo.sessionId === provisionalLeader.sessionId
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

export function evaluatePortOwnerReplacement(
  candidateLeader: ConsoleLeaderInfo,
  fallback: PortLeaderDiscovery,
): PortOwnerReplacementDecision {
  if (!fallback.leaderInfo || fallback.ownerPid === null || fallback.ownerPid === candidateLeader.pid) {
    return {
      shouldEvict: false,
      ownerPid: fallback.ownerPid,
      preference: null,
    };
  }

  const preference = evaluateLeaderPreference(candidateLeader, fallback.leaderInfo);
  return {
    shouldEvict: preference.shouldReplace,
    ownerPid: fallback.ownerPid,
    preference,
  };
}

export function shouldEvictDiscoveredOwner(
  discovery: PortLeaderDiscovery,
  replacement: PortOwnerReplacementDecision,
): boolean {
  return discovery.source !== 'synthetic' && replacement.shouldEvict && replacement.ownerPid !== null;
}

function buildBindFailureLogContext(
  consolePort: number,
  provisionalLeader: ConsoleLeaderInfo,
  bindResult: WebServerResult['bindResult'],
  fallback: PortLeaderDiscovery,
  replacement?: PortOwnerReplacementDecision,
  handoff?: ConsoleLeadershipHandoffDecision | null,
) {
  return {
    port: consolePort,
    bindError: bindResult?.error,
    bindDetail: bindResult?.detail,
    provisionalLeaderPid: provisionalLeader.pid,
    provisionalLeaderSessionId: provisionalLeader.sessionId,
    provisionalLeaderVersion: provisionalLeader.serverVersion ?? LEGACY_SERVER_VERSION,
    provisionalLeaderProtocolVersion: provisionalLeader.consoleProtocolVersion ?? CONSOLE_PROTOCOL_VERSION,
    fallbackOwnerPid: fallback.ownerPid,
    fallbackSource: fallback.source,
    fallbackLeaderPid: fallback.leaderInfo?.pid,
    fallbackLeaderSessionId: fallback.leaderInfo?.sessionId,
    fallbackLeaderVersion: fallback.leaderInfo?.serverVersion ?? LEGACY_SERVER_VERSION,
    fallbackLeaderProtocolVersion: fallback.leaderInfo?.consoleProtocolVersion ?? CONSOLE_PROTOCOL_VERSION,
    replacementShouldEvict: replacement?.shouldEvict ?? false,
    replacementReason: replacement?.preference?.reason,
    handoffAccepted: handoff?.accepted ?? false,
    handoffReason: handoff?.reason ?? null,
    handoffLeaderPid: handoff?.leaderInfo.pid ?? null,
    handoffLeaderSessionId: handoff?.leaderInfo.sessionId ?? null,
  };
}

function buildAuthorityResolutionLogContext(
  consolePort: number,
  electedLeader: ConsoleLeaderInfo,
  discovery: PortLeaderDiscovery | null,
  replacement: PortOwnerReplacementDecision | null,
) {
  return {
    port: consolePort,
    electedLeaderPid: electedLeader.pid,
    electedLeaderSessionId: electedLeader.sessionId,
    electedLeaderVersion: electedLeader.serverVersion ?? LEGACY_SERVER_VERSION,
    electedLeaderProtocolVersion: electedLeader.consoleProtocolVersion ?? CONSOLE_PROTOCOL_VERSION,
    servingOwnerPid: discovery?.ownerPid ?? null,
    servingSource: discovery?.source ?? 'none',
    servingLeaderPid: discovery?.leaderInfo?.pid ?? null,
    servingLeaderSessionId: discovery?.leaderInfo?.sessionId ?? null,
    servingLeaderVersion: discovery?.leaderInfo?.serverVersion ?? LEGACY_SERVER_VERSION,
    servingLeaderProtocolVersion: discovery?.leaderInfo?.consoleProtocolVersion ?? CONSOLE_PROTOCOL_VERSION,
    replacementShouldEvict: replacement?.shouldEvict ?? false,
    replacementReason: replacement?.preference?.reason ?? null,
  };
}

export async function resolveFollowerAuthority(
  sessionId: string,
  consolePort: number,
  election: ElectionResult,
  deps: FollowerAuthorityDependencies = {},
): Promise<FollowerAuthorityResolution> {
  const isLeaderWebConsoleReachableImpl = deps.isLeaderWebConsoleReachableImpl ?? isLeaderWebConsoleReachable;
  const discoverLeaderServingPortImpl = deps.discoverLeaderServingPortImpl ?? discoverLeaderServingPort;
  const forceClaimLeadershipImpl = deps.forceClaimLeadershipImpl ?? forceClaimLeadership;
  const deleteLeaderLockImpl = deps.deleteLeaderLockImpl ?? deleteLeaderLock;

  const reachable = await isLeaderWebConsoleReachableImpl(election.leaderInfo);
  if (!reachable) {
    logger.warn('[UnifiedConsole] Elected leader is not serving the console port; forcing takeover', {
      port: consolePort,
      electedLeaderPid: election.leaderInfo.pid,
      electedLeaderSessionId: election.leaderInfo.sessionId,
    });
    return {
      election: await forceClaimLeadershipImpl(sessionId, consolePort),
      discovery: null,
      replacement: null,
      forcedClaim: true,
    };
  }

  const candidateLeader = createLeaderInfo(sessionId, consolePort);
  const discovery = await discoverLeaderServingPortImpl(consolePort, null);
  if (!discovery.leaderInfo || discovery.ownerPid === null) {
    return {
      election,
      discovery,
      replacement: null,
      forcedClaim: false,
    };
  }

  const replacement = evaluatePortOwnerReplacement(candidateLeader, discovery);
  if (shouldEvictDiscoveredOwner(discovery, replacement)) {
    await deleteLeaderLockImpl();
    logger.warn(
      discovery.ownerPid === election.leaderInfo.pid
        ? '[UnifiedConsole] Older console leader detected on the console port; newer session will take over'
        : '[UnifiedConsole] Split-brain console authority detected; newer session will replace the actual port owner',
      buildAuthorityResolutionLogContext(
        consolePort,
        election.leaderInfo,
        discovery,
        replacement,
      ),
    );
    return {
      election: { role: 'leader', leaderInfo: candidateLeader },
      discovery,
      replacement,
      forcedClaim: false,
    };
  }

  if (discovery.ownerPid !== election.leaderInfo.pid) {
    logger.warn('[UnifiedConsole] Split-brain console authority detected; following the actual port owner', buildAuthorityResolutionLogContext(
      consolePort,
      election.leaderInfo,
      discovery,
      replacement,
    ));
    return {
      election: { role: 'follower', leaderInfo: discovery.leaderInfo },
      discovery,
      replacement,
      forcedClaim: false,
    };
  }

  return {
    election,
    discovery,
    replacement,
    forcedClaim: false,
  };
}

export async function resolveLeaderPreflightAuthority(
  sessionId: string,
  consolePort: number,
  election: ElectionResult,
  authToken: string | null,
  deps: LeaderPreflightDependencies = {},
): Promise<LeaderPreflightResolution> {
  const discoverLeaderServingPortImpl = deps.discoverLeaderServingPortImpl ?? discoverLeaderServingPort;
  const readLeaderLockImpl = deps.readLeaderLockImpl ?? readLeaderLock;
  const deleteLeaderLockImpl = deps.deleteLeaderLockImpl ?? deleteLeaderLock;

  const discovery = await discoverLeaderServingPortImpl(consolePort, authToken, deps);
  if (!discovery.leaderInfo || discovery.ownerPid === null || discovery.ownerPid === election.leaderInfo.pid) {
    return {
      election,
      discovery,
      replacement: discovery.leaderInfo ? evaluatePortOwnerReplacement(election.leaderInfo, discovery) : null,
      demotedToFollower: false,
    };
  }

  const replacement = evaluatePortOwnerReplacement(election.leaderInfo, discovery);
  if (shouldEvictDiscoveredOwner(discovery, replacement)) {
    return {
      election,
      discovery,
      replacement,
      demotedToFollower: false,
    };
  }

  const provisionalLock = await readLeaderLockImpl();
  const provisionalLockMatches = (
    provisionalLock?.pid === election.leaderInfo.pid &&
    provisionalLock.port === election.leaderInfo.port &&
    provisionalLock.sessionId === election.leaderInfo.sessionId
  );

  if (provisionalLockMatches) {
    await deleteLeaderLockImpl();
  }

  logger.warn(
    discovery.source === 'synthetic'
      ? '[UnifiedConsole] Provisional leader detected an unknown active console owner before bind; following the existing port owner instead of forcing eviction'
      : '[UnifiedConsole] Provisional leader detected a healthy console owner before bind; following the existing leader instead of forcing takeover',
    {
      ...buildAuthorityResolutionLogContext(consolePort, election.leaderInfo, discovery, replacement),
      provisionalLockCleared: provisionalLockMatches,
    },
  );

  return {
    election: { role: 'follower', leaderInfo: discovery.leaderInfo },
    discovery,
    replacement,
    demotedToFollower: true,
  };
}

export function startFollowerAuthorityMonitor(
  options: UnifiedConsoleOptions,
  consolePort: number,
  election: ElectionResult,
  promotionMgr: PromotionManager,
  forwardingSink: LeaderForwardingLogSink,
  sessionHeartbeat: SessionHeartbeat,
  deps: FollowerAuthorityMonitorDependencies = {},
): () => void {
  const resolveFollowerAuthorityImpl = deps.resolveFollowerAuthorityImpl ?? resolveFollowerAuthority;
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? clearTimeout;
  const nowImpl = deps.nowImpl ?? Date.now;
  let currentElection = election;
  let promotionQueued = false;
  let consecutiveFailures = 0;
  let circuitOpenUntilMs = 0;
  let authorityTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const recheckIntervalMs = computeFollowerAuthorityRecheckInterval(options.sessionId);

  const queueAuthorityPromotion = () => {
    queueMicrotask(() => {
      promotionMgr.promote(forwardingSink, sessionHeartbeat)
        .catch((err) => logger.error('[UnifiedConsole] Authority-based promotion crashed', {
          error: String(err),
        }));
    });
  };

  const handleResolvedAuthority = (resolved: FollowerAuthorityResolution) => {
    currentElection = resolved.election;
    consecutiveFailures = 0;
    circuitOpenUntilMs = 0;

    if (resolved.election.role !== 'leader') {
      return;
    }

    promotionQueued = true;
    if (authorityTimer) {
      clearTimeoutImpl(authorityTimer);
      authorityTimer = null;
    }

    logger.warn('[UnifiedConsole] Follower authority re-evaluation queued a leader takeover', {
      sessionId: options.sessionId,
      stableSessionId: options.stableSessionId,
      port: consolePort,
      recheckIntervalMs,
      electedLeaderPid: election.leaderInfo.pid,
      electedLeaderSessionId: election.leaderInfo.sessionId,
      resolvedLeaderPid: resolved.election.leaderInfo.pid,
      resolvedLeaderSessionId: resolved.election.leaderInfo.sessionId,
      replacementReason: resolved.replacement?.preference?.reason ?? null,
      forcedClaim: resolved.forcedClaim,
    });

    queueAuthorityPromotion();
  };

  const handleAuthorityFailure = (err: unknown) => {
    consecutiveFailures += 1;
    if (consecutiveFailures >= FOLLOWER_AUTHORITY_MONITOR_CONFIG.failureThreshold) {
      circuitOpenUntilMs = nowImpl() + FOLLOWER_AUTHORITY_MONITOR_CONFIG.failureCooldownMs;
      logger.warn('[UnifiedConsole] Follower authority re-evaluation circuit opened after repeated failures', {
        sessionId: options.sessionId,
        port: consolePort,
        recheckIntervalMs,
        consecutiveFailures,
        circuitOpenUntilMs: new Date(circuitOpenUntilMs).toISOString(),
      });
      consecutiveFailures = 0;
    }

    logger.debug('[UnifiedConsole] Follower authority re-evaluation failed', {
      error: err instanceof Error ? err.message : String(err),
      sessionId: options.sessionId,
      port: consolePort,
      recheckIntervalMs,
      circuitOpenUntilMs: circuitOpenUntilMs ? new Date(circuitOpenUntilMs).toISOString() : null,
    });
  };

  const scheduleNextCheck = (delayMs: number) => {
    if (stopped || promotionQueued) {
      return;
    }
    authorityTimer = setTimeoutImpl(runAuthorityCheck, delayMs);
    authorityTimer.unref();
  };

  const runAuthorityCheck = () => {
    authorityTimer = null;
    if (stopped || promotionQueued) {
      return;
    }
    if (circuitOpenUntilMs > nowImpl()) {
      scheduleNextCheck(recheckIntervalMs);
      return;
    }

    if (circuitOpenUntilMs !== 0) {
      logger.info('[UnifiedConsole] Follower authority re-evaluation circuit closed; resuming checks', {
        sessionId: options.sessionId,
        port: consolePort,
        recheckIntervalMs,
      });
      circuitOpenUntilMs = 0;
    }

    resolveFollowerAuthorityImpl(options.sessionId, consolePort, currentElection)
      .then(handleResolvedAuthority)
      .catch(handleAuthorityFailure)
      .finally(() => {
        scheduleNextCheck(recheckIntervalMs);
      });
  };

  scheduleNextCheck(recheckIntervalMs);

  return () => {
    if (authorityTimer) {
      clearTimeoutImpl(authorityTimer);
      authorityTimer = null;
    }
    stopped = true;
  };
}

export async function reconcileLeaderLease(
  sessionId: string,
  consolePort: number,
  deps: LeaderLeaseReconciliationDependencies = {},
): Promise<'not-port-owner' | 'already-owned' | 'reconciled' | 'reclaim-failed'> {
  const readLeaderLockImpl = deps.readLeaderLockImpl ?? readLeaderLock;
  const findPidOnPortImpl = deps.findPidOnPortImpl ?? findPidOnPort;
  const claimLeadershipImpl = deps.claimLeadershipImpl ?? claimLeadership;
  const deleteLeaderLockImpl = deps.deleteLeaderLockImpl ?? deleteLeaderLock;

  const portOwnerPid = await findPidOnPortImpl(consolePort);
  if (portOwnerPid !== process.pid) {
    return 'not-port-owner';
  }

  const currentLock = await readLeaderLockImpl();
  if (!currentLock || currentLock.pid === process.pid) {
    return 'already-owned';
  }

  const expectedLeader = createLeaderInfo(sessionId, consolePort);
  const replacement = evaluatePortOwnerReplacement(expectedLeader, {
    ownerPid: currentLock.pid,
    source: 'lock',
    leaderInfo: currentLock,
  });

  logger.warn('[UnifiedConsole] Port-owning leader detected a displaced lock writer; reconciling leader lease', {
    sessionId,
    port: consolePort,
    lockOwnerPid: currentLock.pid,
    lockOwnerSessionId: currentLock.sessionId,
    lockOwnerVersion: currentLock.serverVersion ?? LEGACY_SERVER_VERSION,
    actualPortOwnerPid: portOwnerPid,
    replacementReason: replacement.preference?.reason ?? null,
  });

  const lockAfterKill = await readLeaderLockImpl();
  let lockDeleted = false;
  let lockClaimAttempted = false;
  let lockClaimed = false;

  if (lockAfterKill?.pid !== process.pid) {
    if (lockAfterKill) {
      await deleteLeaderLockImpl();
      lockDeleted = true;
    }
    lockClaimAttempted = true;
    lockClaimed = await claimLeadershipImpl(expectedLeader);
  }

  const finalLock = await readLeaderLockImpl();
  const reconciled = finalLock?.pid === process.pid;

  logger.info('[UnifiedConsole] Leader lease reconciliation completed', {
    sessionId,
    port: consolePort,
    displacedPid: currentLock.pid,
    displacedSessionId: currentLock.sessionId,
    displacedVersion: currentLock.serverVersion ?? LEGACY_SERVER_VERSION,
    killAttempted: false,
    killResult: null,
    killed: false,
    lockDeleted,
    lockClaimAttempted,
    lockClaimed,
    finalLockOwnerPid: finalLock?.pid ?? null,
    finalLockOwnerSessionId: finalLock?.sessionId ?? null,
    finalLockOwnerVersion: finalLock?.serverVersion ?? null,
    reconciled,
  });

  if (!reconciled) {
    logger.warn('[UnifiedConsole] Port-owning leader could not reclaim the displaced leader lock', {
      sessionId,
      port: consolePort,
      displacedPid: currentLock.pid,
      displacedSessionId: currentLock.sessionId,
      finalLockOwnerPid: finalLock?.pid ?? null,
      finalLockOwnerSessionId: finalLock?.sessionId ?? null,
      finalLockOwnerVersion: finalLock?.serverVersion ?? null,
      killResult: null,
      lockDeleted,
      lockClaimAttempted,
      lockClaimed,
    });
    return 'reclaim-failed';
  }

  return 'reconciled';
}

export function startLeaderLeaseMonitor(
  sessionId: string,
  consolePort: number,
  deps: LeaderLeaseReconciliationDependencies = {},
): () => void {
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let delayMs = LEADER_LEASE_RECONCILE_INTERVAL_MS;

  const scheduleNext = () => {
    if (stopped) {
      return;
    }
    timer = setTimeoutImpl(runCheck, delayMs);
    timer.unref();
  };

  const runCheck = () => {
    timer = null;
    if (stopped) {
      return;
    }
    reconcileLeaderLease(sessionId, consolePort, deps)
      .then((result) => {
        delayMs = result === 'reconciled'
          ? LEADER_LEASE_RECONCILE_INTERVAL_MS
          : Math.min(delayMs * 2, LEADER_LEASE_RECONCILE_MAX_INTERVAL_MS);
      })
      .catch((err) => logger.debug('[UnifiedConsole] Leader lease reconciliation failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId,
        port: consolePort,
      }))
      .finally(() => {
        scheduleNext();
      });
  };

  scheduleNext();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  };
}

async function attemptForceTakeover(
  options: UnifiedConsoleOptions,
  currentElection: ElectionResult,
  consolePort: number,
  primaryToken: string,
  serverOpts: WebServerOptions,
  startWebServerImpl: (options: WebServerOptions) => Promise<WebServerResult>,
): Promise<ForceTakeoverAttemptResult> {
  const initialFallback = await recoverLeaderBindFailure(currentElection.leaderInfo, consolePort, primaryToken);
  const initialReplacement = evaluatePortOwnerReplacement(currentElection.leaderInfo, initialFallback);

  if (!shouldEvictDiscoveredOwner(initialFallback, initialReplacement)) {
    return {
      webResult: { bindResult: { success: false, error: 'EADDRINUSE', detail: `Port ${consolePort} already in use` } },
      election: currentElection,
      fallback: initialFallback,
      replacement: initialReplacement,
      recoveredSessions: [],
      handoff: null,
      takeoverAttempted: false,
      reboundLockClaimed: false,
    };
  }

  const latestFallback = await discoverLeaderServingPort(consolePort, primaryToken);
  const recoveredSessions = await fetchLeaderSessionsSnapshot(consolePort, primaryToken);
  const latestReplacement = evaluatePortOwnerReplacement(currentElection.leaderInfo, latestFallback);
  if (!shouldEvictDiscoveredOwner(latestFallback, latestReplacement)) {
    logger.warn('[UnifiedConsole] Leadership handoff target changed before takeover; following the current leader instead', {
      ...buildBindFailureLogContext(
        consolePort,
        currentElection.leaderInfo,
        { success: false, error: 'EADDRINUSE', detail: `Port ${consolePort} already in use` },
        latestFallback,
        latestReplacement,
      ),
      previousOwnerPid: initialReplacement.ownerPid,
    });
    return {
      webResult: { bindResult: { success: false, error: 'EADDRINUSE', detail: `Port ${consolePort} already in use` } },
      election: currentElection,
      fallback: latestFallback,
      replacement: latestReplacement,
      recoveredSessions,
      handoff: null,
      takeoverAttempted: false,
      reboundLockClaimed: false,
    };
  }

  logger.warn('[UnifiedConsole] Requesting non-destructive leadership handoff from older or incompatible active leader', {
    ...buildBindFailureLogContext(
      consolePort,
      currentElection.leaderInfo,
      { success: false, error: 'EADDRINUSE', detail: `Port ${consolePort} already in use` },
      latestFallback,
      latestReplacement,
    ),
  });

  const ownerPid = latestReplacement.ownerPid;
  if (ownerPid === null) {
    return {
      webResult: { bindResult: { success: false, error: 'EADDRINUSE', detail: `Port ${consolePort} already in use` } },
      election: currentElection,
      fallback: latestFallback,
      replacement: latestReplacement,
      recoveredSessions,
      handoff: null,
      takeoverAttempted: false,
      reboundLockClaimed: false,
    };
  }

  const handoff = await requestLeaderHandoff(consolePort, primaryToken, currentElection.leaderInfo);
  if (!handoff?.accepted) {
    logger.warn('[UnifiedConsole] Leadership handoff was rejected or unavailable; following the existing leader', {
      ...buildBindFailureLogContext(
        consolePort,
        currentElection.leaderInfo,
        { success: false, error: 'EADDRINUSE', detail: `Port ${consolePort} already in use` },
        latestFallback,
        latestReplacement,
        handoff,
      ),
    });
    return {
      webResult: { bindResult: { success: false, error: 'EADDRINUSE', detail: `Port ${consolePort} already in use` } },
      election: currentElection,
      fallback: latestFallback,
      replacement: latestReplacement,
      recoveredSessions,
      handoff,
      takeoverAttempted: true,
      reboundLockClaimed: false,
    };
  }

  const released = await waitForLeaderRelease(consolePort, ownerPid);
  if (!released) {
    logger.warn('[UnifiedConsole] Leadership handoff was accepted but the older leader did not release the console port in time', {
      ...buildBindFailureLogContext(
        consolePort,
        currentElection.leaderInfo,
        { success: false, error: 'EADDRINUSE', detail: `Port ${consolePort} already in use` },
        latestFallback,
        latestReplacement,
        handoff,
      ),
    });
    return {
      webResult: { bindResult: { success: false, error: 'EADDRINUSE', detail: `Port ${consolePort} already in use` } },
      election: currentElection,
      fallback: latestFallback,
      replacement: latestReplacement,
      recoveredSessions,
      handoff,
      takeoverAttempted: true,
      reboundLockClaimed: false,
    };
  }

  const reboundWebResult = await startWebServerImpl(serverOpts);
  let reboundElection = currentElection;
  let reboundLockClaimed = false;

  if (!reboundWebResult.bindResult || reboundWebResult.bindResult.success) {
    const reboundLeaderInfo = createLeaderInfo(options.sessionId, consolePort);
    reboundLockClaimed = await claimLeadership(reboundLeaderInfo);
    if (!reboundLockClaimed) {
      logger.warn('[UnifiedConsole] Rebound leader bound port but could not immediately re-claim lock', {
        ...buildBindFailureLogContext(
          consolePort,
          reboundLeaderInfo,
          reboundWebResult.bindResult,
          latestFallback,
          latestReplacement,
          handoff,
        ),
      });
    }
    reboundElection = { role: 'leader', leaderInfo: reboundLeaderInfo };
  } else {
    logger.warn('[UnifiedConsole] Leadership handoff succeeded but the bind retry still failed', {
      ...buildBindFailureLogContext(
        consolePort,
        currentElection.leaderInfo,
        reboundWebResult.bindResult,
        latestFallback,
        latestReplacement,
        handoff,
      ),
    });
  }

  return {
    webResult: reboundWebResult,
    election: reboundElection,
    fallback: latestFallback,
    replacement: latestReplacement,
    recoveredSessions,
    handoff,
    takeoverAttempted: true,
    reboundLockClaimed,
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

  if (election.role === 'follower') {
    const resolved = await resolveFollowerAuthority(options.sessionId, consolePort, election);
    election = resolved.election;
  } else {
    const { getPrimaryTokenFromFile } = await import('./consoleToken.js');
    const authToken = await getPrimaryTokenFromFile(env.DOLLHOUSE_CONSOLE_TOKEN_FILE);
    const resolved = await resolveLeaderPreflightAuthority(options.sessionId, consolePort, election, authToken);
    election = resolved.election;
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
  const { startWebServer, shutdownWebServer } = await import('../server.js');
  const { derivePreferredLeaderSessionName, pickRandomTokenName } = await import('./SessionNames.js');

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
  let stopHeartbeat = () => {};
  let stopLeaseMonitor = () => {};
  let demotionInProgress = false;
  let activeCleanup = async (): Promise<void> => {
    stopHeartbeat();
    stopLeaseMonitor();
  };

  const requestLeaderHandoff = async (candidateLeader: ConsoleLeaderInfo): Promise<ConsoleLeadershipHandoffDecision> => {
    const currentLeaderInfo = createLeaderInfo(options.sessionId, consolePort);
    const preference = evaluateLeaderPreference(candidateLeader, currentLeaderInfo);
    if (!preference.shouldReplace) {
      logger.info('[UnifiedConsole] Leadership handoff rejected because the requesting session is not preferred', {
        currentLeaderSessionId: currentLeaderInfo.sessionId,
        currentLeaderVersion: preference.existingVersion,
        candidateSessionId: candidateLeader.sessionId,
        candidateVersion: preference.candidateVersion,
        reason: preference.reason,
      });
      return {
        accepted: false,
        reason: preference.reason,
        leaderInfo: currentLeaderInfo,
      };
    }

    if (demotionInProgress) {
      return {
        accepted: false,
        reason: 'handoff-in-progress',
        leaderInfo: currentLeaderInfo,
      };
    }

    demotionInProgress = true;
    logger.warn('[UnifiedConsole] Leadership handoff accepted; stepping down to follower for a newer compatible session', {
      currentLeaderSessionId: currentLeaderInfo.sessionId,
      currentLeaderVersion: currentLeaderInfo.serverVersion ?? LEGACY_SERVER_VERSION,
      candidateSessionId: candidateLeader.sessionId,
      candidateVersion: candidateLeader.serverVersion ?? LEGACY_SERVER_VERSION,
      port: consolePort,
    });

    setImmediate(() => {
      void (async () => {
        try {
          await activeCleanup();
          shutdownWebServer();
          await deleteLeaderLock();
          const followerResult = await startAsFollower(
            options,
            { role: 'follower', leaderInfo: candidateLeader },
            consolePort,
            primaryToken.token,
          );
          activeCleanup = followerResult.cleanup;
          logger.info('[UnifiedConsole] Former leader resumed as follower after leadership handoff', {
            sessionId: options.sessionId,
            stableSessionId: options.stableSessionId,
            newLeaderSessionId: candidateLeader.sessionId,
            port: consolePort,
          });
        } catch (err) {
          demotionInProgress = false;
          logger.error('[UnifiedConsole] Leadership handoff failed during leader demotion', {
            sessionId: options.sessionId,
            candidateLeaderSessionId: candidateLeader.sessionId,
            port: consolePort,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    });

    return {
      accepted: true,
      reason: preference.reason,
      leaderInfo: currentLeaderInfo,
    };
  };

  // Create ingestion routes with a deferred broadcast (wired after server starts)
  const ingestResult = createIngestRoutes({
    logBroadcast: (entry) => liveBroadcast?.(entry),
    metricsOnSnapshot: (snapshot) => liveMetricsOnSnapshot?.(snapshot),
    storeMetricsSnapshot: (snapshot) => options.metricsSink?.onSnapshot(snapshot),
    requestLeaderHandoff,
  });

  // Start the web server with ingest routes mounted before the SPA fallback.
  // If the port is occupied, later recovery prefers non-destructive leader handoff
  // over process termination for verified Dollhouse sessions.
  const serverOpts = {
    portfolioDir: options.portfolioDir,
    memorySink: options.memorySink,
    metricsSink: options.metricsSink,
    port: consolePort,
    sessionId: options.stableSessionId,
    runtimeSessionId: options.sessionId,
    additionalRouters: [ingestResult.router],
    tokenStore,
    ...(options.mcpAqlHandler ? { mcpAqlHandler: options.mcpAqlHandler } : {}),
  };
  // bindAndListen handles the first bind attempt; explicit leader handoff logic
  // below decides whether a newer compatible session should replace the current
  // console leader without killing the live MCP process.
  let webResult = await startWebServer(serverOpts);
  let recoveredFollowerSessions: SessionInfo[] = [];

  if (webResult.bindResult && !webResult.bindResult.success) {
    const forceTakeover = await attemptForceTakeover(
      options,
      election,
      consolePort,
      primaryToken.token,
      serverOpts,
      startWebServer,
    );
    webResult = forceTakeover.webResult;
    election = forceTakeover.election;
    recoveredFollowerSessions = forceTakeover.recoveredSessions;

    if (webResult.bindResult && !webResult.bindResult.success) {
      if (forceTakeover.fallback.leaderInfo) {
      logger.warn('[UnifiedConsole] Leader role aborted: bind failed, falling back to follower', {
        ...buildBindFailureLogContext(
          consolePort,
          election.leaderInfo,
          webResult.bindResult,
          forceTakeover.fallback,
          forceTakeover.replacement,
          forceTakeover.handoff,
        ),
        takeoverAttempted: forceTakeover.takeoverAttempted,
        reboundLockClaimed: forceTakeover.reboundLockClaimed,
        lockCleanupAttempted: forceTakeover.fallback.source !== 'none',
      });
      const followerElection: ElectionResult = { role: 'follower', leaderInfo: forceTakeover.fallback.leaderInfo };
      return startAsFollower(options, followerElection, consolePort, primaryToken.token);
      }

      logger.error('[UnifiedConsole] Leader failed to bind and no active leader could be identified', {
        ...buildBindFailureLogContext(
          consolePort,
          election.leaderInfo,
          webResult.bindResult,
          forceTakeover.fallback,
          forceTakeover.replacement,
          forceTakeover.handoff,
        ),
        takeoverAttempted: forceTakeover.takeoverAttempted,
        reboundLockClaimed: forceTakeover.reboundLockClaimed,
      });
      throw new Error(`Leader failed to bind port ${consolePort} and no active leader was discoverable`);
    }
  }

  // Register the leader only after the HTTP listener is actually serving the port.
  ingestResult.registerLeaderSession(
    options.sessionId,
    process.pid,
    derivePreferredLeaderSessionName(options.sessionId),
    options.stableSessionId,
  );

  // Register the web console itself so the session indicator is never empty (#1805)
  ingestResult.registerConsoleSession();

  if (recoveredFollowerSessions.length > 0) {
    ingestResult.importSessions(recoveredFollowerSessions);
    logger.info('[UnifiedConsole] Recovered follower session snapshot from displaced leader', {
      sessionId: options.sessionId,
      recoveredSessions: recoveredFollowerSessions.length,
    });
  }

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
  stopHeartbeat = startHeartbeat(election.leaderInfo);
  stopLeaseMonitor = startLeaderLeaseMonitor(options.sessionId, consolePort);
  activeCleanup = async () => {
    stopHeartbeat();
    stopLeaseMonitor();
  };
  registerLeaderCleanup();

  logger.info('[UnifiedConsole] Leader started', {
    sessionId: options.sessionId, port: consolePort, pid: process.pid,
    role: 'leader', ingestRoutes: ['/api/ingest/logs', '/api/ingest/metrics', '/api/ingest/session', '/api/sessions'],
  });

  return {
    role: 'leader',
    election,
    port: consolePort,
    cleanup: async () => activeCleanup(),
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
  initialAuthToken: string | null = null,
): Promise<UnifiedConsoleResult> {
  const leaderUrl = `http://127.0.0.1:${election.leaderInfo.port}`;

  // Read the console auth token (#1780) written by the leader. May be null
  // if the file doesn't exist yet — the sinks handle that gracefully and
  // simply omit the Bearer header, which is fine when auth is not enforced.
  let authToken = initialAuthToken;
  if (authToken === null) {
    const { getPrimaryTokenFromFile } = await import('./consoleToken.js');
    authToken = await getPrimaryTokenFromFile(env.DOLLHOUSE_CONSOLE_TOKEN_FILE);
  }
  if (authToken) {
    logger.debug('[UnifiedConsole] Follower loaded console auth token');
  } else {
    logger.debug('[UnifiedConsole] No console auth token file found; follower will POST without Bearer header');
  }

  const { derivePreferredFollowerSessionName } = await import('./SessionNames.js');
  const leaseState = new SessionLeaseState(
    derivePreferredFollowerSessionName(options.sessionId),
    options.stableSessionId,
  );

  // Per-instance promotion manager — tracks its own attempt counter so
  // multiple followers don't interfere with each other's promotion budgets.
  const promotionMgr = new PromotionManager(options, consolePort, startAsLeader, startAsFollower);

  // Declare sessionHeartbeat before the sink so the closure can capture it.
  // Both are initialized before the callback could possibly fire (needs 5+ failed flushes).
  let sessionHeartbeat: SessionHeartbeat;

  // Register a forwarding log sink with leader-death callback (#1850).
  const forwardingSink = new LeaderForwardingLogSink(
    leaderUrl,
    options.sessionId,
    authToken,
    () => {
    promotionMgr.promote(forwardingSink, sessionHeartbeat)
      .catch(err => logger.error('[UnifiedConsole] Promotion crashed', { error: String(err) }));
    },
    leaseState,
  );
  options.registerLogSink(forwardingSink);

  // Start session heartbeat to the leader
  sessionHeartbeat = new SessionHeartbeat(
    leaderUrl,
    options.sessionId,
    process.pid,
    authToken,
    leaseState,
  );
  await sessionHeartbeat.start();

  const stopAuthorityMonitor = startFollowerAuthorityMonitor(
    options,
    consolePort,
    election,
    promotionMgr,
    forwardingSink,
    sessionHeartbeat,
  );

  logger.info('[UnifiedConsole] Follower started', {
    sessionId: options.sessionId, pid: process.pid, role: 'follower',
    leaderSession: election.leaderInfo.sessionId, leaderPid: election.leaderInfo.pid,
    leaderPort: election.leaderInfo.port, leaderUrl,
  });

  return {
    role: 'follower',
    election,
    cleanup: async () => {
      stopAuthorityMonitor();
      await sessionHeartbeat.stop();
      await forwardingSink.close();
    },
  };
}
