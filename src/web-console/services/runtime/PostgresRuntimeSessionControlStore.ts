import { and, desc, eq, gt, isNull, lt, notExists, sql, type SQL } from 'drizzle-orm';

import { withSystemContext } from '../../../database/admin.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import type { DrizzleTx } from '../../../database/db-utils.js';
import {
  runtimeControlAcks,
  runtimeControlCommands,
  runtimeSessionPresence,
  agentStates,
} from '../../../database/schema/index.js';
import type {
  IRuntimeSessionControlStore,
  RuntimeOperationalListQuery,
  RuntimeOperationalPresencePage,
  RuntimeSessionHeartbeatInput,
  RuntimeSessionHeartbeatResult,
  RuntimeSessionListQuery,
  RuntimeSessionPresence,
  RuntimeSessionPresenceInput,
  RuntimeTerminationAck,
  RuntimeTerminationAckInput,
  RuntimeTerminationCommand,
  RuntimeTerminationCommandInput,
} from './IRuntimeSessionControlStore.js';
import {
  cloneRuntimeSessionPresence,
  cloneRuntimeTerminationAck,
  cloneRuntimeTerminationCommand,
  validateRuntimeListQuery,
  validateRuntimeOperationalListQuery,
  validateRuntimeSessionHeartbeatInput,
  validateRuntimeSessionPresenceInput,
  validateRuntimeTerminationAckInput,
  validateRuntimeTerminationCommandInput,
  validateSessionId,
} from './IRuntimeSessionControlStore.js';
import { assertUuid } from '../../stores/ConsoleStoreValidation.js';
import { validateReplicaId } from '../invalidation/IConsoleSecurityInvalidationStore.js';

export class PostgresRuntimeSessionControlStore implements IRuntimeSessionControlStore {
  constructor(private readonly db: DatabaseInstance) {}

  async registerPresence(input: RuntimeSessionPresenceInput): Promise<RuntimeSessionPresence> {
    return withSystemContext(this.db, tx => registerRuntimePresenceWithTx(tx, input));
  }

  async heartbeatPresence(input: RuntimeSessionHeartbeatInput): Promise<RuntimeSessionHeartbeatResult> {
    return withSystemContext(this.db, tx => heartbeatRuntimePresenceWithTx(tx, input));
  }

  async markPresenceClosing(sessionId: string, closedAt: Date): Promise<RuntimeSessionPresence | null> {
    return withSystemContext(this.db, tx => markRuntimePresenceClosingWithTx(tx, sessionId, closedAt));
  }

  async sweepStalePresence(before: Date = new Date()): Promise<number> {
    const rows = await withSystemContext(this.db, tx =>
      tx.delete(runtimeSessionPresence)
        .where(and(
          lt(runtimeSessionPresence.leaseUntil, before),
          notExists(
            tx.select({ id: agentStates.id })
              .from(agentStates)
              .where(and(
                eq(agentStates.sessionId, runtimeSessionPresence.sessionId),
                sql`EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(
                    CASE
                      WHEN jsonb_typeof(${agentStates.goals}) = 'array' THEN ${agentStates.goals}
                      ELSE '[]'::jsonb
                    END
                  ) AS goal
                  WHERE goal->>'status' = 'in_progress'
                )`,
              )),
          ),
        ))
        .returning({ sessionId: runtimeSessionPresence.sessionId }),
    );
    return rows.length;
  }

