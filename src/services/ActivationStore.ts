/**
 * Activation Store
 *
 * Persists per-session element activation state to disk.
 * Each MCP session (identified by DOLLHOUSE_SESSION_ID) gets its own
 * activation file so concurrent sessions maintain independent profiles.
 *
 * Follows the DangerZoneEnforcer pattern:
 * - DI-managed singleton with FileOperationsService
 * - initialize() loads from disk (tolerates missing/corrupt files)
 * - In-memory state is the hot path; disk writes are fire-and-forget
 * - atomicWriteFile (write-to-temp + rename) prevents partial reads
 *
 * Forward compatibility: The versioned file format (v1) can evolve to
 * include userId, orgId, and audit fields for multi-user HTTPS mode
 * without breaking existing installations.
 *
 * @since v2.0.0 - Issue #598
 */

import { randomBytes } from 'node:crypto';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { FileOperationsService } from './FileOperationsService.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

/**
 * A persisted activation record for a single element.
 */
export interface PersistedActivation {
  /** Element name (human-readable, used for all types) */
  name: string;
  /** For personas only: the filename key used by PersonaManager */
  filename?: string;
  /** ISO-8601 timestamp of when activation was persisted */
  activatedAt: string;
}

/**
 * Persisted file format (versioned for forward compatibility).
 */
interface PersistedActivationState {
  version: number;
  sessionId: string;
  lastUpdated: string;
  activations: Record<string, PersistedActivation[]>;
}

/** Valid element types that support activation (stored in singular form) */
const ACTIVATABLE_TYPES = new Set(['persona', 'skill', 'agent', 'memory', 'ensemble']);

/**
 * Normalize element type to singular form for consistent storage.
 * ElementType enum uses plural ('personas', 'skills', etc.) but we
 * store in singular form for readability and forward compatibility.
 */
const PLURAL_TO_SINGULAR: Record<string, string> = {
  personas: 'persona',
  skills: 'skill',
  agents: 'agent',
  memories: 'memory',
  ensembles: 'ensemble',
};

function normalizeType(elementType: string): string {
  const lower = elementType.toLowerCase();
  return PLURAL_TO_SINGULAR[lower] ?? lower;
}

function normalizeActivationIdentifier(value: string): string {
  return UnicodeValidator.normalize(value).normalizedContent.trim();
}

/** Session ID validation: must start with a letter, then alphanumeric/hyphens/underscores, 1-64 chars */
const SESSION_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * Validates and returns the session ID from environment or default.
 *
 * Examples of valid session IDs:
 * - `claude-code` — Claude Code CLI sessions
 * - `zulip-bridge` — Zulip bridge integration
 * - `dev-local` — Local development
 * - `staging-v2` — Staging environment
 */
