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
export interface PersistedActivationIdentity {
  /** The storage backend that owns the durable key. */
  kind: 'file' | 'database';
  /** File path/filename in file mode, or element row UUID in database mode. */
  value: string;
}

export interface PersistedActivation {
  /** Element name (human-readable, used for all types) */
  name: string;
  /**
   * Legacy persona filename key. Retained for read compatibility with v1
   * activation records; new agent records use `identity` instead.
   */
  filename?: string;
  /** Backend-neutral durable identity used when display names can change. */
  identity?: PersistedActivationIdentity;
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
   * @param filename - Optional legacy filename key (personas only)
   * @param identity - Optional backend-neutral durable storage identity
   */
  recordActivation(
    elementType: string,
    name: string,
    filename?: string,
    identity?: PersistedActivationIdentity,
  ): void;

  /**
   * Record an element deactivation. Fires async persist.
   * @param elementType - Singular element type
   * @param name - Normalized element name
   */
  recordDeactivation(
    elementType: string,
    name: string,
    filename?: string,
    identity?: PersistedActivationIdentity,
  ): void;

  /**
   * Remove a stale activation (element no longer exists on disk).
   * @param elementType - Singular element type
   * @param name - Normalized element name
   */
  removeStaleActivation(
    elementType: string,
    name: string,
    filename?: string,
    identity?: PersistedActivationIdentity,
  ): void;

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
