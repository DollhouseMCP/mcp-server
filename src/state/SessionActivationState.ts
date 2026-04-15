/**
 * Session Activation State
 *
 * Per-session activation tracking for DollhouseMCP elements.
 * Each session gets its own independent activation state — which elements
 * are active, and optionally an identity override from set_user_identity.
 *
 * The SessionActivationRegistry maps sessionId → SessionActivationState
 * and is the single source of truth for "what's active in this session."
 * Element managers resolve the correct session's state internally via
 * ContextTracker.getSessionContext()?.sessionId.
 *
 * @since v2.1.0 — Issue #1946
 */

import { logger } from '../utils/logger.js';

/**
 * Per-session identity override.
 * Set via the set_user_identity MCP tool. Scoped to the session,
 * not global (unlike the previous process.env mutation pattern).
 */
export interface SessionUserIdentity {
  username: string;
  email?: string;
}

/**
 * Per-session activation state.
 * One instance per session, held by SessionActivationRegistry.
 *
 * Each Set tracks which elements of that type are active in this session.
 * Key conventions match the existing manager patterns:
 * - personas: keyed by **filename** (e.g., 'creative-dev.md')
 * - all others: keyed by **metadata.name**
 */
export interface SessionActivationState {
  readonly sessionId: string;
  readonly personas: Set<string>;
  readonly skills: Set<string>;
  readonly agents: Set<string>;
  readonly memories: Set<string>;
  readonly ensembles: Set<string>;

  /** Per-session identity override from set_user_identity. */
  userIdentity?: SessionUserIdentity;

  /**
   * Per-session activation persistence store.
   * Set by the Container when the session is created.
   * Used by ElementCRUDHandler to persist activation changes
   * to the correct session's file.
   */
  activationStore?: import('./IActivationStateStore.js').IActivationStateStore;
}

/**
 * Create a fresh SessionActivationState with empty Sets.
 */
export function createSessionActivationState(sessionId: string): SessionActivationState {
  return {
    sessionId,
    personas: new Set(),
    skills: new Set(),
    agents: new Set(),
    memories: new Set(),
    ensembles: new Set(),
    userIdentity: undefined,
  };
}

/**
 * Registry mapping sessionId → SessionActivationState.
 *
 * Singleton service injected into all element managers.
 * Managers resolve the current session's state at call time via
 * ContextTracker, then look it up here.
 *
 * The registry handles:
 * - Lazy creation of session state (getOrCreate)
 * - Cleanup on session disconnect (dispose)
 * - Default session ID for background operations with no request context
 */
export class SessionActivationRegistry {
  private readonly sessions = new Map<string, SessionActivationState>();
  private readonly defaultId: string;

  constructor(defaultSessionId: string) {
    this.defaultId = defaultSessionId;
  }

  /**
   * Get or create activation state for a session.
   * Creates a fresh state with empty Sets on first access.
   */
  getOrCreate(sessionId: string): SessionActivationState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = createSessionActivationState(sessionId);
      this.sessions.set(sessionId, state);
      logger.debug(`[SessionActivationRegistry] Created activation state for session '${sessionId}'`);
    }
    return state;
  }

  /**
   * Get activation state for a session, or undefined if not registered.
   */
  get(sessionId: string): SessionActivationState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Remove a session's activation state (called on disconnect).
   * Does not close any backing stores — caller owns store lifetime.
   */
  dispose(sessionId: string): void {
    if (this.sessions.delete(sessionId)) {
      logger.debug(`[SessionActivationRegistry] Disposed activation state for session '${sessionId}'`);
    }
  }

  /**
   * Get the default session ID (stdio session).
   * Used as fallback when no SessionContext is available
   * (background tasks, auto-load, startup).
   */
  getDefaultSessionId(): string {
    return this.defaultId;
  }

  /**
   * Number of active sessions.
   */
  get size(): number {
    return this.sessions.size;
  }
}
