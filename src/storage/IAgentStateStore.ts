import type { AgentState } from '../elements/agents/types.js';

/**
 * Identity for an agent's runtime state. File-backed stores use the logical
 * name; database-backed stores use the persisted element UUID.
 */
export interface AgentStateKey {
  readonly name: string;
  readonly agentElementId: string;
  /** Durable transport-session identity; required for cross-session recovery in DB mode. */
  readonly sessionId?: string;
}

export interface AgentStateLoadOptions {
  /** Bypass process-local caches and surface storage failures. */
  strict?: boolean;
}

export interface AgentStateSaveOptions {
  /** Require an existing durable state at exactly expectedVersion. */
  requireExisting?: boolean;
  /** Recovery/snapshot writes preserve the supplied durable session counter. */
  preserveSessionCount?: boolean;
}

export interface AgentStateDeleteOptions {
  /** Reject deletion unless the durable row/file has this version. */
  readonly expectedVersion?: number;
  /** Reject deletion when no durable state exists. */
  readonly requireExisting?: boolean;
}

export interface AgentStateReclaimOptions {
  /** Goal IDs still owned by live transport sessions and therefore ineligible. */
  readonly excludedGoalIds?: readonly string[];
}

export interface IAgentStateStore {
  /** Returns null when no persisted runtime state exists for this agent. */
  load(key: AgentStateKey, options?: AgentStateLoadOptions): Promise<AgentState | null>;

  /**
   * Claim durable state left by a disconnected transport session.
   * Database stores transfer session ownership atomically after checking
   * durable presence. Stores without trustworthy ownership data fail closed.
   */
  reclaimOrphaned(
    key: AgentStateKey,
    options?: AgentStateReclaimOptions,
  ): Promise<AgentState | null>;

  /**
   * Save with optimistic locking.
   *
   * @param expectedVersion version the caller believes is current (0 = first save)
   * @returns the new version after a successful save
   */
  save(
    key: AgentStateKey,
    state: AgentState,
    expectedVersion: number,
    options?: AgentStateSaveOptions,
  ): Promise<number>;

  delete(key: AgentStateKey, options?: AgentStateDeleteOptions): Promise<boolean>;
}
