/**
 * File-Backed Activation State Store
 *
 * Persists per-session element activation state to JSON files.
 * Each session gets its own file: ~/.dollhouse/state/activations-{sessionId}.json
 *
 * Handles normalization, deduplication, security event logging,
 * and file I/O for activation state persistence.
 *
 * @since v2.1.0 — Issue #1945
 */

import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { fireAndForgetPersist, handleInitializeError } from './persistence-utils.js';
import type { FileOperationsService } from '../services/FileOperationsService.js';
import {
  ACTIVATION_SESSION_ID_PATTERN,
  normalizeActivationInput,
  normalizeActivationType,
  normalizePersistedActivationMap,
  removeActivationRecords,
  upsertActivationRecord,
} from './activation-record-utils.js';
import type {
  IActivationStateStore,
  PersistedActivation,
  PersistedActivationIdentity,
  PersistedActivationState,
  PersistedActivationStateSnapshot,
} from './IActivationStateStore.js';

// ── Constants ───────────────────────────────────────────────────────

/** Session ID validation: filename-safe alphanumeric/hyphen/underscore, 1-64 chars. */
/** Store name for logging and security events. */
const STORE_NAME = 'FileActivationStateStore';

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Normalize element type to singular form for consistent storage.
 * Delegates to the canonical normalizeMCPAQLElementType() so that new
 * element types added to the ElementType enum are automatically supported.
 * Returns undefined for unrecognized types.
 */
export function normalizeType(elementType: string): string | undefined {
  return normalizeActivationType(elementType);
}

export { normalizeActivationIdentifier } from './activation-record-utils.js';

/**
 * Validates and returns the session ID from environment or default.
 */
