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

function normalizeType(elementType: string): string | undefined {
  return normalizeMCPAQLElementType(elementType);
}

function normalizeIdentifier(value: string): string {
  return UnicodeValidator.normalize(value).normalizedContent.trim();
}

function normalizeIdentity(value: PersistedActivationIdentity | undefined): PersistedActivationIdentity | undefined {
  if (!value || (value.kind !== 'file' && value.kind !== 'database')) return undefined;
  const normalizedValue = normalizeIdentifier(value.value);
  return normalizedValue ? { kind: value.kind, value: normalizedValue } : undefined;
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
          const normalizedIdentity = normalizeIdentity(a.identity);
          return [{
            ...a,
            name: normalizedName,
            ...(normalizedFilename ? { filename: normalizedFilename } : {}),
            ...(normalizedIdentity ? { identity: normalizedIdentity } : {}),
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

  recordActivation(
    elementType: string,
    name: string,
    filename?: string,
    identity?: PersistedActivationIdentity,
  ): void {
    const type = normalizeType(elementType);
    if (!type) return;
    const normalizedName = normalizeIdentifier(name);
    if (!normalizedName) return;
    const normalizedFilename = typeof filename === 'string'
      ? normalizeIdentifier(filename)
      : undefined;
    const normalizedIdentity = normalizeIdentity(identity);

    if (!this.activations[type]) {
      this.activations[type] = [];
    }

    const existing = this.activations[type];
    let activeRecord = normalizedIdentity
      ? existing.find(a => a.identity?.kind === normalizedIdentity.kind && a.identity.value === normalizedIdentity.value)
      : undefined;
    activeRecord ??= normalizedIdentity?.kind === 'file'
      ? existing.find(a => !a.identity && a.filename === normalizedIdentity.value)
      : undefined;
    activeRecord ??= normalizedFilename
      ? existing.find(a => a.filename === normalizedFilename)
      : undefined;
    activeRecord ??= existing.find(a =>
      a.name === normalizedName && (!normalizedIdentity || !a.identity)
    );
    if (activeRecord) {
      let changed = false;
      if (activeRecord.name !== normalizedName) {
        activeRecord.name = normalizedName;
        changed = true;
      }
      if (normalizedFilename && activeRecord.filename !== normalizedFilename) {
        activeRecord.filename = normalizedFilename;
        changed = true;
      }
      if (normalizedIdentity && (
        activeRecord.identity?.kind !== normalizedIdentity.kind ||
        activeRecord.identity?.value !== normalizedIdentity.value
      )) {
        activeRecord.identity = normalizedIdentity;
        changed = true;
      }
      if (type === 'agent' && normalizedIdentity && activeRecord.filename) {
        delete activeRecord.filename;
        changed = true;
      }
      if (changed) this.persistAsync();
      return;
    }

    existing.push({
      name: normalizedName,
      ...(normalizedFilename ? { filename: normalizedFilename } : {}),
      ...(normalizedIdentity ? { identity: normalizedIdentity } : {}),
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

  recordDeactivation(
    elementType: string,
    name: string,
    filename?: string,
    identity?: PersistedActivationIdentity,
  ): void {
    const type = normalizeType(elementType);
    if (!type) return;
    const normalizedName = normalizeIdentifier(name);
    if (!normalizedName) return;
    const normalizedFilename = typeof filename === 'string'
      ? normalizeIdentifier(filename)
      : undefined;
    const normalizedIdentity = normalizeIdentity(identity);

    const activations = this.activations[type];
    if (!activations) return;

    const initialLength = activations.length;
    this.activations[type] = activations.filter(a => {
      if (normalizedIdentity) {
        const identityMatches = a.identity?.kind === normalizedIdentity.kind &&
          a.identity.value === normalizedIdentity.value;
        const legacyNameMatches = !a.identity && a.name === normalizedName;
        return !identityMatches && !legacyNameMatches;
      }
      if (normalizedFilename) {
        return a.filename !== normalizedFilename && !(!a.filename && a.name === normalizedName);
      }
      return a.name !== normalizedName && a.filename !== normalizedName;
    });

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

  removeStaleActivation(
    elementType: string,
    name: string,
    filename?: string,
    identity?: PersistedActivationIdentity,
  ): void {
    this.recordDeactivation(elementType, name, filename, identity);
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

  /** Wait for any in-flight fire-and-forget writes to complete. */
  awaitPendingWrites(): Promise<void> {
    return this.persistQueue.awaitPending();
  }

  async listPersistedActivationStates(sessionId?: string): Promise<PersistedActivationStateSnapshot[]> {
    if (sessionId !== undefined) validateDbSessionId(sessionId);
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
        const normalizedIdentity = normalizeIdentity(entry.identity);
        return [{
          ...entry,
          name: normalizedName,
          ...(normalizedFilename ? { filename: normalizedFilename } : {}),
          ...(normalizedIdentity ? { identity: normalizedIdentity } : {}),
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
