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
  createLeaderInfo,
  type ElectionResult,
} from './LeaderElection.js';
import type { LeaderForwardingLogSink, SessionHeartbeat } from './LeaderForwardingSink.js';
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
    const startMs = Date.now();

    try {
      logger.warn(`[PromotionManager] Leader death detected — promotion attempt ${this.attempts}/${MAX_PROMOTION_ATTEMPTS}`, {
        sessionId: this.options.sessionId, pid: process.pid, port: this.consolePort, attempt: this.attempts,
      });

      await sessionHeartbeat.stop();
      await forwardingSink.close();
      await deleteLeaderLock();

      const myInfo = createLeaderInfo(this.options.sessionId, this.consolePort);

      const claimed = await claimLeadership(myInfo);
      const durationMs = Date.now() - startMs;

      if (claimed) {
        logger.info('[PromotionManager] Promotion succeeded — starting as leader', {
          sessionId: this.options.sessionId, port: this.consolePort, durationMs, attempt: this.attempts,
        });
        const election: ElectionResult = { role: 'leader', leaderInfo: myInfo };
        await this.startAsLeader(this.options, election, this.consolePort);
      } else {
        logger.info('[PromotionManager] Lost promotion race — following new leader', {
          sessionId: this.options.sessionId, durationMs, attempt: this.attempts,
        });
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
        durationMs: Date.now() - startMs, attempt: this.attempts,
      });
    } finally {
      this.inProgress = false;
    }
  }
}