function resolveSessionId(): string {
  const envValue = process.env.DOLLHOUSE_SESSION_ID?.trim();
  if (!envValue) {
    const id = `session-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    logger.info(`[FileActivationStateStore] No DOLLHOUSE_SESSION_ID set — generated '${id}'`);
    return id;
  }

  if (!ACTIVATION_SESSION_ID_PATTERN.test(envValue)) {
    logger.warn(
      `Invalid DOLLHOUSE_SESSION_ID '${envValue}' — must contain only letters, numbers, hyphens, or underscores, 1-64 chars. Falling back to 'default'.`
    );
    return 'default';
  }

  return envValue;
}

/**
 * Validates a sessionId provided externally (e.g., from SessionContext via DI).
 */
export function validateExternalSessionId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('[FileActivationStateStore] Invalid external sessionId: value must not be empty');
  }
  if (!ACTIVATION_SESSION_ID_PATTERN.test(trimmed)) {
    throw new Error(
      `[FileActivationStateStore] Invalid external sessionId '${trimmed.slice(0, 64)}' — ` +
      'must contain only letters, numbers, hyphens, or underscores (1-64 characters)'
    );
  }
  return trimmed;
}

/**
 * Checks whether activation persistence is enabled.
 */
function isPersistenceEnabled(): boolean {
  const envValue = process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE?.trim().toLowerCase();
  if (envValue === 'false' || envValue === '0' || envValue === 'no') {
    return false;
  }
  return true;
}

// ── Implementation ──────────────────────────────────────────────────

/**
 * File-backed activation state store.
 *
 * Persists element activation state to JSON files using atomic writes
 * (write-to-temp + rename) via FileOperationsService. Disk writes are
 * fire-and-forget with retry — they never block activation operations.
 */
export class FileActivationStateStore implements IActivationStateStore {
  private readonly fileOps: FileOperationsService;
  private readonly stateDir: string;
  private readonly sessionId: string;
  private readonly persistPath: string;
  private readonly enabled: boolean;

  private state: PersistedActivationState;

  constructor(fileOps: FileOperationsService, stateDir?: string, sessionId?: string) {
    this.fileOps = fileOps;
    this.sessionId = sessionId === undefined
      ? resolveSessionId()
      : validateExternalSessionId(sessionId);
    this.enabled = isPersistenceEnabled();
    this.stateDir = stateDir ?? path.join(os.homedir(), '.dollhouse', 'state');
    this.persistPath = path.join(this.stateDir, `activations-${this.sessionId}.json`);

    this.state = this.createEmptyState();
  }

  async initialize(): Promise<void> {
    if (!this.enabled) {
      logger.debug('[FileActivationStateStore] Persistence disabled via DOLLHOUSE_ACTIVATION_PERSISTENCE');
      return;
    }

    try {
      const content = await this.fileOps.readFile(this.persistPath);
      const data = JSON.parse(content) as PersistedActivationState;

      if (data.version === 1 && data.activations && typeof data.activations === 'object') {
        this.state.activations = normalizePersistedActivationMap(data.activations);

        const totalCount = this.getTotalActivationCount();
        if (totalCount > 0) {
          logger.info(
            `[FileActivationStateStore] Restored ${totalCount} activation(s) for session '${this.sessionId}'`
          );

          SecurityMonitor.logSecurityEvent({
            type: 'ELEMENT_ACTIVATED',
            severity: 'LOW',
            source: 'FileActivationStateStore.initialize',
            details: `Restored ${totalCount} activation(s) from disk for session '${this.sessionId}'`,
            additionalData: {
              sessionId: this.sessionId,
              counts: this.getActivationCounts(),
            },
          });
        }
      }
    } catch (error) {
      handleInitializeError(error, STORE_NAME, 'activation', this.sessionId);
    }
  }

  recordActivation(
    elementType: string,
    name: string,
    filename?: string,
    identity?: PersistedActivationIdentity,
  ): void {
    if (!this.enabled) return;

    const type = normalizeType(elementType);
    if (!type) return;
    const input = normalizeActivationInput(name, filename, identity);
    if (!input) return;

    if (!this.state.activations[type]) {
      this.state.activations[type] = [];
    }

    const mutation = upsertActivationRecord(
      this.state.activations[type],
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
      source: 'FileActivationStateStore.recordActivation',
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
    if (!this.enabled) return;

    const type = normalizeType(elementType);
    if (!type) return;
    const input = normalizeActivationInput(name, filename, identity);
    if (!input) return;

    const activations = this.state.activations[type];
    if (!activations) return;

    const removal = removeActivationRecords(activations, input);
    this.state.activations[type] = removal.records;

    if (removal.removed) {
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_DEACTIVATED',
        severity: 'LOW',
        source: 'FileActivationStateStore.recordDeactivation',
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
    const type = normalizeType(elementType);
    if (!type) return [];
    return this.state.activations[type] ? [...this.state.activations[type]] : [];
  }

  getSessionId(): string {
    return this.sessionId;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  clearAll(): void {
    this.state = this.createEmptyState();
    if (this.enabled) {
      this.persistAsync();
    }
  }

  // ── Reporting (read-only disk enumeration) ────────────────────────

  async listPersistedActivationStates(sessionId?: string): Promise<PersistedActivationStateSnapshot[]> {
    if (!this.enabled) {
      return [];
    }

    const normalizedSessionId = typeof sessionId === 'string'
      ? validateExternalSessionId(sessionId)
      : undefined;

    try {
      const filenames = await this.getPersistedActivationFilenames(normalizedSessionId);
      const states = await Promise.all(
        filenames.map(filename => this.readPersistedActivationState(filename)),
      );
      return states
        .flatMap((state) => (state ? [state] : []))
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug('[FileActivationStateStore] Failed to enumerate activation snapshots for reporting', {
          stateDir: this.stateDir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return [];
  }

  private async getPersistedActivationFilenames(sessionId?: string): Promise<string[]> {
    if (sessionId) {
      return [`activations-${sessionId}.json`];
    }
    const filenames = await fs.readdir(this.stateDir);
    return filenames.filter(name => /^activations-[^.]+\.json$/u.test(name));
  }

  private async readPersistedActivationState(filename: string): Promise<PersistedActivationStateSnapshot | null> {
    const filePath = path.join(this.stateDir, filename);
    try {
      const content = await this.fileOps.readFile(filePath);
      const data = JSON.parse(content) as PersistedActivationState;
      if (data.version !== 1 || !data.activations || typeof data.activations !== 'object') {
        return null;
      }
      return {
        sessionId: data.sessionId,
        lastUpdated: data.lastUpdated,
        activations: this.normalizePersistedActivationsForSnapshot(data.activations),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug('[FileActivationStateStore] Skipping unreadable activation snapshot during reporting', {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    }
  }

  private normalizePersistedActivationsForSnapshot(
    activations: PersistedActivationState['activations']
  ): Record<string, PersistedActivation[]> {
    return normalizePersistedActivationMap(activations);
  }

  // ── Private persistence methods ───────────────────────────────────

  private persistAsync(): void {
    fireAndForgetPersist(() => this.persist(), STORE_NAME, 'activation state', this.sessionId);
  }

  private async persist(): Promise<void> {
    this.state.lastUpdated = new Date().toISOString();
    await fs.mkdir(this.stateDir, { recursive: true });
    await this.fileOps.writeFile(this.persistPath, JSON.stringify(this.state, null, 2));
  }

  private createEmptyState(): PersistedActivationState {
    return {
      version: 1,
      sessionId: this.sessionId,
      lastUpdated: new Date().toISOString(),
      activations: {},
    };
  }

  private getTotalActivationCount(): number {
    return Object.values(this.state.activations).reduce(
      (sum, arr) => sum + (arr?.length ?? 0), 0
    );
  }

  private getActivationCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [type, arr] of Object.entries(this.state.activations)) {
      if (arr && arr.length > 0) {
        counts[type] = arr.length;
      }
    }
    return counts;
  }
}
