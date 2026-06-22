/**
 * Database-Backed Agent State Store
 *
 * Persists agent runtime state (goals, decisions, context) to the
 * agent_states table. Replaces .state.yaml files in database mode.
 * Uses optimistic locking via the state_version column.
 *
 * All queries are RLS-scoped via withUserContext/withUserRead.
 *
 * @since v2.2.0 — Phase 4, Step 4.3
 */

import { eq, and } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import type { DatabaseInstance } from '../database/connection.js';
import { withUserContext, withUserRead } from '../database/rls.js';
import { agentStates } from '../database/schema/agents.js';
import type { SessionIdResolver, UserIdResolver } from '../database/UserContext.js';
import type { AgentState } from '../elements/agents/types.js';
import type { AgentStateKey, IAgentStateStore } from './IAgentStateStore.js';

// ── Types ───────────────────────────────────────────────────────────

interface AgentStateData {
  goals: unknown[];
  decisions: unknown[];
  context: Record<string, unknown>;
  stateVersion: number;
  sessionCount?: number;
  lastActive?: Date | null;
}

// ── Implementation ──────────────────────────────────────────────────

export class DatabaseAgentStateStore implements IAgentStateStore {
  private readonly db: DatabaseInstance;
  private readonly getCurrentUserId: UserIdResolver;
  private readonly getCurrentSessionId: SessionIdResolver;

  constructor(
    db: DatabaseInstance,
    getCurrentUserId: UserIdResolver,
    getCurrentSessionId: SessionIdResolver = () => 'default',
  ) {
    this.db = db;
    this.getCurrentUserId = getCurrentUserId;
    this.getCurrentSessionId = getCurrentSessionId;
  }

  /** Resolved per call — reads from the active session's user context. */
  private get userId(): string {
    return this.getCurrentUserId();
  }

  /** Resolved per call — scopes runtime state to the active MCP session. */
  private get sessionId(): string {
    return this.getCurrentSessionId();
  }

  /**
   * Load agent state from the database.
   * Returns null if no state exists for this agent.
   */
  async load(key: AgentStateKey): Promise<AgentState | null> {
    const state = await this.loadData(key.agentElementId);
    return state ? this.toAgentState(state) : null;
  }

  async save(
    key: AgentStateKey,
    state: AgentState,
    expectedVersion: number,
  ): Promise<number> {
    return this.saveData(key.agentElementId, this.fromAgentState(state), expectedVersion);
  }

  async delete(key: AgentStateKey): Promise<void> {
    await this.deleteData(key.agentElementId);
  }

  async loadState(agentElementId: string): Promise<AgentStateData | null> {
    return this.loadData(agentElementId);
  }

  async saveState(
    agentElementId: string,
    state: AgentStateData,
    expectedVersion: number,
  ): Promise<number> {
    return this.saveData(agentElementId, state, expectedVersion);
  }

  async deleteState(agentElementId: string): Promise<void> {
    return this.deleteData(agentElementId);
  }

  private async loadData(agentElementId: string): Promise<AgentStateData | null> {
    return withUserRead(this.db, this.userId, async (tx) => {
      // Defense-in-depth: userId filter alongside RLS enforcement.
      const rows = await tx
        .select({
          goals: agentStates.goals,
          decisions: agentStates.decisions,
          context: agentStates.context,
          lastActive: agentStates.lastActive,
          stateVersion: agentStates.stateVersion,
          sessionCount: agentStates.sessionCount,
        })
        .from(agentStates)
        .where(and(
          eq(agentStates.userId, this.userId),
          eq(agentStates.agentId, agentElementId),
          eq(agentStates.sessionId, this.sessionId),
        ))
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      return {
        goals: Array.isArray(row.goals) ? row.goals : [],
        decisions: Array.isArray(row.decisions) ? row.decisions : [],
        context: row.context && typeof row.context === 'object' && !Array.isArray(row.context)
          ? row.context as Record<string, unknown>
          : {},
        lastActive: row.lastActive,
        stateVersion: row.stateVersion,
        sessionCount: row.sessionCount,
      };
    });
  }