  async findPresence(sessionId: string, now: Date = new Date()): Promise<RuntimeSessionPresence | null> {
    validateSessionId(sessionId);
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(runtimeSessionPresence)
        .where(and(
          eq(runtimeSessionPresence.sessionId, sessionId),
          eq(runtimeSessionPresence.status, 'active'),
          gt(runtimeSessionPresence.leaseUntil, now),
        ))
        .limit(1),
    );
    return rows[0] ? fromPresenceRow(rows[0]) : null;
  }

  /**
   * Read the durable presence record without applying visibility filters.
   * Callers use this to distinguish a known closed/expired session from a
   * session whose presence was never recorded.
   */
  async findRecordedPresence(sessionId: string): Promise<RuntimeSessionPresence | null> {
    validateSessionId(sessionId);
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(runtimeSessionPresence)
        .where(eq(runtimeSessionPresence.sessionId, sessionId))
        .limit(1),
    );
    return rows[0] ? fromPresenceRow(rows[0]) : null;
  }

  async listPresenceByUser(
    userId: string,
    query: RuntimeSessionListQuery = {},
  ): Promise<RuntimeSessionPresence[]> {
    assertUuid(userId, 'userId');
    const parsed = validateRuntimeListQuery(query);
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(runtimeSessionPresence)
        .where(and(
          eq(runtimeSessionPresence.userId, userId),
          eq(runtimeSessionPresence.status, 'active'),
          gt(runtimeSessionPresence.leaseUntil, parsed.now),
        ))
        .orderBy(desc(runtimeSessionPresence.lastActiveAt), runtimeSessionPresence.sessionId)
        .limit(parsed.limit),
    );
    return rows.map(row => fromPresenceRow(row));
  }

  // Known limitation: the keyset sorts/cursors on last_active_at, which a heartbeat
  // mutates. A session that heartbeats above the page cursor between page requests can
  // be skipped from a full paged sweep — acceptable for a live operational snapshot
  // (it re-appears near the top on the next sweep), but callers doing an exhaustive
  // cross-page audit should be aware it is best-effort, not a consistent point-in-time cut.
  async listOperationalPresence(query: RuntimeOperationalListQuery = {}): Promise<RuntimeOperationalPresencePage> {
    const parsed = validateRuntimeOperationalListQuery(query);
    const conditions: SQL[] = [
      eq(runtimeSessionPresence.status, parsed.status ?? 'active'),
      gt(runtimeSessionPresence.leaseUntil, parsed.now),
    ];
    if (parsed.userId) conditions.push(eq(runtimeSessionPresence.userId, parsed.userId));
    if (parsed.after) {
      conditions.push(sql`(${runtimeSessionPresence.lastActiveAt}, ${runtimeSessionPresence.sessionId}) < (${parsed.after.lastActiveAt}::timestamptz, ${parsed.after.sessionId})`);
    }
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(runtimeSessionPresence)
        .where(and(...conditions))
        .orderBy(desc(runtimeSessionPresence.lastActiveAt), desc(runtimeSessionPresence.sessionId))
        .limit(parsed.limit + 1),
    );
    const items = rows.slice(0, parsed.limit).map(row => fromPresenceRow(row));
    const last = items.at(-1);
    const nextCursor = rows.length > parsed.limit && last
      ? { lastActiveAt: last.lastActiveAt, sessionId: last.sessionId }
      : null;
    return { items, nextCursor };
  }

  async createTerminationCommand(input: RuntimeTerminationCommandInput): Promise<RuntimeTerminationCommand> {
    return withSystemContext(this.db, tx => createRuntimeTerminationCommandWithTx(tx, input));
  }

  async listPendingCommandsForReplica(
    replicaId: string,
    query: RuntimeSessionListQuery = {},
  ): Promise<RuntimeTerminationCommand[]> {
    validateReplicaId(replicaId);
    const parsed = validateRuntimeListQuery(query);
    const rows = await withSystemContext(this.db, tx =>
      tx.select({ command: runtimeControlCommands })
        .from(runtimeControlCommands)
        .leftJoin(runtimeControlAcks, eq(runtimeControlCommands.commandId, runtimeControlAcks.commandId))
        .where(and(
          eq(runtimeControlCommands.targetReplicaId, replicaId),
          isNull(runtimeControlAcks.commandId),
        ))
        .orderBy(runtimeControlCommands.requestedAt)
        .limit(parsed.limit),
    );
    return rows.map(row => fromCommandRow(row.command));
  }

  async acknowledgeCommand(input: RuntimeTerminationAckInput): Promise<boolean> {
    return withSystemContext(this.db, tx => acknowledgeRuntimeCommandWithTx(tx, input));
  }

  async getCommandAck(commandId: string): Promise<RuntimeTerminationAck | null> {
    assertUuid(commandId, 'commandId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(runtimeControlAcks)
        .where(eq(runtimeControlAcks.commandId, commandId))
        .limit(1),
    );
    return rows[0] ? fromAckRow(rows[0]) : null;
  }

  async getCommand(commandId: string): Promise<RuntimeTerminationCommand | null> {
    assertUuid(commandId, 'commandId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(runtimeControlCommands)
        .where(eq(runtimeControlCommands.commandId, commandId))
        .limit(1),
    );
    return rows[0] ? fromCommandRow(rows[0]) : null;
  }
}

