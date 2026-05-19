import type { AgentState } from '../elements/agents/types.js';

/**
 * Identity for an agent's runtime state. File-backed stores use the logical
 * name; database-backed stores use the persisted element UUID.
 */
export interface AgentStateKey {
  readonly name: string;
  readonly agentElementId: string;
}

export interface IAgentStateStore {
  /** Returns null when no persisted runtime state exists for this agent. */
  load(key: AgentStateKey): Promise<AgentState | null>;

  /**
   * Save with optimistic locking.
   *
   * @param expectedVersion version the caller believes is current (0 = first save)
   * @returns the new version after a successful save
   */
  save(key: AgentStateKey, state: AgentState, expectedVersion: number): Promise<number>;

  delete(key: AgentStateKey): Promise<void>;
}
