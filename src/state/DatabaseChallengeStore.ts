/**
 * Database-Backed Challenge Store
 *
 * Persists verification challenge state to the sessions table
 * (challenges JSONB column). In-memory Map is the hot path;
 * database writes are fire-and-forget.
 *
 * Includes configurable auto-cleanup interval for expired challenges.
 *
 * @since v2.2.0 — Phase 4, Step 4.2
 */

import { timingSafeEqual } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { StoredChallenge } from '@dollhousemcp/safety';
import type { DatabaseInstance } from '../database/connection.js';
import type { IChallengeStore } from './IChallengeStore.js';
import {
  validateDbStoreParams,
  handleDbInitializeError,
  loadSessionRow,
  ensureSessionRow,
  updateSessionColumns,
} from './db-persistence-utils.js';
import { PersistQueue } from './PersistQueue.js';

// ── Constants ───────────────────────────────────────────────────────

const STORE_NAME = 'DatabaseChallengeStore';

// ── Implementation ──────────────────────────────────────────────────

export class DatabaseChallengeStore implements IChallengeStore {
  private readonly db: DatabaseInstance;
  private readonly userId: string;
  private readonly sessionId: string;

  private readonly challenges = new Map<string, StoredChallenge>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private initialized = false;
  private readonly persistQueue: PersistQueue;

  constructor(
    db: DatabaseInstance,
    userId: string,
    sessionId: string,
    autoCleanupIntervalMs: number = 60000,
  ) {
    validateDbStoreParams(userId, sessionId);
    this.db = db;
    this.userId = userId;
    this.sessionId = sessionId;
    this.persistQueue = new PersistQueue({
      storeName: STORE_NAME,
      stateType: 'challenge state',
      sessionId,
    });

    if (autoCleanupIntervalMs > 0) {
      this.cleanupInterval = setInterval(() => {
        this.cleanup();
      }, autoCleanupIntervalMs);

      if (this.cleanupInterval.unref) {
        this.cleanupInterval.unref();
      }
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      await ensureSessionRow(this.db, this.userId, this.sessionId);

      const row = await loadSessionRow(this.db, this.userId, this.sessionId);
      if (!row) return;

      // Clear before populating to prevent duplicates on re-initialization
      this.challenges.clear();

      const raw = row.challenges as Array<[string, StoredChallenge]> | null;
      if (!Array.isArray(raw)) return;

      const now = Date.now();
      for (const [challengeId, challenge] of raw) {
        if (!challengeId || !challenge) continue;
        if (now > challenge.expiresAt) continue;
        this.challenges.set(challengeId, challenge);
      }

      if (this.challenges.size > 0) {
        logger.info(
          `[${STORE_NAME}] Restored ${this.challenges.size} challenge(s) for session '${this.sessionId}'`,
        );

        SecurityMonitor.logSecurityEvent({
          type: 'ELEMENT_ACTIVATED',
          severity: 'LOW',
          source: `${STORE_NAME}.initialize`,
          details: `Restored ${this.challenges.size} challenge(s) from database for session '${this.sessionId}'`,
          additionalData: { sessionId: this.sessionId, count: this.challenges.size },
        });
      }
    } catch (error) {
      handleDbInitializeError(error, STORE_NAME, 'challenge', this.sessionId);
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

    // Timing-safe comparison to prevent side-channel attacks
    const expected = Buffer.from(challenge.code, 'utf8');
    const actual = Buffer.from(code, 'utf8');
    const matches = expected.length === actual.length
      && timingSafeEqual(expected, actual);

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

  /** Wait for any in-flight fire-and-forget writes to complete. */
  awaitPendingWrites(): Promise<void> {
    return this.persistQueue.awaitPending();
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  // ── Private ───────────────────────────────────────────────────────

  private persistAsync(): void {
    this.persistQueue.enqueueFireAndForget(
      () => updateSessionColumns(this.db, this.userId, this.sessionId, {
        challenges: Array.from(this.challenges.entries()),
      }),
    );
  }
}