function resolveSessionId(): string {
  const envValue = process.env.DOLLHOUSE_SESSION_ID?.trim();
  if (!envValue) {
    // Generate a unique session ID per server instance to prevent
    // cross-session activation leaking (issue #33)
    const id = `session-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    logger.info(`[ActivationStore] No DOLLHOUSE_SESSION_ID set — generated '${id}'`);
    return id;
  }

  if (!SESSION_ID_PATTERN.test(envValue)) {
    logger.warn(
      `Invalid DOLLHOUSE_SESSION_ID '${envValue}' — must start with a letter, then alphanumeric/hyphens/underscores, 1-64 chars. Falling back to 'default'.`
    );
    return 'default';
  }

  return envValue;
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

/** Maximum number of retry attempts for transient disk failures */
const PERSIST_MAX_RETRIES = 2;

/** Delay between retry attempts in milliseconds */
const PERSIST_RETRY_DELAY_MS = 100;

/**
 * Per-session activation state persistence.
 *
 * Persists element activation state to `~/.dollhouse/state/activations-{sessionId}.json`.
 * Each MCP session is identified by the `DOLLHOUSE_SESSION_ID` environment variable.
 *
 * Thread-safety note: Node.js is single-threaded, so Map operations are safe.
 * For multi-process deployments (future HTTPS), consider Redis or DB backing.
 *
 * @example
 * ```ts
 * // Session ID set via environment:
 * // DOLLHOUSE_SESSION_ID=claude-code
 *
 * const store = new ActivationStore(fileOps);
 * await store.initialize();  // loads ~/.dollhouse/state/activations-claude-code.json
 *
 * store.recordActivation('skill', 'code-reviewer');
 * store.recordActivation('persona', 'Creative Dev', 'creative-dev.md');
 *
 * // On next server start, initialize() restores these activations
 * ```
 */
export class ActivationStore {
  private readonly fileOps: FileOperationsService;
  private readonly stateDir: string;
  private readonly sessionId: string;
  private readonly persistPath: string;
  private readonly enabled: boolean;

  private state: PersistedActivationState;

  constructor(fileOps: FileOperationsService, stateDir?: string) {
    this.fileOps = fileOps;
    this.sessionId = resolveSessionId();
    this.enabled = isPersistenceEnabled();
    this.stateDir = stateDir ?? path.join(os.homedir(), '.dollhouse', 'state');
    this.persistPath = path.join(this.stateDir, `activations-${this.sessionId}.json`);

    this.state = this.createEmptyState();
  }

  /**
   * Load persisted activations from disk.
   * Call once after construction to restore state from a previous session.
   * If the file is missing or corrupt, starts with empty activations.
   */
  async initialize(): Promise<void> {
    if (!this.enabled) {
      logger.debug('[ActivationStore] Persistence disabled via DOLLHOUSE_ACTIVATION_PERSISTENCE');
      return;
    }

    try {
      const content = await this.fileOps.readFile(this.persistPath);
      const data = JSON.parse(content) as PersistedActivationState;

      if (data.version === 1 && data.activations && typeof data.activations === 'object') {
        // Validate and load only known element types
        for (const [type, activations] of Object.entries(data.activations)) {
          if (ACTIVATABLE_TYPES.has(type) && Array.isArray(activations)) {
            this.state.activations[type] = activations.flatMap((a) => {
              if (!a || typeof a.name !== 'string') return [];

              const normalizedName = normalizeActivationIdentifier(a.name);
              if (!normalizedName) return [];

              const normalizedFilename = typeof a.filename === 'string'
                ? normalizeActivationIdentifier(a.filename)
                : undefined;

              return [{
                ...a,
                name: normalizedName,
                ...(normalizedFilename ? { filename: normalizedFilename } : {}),
              }];
            });
          }
        }

        const totalCount = this.getTotalActivationCount();
        if (totalCount > 0) {
          logger.info(
            `[ActivationStore] Restored ${totalCount} activation(s) for session '${this.sessionId}'`
          );

          SecurityMonitor.logSecurityEvent({
            type: 'ELEMENT_ACTIVATED',
            severity: 'LOW',
            source: 'ActivationStore.initialize',
            details: `Restored ${totalCount} activation(s) from disk for session '${this.sessionId}'`,
            additionalData: {
              sessionId: this.sessionId,
              counts: this.getActivationCounts(),
            },
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug(`[ActivationStore] No activation file found for session '${this.sessionId}', starting fresh`);
      } else {
        logger.warn(`[ActivationStore] Failed to load activation file for session '${this.sessionId}', starting fresh`, { error });

        SecurityMonitor.logSecurityEvent({
          type: 'ELEMENT_ACTIVATED',
          severity: 'MEDIUM',
          source: 'ActivationStore.initialize',
          details: `Failed to load activation file for session '${this.sessionId}' — starting fresh (possible data corruption)`,
          additionalData: { error: String(error), sessionId: this.sessionId },
        });
      }
    }
  }

  /**
   * Record an element activation. Fire-and-forget persist.
   */
  recordActivation(elementType: string, name: string, filename?: string): void {
    if (!this.enabled) return;

    const type = normalizeType(elementType);
    if (!ACTIVATABLE_TYPES.has(type)) return;
    const normalizedName = normalizeActivationIdentifier(name);
    if (!normalizedName) return;
    const normalizedFilename = typeof filename === 'string'
      ? normalizeActivationIdentifier(filename)
      : undefined;

    if (!this.state.activations[type]) {
      this.state.activations[type] = [];
    }

    // Deduplicate — don't add if already present
    const existing = this.state.activations[type]!;
    const alreadyActive = existing.some(a => a.name === normalizedName);
    if (alreadyActive) return;

    existing.push({
      name: normalizedName,
      ...(normalizedFilename ? { filename: normalizedFilename } : {}),
      activatedAt: new Date().toISOString(),
    });

    this.persistAsync();
  }

  /**
   * Record an element deactivation. Fire-and-forget persist.
   */
  recordDeactivation(elementType: string, name: string): void {
    if (!this.enabled) return;

    const type = normalizeType(elementType);
    if (!ACTIVATABLE_TYPES.has(type)) return;
    const normalizedName = normalizeActivationIdentifier(name);
    if (!normalizedName) return;

    const activations = this.state.activations[type];
    if (!activations) return;

    const initialLength = activations.length;
    this.state.activations[type] = activations.filter(a => a.name !== normalizedName);

    // Only persist if something actually changed
    if (this.state.activations[type]!.length !== initialLength) {
      this.persistAsync();
    }
  }

  /**
   * Remove a specific activation by name (used during restore to prune stale entries).
   */
  removeStaleActivation(elementType: string, name: string): void {
    this.recordDeactivation(elementType, name);
  }

  /**
   * Get all persisted activations for a given element type.
   */
  getActivations(elementType: string): PersistedActivation[] {
    const type = normalizeType(elementType);
    return this.state.activations[type] ? [...this.state.activations[type]!] : [];
  }

  /**
   * Get the session ID this store is scoped to.
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Check if persistence is enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Clear all persisted activations. Used for testing or admin reset.
   */
  clearAll(): void {
    this.state = this.createEmptyState();
    if (this.enabled) {
      this.persistAsync();
    }
  }

  /**
   * Fire-and-forget persistence with retry for transient disk failures.
   * Retries up to PERSIST_MAX_RETRIES times with a short delay.
   * Disk failure does not block activation operations.
   */
  private persistAsync(): void {
    this.persistWithRetry(0).catch(error => {
      logger.warn('[ActivationStore] Failed to persist activation state after retries', { error });

      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_ACTIVATED',
        severity: 'MEDIUM',
        source: 'ActivationStore.persistAsync',
        details: `Failed to persist activation state for session '${this.sessionId}' after ${PERSIST_MAX_RETRIES + 1} attempts — state continues in-memory only`,
        additionalData: { error: String(error), sessionId: this.sessionId },
      });
    });
  }

  /**
   * Attempt to persist with retries for transient failures (e.g., EBUSY, EAGAIN).
   */
  private async persistWithRetry(attempt: number): Promise<void> {
    try {
      await this.persist();
    } catch (error) {
      if (attempt < PERSIST_MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, PERSIST_RETRY_DELAY_MS));
        return this.persistWithRetry(attempt + 1);
      }
      throw error;
    }
  }

  /**
   * Write current activation state to disk.
   */
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
