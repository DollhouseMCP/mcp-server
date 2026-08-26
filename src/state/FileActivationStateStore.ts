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
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { normalizeMCPAQLElementType } from '../handlers/mcp-aql/types.js';
import type {
  IActivationStateStore,
  PersistedActivation,
  PersistedActivationIdentity,
  PersistedActivationState,
  PersistedActivationStateSnapshot,
} from './IActivationStateStore.js';

// ── Constants ───────────────────────────────────────────────────────

/** Session ID validation: filename-safe alphanumeric/hyphen/underscore, 1-64 chars. */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

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
  return normalizeMCPAQLElementType(elementType);
}

/**
 * Normalize an activation identifier (name or filename) for safe storage.
 */
export function normalizeActivationIdentifier(value: string): string {
  return UnicodeValidator.normalize(value).normalizedContent.trim();
}

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

  if (!SESSION_ID_PATTERN.test(envValue)) {
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
  if (!SESSION_ID_PATTERN.test(trimmed)) {
    throw new Error(
      `[FileActivationStateStore] Invalid external sessionId '${trimmed.slice(0, 64)}' — ` +
      'must contain only letters, numbers, hyphens, or underscores (1-64 characters)'
    );
  }
  return trimmed;
}

function normalizeIdentity(value: PersistedActivationIdentity | undefined): PersistedActivationIdentity | undefined {
  if (!value || (value.kind !== 'file' && value.kind !== 'database')) return undefined;
  const normalizedValue = normalizeActivationIdentifier(value.value);
  return normalizedValue ? { kind: value.kind, value: normalizedValue } : undefined;
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
        for (const [rawType, activations] of Object.entries(data.activations)) {
          const type = normalizeType(rawType);
          if (type && Array.isArray(activations)) {
            this.state.activations[type] = activations.flatMap((a) => {
              if (!a || typeof a.name !== 'string') return [];

              const normalizedName = normalizeActivationIdentifier(a.name);
              if (!normalizedName) return [];

              const normalizedFilename = typeof a.filename === 'string'
                ? normalizeActivationIdentifier(a.filename)
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
        }

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
    const normalizedName = normalizeActivationIdentifier(name);
    if (!normalizedName) return;
    const normalizedFilename = typeof filename === 'string'
      ? normalizeActivationIdentifier(filename)
      : undefined;
    const normalizedIdentity = normalizeIdentity(identity);

    if (!this.state.activations[type]) {
      this.state.activations[type] = [];
    }

    // Deduplicate by durable identity first. A name-only match upgrades a
    // legacy record so the next restart no longer depends on display metadata.
    const existing = this.state.activations[type];
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
      source: 'FileActivationStateStore.recordActivation',
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
    if (!this.enabled) return;

    const type = normalizeType(elementType);
    if (!type) return;
    const normalizedName = normalizeActivationIdentifier(name);
    if (!normalizedName) return;
    const normalizedFilename = typeof filename === 'string'
      ? normalizeActivationIdentifier(filename)
      : undefined;
    const normalizedIdentity = normalizeIdentity(identity);

    const activations = this.state.activations[type];
    if (!activations) return;

    const initialLength = activations.length;
    this.state.activations[type] = activations.filter(a => {
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

    if (this.state.activations[type].length !== initialLength) {
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_DEACTIVATED',
        severity: 'LOW',
        source: 'FileActivationStateStore.recordDeactivation',
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
    const normalized: Record<string, PersistedActivation[]> = {};
    for (const [rawType, entries] of Object.entries(activations)) {
      const type = normalizeType(rawType);
      if (!type || !Array.isArray(entries)) continue;

      const normalizedEntries = entries.flatMap((entry) => {
        if (!entry || typeof entry.name !== 'string') return [];
        const normalizedName = normalizeActivationIdentifier(entry.name);
        if (!normalizedName) return [];
        const normalizedFilename = typeof entry.filename === 'string'
          ? normalizeActivationIdentifier(entry.filename)
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
