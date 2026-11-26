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
import type { DatabaseInstance } from '../database/connection.js';
import { withUserContext } from '../database/rls.js';
import { sessions } from '../database/schema/sessions.js';
import { ProtectedChallengeStore, hasLegacyChallengeCodes, type ChallengeKeyResolver, type PersistedChallenge } from './ProtectedChallengeStore.js';
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

export class DatabaseChallengeStore extends ProtectedChallengeStore {
  private readonly db: DatabaseInstance;
  private readonly userId: string;
  private readonly sessionId: string;

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
    super(keyResolver, JSON.stringify([userId, sessionId]), autoCleanupIntervalMs);
    this.db = db;
    this.userId = userId;
    this.sessionId = sessionId;
    this.persistQueue = new PersistQueue({
      storeName: STORE_NAME,
      stateType: 'challenge state',
      sessionId,
    });
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
      const challenges = hasLegacyChallengeCodes(row.challenges)
        ? await this.restoreLegacySnapshot()
        : await this.verifier.loadEntries(row.challenges);
      this.replaceChallenges(challenges);

      if (challenges.size > 0) {
        logger.info(
          `[${STORE_NAME}] Restored ${challenges.size} challenge(s) for session '${this.sessionId}'`,
        );

        SecurityMonitor.logSecurityEvent({
          type: 'ELEMENT_ACTIVATED',
          severity: 'LOW',
          source: `${STORE_NAME}.initialize`,
          details: `Restored ${challenges.size} challenge(s) from database for session '${this.sessionId}'`,
          additionalData: { sessionId: this.sessionId, count: challenges.size },
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

  /** Wait for any in-flight fire-and-forget writes to complete. */
  awaitPendingWrites(): Promise<void> {
    return this.persistQueue.awaitPending();
  }

  // ── Private ───────────────────────────────────────────────────────

  protected persistAsync(): void {
    this.persistQueue.enqueueFireAndForget(
      () => updateSessionColumns(this.db, this.userId, this.sessionId, {
        challenges: this.challengeEntries(),
      }),
    );
  }
}
