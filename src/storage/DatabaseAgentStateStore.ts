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

import { eq, and, desc, lte, sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { withSystemContext } from '../database/admin.js';
import type { DatabaseInstance } from '../database/connection.js';
import type { DrizzleTx } from '../database/db-utils.js';
import { withUserContext, withUserRead } from '../database/rls.js';
import { agentStates } from '../database/schema/agents.js';
import { runtimeSessionPresence } from '../database/schema/webConsole.js';
import type { SessionIdResolver, UserIdResolver } from '../database/UserContext.js';
import type { AgentState } from '../elements/agents/types.js';
import type {
  AgentStateKey,
  AgentStateDeleteOptions,
  AgentStateSaveOptions,
  AgentStateReclaimOptions,
  IAgentStateStore,
} from './IAgentStateStore.js';
import { withAgentReplacementTransactionOr } from './AgentReplacementTransactionContext.js';

// ── Types ───────────────────────────────────────────────────────────

interface AgentStateData {
  goals: unknown[];
  decisions: unknown[];
  context: Record<string, unknown>;
  stateVersion: number;
  sessionCount?: number;
  lastActive?: Date | null;
}

interface AgentStateRow {
  id: string;
  sessionId: string;
  goals: unknown;
  decisions: unknown;
  context: unknown;
  lastActive: Date | null;
  stateVersion: number;
  sessionCount: number;
}

const AGENT_STATE_ROW_COLUMNS = {
  id: agentStates.id,
  sessionId: agentStates.sessionId,
  goals: agentStates.goals,
  decisions: agentStates.decisions,
  context: agentStates.context,
  lastActive: agentStates.lastActive,
  stateVersion: agentStates.stateVersion,
  sessionCount: agentStates.sessionCount,
} as const;

export type AgentSessionActivity = 'active' | 'inactive' | 'unknown';

export type AgentSessionActivityResolver = (
  sessionId: string,
  userId: string,
  tx: DrizzleTx,
) => Promise<AgentSessionActivity>;

// ── Implementation ──────────────────────────────────────────────────

export class DatabaseAgentStateStore implements IAgentStateStore {
  private readonly db: DatabaseInstance;
  private readonly getCurrentUserId: UserIdResolver;
  private readonly getCurrentSessionId: SessionIdResolver;

  constructor(
    db: DatabaseInstance,
    getCurrentUserId: UserIdResolver,
    getCurrentSessionId: SessionIdResolver = () => 'default',
    private readonly resolveSessionActivity?: AgentSessionActivityResolver,
    private readonly reclaimDb: DatabaseInstance = db,
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
    const state = await this.loadData(key.agentElementId, key.sessionId ?? this.sessionId);
    return state ? this.toAgentState(state) : null;
  }

  async reclaimOrphaned(
    key: AgentStateKey,
    options: AgentStateReclaimOptions = {},
  ): Promise<AgentState | null> {
    const state = await this.reclaimOrphanedData(
      key.agentElementId,
      new Set(options.excludedGoalIds ?? []),
    );
    return state ? this.toAgentState(state) : null;
  }

  async save(
    key: AgentStateKey,
    state: AgentState,
    expectedVersion: number,
    options: AgentStateSaveOptions = {},
  ): Promise<number> {
    return this.saveData(
      key.agentElementId,
      this.fromAgentState(state),
      expectedVersion,
      key.sessionId ?? this.sessionId,
      options,
    );
  }

  async delete(
    key: AgentStateKey,
    options: AgentStateDeleteOptions = {},
  ): Promise<boolean> {
    return this.deleteData(key.agentElementId, options, key.sessionId ?? this.sessionId);
  }

  async loadState(agentElementId: string): Promise<AgentStateData | null> {
    return this.loadData(agentElementId, this.sessionId);
  }

  async saveState(
    agentElementId: string,
    state: AgentStateData,
    expectedVersion: number,
  ): Promise<number> {
    return this.saveData(agentElementId, state, expectedVersion, this.sessionId);
  }

  async deleteState(
    agentElementId: string,
    options: AgentStateDeleteOptions = {},
  ): Promise<boolean> {
    return this.deleteData(agentElementId, options, this.sessionId);
  }

  private async loadData(
    agentElementId: string,
    sessionId: string,
  ): Promise<AgentStateData | null> {
    const userId = this.userId;
    return withAgentReplacementTransactionOr(
      userId,
      operation => withUserRead(this.db, userId, operation),
      async (tx) => {
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
          eq(agentStates.userId, userId),
          eq(agentStates.agentId, agentElementId),
          eq(agentStates.sessionId, sessionId),
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
      },
    );
  }

  /**
   * Transfer a disconnected session's state row to the calling session.
   *
   * The user filter and RLS preserve tenant isolation. Row locks serialize
   * competing claims, while the runtime-presence resolver prevents a row that
   * still belongs to a live session (including another replica) from moving.
   * Without a presence resolver, cross-session claims fail closed.
   */
  private async reclaimOrphanedData(
    agentElementId: string,
    excludedGoalIds: ReadonlySet<string>,
  ): Promise<AgentStateData | null> {
    const userId = this.userId;
    const sessionId = this.sessionId;

    const rows = await this.loadAgentRows(userId, agentElementId);

    const current = rows.find(row => row.sessionId === sessionId);
    if (current && this.hasClaimableGoals(current.goals, excludedGoalIds)) {
      return this.rowToStateData(current);
    }
    if (!this.resolveSessionActivity) {
      logger.warn('[DatabaseAgentStateStore] Orphan reclaim unavailable without runtime presence');
      return null;
    }

    for (const candidate of rows) {
      if (candidate.sessionId === sessionId) {
        continue;
      }
      if (!this.hasClaimableGoals(candidate.goals, excludedGoalIds)) {
        continue;
      }
      const transferredState = await this.tryTransferCandidate({
        candidate,
        userId,
        agentElementId,
        targetSessionId: sessionId,
        excludedGoalIds,
      });
      if (!transferredState) {
        continue;
      }

      logger.info('[DatabaseAgentStateStore] Transferred orphaned agent state', {
        agentElementId,
        fromSessionId: candidate.sessionId,
        toSessionId: sessionId,
        goalIds: this.getActiveGoalIds(transferredState.goals),
      });
      return this.rowToStateData(transferredState);
    }

    return null;
  }

  private async loadAgentRows(userId: string, agentElementId: string): Promise<AgentStateRow[]> {
    return withUserRead(this.db, userId, async (tx) =>
      tx
        .select(AGENT_STATE_ROW_COLUMNS)
        .from(agentStates)
        .where(and(
          eq(agentStates.userId, userId),
          eq(agentStates.agentId, agentElementId),
        ))
        .orderBy(desc(agentStates.lastActive), agentStates.sessionId),
    );
  }

  private async tryTransferCandidate(input: {
    candidate: AgentStateRow;
    userId: string;
    agentElementId: string;
    targetSessionId: string;
    excludedGoalIds: ReadonlySet<string>;
  }): Promise<AgentStateRow | null> {
    // Reclaim is a control-plane operation. Use the system connection so the
    // presence row and tenant-filtered agent rows are verified and locked in
    // one transaction, without nesting another transaction on a pool of one.
    return withSystemContext(this.reclaimDb, async (tx) => {
      if (
        !this.resolveSessionActivity ||
        await this.resolveSessionActivity(
          input.candidate.sessionId,
          input.userId,
          tx,
        ) !== 'inactive'
      ) {
        return null;
      }
      if (!await claimInactiveRuntimePresenceForReclaimWithTx(
        tx,
        input.candidate.sessionId,
        input.userId,
      )) {
        return null;
      }

      const lockedCurrent = await this.lockCurrentSessionRow(tx, input);
      if (lockedCurrent && this.getActiveGoalIds(lockedCurrent.goals).length > 0) {
        return null;
      }

      const locked = await this.lockCandidateRow(tx, input);
      if (!locked || !this.hasClaimableGoals(locked.goals, input.excludedGoalIds)) {
        return null;
      }
      if (lockedCurrent) {
        return this.mergeCandidateIntoCurrent(tx, input, lockedCurrent, locked);
      }

      const transferred = await tx
        .update(agentStates)
        .set({ sessionId: input.targetSessionId })
        .where(and(
          eq(agentStates.id, locked.id),
          eq(agentStates.userId, input.userId),
          eq(agentStates.agentId, input.agentElementId),
          eq(agentStates.sessionId, input.candidate.sessionId),
        ))
        .returning({ id: agentStates.id });
      return transferred.length > 0 ? locked : null;
    });
  }

  private async lockCurrentSessionRow(
    tx: DrizzleTx,
    input: {
      userId: string;
      agentElementId: string;
      targetSessionId: string;
    },
  ): Promise<AgentStateRow | null> {
    const rows = await tx
      .select(AGENT_STATE_ROW_COLUMNS)
      .from(agentStates)
      .where(and(
        eq(agentStates.userId, input.userId),
        eq(agentStates.agentId, input.agentElementId),
        eq(agentStates.sessionId, input.targetSessionId),
      ))
      .for('update')
      .limit(1);
    return rows[0] ?? null;
  }

  private async lockCandidateRow(
    tx: DrizzleTx,
    input: { candidate: AgentStateRow; userId: string; agentElementId: string },
  ): Promise<AgentStateRow | null> {
    const rows = await tx
      .select(AGENT_STATE_ROW_COLUMNS)
      .from(agentStates)
      .where(and(
        eq(agentStates.id, input.candidate.id),
        eq(agentStates.userId, input.userId),
        eq(agentStates.agentId, input.agentElementId),
        eq(agentStates.sessionId, input.candidate.sessionId),
      ))
      .for('update')
      .limit(1);
    return rows[0] ?? null;
  }

  private async mergeCandidateIntoCurrent(
    tx: DrizzleTx,
    input: {
      candidate: AgentStateRow;
      userId: string;
      agentElementId: string;
      targetSessionId: string;
    },
    current: AgentStateRow,
    candidate: AgentStateRow,
  ): Promise<AgentStateRow> {
    const merged = this.mergeStateRows(current, candidate);
    const updated = await tx
      .update(agentStates)
      .set({
        goals: merged.goals,
        decisions: merged.decisions,
        context: merged.context,
        lastActive: merged.lastActive,
        stateVersion: merged.stateVersion,
        sessionCount: merged.sessionCount,
      })
      .where(and(
        eq(agentStates.id, current.id),
        eq(agentStates.userId, input.userId),
        eq(agentStates.agentId, input.agentElementId),
        eq(agentStates.sessionId, input.targetSessionId),
      ))
      .returning(AGENT_STATE_ROW_COLUMNS);
    if (!updated[0]) {
      throw new Error('Current agent state disappeared while reclaiming orphaned execution');
    }

    const deleted = await tx
      .delete(agentStates)
      .where(and(
        eq(agentStates.id, candidate.id),
        eq(agentStates.userId, input.userId),
        eq(agentStates.agentId, input.agentElementId),
        eq(agentStates.sessionId, input.candidate.sessionId),
      ))
      .returning({ id: agentStates.id });
    if (!deleted[0]) {
      throw new Error('Orphaned agent state disappeared while merging execution ownership');
    }
    return updated[0];
  }

  private mergeStateRows(current: AgentStateRow, candidate: AgentStateRow): AgentStateRow {
    return {
      ...current,
      goals: this.mergeStateArrays(current.goals, candidate.goals),
      decisions: this.mergeStateArrays(current.decisions, candidate.decisions),
      context: {
        ...this.toRecord(current.context),
        ...this.toRecord(candidate.context),
      },
      lastActive: this.latestDate(current.lastActive, candidate.lastActive),
      stateVersion: Math.max(current.stateVersion, candidate.stateVersion) + 1,
      sessionCount: Math.max(current.sessionCount, candidate.sessionCount),
    };
  }

  private mergeStateArrays(current: unknown, candidate: unknown): unknown[] {
    const merged = Array.isArray(current) ? [...current] : [];
    const positions = new Map<string, number>();
    merged.forEach((value, index) => {
      const id = this.getRecordId(value);
      if (id) positions.set(id, index);
    });
    for (const value of Array.isArray(candidate) ? candidate : []) {
      const id = this.getRecordId(value);
      const existingIndex = id ? positions.get(id) : undefined;
      if (existingIndex === undefined) {
        if (id) positions.set(id, merged.length);
        merged.push(value);
      } else {
        merged[existingIndex] = value;
      }
    }
    return merged;
  }

  private getRecordId(value: unknown): string | undefined {
    return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
      ? value.id
      : undefined;
  }

  private toRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private latestDate(left: Date | null, right: Date | null): Date | null {
    if (!left) return right;
    if (!right) return left;
    return left > right ? left : right;
  }

  private hasClaimableGoals(goals: unknown, excludedGoalIds: ReadonlySet<string>): boolean {
    const activeGoalIds = this.getActiveGoalIds(goals);
    return activeGoalIds.length > 0 &&
      !activeGoalIds.some(goalId => excludedGoalIds.has(goalId));
  }

  private getActiveGoalIds(goals: unknown): string[] {
    if (!Array.isArray(goals)) {
      return [];
    }
    return goals.flatMap((goal) => {
      if (
        typeof goal === 'object' &&
        goal !== null &&
        'id' in goal &&
        typeof goal.id === 'string' &&
        'status' in goal &&
        goal.status === 'in_progress'
      ) {
        return [goal.id];
      }
      return [];
    });
  }

  private rowToStateData(row: Omit<AgentStateRow, 'id' | 'sessionId'>): AgentStateData {
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
    sessionId: string,
    options: AgentStateSaveOptions = {},
  ): Promise<number> {
    const newVersion = expectedVersion + 1;

    const userId = this.userId;
    return withAgentReplacementTransactionOr(
      userId,
      operation => withUserContext(this.db, userId, operation),
      async (tx) => {
      // SELECT FOR UPDATE: acquire row-level lock to prevent concurrent
      // readers from both passing the version check (TOCTOU prevention).
      const existing = await tx
        .select({ stateVersion: agentStates.stateVersion })
        .from(agentStates)
        .where(and(
          eq(agentStates.userId, userId),
          eq(agentStates.agentId, agentElementId),
          eq(agentStates.sessionId, sessionId),
        ))
        .for('update')
        .limit(1);

      if (existing.length === 0) {
        // No existing row — this is a first-time save
        if (options.requireExisting) {
          throw new Error(`Agent state disappeared while saving '${agentElementId}'`);
        }
        if (expectedVersion !== 0) {
          throw new Error(
            `State version conflict for agent ${agentElementId}: ` +
            `expected version ${expectedVersion} but no state exists (expected 0 for initial save).`,
          );
        }

        await tx.insert(agentStates).values({
          agentId: agentElementId,
          userId,
          sessionId,
          goals: state.goals,
          decisions: state.decisions,
          context: state.context,
          stateVersion: newVersion,
          sessionCount: options.preserveSessionCount
            ? state.sessionCount ?? 0
            : (state.sessionCount ?? 0) + 1,
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
          sessionCount: options.preserveSessionCount
            ? state.sessionCount ?? 0
            : (state.sessionCount ?? 0) + 1,
          lastActive: state.lastActive ?? new Date(),
        })
        .where(and(
          eq(agentStates.userId, userId),
          eq(agentStates.agentId, agentElementId),
          eq(agentStates.sessionId, sessionId),
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
      },
    );
  }

  /**
   * Delete agent state. Called when the agent element is deleted.
   */
  private async deleteData(
    agentElementId: string,
    options: AgentStateDeleteOptions,
    sessionId: string,
  ): Promise<boolean> {
    const userId = this.userId;
    const deleted = await withAgentReplacementTransactionOr<boolean>(
      userId,
      operation => withUserContext(this.db, userId, operation),
      async (tx) => {
      const existing = await tx
        .select({ stateVersion: agentStates.stateVersion })
        .from(agentStates)
        .where(and(
          eq(agentStates.userId, userId),
          eq(agentStates.agentId, agentElementId),
          eq(agentStates.sessionId, sessionId),
        ))
        .for('update')
        .limit(1);
      const row = existing[0];
      if (!row) {
        if (options.requireExisting) {
          throw new Error(`Agent state disappeared while deleting '${agentElementId}'`);
        }
        return false;
      }
      if (
        options.expectedVersion !== undefined &&
        row.stateVersion !== options.expectedVersion
      ) {
        throw new Error(
          `State version conflict for agent ${agentElementId}: ` +
          `expected version ${options.expectedVersion}, current version is ${row.stateVersion}.`,
        );
      }
      const removed = await tx.delete(agentStates).where(and(
        eq(agentStates.userId, userId),
        eq(agentStates.agentId, agentElementId),
        eq(agentStates.sessionId, sessionId),
        eq(agentStates.stateVersion, row.stateVersion),
      )).returning({ id: agentStates.id });
      if (removed.length === 0) {
        throw new Error(`Agent state changed concurrently while deleting '${agentElementId}'`);
      }
      return true;
      },
    );

    logger.debug(`[DatabaseAgentStateStore] Deleted state for agent ${agentElementId}`);
    return deleted;
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

/**
 * Atomically retire an expired source-session lease before its agent state is
 * transferred. A delayed heartbeat then observes `closing` and loses
 * ownership instead of reviving an execution that has already moved.
 */
export async function claimInactiveRuntimePresenceForReclaimWithTx(
  tx: DrizzleTx,
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx.select({
    userId: runtimeSessionPresence.userId,
    status: runtimeSessionPresence.status,
    leaseUntil: runtimeSessionPresence.leaseUntil,
    replicaId: runtimeSessionPresence.replicaId,
  }).from(runtimeSessionPresence)
    .where(eq(runtimeSessionPresence.sessionId, sessionId))
    .for('update')
    .limit(1);
  const presence = rows[0];
  if (!presence) return true;
  if (presence.userId !== userId) return false;
  if (presence.status === 'closing') return true;
  const claimed = await tx.update(runtimeSessionPresence).set({
    status: 'closing',
    closedAt: sql<Date>`statement_timestamp()`,
  }).where(and(
    eq(runtimeSessionPresence.sessionId, sessionId),
    eq(runtimeSessionPresence.userId, userId),
    eq(runtimeSessionPresence.replicaId, presence.replicaId),
    eq(runtimeSessionPresence.status, 'active'),
    eq(runtimeSessionPresence.leaseUntil, presence.leaseUntil),
    lte(runtimeSessionPresence.leaseUntil, sql<Date>`statement_timestamp()`),
  )).returning({ sessionId: runtimeSessionPresence.sessionId });
  return claimed.length === 1;
}
