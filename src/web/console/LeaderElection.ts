/**
 * Leader election for the unified web console.
 *
 * When multiple MCP server instances run concurrently, only one should host
 * the web console (the "leader"). Others become "followers" that forward
 * events to the leader. This module handles:
 *
 * 1. Reading/writing a leader lock file at ~/.dollhouse/run/console-leader.lock
 * 2. Atomic claim via temp+rename to prevent TOCTOU races
 * 3. PID-based stale detection (signal-0 liveness check)
 * 4. Heartbeat updates (10s interval) so followers can detect hung leaders
 * 5. Cleanup on process exit
 *
 * The configured port binding is the ultimate tiebreaker: even if two
 * processes both write the lock file, only one can bind the port (see
 * `DOLLHOUSE_WEB_CONSOLE_PORT` in `src/config/env.ts`).
 *
 * @since v2.1.0 — Issue #1700
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { env } from '../../config/env.js';
import { PACKAGE_VERSION } from '../../generated/version.js';
import { logger } from '../../utils/logger.js';
import { compareVersions } from '../../utils/version.js';

/** Directory for runtime state files */
const RUN_DIR = join(homedir(), '.dollhouse', 'run');

/**
 * Built-in default filename for the authenticated console's leader lock.
 *
 * The `.auth` suffix isolates this from any legacy no-authentication
 * DollhouseMCP installation that may also be running on the same
 * machine. Those older installs use `console-leader.lock` (no suffix);
 * the authenticated console uses `console-leader.auth.lock`. Combined
 * with the port separation, this means the two generations of the
 * console can coexist with zero interference — different port, different
 * lock file, different token file, independent leader election spaces.
 */
const DEFAULT_LOCK_FILENAME = 'console-leader.auth.lock';

/** Legacy lock filename from the pre-authentication console. Used only for detection. */
const LEGACY_LOCK_FILENAME = 'console-leader.lock';

/**
 * Path to the leader lock file. Prefers the `DOLLHOUSE_CONSOLE_LEADER_LOCK_FILE`
 * env var when set, otherwise uses `DEFAULT_LOCK_FILENAME` under RUN_DIR.
 * The env var is the single source of truth when present, so a deployment
 * can relocate the lock without code changes (see `src/config/env.ts`).
 */
const LOCK_FILE = env.DOLLHOUSE_CONSOLE_LEADER_LOCK_FILE ?? join(RUN_DIR, DEFAULT_LOCK_FILENAME);

/** Path to the legacy pre-auth lock file (used by `detectLegacyLeader` only). */
const LEGACY_LOCK_FILE = join(RUN_DIR, LEGACY_LOCK_FILENAME);

/** How often the leader updates its heartbeat (ms) */
const HEARTBEAT_INTERVAL_MS = 10_000;

/** How long before a heartbeat is considered stale (ms) */
const HEARTBEAT_STALE_MS = 30_000;

/** Current lock file schema version */
export const LOCK_VERSION = 1;

/**
 * Version of the leader-election/session metadata contract used by the
 * authenticated web console. Older leaders will not have this field.
 */
export const CONSOLE_PROTOCOL_VERSION = 1;

/** Missing protocol metadata means the leader predates version-aware election. */
export const LEGACY_CONSOLE_PROTOCOL_VERSION = 0;

/** Old lock files do not carry package version metadata. Treat them as oldest. */
export const LEGACY_SERVER_VERSION = '0.0.0';

/**
 * Information stored in the leader lock file.
 */
export interface ConsoleLeaderInfo {
  version: number;
  pid: number;
  port: number;
  sessionId: string;
  startedAt: string;
  heartbeat: string;
  serverVersion?: string;
  consoleProtocolVersion?: number;
}

/**
 * Result of a leader election attempt.
 */
export interface ElectionResult {
  role: 'leader' | 'follower';
  /** Leader info — for followers, this is the existing leader's info */
  leaderInfo: ConsoleLeaderInfo;
}

export interface LeaderPreferenceDecision {
  shouldReplace: boolean;
  reason: 'newer-compatible-version' | 'same-version' | 'older-version' | 'incompatible-protocol';
  candidateVersion: string;
  existingVersion: string;
  candidateProtocolVersion: number;
  existingProtocolVersion: number;
}

