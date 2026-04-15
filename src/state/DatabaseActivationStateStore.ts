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
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { normalizeMCPAQLElementType } from '../handlers/mcp-aql/types.js';
import type { DatabaseInstance } from '../database/connection.js';
import {
  validateDbStoreParams,
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
  PersistedActivationStateSnapshot,
} from './IActivationStateStore.js';

// ── Constants ───────────────────────────────────────────────────────

const STORE_NAME = 'DatabaseActivationStateStore';

// ── Helpers ─────────────────────────────────────────────────────────

function normalizeType(elementType: string): string | undefined {
  return normalizeMCPAQLElementType(elementType);
}

function normalizeIdentifier(value: string): string {
  return UnicodeValidator.normalize(value).normalizedContent.trim();
}

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

      for (const [rawType, entries] of Object.entries(raw)) {
        const type = normalizeType(rawType);
        if (!type || !Array.isArray(entries)) continue;

        this.activations[type] = entries.flatMap((a) => {
          if (!a || typeof a.name !== 'string') return [];
          const normalizedName = normalizeIdentifier(a.name);
          if (!normalizedName) return [];
          const normalizedFilename = typeof a.filename === 'string'
            ? normalizeIdentifier(a.filename)
            : undefined;
          return [{
            ...a,
            name: normalizedName,
            ...(normalizedFilename ? { filename: normalizedFilename } : {}),
          }];
        });
      }

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

  recordActivation(elementType: string, name: string, filename?: string): void {
    const type = normalizeType(elementType);
    if (!type) return;
    const normalizedName = normalizeIdentifier(name);
    if (!normalizedName) return;
    const normalizedFilename = typeof filename === 'string'
      ? normalizeIdentifier(filename)
      : undefined;

    if (!this.activations[type]) {
      this.activations[type] = [];
    }

    const existing = this.activations[type];
    if (existing.some(a => a.name === normalizedName)) return;

    existing.push({
      name: normalizedName,
      ...(normalizedFilename ? { filename: normalizedFilename } : {}),
      activatedAt: new Date().toISOString(),
    });

    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_ACTIVATED',
      severity: 'LOW',
      source: `${STORE_NAME}.recordActivation`,
      details: `Activation recorded: ${type}/${normalizedName}`,
      additionalData: { sessionId: this.sessionId, elementType: type, name: normalizedName },
    });

    this.persistAsync();
  }

  recordDeactivation(elementType: string, name: string): void {
    const type = normalizeType(elementType);
    if (!type) return;
    const normalizedName = normalizeIdentifier(name);
    if (!normalizedName) return;

    const activations = this.activations[type];
    if (!activations) return;

    const initialLength = activations.length;
    this.activations[type] = activations.filter(a => a.name !== normalizedName);

    if (this.activations[type].length !== initialLength) {
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_DEACTIVATED',
        severity: 'LOW',
        source: `${STORE_NAME}.recordDeactivation`,
        details: `Deactivation recorded: ${type}/${normalizedName}`,
        additionalData: { sessionId: this.sessionId, elementType: type, name: normalizedName },
      });

      this.persistAsync();
    }
  }

  removeStaleActivation(elementType: string, name: string): void {
    this.recordDeactivation(elementType, name);
  }

  getActivations(elementType: string): PersistedActivation[] {
    const type = normalizeType(elementType);
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

  async listPersistedActivationStates(sessionId?: string): Promise<PersistedActivationStateSnapshot[]> {
    try {
      const normalizedSessionId = sessionId ? normalizeIdentifier(sessionId) : undefined;
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
    const normalized: Record<string, PersistedActivation[]> = {};
    for (const [rawType, entries] of Object.entries(raw)) {
      const type = normalizeType(rawType);
      if (!type || !Array.isArray(entries)) continue;

      const normalizedEntries = entries.flatMap((entry) => {
        if (!entry || typeof entry.name !== 'string') return [];
        const normalizedName = normalizeIdentifier(entry.name);
        if (!normalizedName) return [];
        const normalizedFilename = typeof entry.filename === 'string'
          ? normalizeIdentifier(entry.filename)
          : undefined;
        return [{
          ...entry,
          name: normalizedName,
          ...(normalizedFilename ? { filename: normalizedFilename } : {}),
        }];
      });

      if (normalizedEntries.length > 0) {
        normalized[type] = normalizedEntries;
      }
    }
    return normalized;
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
