/**
 * Follower-to-leader promotion manager (#1850).
 *
 * Handles the lifecycle of promoting a follower process to leader when the
 * current leader becomes unreachable. Extracted from UnifiedConsole.ts to
 * reduce complexity and allow per-instance state tracking.
 *
 * Each PromotionManager instance tracks its own attempt counter, so multiple
 * followers in the same process (unlikely but possible) don't interfere
 * with each other's promotion budgets.
 */

import { logger } from '../../utils/logger.js';
import {
  deleteLeaderLock,
  claimLeadership,
  readLeaderLock,
  LOCK_VERSION,
  type ElectionResult,
  type ConsoleLeaderInfo,
} from './LeaderElection.js';
import type { LeaderForwardingLogSink } from './LeaderForwardingSink.js';
import type { SessionHeartbeat } from './LeaderForwardingSink.js';
import type { UnifiedConsoleOptions } from './UnifiedConsole.js';

const MAX_PROMOTION_ATTEMPTS = 3;

export class PromotionManager {
  private inProgress = false;
  private attempts = 0;

  constructor(
    private readonly options: UnifiedConsoleOptions,
    private readonly consolePort: number,
    private readonly startAsLeader: (
      options: UnifiedConsoleOptions,
      election: ElectionResult,
      consolePort: number,
    ) => Promise<unknown>,
    private readonly startAsFollower: (
      options: UnifiedConsoleOptions,
      election: ElectionResult,
      consolePort: number,
    ) => Promise<unknown>,
  ) {}

  /**
   * Attempt promotion. Safe to call from the ForwardingSink onLeaderDeath
   * callback — guards against concurrent and excessive attempts.
   */
  async promote(
    forwardingSink: LeaderForwardingLogSink,
    sessionHeartbeat: SessionHeartbeat,
  ): Promise<void> {
    if (this.inProgress) {
      logger.info('[PromotionManager] Promotion already in progress — skipping');
      return;
    }

    this.attempts++;
    if (this.attempts > MAX_PROMOTION_ATTEMPTS) {
      logger.error(`[PromotionManager] Attempt ${this.attempts} exceeds max (${MAX_PROMOTION_ATTEMPTS}) — giving up`);
      return;
    }

    this.inProgress = true;

    try {
      logger.warn(`[PromotionManager] Leader death detected — promotion attempt ${this.attempts}/${MAX_PROMOTION_ATTEMPTS}`);

      await sessionHeartbeat.stop();
      await forwardingSink.close();
      await deleteLeaderLock();

      const now = new Date().toISOString();
      const myInfo: ConsoleLeaderInfo = {
        version: LOCK_VERSION,
        pid: process.pid,
        port: this.consolePort,
        sessionId: this.options.sessionId,
        startedAt: now,
        heartbeat: now,
      };

      const claimed = await claimLeadership(myInfo);

      if (claimed) {
        logger.info('[PromotionManager] Promotion succeeded — starting as leader');
        const election: ElectionResult = { role: 'leader', leaderInfo: myInfo };
        await this.startAsLeader(this.options, election, this.consolePort);
      } else {
        logger.info('[PromotionManager] Lost promotion race — following new leader');
        const newLeader = await readLeaderLock();
        if (newLeader) {
          const election: ElectionResult = { role: 'follower', leaderInfo: newLeader };
          await this.startAsFollower(this.options, election, this.consolePort);
        } else {
          logger.error('[PromotionManager] No leader available after lost race');
        }
      }
    } catch (err) {
      logger.error('[PromotionManager] Promotion failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.inProgress = false;
    }
  }
}