/**
 * Check whether a process with the given PID is alive.
 * Uses signal 0 which checks existence without sending a signal.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM = process exists but owned by another user — still alive
    return err?.code === 'EPERM';
  }
}

/**
 * Normalize the server version present in the leader lock.
 * Missing metadata means "legacy leader" for election purposes.
 */
export function getLeaderServerVersion(info: ConsoleLeaderInfo): string {
  if (typeof info.serverVersion === 'string' && info.serverVersion.trim().length > 0) {
    return info.serverVersion.trim();
  }
  return LEGACY_SERVER_VERSION;
}

/**
 * Normalize the console protocol version present in the leader lock.
 * Missing metadata means a leader from before version-aware election.
 */
export function getLeaderConsoleProtocolVersion(info: ConsoleLeaderInfo): number {
  const raw = info.consoleProtocolVersion;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return raw;
  }
  return LEGACY_CONSOLE_PROTOCOL_VERSION;
}

/**
 * Create this process's leader metadata in one place so all leadership paths
 * publish the same version and protocol information.
 */
export function createLeaderInfo(sessionId: string, port: number): ConsoleLeaderInfo {
  const now = new Date().toISOString();
  return {
    version: LOCK_VERSION,
    pid: process.pid,
    port,
    sessionId: UnicodeValidator.normalize(sessionId).normalizedContent,
    startedAt: now,
    heartbeat: now,
    serverVersion: PACKAGE_VERSION,
    consoleProtocolVersion: CONSOLE_PROTOCOL_VERSION,
  };
}

/**
 * Decide whether this process should replace the current live leader based on
 * compatibility first, then package version.
 */
export function evaluateLeaderPreference(
  candidate: ConsoleLeaderInfo,
  existing: ConsoleLeaderInfo,
): LeaderPreferenceDecision {
  const candidateVersion = getLeaderServerVersion(candidate);
  const existingVersion = getLeaderServerVersion(existing);
  const candidateProtocolVersion = getLeaderConsoleProtocolVersion(candidate);
  const existingProtocolVersion = getLeaderConsoleProtocolVersion(existing);

  const compatible =
    existingProtocolVersion === candidateProtocolVersion ||
    existingProtocolVersion === LEGACY_CONSOLE_PROTOCOL_VERSION;

  if (!compatible) {
    return {
      shouldReplace: false,
      reason: 'incompatible-protocol',
      candidateVersion,
      existingVersion,
      candidateProtocolVersion,
      existingProtocolVersion,
    };
  }

  const versionComparison = compareVersions(candidateVersion, existingVersion);
  if (versionComparison > 0) {
    return {
      shouldReplace: true,
      reason: 'newer-compatible-version',
      candidateVersion,
      existingVersion,
      candidateProtocolVersion,
      existingProtocolVersion,
    };
  }
  if (versionComparison === 0) {
    return {
      shouldReplace: false,
      reason: 'same-version',
      candidateVersion,
      existingVersion,
      candidateProtocolVersion,
      existingProtocolVersion,
    };
  }
  return {
    shouldReplace: false,
    reason: 'older-version',
    candidateVersion,
    existingVersion,
    candidateProtocolVersion,
    existingProtocolVersion,
  };
}

/**
 * Result of a legacy-leader detection scan.
 * `legacyRunning === true` means a pre-authentication DollhouseMCP console
 * is currently running on this machine (its lock file exists and its pid
 * is alive). Callers can surface this to the user as a warning.
 */
export interface LegacyLeaderInfo {
  legacyRunning: boolean;
  pid?: number;
  port?: number;
  lockPath: string;
}

/**
 * Detect whether a legacy (pre-authentication) DollhouseMCP console is
 * currently running on this machine (#1794).
 *
 * The pre-authentication console writes its lock to
 * `~/.dollhouse/run/console-leader.lock` (no `.auth` suffix). An
 * authenticated console on a different port will not interfere with
 * it — they have fully independent ports, lock files, and token files —
 * but the user probably wants to know the two exist simultaneously
 * because the security posture of each console is different.
 *
 * Returns info about the legacy leader if one is detected, or
 * `{ legacyRunning: false }` otherwise.
 *
 * @param lockPath - Optional override for the legacy lock file path.
 *                   Defaults to the built-in legacy location. Primarily
 *                   used by tests to point at a temp directory.
 */