  /**
   * Save agent state with optimistic locking.
   * The state_version column acts as a concurrency guard — if the current
   * version in the DB doesn't match expectedVersion, the save is rejected.
   *
   * @returns The new state version after successful save
   * @throws If a version conflict is detected (concurrent modification)
   */
  private async saveData(
    agentElementId: string,
    state: AgentStateData,
    expectedVersion: number,
  ): Promise<number> {
    const newVersion = expectedVersion + 1;

    return withUserContext(this.db, this.userId, async (tx) => {
      // SELECT FOR UPDATE: acquire row-level lock to prevent concurrent
      // readers from both passing the version check (TOCTOU prevention).
      const existing = await tx
        .select({ stateVersion: agentStates.stateVersion })
        .from(agentStates)
        .where(and(
          eq(agentStates.userId, this.userId),
          eq(agentStates.agentId, agentElementId),
          eq(agentStates.sessionId, this.sessionId),
        ))
        .for('update')
        .limit(1);

      if (existing.length === 0) {
        // No existing row — this is a first-time save
        if (expectedVersion !== 0) {
          throw new Error(
            `State version conflict for agent ${agentElementId}: ` +
            `expected version ${expectedVersion} but no state exists (expected 0 for initial save).`,
          );
        }

        await tx.insert(agentStates).values({
          agentId: agentElementId,
          userId: this.userId,
          sessionId: this.sessionId,
          goals: state.goals,
          decisions: state.decisions,
          context: state.context,
          stateVersion: newVersion,
          sessionCount: (state.sessionCount ?? 0) + 1,
          lastActive: state.lastActive ?? new Date(),
        });

        return newVersion;
      }

      // Optimistic lock check (the FOR UPDATE lock ensures no concurrent
      // writer can interleave between this check and the UPDATE below)
      if (existing[0].stateVersion !== expectedVersion) {
        throw new Error(
          `State version conflict for agent ${agentElementId}: ` +
          `expected version ${expectedVersion}, current version is ${existing[0].stateVersion}.`,
        );
      }

      // Version in WHERE clause as defense-in-depth belt-and-suspenders
      const updated = await tx
        .update(agentStates)
        .set({
          goals: state.goals,
          decisions: state.decisions,
          context: state.context,
          stateVersion: newVersion,
          sessionCount: (state.sessionCount ?? 0) + 1,
          lastActive: state.lastActive ?? new Date(),
        })
        .where(and(
          eq(agentStates.userId, this.userId),
          eq(agentStates.agentId, agentElementId),
          eq(agentStates.sessionId, this.sessionId),
          eq(agentStates.stateVersion, expectedVersion),
        ))
        .returning({ id: agentStates.id });

      if (updated.length === 0) {
        throw new Error(
          `State version conflict for agent ${agentElementId}: ` +
          `version changed between check and update (concurrent modification).`,
        );
      }

      return newVersion;
    });
  }

  /**
   * Delete agent state. Called when the agent element is deleted.
   */
  private async deleteData(agentElementId: string): Promise<void> {
    await withUserContext(this.db, this.userId, async (tx) => {
      // Defense-in-depth: userId filter alongside RLS.
      await tx.delete(agentStates).where(and(
        eq(agentStates.userId, this.userId),
        eq(agentStates.agentId, agentElementId),
        eq(agentStates.sessionId, this.sessionId),
      ));
    });

    logger.debug(`[DatabaseAgentStateStore] Deleted state for agent ${agentElementId}`);
  }

  private toAgentState(state: AgentStateData): AgentState {
    const agentState = {
      goals: Array.isArray(state.goals) ? state.goals : [],
      decisions: Array.isArray(state.decisions) ? state.decisions : [],
      context: state.context && typeof state.context === 'object' && !Array.isArray(state.context)
        ? state.context
        : {},
      lastActive: state.lastActive ? new Date(state.lastActive) : new Date(),
      sessionCount: state.sessionCount ?? 0,
      stateVersion: state.stateVersion,
    } as AgentState;

    this.normalizeDates(agentState);
    return agentState;
  }

  private fromAgentState(state: AgentState): AgentStateData {
    return {
      goals: state.goals ?? [],
      decisions: state.decisions ?? [],
      context: state.context ?? {},
      lastActive: state.lastActive instanceof Date ? state.lastActive : new Date(state.lastActive ?? Date.now()),
      sessionCount: state.sessionCount ?? 0,
      stateVersion: state.stateVersion ?? 0,
    };
  }

  private normalizeDates(state: AgentState): void {
    state.goals.forEach((goal) => {
      if (goal.createdAt) goal.createdAt = new Date(goal.createdAt);
      if (goal.updatedAt) goal.updatedAt = new Date(goal.updatedAt);
      if (goal.completedAt) goal.completedAt = new Date(goal.completedAt);
    });
    state.decisions.forEach((decision) => {
      if (decision.timestamp) decision.timestamp = new Date(decision.timestamp);
    });
  }
}