export async function registerRuntimePresenceWithTx(
  tx: DrizzleTx,
  input: RuntimeSessionPresenceInput,
): Promise<RuntimeSessionPresence> {
  validateRuntimeSessionPresenceInput(input);
  const insert = toPresenceInsert(input);
  const rows = await tx.insert(runtimeSessionPresence).values(insert)
    .onConflictDoUpdate({
      target: runtimeSessionPresence.sessionId,
      // Last registration wins. The prior replica discovers ownership loss
      // because subsequent heartbeats return `replica_mismatch`.
      set: insert,
    })
    .returning();
  return fromPresenceRow(rows[0]);
}

export async function heartbeatRuntimePresenceWithTx(
  tx: DrizzleTx,
  input: RuntimeSessionHeartbeatInput,
): Promise<RuntimeSessionHeartbeatResult> {
  validateRuntimeSessionHeartbeatInput(input);
  const rows = await tx.update(runtimeSessionPresence).set({
    lastActiveAt: input.lastActiveAt,
    requestCount: input.requestCount,
    errorCount: input.errorCount,
    leaseUntil: input.leaseUntil,
  }).where(and(
    eq(runtimeSessionPresence.sessionId, input.sessionId),
    eq(runtimeSessionPresence.replicaId, input.replicaId),
    eq(runtimeSessionPresence.status, 'active'),
  )).returning();
  if (rows[0]) return { kind: 'updated', presence: fromPresenceRow(rows[0]) };

  const current = await tx.select({
    replicaId: runtimeSessionPresence.replicaId,
    status: runtimeSessionPresence.status,
  }).from(runtimeSessionPresence)
    .where(eq(runtimeSessionPresence.sessionId, input.sessionId))
    .limit(1);
  if (!current[0]) return { kind: 'lost', reason: 'missing' };
  if (current[0].replicaId !== input.replicaId) return { kind: 'lost', reason: 'replica_mismatch' };
  return { kind: 'lost', reason: 'closing' };
}

export async function markRuntimePresenceClosingWithTx(
  tx: DrizzleTx,
  sessionId: string,
  closedAt: Date,
): Promise<RuntimeSessionPresence | null> {
  validateSessionId(sessionId);
  const rows = await tx.update(runtimeSessionPresence).set({
    status: 'closing',
    closedAt,
  }).where(eq(runtimeSessionPresence.sessionId, sessionId)).returning();
  return rows[0] ? fromPresenceRow(rows[0]) : null;
}

export async function findRecordedRuntimePresenceWithTx(
  tx: DrizzleTx,
  sessionId: string,
): Promise<RuntimeSessionPresence | null> {
  validateSessionId(sessionId);
  const rows = await tx.select().from(runtimeSessionPresence)
    .where(eq(runtimeSessionPresence.sessionId, sessionId))
    .for('update')
    .limit(1);
  return rows[0] ? fromPresenceRow(rows[0]) : null;
}

