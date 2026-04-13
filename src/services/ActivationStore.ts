/**
 * Activation Store
 *
 * Service layer for per-session element activation state.
 * Handles business logic (security logging) and delegates persistence
 * to an IActivationStateStore implementation.
 *
 * The default backing store is FileActivationStateStore, which persists
 * to ~/.dollhouse/state/activations-{sessionId}.json. A database-backed
 * implementation can be injected via the constructor for hosted deployments.
 *
 * @since v2.0.0 — Issue #598
 * @since v2.1.0 — Issue #1945: Extracted persistence into IActivationStateStore
 */

import { SecurityMonitor } from '../security/securityMonitor.js';
import type { IActivationStateStore, PersistedActivationStateSnapshot } from '../state/IActivationStateStore.js';

// Re-export for backward compatibility — existing code imports these from ActivationStore
export type { PersistedActivation, PersistedActivationState, PersistedActivationStateSnapshot } from '../state/IActivationStateStore.js';

/**
 * Per-session activation state service.
 *
 * Wraps an IActivationStateStore with security event logging.
 * All persistence, normalization, and file I/O is handled by the
 * backing store implementation.
 *
 * @example
 * ```ts
 * const store = new ActivationStore(fileActivationStateStore);
 * await store.initialize();
 *
 * store.recordActivation('skill', 'code-reviewer');
 * store.recordActivation('persona', 'Creative Dev', 'creative-dev.md');
 * ```
 */
export class ActivationStore {
  private readonly store: IActivationStateStore;
  private readonly enabled: boolean;

  /**
   * @param store - Backing store for activation state persistence.
   *                Must be provided by the DI container.
   */
  constructor(store: IActivationStateStore) {
    this.store = store;
    this.enabled = this.store.isEnabled();
  }

  /**
   * Load persisted activations from the backing store.
   * Call once after construction to restore state from a previous session.
   */
  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  /**
   * Record an element activation. Fire-and-forget persist.
   */
  recordActivation(elementType: string, name: string, filename?: string): void {
    if (!this.enabled) return;

    this.store.recordActivation(elementType, name, filename);

    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_ACTIVATED',
      severity: 'LOW',
      source: 'ActivationStore.recordActivation',
      details: `Activation recorded: ${elementType}/${name}`,
      additionalData: {
        sessionId: this.store.getSessionId(),
        elementType,
        name,
      },
    });
  }

  /**
   * Record an element deactivation. Fire-and-forget persist.
   */
  recordDeactivation(elementType: string, name: string): void {
    if (!this.enabled) return;

    this.store.recordDeactivation(elementType, name);

    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_DEACTIVATED' as 'ELEMENT_ACTIVATED',
      severity: 'LOW',
      source: 'ActivationStore.recordDeactivation',
      details: `Deactivation recorded: ${elementType}/${name}`,
      additionalData: {
        sessionId: this.store.getSessionId(),
        elementType,
        name,
      },
    });
  }

  /**
   * Remove a specific activation by name (used during restore to prune stale entries).
   */
  removeStaleActivation(elementType: string, name: string): void {
    this.store.removeStaleActivation(elementType, name);
  }

  /**
   * Get all persisted activations for a given element type.
   */
  getActivations(elementType: string): import('../state/IActivationStateStore.js').PersistedActivation[] {
    return this.store.getActivations(elementType);
  }

  /**
   * Read persisted activation snapshots from disk for reporting/diagnostics.
   * Delegates to the backing store's file-enumeration logic.
   */
  async listPersistedActivationStates(sessionId?: string): Promise<PersistedActivationStateSnapshot[]> {
    return this.store.listPersistedActivationStates(sessionId);
  }

  /**
   * Get the session ID this store is scoped to.
   */
  getSessionId(): string {
    return this.store.getSessionId();
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
    this.store.clearAll();
  }
}
