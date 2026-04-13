/**
 * File-Backed Challenge Store
 *
 * Persists verification challenge state to JSON files.
 * Each session gets its own file: ~/.dollhouse/state/challenges-{sessionId}.json
 *
 * In-memory Map is the hot path (same as VerificationStore). Disk writes
 * are fire-and-forget — they never block verification operations.
 *
 * @since v2.1.0 — Issue #1945
 */

import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { FileOperationsService } from '../services/FileOperationsService.js';
import type { StoredChallenge } from '@dollhousemcp/safety';
import type { IChallengeStore } from './IChallengeStore.js';
import { validateExternalSessionId } from './FileActivationStateStore.js';

// ── Constants ───────────────────────────────────────────────────────

/** Maximum number of retry attempts for transient disk failures */
const PERSIST_MAX_RETRIES = 2;

/** Delay between retry attempts in milliseconds */
const PERSIST_RETRY_DELAY_MS = 100;

// ── Persisted File Format ───────────────────────────────────────────

interface PersistedChallengeState {
  version: number;
  sessionId: string;
  lastUpdated: string;
  challenges: Array<[string, StoredChallenge]>;
}

// ── Implementation ──────────────────────────────────────────────────

export class FileChallengeStore implements IChallengeStore {
  private readonly fileOps: FileOperationsService;
  private readonly stateDir: string;
  private readonly sessionId: string;
  private readonly persistPath: string;

  private challenges = new Map<string, StoredChallenge>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    fileOps: FileOperationsService,
    stateDir?: string,
    sessionId?: string,
    autoCleanupIntervalMs: number = 60000,
  ) {
    this.fileOps = fileOps;
    this.sessionId = sessionId
      ? validateExternalSessionId(sessionId)
      : 'default';
    this.stateDir = stateDir ?? path.join(os.homedir(), '.dollhouse', 'state');
    this.persistPath = path.join(this.stateDir, `challenges-${this.sessionId}.json`);

    if (autoCleanupIntervalMs > 0) {
      this.cleanupInterval = setInterval(() => {
        this.cleanup();
      }, autoCleanupIntervalMs);

      if (this.cleanupInterval.unref) {
        this.cleanupInterval.unref();
      }
    }
  }

  /**
   * Load persisted challenges from disk.
   * Drops expired entries on load.
   */
  async initialize(): Promise<void> {
    try {
      const content = await this.fileOps.readFile(this.persistPath);
      const data = JSON.parse(content) as PersistedChallengeState;

      if (data.version === 1 && Array.isArray(data.challenges)) {
        const now = Date.now();
        for (const [challengeId, challenge] of data.challenges) {
          if (!challengeId || !challenge) continue;
          // Drop expired challenges
          if (now > challenge.expiresAt) continue;
          this.challenges.set(challengeId, challenge);
        }

        if (this.challenges.size > 0) {
          logger.info(
            `[FileChallengeStore] Restored ${this.challenges.size} challenge(s) for session '${this.sessionId}'`
          );
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug(`[FileChallengeStore] No challenge file found for session '${this.sessionId}', starting fresh`);
      } else {
        logger.warn(`[FileChallengeStore] Failed to load challenge file for session '${this.sessionId}', starting fresh`, { error });

        SecurityMonitor.logSecurityEvent({
          type: 'OPERATION_FAILED',
          severity: 'MEDIUM',
          source: 'FileChallengeStore.initialize',
          details: `Failed to load challenge file for session '${this.sessionId}' — starting fresh`,
          additionalData: { error: String(error), sessionId: this.sessionId },
        });
      }
    }
  }

  set(challengeId: string, challenge: StoredChallenge): void {
    this.challenges.set(challengeId, challenge);
    this.persistAsync();
  }

  get(challengeId: string): StoredChallenge | undefined {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) return undefined;

    if (Date.now() > challenge.expiresAt) {
      this.challenges.delete(challengeId);
      this.persistAsync();
      return undefined;
    }

    return challenge;
  }

  verify(challengeId: string, code: string): boolean {
    const challenge = this.get(challengeId);
    if (!challenge) return false;

    const matches = challenge.code === code;

    // Delete challenge after verification attempt (one-time use)
    this.challenges.delete(challengeId);
    this.persistAsync();

    return matches;
  }

  cleanup(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, challenge] of this.challenges.entries()) {
      if (now > challenge.expiresAt) {
        this.challenges.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.persistAsync();
    }
  }

  clear(): void {
    this.challenges.clear();
    this.persistAsync();
  }

  size(): number {
    return this.challenges.size;
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  // ── Private persistence methods ───────────────────────────────────

  private persistAsync(): void {
    this.persistWithRetry(0).catch(error => {
      logger.warn('[FileChallengeStore] Failed to persist challenge state after retries', { error });

      SecurityMonitor.logSecurityEvent({
        type: 'OPERATION_FAILED',
        severity: 'MEDIUM',
        source: 'FileChallengeStore.persistAsync',
        details: `Failed to persist challenge state for session '${this.sessionId}' after ${PERSIST_MAX_RETRIES + 1} attempts`,
        additionalData: { error: String(error), sessionId: this.sessionId },
      });
    });
  }

  private async persistWithRetry(attempt: number): Promise<void> {
    try {
      await this.persistToDisk();
    } catch (error) {
      if (attempt < PERSIST_MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, PERSIST_RETRY_DELAY_MS));
        return this.persistWithRetry(attempt + 1);
      }
      throw error;
    }
  }

  private async persistToDisk(): Promise<void> {
    const state: PersistedChallengeState = {
      version: 1,
      sessionId: this.sessionId,
      lastUpdated: new Date().toISOString(),
      challenges: Array.from(this.challenges.entries()),
    };

    await fs.mkdir(this.stateDir, { recursive: true });
    await this.fileOps.writeFile(this.persistPath, JSON.stringify(state, null, 2));
  }
}
