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
 * The port 3939 binding is the ultimate tiebreaker: even if two processes
 * both write the lock file, only one can bind the port.
 *
 * @since v2.1.0 — Issue #1700
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { logger } from '../../utils/logger.js';

/** Directory for runtime state files */
const RUN_DIR = join(homedir(), '.dollhouse', 'run');

/** Path to the leader lock file */
const LOCK_FILE = join(RUN_DIR, 'console-leader.lock');

/** How often the leader updates its heartbeat (ms) */
const HEARTBEAT_INTERVAL_MS = 10_000;

/** How long before a heartbeat is considered stale (ms) */
const HEARTBEAT_STALE_MS = 30_000;

/** Current lock file schema version */
const LOCK_VERSION = 1;

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
}

/**
 * Result of a leader election attempt.
 */
export interface ElectionResult {
  role: 'leader' | 'follower';
  /** Leader info — for followers, this is the existing leader's info */
  leaderInfo: ConsoleLeaderInfo;
}

/**
 * Check whether a process with the given PID is alive.
 * Uses signal 0 which checks existence without sending a signal.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse the leader lock file.
 * Returns null if the file doesn't exist, is unreadable, or has invalid content.
 */
export async function readLeaderLock(): Promise<ConsoleLeaderInfo | null> {
  try {
    const content = await readFile(LOCK_FILE, 'utf-8');
    const data = JSON.parse(content) as ConsoleLeaderInfo;
    if (data.version !== LOCK_VERSION || !data.pid || !data.port || !data.sessionId) {
      return null;
    }
    return data;
  } catch {
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
 * Writes to a temp file then renames to the lock path. On POSIX systems
 * rename is atomic, so only one writer wins. After renaming, re-reads the
 * lock to verify our PID won.
 *
 * @returns true if this process successfully claimed leadership
 */
export async function claimLeadership(info: ConsoleLeaderInfo): Promise<boolean> {
  await mkdir(RUN_DIR, { recursive: true });
  const tmpFile = join(RUN_DIR, `console-leader.lock.${process.pid}.tmp`);
  try {
    await writeFile(tmpFile, JSON.stringify(info, null, 2), 'utf-8');
    await rename(tmpFile, LOCK_FILE);

    // Verify we won the race
    const written = await readLeaderLock();
    return written !== null && written.pid === info.pid;
  } catch {
    // Clean up temp file on failure
    try { await unlink(tmpFile); } catch { /* ignore */ }
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
 * @param port - The port this process would use as leader (typically 3939)
 * @returns Election result with role and leader info
 */
export async function electLeader(sessionId: string, port: number): Promise<ElectionResult> {
  const existingLock = await readLeaderLock();

  if (existingLock && !isLockStale(existingLock)) {
    logger.info(
      `[LeaderElection] Existing leader found: session=${existingLock.sessionId} pid=${existingLock.pid} port=${existingLock.port}`
    );
    return { role: 'follower', leaderInfo: existingLock };
  }

  // No valid leader — try to claim
  if (existingLock) {
    logger.info(
      `[LeaderElection] Stale leader lock detected (pid=${existingLock.pid}, alive=${isProcessAlive(existingLock.pid)}). Taking over.`
    );
    await deleteLeaderLock();
  }

  const now = new Date().toISOString();
  const myInfo: ConsoleLeaderInfo = {
    version: LOCK_VERSION,
    pid: process.pid,
    port,
    sessionId,
    startedAt: now,
    heartbeat: now,
  };

  const claimed = await claimLeadership(myInfo);
  if (claimed) {
    logger.info(`[LeaderElection] Claimed leadership: session=${sessionId} port=${port}`);
    return { role: 'leader', leaderInfo: myInfo };
  }

  // Another process won the race — re-read and become follower
  const winner = await readLeaderLock();
  if (winner) {
    logger.info(`[LeaderElection] Lost election to pid=${winner.pid}. Becoming follower.`);
    return { role: 'follower', leaderInfo: winner };
  }

  // Extremely unlikely: lock disappeared between our claim and re-read. Retry once.
  logger.warn('[LeaderElection] Lock vanished after failed claim. Retrying.');
  const retryInfo: ConsoleLeaderInfo = { ...myInfo, heartbeat: new Date().toISOString() };
  const retryClaimed = await claimLeadership(retryInfo);
  return { role: retryClaimed ? 'leader' : 'follower', leaderInfo: retryInfo };
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
}