export async function createRuntimeTerminationCommandWithTx(
  tx: DrizzleTx,
  input: RuntimeTerminationCommandInput,
): Promise<RuntimeTerminationCommand> {
  validateRuntimeTerminationCommandInput(input);
  const rows = await tx.insert(runtimeControlCommands).values(toCommandInsert(input)).returning();
  return fromCommandRow(rows[0]);
}

export async function acknowledgeRuntimeCommandWithTx(
  tx: DrizzleTx,
  input: RuntimeTerminationAckInput,
): Promise<boolean> {
  validateRuntimeTerminationAckInput(input);
  const rows = await tx.insert(runtimeControlAcks).values({
    commandId: input.commandId,
    replicaId: input.replicaId,
    acknowledgedAt: input.acknowledgedAt,
    result: input.result,
    errorCode: input.errorCode ?? null,
  }).onConflictDoNothing({
    target: runtimeControlAcks.commandId,
  }).returning({ commandId: runtimeControlAcks.commandId });
  return rows.length === 1;
}

function toPresenceInsert(input: RuntimeSessionPresenceInput): typeof runtimeSessionPresence.$inferInsert {
  return {
    sessionId: input.sessionId,
    userId: input.userId,
    accountCorrelationId: input.accountCorrelationId,
    replicaId: input.replicaId,
    transport: input.transport,
    clientName: input.clientInfo?.name ?? null,
    clientVersion: input.clientInfo?.version ?? null,
    startedAt: input.startedAt,
    lastActiveAt: input.lastActiveAt,
    requestCount: input.requestCount ?? 0,
    errorCount: input.errorCount ?? 0,
    leaseUntil: input.leaseUntil,
    status: 'active',
    closedAt: null,
  };
}

function toCommandInsert(input: RuntimeTerminationCommandInput): typeof runtimeControlCommands.$inferInsert {
  return {
    commandId: input.commandId,
    kind: 'terminate_session',
    sessionId: input.sessionId,
    targetReplicaId: input.targetReplicaId,
    reason: input.reason,
    requestedAt: input.requestedAt,
    requestedByKind: input.requestedBy.kind,
    requestedByUserId: input.requestedBy.userId,
    invalidationEventId: input.invalidationEventId ?? null,
  };
}

function fromPresenceRow(row: typeof runtimeSessionPresence.$inferSelect): RuntimeSessionPresence {
  return cloneRuntimeSessionPresence({
    sessionId: row.sessionId,
    userId: row.userId,
    accountCorrelationId: row.accountCorrelationId,
    replicaId: row.replicaId,
    transport: row.transport,
    clientInfo: row.clientName || row.clientVersion
      ? {
          ...(row.clientName ? { name: row.clientName } : {}),
          ...(row.clientVersion ? { version: row.clientVersion } : {}),
        }
      : null,
    startedAt: row.startedAt,
    lastActiveAt: row.lastActiveAt,
    requestCount: row.requestCount,
    errorCount: row.errorCount,
    leaseUntil: row.leaseUntil,
    status: row.status,
    closedAt: row.closedAt,
  });
}

function fromCommandRow(row: typeof runtimeControlCommands.$inferSelect): RuntimeTerminationCommand {
  return cloneRuntimeTerminationCommand({
    commandId: row.commandId,
    kind: 'terminate_session',
    sessionId: row.sessionId,
    targetReplicaId: row.targetReplicaId,
    reason: row.reason,
    requestedAt: row.requestedAt,
    requestedBy: {
      kind: row.requestedByKind,
      userId: row.requestedByUserId,
    },
    invalidationEventId: row.invalidationEventId,
  });
}

function fromAckRow(row: typeof runtimeControlAcks.$inferSelect): RuntimeTerminationAck {
  return cloneRuntimeTerminationAck({
    commandId: row.commandId,
    replicaId: row.replicaId,
    acknowledgedAt: row.acknowledgedAt,
    result: row.result,
    errorCode: row.errorCode,
  });
}
