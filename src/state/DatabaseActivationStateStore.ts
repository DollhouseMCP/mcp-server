/**
 * Database-Backed Activation State Store
 *
 * Persists per-session element activation state to the sessions table
 * (activations JSONB column). In-memory Map is the hot path; database
 * writes are fire-and-forget — they never block activation operations.
 *
 * @since v2.2.0 — Phase 4, Step 4.2
 */

import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { DatabaseInstance } from '../database/connection.js';
import {
  normalizeActivationIdentifier,
  normalizeActivationInput,
  normalizeActivationType,
  normalizePersistedActivationMap,
  removeActivationRecords,
  upsertActivationRecord,
} from './activation-record-utils.js';
import {
  validateDbStoreParams,
  validateDbSessionId,
  handleDbInitializeError,
  loadSessionRow,
  ensureSessionRow,
  updateSessionColumns,
  queryUserSessions,
} from './db-persistence-utils.js';
import { PersistQueue } from './PersistQueue.js';
import type {
  IActivationStateStore,
  PersistedActivation,
  PersistedActivationIdentity,
  PersistedActivationStateSnapshot,
} from './IActivationStateStore.js';

// ── Constants ───────────────────────────────────────────────────────

const STORE_NAME = 'DatabaseActivationStateStore';

// ── Helpers ─────────────────────────────────────────────────────────

// ── Implementation ──────────────────────────────────────────────────

export class DatabaseActivationStateStore implements IActivationStateStore {
  private readonly db: DatabaseInstance;
  private readonly userId: string;
  private readonly sessionId: string;

  private activations: Record<string, PersistedActivation[]> = {};
  private initialized = false;
  private readonly persistQueue: PersistQueue;

  constructor(db: DatabaseInstance, userId: string, sessionId: string) {
    validateDbStoreParams(userId, sessionId);
    this.db = db;
    this.userId = userId;
    this.sessionId = sessionId;
    this.persistQueue = new PersistQueue({
      storeName: STORE_NAME,
      stateType: 'activation state',
      sessionId,
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      await ensureSessionRow(this.db, this.userId, this.sessionId);

      const row = await loadSessionRow(this.db, this.userId, this.sessionId);
      if (!row) return;

      // Reset before populating to prevent duplicates on re-initialization
      this.activations = {};

      const raw = row.activations as Record<string, PersistedActivation[]> | null;
      if (!raw || typeof raw !== 'object') return;

      this.activations = normalizePersistedActivationMap(raw);

      const totalCount = this.getTotalActivationCount();
      if (totalCount > 0) {
        logger.info(
          `[${STORE_NAME}] Restored ${totalCount} activation(s) for session '${this.sessionId}'`,
        );

        SecurityMonitor.logSecurityEvent({
          type: 'ELEMENT_ACTIVATED',
          severity: 'LOW',
          source: `${STORE_NAME}.initialize`,
          details: `Restored ${totalCount} activation(s) from database for session '${this.sessionId}'`,
          additionalData: {
            sessionId: this.sessionId,
            counts: this.getActivationCounts(),
          },
        });
      }
    } catch (error) {
      handleDbInitializeError(error, STORE_NAME, 'activation', this.sessionId);
    }
  }

  recordActivation(
    elementType: string,
    name: string,
    filename?: string,
    identity?: PersistedActivationIdentity,
  ): void {
    const type = normalizeActivationType(elementType);
    if (!type) return;
    const input = normalizeActivationInput(name, filename, identity);
    if (!input) return;

    if (!this.activations[type]) {
      this.activations[type] = [];
    }

    const mutation = upsertActivationRecord(
      this.activations[type],
      type,
      input,
      new Date().toISOString(),
    );
    if (mutation === 'unchanged') return;
    if (mutation === 'updated') {
      this.persistAsync();
      return;
    }

    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_ACTIVATED',
      severity: 'LOW',
      source: `${STORE_NAME}.recordActivation`,
      details: `Activation recorded: ${type}/${input.name}`,
      additionalData: { sessionId: this.sessionId, elementType: type, name: input.name },
    });

    this.persistAsync();
  }

  recordDeactivation(
    elementType: string,
    name: string,
    filename?: string,
    identity?: PersistedActivationIdentity,
  ): void {
    const type = normalizeActivationType(elementType);
    if (!type) return;
    const input = normalizeActivationInput(name, filename, identity);
    if (!input) return;

    const activations = this.activations[type];
    if (!activations) return;

    const removal = removeActivationRecords(activations, input);
    this.activations[type] = removal.records;

    if (removal.removed) {
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_DEACTIVATED',
        severity: 'LOW',
        source: `${STORE_NAME}.recordDeactivation`,
        details: `Deactivation recorded: ${type}/${input.name}`,
        additionalData: { sessionId: this.sessionId, elementType: type, name: input.name },
      });

      this.persistAsync();
    }
  }

  removeStaleActivation(
    elementType: string,
    name: string,
    filename?: string,
    identity?: PersistedActivationIdentity,
  ): void {
    this.recordDeactivation(elementType, name, filename, identity);
  }

  getActivations(elementType: string): PersistedActivation[] {
    const type = normalizeActivationType(elementType);
    if (!type) return [];
    return this.activations[type] ? [...this.activations[type]] : [];
  }

  clearAll(): void {
    this.activations = {};
    this.persistAsync();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  isEnabled(): boolean {
    return true;
  }

  /** Wait for any in-flight fire-and-forget writes to complete. */
  awaitPendingWrites(): Promise<void> {
    return this.persistQueue.awaitPending();
  }

  async listPersistedActivationStates(sessionId?: string): Promise<PersistedActivationStateSnapshot[]> {
    if (sessionId !== undefined) validateDbSessionId(sessionId);
    try {
      const normalizedSessionId = sessionId ? normalizeActivationIdentifier(sessionId) : undefined;
      const rows = await queryUserSessions(this.db, this.userId, normalizedSessionId);

      return rows
        .map(row => {
          const raw = row.activations as Record<string, PersistedActivation[]> | null;
          if (!raw || typeof raw !== 'object') return null;

          const normalized = this.normalizeActivationsForSnapshot(raw);
          if (Object.keys(normalized).length === 0) return null;

          return {
            sessionId: row.sessionId,
            lastUpdated: row.updatedAt.toISOString(),
            activations: normalized,
          };
        })
        .flatMap(s => s ? [s] : [])
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    } catch (error) {
      logger.debug(`[${STORE_NAME}] Failed to enumerate activation snapshots for reporting`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  // ── Private ───────────────────────────────────────────────────────

  private normalizeActivationsForSnapshot(
    raw: Record<string, PersistedActivation[]>,
  ): Record<string, PersistedActivation[]> {
    return normalizePersistedActivationMap(raw);
  }

  private persistAsync(): void {
    this.persistQueue.enqueueFireAndForget(
      () => updateSessionColumns(this.db, this.userId, this.sessionId, {
        activations: this.activations,
      }),
    );
  }

  private getTotalActivationCount(): number {
    return Object.values(this.activations).reduce(
      (sum, arr) => sum + (arr?.length ?? 0), 0,
    );
  }

  private getActivationCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [type, arr] of Object.entries(this.activations)) {
      if (arr && arr.length > 0) {
        counts[type] = arr.length;
      }
    }
    return counts;
  }
}
