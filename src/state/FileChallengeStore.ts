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
import type { FileOperationsService } from '../services/FileOperationsService.js';
import type { StoredChallenge } from '@dollhousemcp/safety';
import type { IChallengeStore } from './IChallengeStore.js';
import { validateExternalSessionId } from './FileActivationStateStore.js';
import { fireAndForgetPersist, handleInitializeError } from './persistence-utils.js';

// ── Constants ───────────────────────────────────────────────────────

const STORE_NAME = 'FileChallengeStore';

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
      handleInitializeError(error, STORE_NAME, 'challenge', this.sessionId);
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
    fireAndForgetPersist(() => this.persistToDisk(), STORE_NAME, 'challenge state', this.sessionId);
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
