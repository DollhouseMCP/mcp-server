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

import { logger } from '../utils/logger.js';
import { and, eq } from 'drizzle-orm';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { StoredChallenge } from '@dollhousemcp/safety';
import type { DatabaseInstance } from '../database/connection.js';
import { withUserContext } from '../database/rls.js';
import { sessions } from '../database/schema/sessions.js';
import type { ChallengeMetadata, IChallengeStore } from './IChallengeStore.js';
import { ChallengeVerifier, hasLegacyChallengeCodes, type ChallengeKeyResolver, type PersistedChallenge } from './challenge-verifier.js';
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

  private challenges = new Map<string, PersistedChallenge>();
  private readonly verifier: ChallengeVerifier;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private initialized = false;
  private readonly persistQueue: PersistQueue;

  constructor(
    db: DatabaseInstance,
    userId: string,
    sessionId: string,
    keyResolver: ChallengeKeyResolver,
    autoCleanupIntervalMs: number = 60000,
  ) {
    validateDbStoreParams(userId, sessionId);
    this.db = db;
    this.userId = userId;
    this.sessionId = sessionId;
    this.verifier = new ChallengeVerifier(keyResolver, JSON.stringify([userId, sessionId]));
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
      await this.verifier.initialize();
      await ensureSessionRow(this.db, this.userId, this.sessionId);

      const row = await loadSessionRow(this.db, this.userId, this.sessionId);
      if (!row) return;

      if (!Array.isArray(row.challenges)) return;
      this.challenges = hasLegacyChallengeCodes(row.challenges)
        ? await this.restoreLegacySnapshot()
        : await this.verifier.loadEntries(row.challenges);

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

  private restoreLegacySnapshot(): Promise<Map<string, PersistedChallenge>> {
    return withUserContext(this.db, this.userId, async tx => {
      const scope = and(eq(sessions.userId, this.userId), eq(sessions.sessionId, this.sessionId));
      const [row] = await tx.select({ challenges: sessions.challenges }).from(sessions).where(scope).for('update');
      const entries = Array.isArray(row?.challenges) ? row.challenges : [];
      const legacy = hasLegacyChallengeCodes(entries);
      const challenges = await this.verifier.loadEntries(entries, legacy);
      if (legacy) await tx.update(sessions).set({ challenges: Array.from(challenges) }).where(scope);
      return challenges;
    });
  }

  set(challengeId: string, challenge: StoredChallenge): void {
    this.challenges.set(challengeId, this.verifier.seal(challengeId, challenge));
    this.persistAsync();
  }

  get(challengeId: string): ChallengeMetadata | undefined {
    const challenge = this.lookup(challengeId);
    return challenge && { expiresAt: challenge.expiresAt, reason: challenge.reason };
  }

  private lookup(challengeId: string): PersistedChallenge | undefined {
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
    const challenge = this.lookup(challengeId);
    if (!challenge) return false;

    // Delete challenge after verification attempt (one-time use)
    this.challenges.delete(challengeId);
    this.persistAsync();

    return this.verifier.matches(challengeId, challenge, code);
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