export async function detectLegacyLeader(lockPath: string = LEGACY_LOCK_FILE): Promise<LegacyLeaderInfo> {
  try {
    const content = await readFile(lockPath, 'utf-8');
    const data = JSON.parse(content) as ConsoleLeaderInfo;
    if (!data.pid || !isProcessAlive(data.pid)) {
      return { legacyRunning: false, lockPath };
    }
    return {
      legacyRunning: true,
      pid: data.pid,
      port: data.port,
      lockPath,
    };
  } catch {
    // File missing, unreadable, or invalid JSON — no legacy leader detected
    return { legacyRunning: false, lockPath };
  }
}

/**
 * Read and parse the leader lock file.
 * Returns null if the file doesn't exist, is unreadable, or has invalid content.
 */
export async function readLeaderLock(lockPath: string = LOCK_FILE): Promise<ConsoleLeaderInfo | null> {
  try {
    const content = await readFile(lockPath, 'utf-8');
    const data = JSON.parse(content) as ConsoleLeaderInfo;
    if (data.version !== LOCK_VERSION || !data.pid || !data.port || !data.sessionId) {
      return null;
    }
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.debug('[LeaderElection] Ignoring unreadable or invalid leader lock', {
        lockFile: lockPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

/**
 * Check if a leader lock is stale (dead process or expired heartbeat).
 */
export function isLockStale(info: ConsoleLeaderInfo): boolean {
  if (!isProcessAlive(info.pid)) {
    return true;
  }
  const heartbeatAge = Date.now() - new Date(info.heartbeat).getTime();
  return heartbeatAge > HEARTBEAT_STALE_MS;
}

/**
 * Attempt to atomically claim leadership.
 *
 * Creates the lock file with exclusive-write semantics so only one process
 * can win the initial claim. This avoids startup races where multiple
 * contenders overwrite the lock in quick succession and each briefly believe
 * they are leader.
 *
 * @returns true if this process successfully claimed leadership
 */
export async function claimLeadership(
  info: ConsoleLeaderInfo,
  lockPath: string = LOCK_FILE,
): Promise<boolean> {
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(info, null, 2), 'utf-8');
    } finally {
      await handle.close();
    }

    // Verify we won the race.
    const written = await readLeaderLock(lockPath);
    return written !== null && written.pid === info.pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    return false;
  }
}

/**
 * Delete the leader lock file (for cleanup or takeover).
 */
export async function deleteLeaderLock(): Promise<void> {
  try { await unlink(LOCK_FILE); } catch { /* already gone */ }
}

/**
 * Run the leader election protocol.
 *
 * 1. If no lock exists or lock is stale → claim leadership
 * 2. If lock exists with a live, responsive leader → become follower
 *
 * @param sessionId - This process's unique session identifier
 * @param port - The port this process would use as leader (see `DOLLHOUSE_WEB_CONSOLE_PORT`)
 * @returns Election result with role and leader info
 */
export async function electLeader(sessionId: string, port: number): Promise<ElectionResult> {
  const myInfo = createLeaderInfo(sessionId, port);
  sessionId = myInfo.sessionId;
  const existingLock = await readLeaderLock();

  if (existingLock && !isLockStale(existingLock)) {
    const preference = evaluateLeaderPreference(myInfo, existingLock);
    if (preference.shouldReplace) {
      logger.info('[LeaderElection] Replacing leader with newer compatible version', {
        staleSession: existingLock.sessionId,
        stalePid: existingLock.pid,
        stalePort: existingLock.port,
        staleVersion: preference.existingVersion,
        staleProtocolVersion: preference.existingProtocolVersion,
        mySession: sessionId,
        myPid: process.pid,
        myVersion: preference.candidateVersion,
        myProtocolVersion: preference.candidateProtocolVersion,
      });
      await deleteLeaderLock();
    } else {
      logger.info('[LeaderElection] Existing leader found — becoming follower', {
        leaderSession: existingLock.sessionId,
        leaderPid: existingLock.pid,
        leaderPort: existingLock.port,
        leaderVersion: preference.existingVersion,
        leaderProtocolVersion: preference.existingProtocolVersion,
        mySession: sessionId,
        myPid: process.pid,
        myVersion: preference.candidateVersion,
        myProtocolVersion: preference.candidateProtocolVersion,
        reason: preference.reason,
      });
      return { role: 'follower', leaderInfo: existingLock };
    }
  }

  if (existingLock && !isLockStale(existingLock)) {
    // Leader was intentionally replaced above. Continue to the claim path.
  } else if (existingLock) {
    // No valid leader — try to claim
    const alive = isProcessAlive(existingLock.pid);
    const heartbeatAge = Date.now() - new Date(existingLock.heartbeat).getTime();
    logger.info('[LeaderElection] Stale leader lock — taking over', {
      stalePid: existingLock.pid, alive, heartbeatAgeMs: heartbeatAge,
      staleSession: existingLock.sessionId, mySession: sessionId,
    });
    await deleteLeaderLock();
  }

  const claimed = await claimLeadership(myInfo);
  if (claimed) {
    logger.info('[LeaderElection] Claimed leadership', { sessionId, port, pid: process.pid });
    return { role: 'leader', leaderInfo: myInfo };
  }

  // Another process won the race — re-read and become follower
  const winner = await readLeaderLock();
  if (winner) {
    logger.info('[LeaderElection] Lost election — becoming follower', {
      winnerPid: winner.pid, winnerSession: winner.sessionId, mySession: sessionId, myPid: process.pid,
    });
    return { role: 'follower', leaderInfo: winner };
  }

  // Extremely unlikely: lock disappeared between our claim and re-read. Retry once.
  logger.warn('[LeaderElection] Lock vanished after failed claim. Retrying.');
  const retryInfo: ConsoleLeaderInfo = { ...createLeaderInfo(sessionId, port) };
  const retryClaimed = await claimLeadership(retryInfo);
  if (retryClaimed) {
    return { role: 'leader', leaderInfo: retryInfo };
  }
  const actualLeader = await readLeaderLock();
  return { role: 'follower', leaderInfo: actualLeader ?? retryInfo };
}

/**
 * Probe whether the leader's web console is reachable.
 * Returns true if the leader's ingest endpoint responds, false otherwise.
 */
export async function isLeaderWebConsoleReachable(leaderInfo: ConsoleLeaderInfo): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    const res = await fetch(`http://127.0.0.1:${leaderInfo.port}/api/logs/stats`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Force claim leadership by deleting the existing lock and claiming.
 * Used when the existing leader is alive but not running a web console.
 */
export async function forceClaimLeadership(sessionId: string, port: number): Promise<ElectionResult> {
  logger.info('[LeaderElection] Forcing leadership takeover — existing leader has no web console');
  await deleteLeaderLock();
  const myInfo = createLeaderInfo(sessionId, port);

  const claimed = await claimLeadership(myInfo);
  if (claimed) {
    logger.info('[LeaderElection] Forced leadership claimed', { sessionId, port, pid: process.pid });
    return { role: 'leader', leaderInfo: myInfo };
  }

  // Failed — fall back to follower
  const winner = await readLeaderLock();
  return { role: 'follower', leaderInfo: winner ?? myInfo };
}

/**
 * Start the leader heartbeat loop.
 * Updates the lock file every HEARTBEAT_INTERVAL_MS so followers know the leader is alive.
 *
 * @returns A stop function to clear the interval
 */
export function startHeartbeat(info: ConsoleLeaderInfo): () => void {
  const interval = setInterval(async () => {
    try {
      const updated: ConsoleLeaderInfo = { ...info, heartbeat: new Date().toISOString() };
      const tmpFile = join(RUN_DIR, `console-leader.lock.${process.pid}.tmp`);
      await writeFile(tmpFile, JSON.stringify(updated, null, 2), 'utf-8');
      await rename(tmpFile, LOCK_FILE);
    } catch (err) {
      logger.debug('[LeaderElection] Heartbeat write failed:', err);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Don't let the heartbeat interval keep the process alive
  interval.unref();

  return () => clearInterval(interval);
}

/**
 * Register cleanup handlers to remove the leader lock on process exit.
 * Should only be called by the leader.
 */
export function registerLeaderCleanup(): void {
  const cleanup = () => { deleteLeaderLock().catch(() => {}); };
  process.once('exit', cleanup);
  process.once('SIGTERM', cleanup);
  process.once('SIGINT', cleanup);
  process.once('SIGHUP', cleanup);
}
