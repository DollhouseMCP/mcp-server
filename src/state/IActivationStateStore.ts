/**
 * Activation State Store Interface
 *
 * Persistence contract for per-session element activation state.
 * Each store instance is bound to a single session at construction.
 *
 * Implementations:
 * - FileActivationStateStore: JSON files in ~/.dollhouse/state/
 * - (Phase 4) DatabaseActivationStateStore: PostgreSQL rows
 *
 * @since v2.1.0 — Issue #1945
 */

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
export interface PersistedActivationState {
  version: number;
  sessionId: string;
  lastUpdated: string;
  activations: Record<string, PersistedActivation[]>;
}

/**
 * Read-only snapshot of a session's persisted activation state.
 * Used by the web console permission dashboard for cross-session reporting
 * without mutating live enforcement state.
 */
export interface PersistedActivationStateSnapshot {
  sessionId: string;
  lastUpdated: string;
  activations: Record<string, PersistedActivation[]>;
}

/**
 * Contract for activation state persistence.
 *
 * Implementations are responsible for normalization, deduplication,
 * persistence, and security event logging for element activations.
 */
export interface IActivationStateStore {
  /**
   * Load persisted activation state from the backing store.
   * Tolerates missing or corrupt data — starts fresh on failure.
   */
  initialize(): Promise<void>;

  /**
   * Record an element activation. Fires async persist.
   * @param elementType - Singular element type (e.g., 'persona', 'skill')
   * @param name - Normalized element name
   * @param filename - Optional filename key (personas only)
   */
  recordActivation(elementType: string, name: string, filename?: string): void;

  /**
   * Record an element deactivation. Fires async persist.
   * @param elementType - Singular element type
   * @param name - Normalized element name
   */
  recordDeactivation(elementType: string, name: string): void;

  /**
   * Remove a stale activation (element no longer exists on disk).
   * @param elementType - Singular element type
   * @param name - Normalized element name
   */
  removeStaleActivation(elementType: string, name: string): void;

  /**
   * Get all persisted activations for a given element type.
   * @param elementType - Singular element type
   * @returns Shallow copy of activation records
   */
  getActivations(elementType: string): PersistedActivation[];

  /**
   * Clear all persisted activations and persist the empty state.
   */
  clearAll(): void;

  /**
   * Get the session ID this store is scoped to.
   */
  getSessionId(): string;

  /**
   * Whether persistence is enabled for this store.
   */
  isEnabled(): boolean;

  /**
   * Read persisted activation snapshots from disk for reporting.
   * Does not mutate in-memory state. Safe for cross-session diagnostics.
   * @param sessionId - Optional filter for a specific session
   */
  listPersistedActivationStates(sessionId?: string): Promise<PersistedActivationStateSnapshot[]>;
}
