import { and, desc, eq, gt, isNull, lt, lte, notExists, sql, type SQL } from 'drizzle-orm';

import { withSystemContext } from '../../../database/admin.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import type { DrizzleTx } from '../../../database/db-utils.js';
import { lockActiveUserLifecycleWithTx } from '../../../database/authPrincipalLock.js';
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
import { assertUuid, ConsoleStoreValidationError } from '../../stores/ConsoleStoreValidation.js';
import { validateReplicaId } from '../invalidation/IConsoleSecurityInvalidationStore.js';

export class PostgresRuntimeSessionControlStore implements IRuntimeSessionControlStore {
  constructor(private readonly db: DatabaseInstance) {}

  async registerPresence(input: RuntimeSessionPresenceInput): Promise<RuntimeSessionPresence> {
    return withSystemContext(this.db, async (tx) => {
      await lockActiveUserLifecycleWithTx(tx, input.userId);
      return registerRuntimePresenceWithTx(tx, input);
    });
  }

  async heartbeatPresence(input: RuntimeSessionHeartbeatInput): Promise<RuntimeSessionHeartbeatResult> {
    return withSystemContext(this.db, tx => heartbeatRuntimePresenceWithTx(tx, input));
  }

  async markPresenceClosing(
    sessionId: string,
    replicaId: string,
    closedAt: Date,
  ): Promise<RuntimeSessionPresence | null> {
    return withSystemContext(this.db, tx =>
      markRuntimePresenceClosingWithTx(tx, sessionId, replicaId, closedAt));
  }

  async sweepStalePresence(before?: Date): Promise<number> {
    const cutoff = before ?? sql<Date>`statement_timestamp()`;
    const rows = await withSystemContext(this.db, tx =>
      tx.delete(runtimeSessionPresence)
        .where(and(
          lt(runtimeSessionPresence.leaseUntil, cutoff),
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

  async findPresence(sessionId: string, now?: Date): Promise<RuntimeSessionPresence | null> {
    return withSystemContext(this.db, tx => findRuntimePresenceWithTx(tx, sessionId, now));
  }

  async findOperationalPresence(sessionId: string, now?: Date): Promise<RuntimeSessionPresence | null> {
    validateSessionId(sessionId);
    const cutoff = now ?? sql<Date>`statement_timestamp()`;
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(runtimeSessionPresence)
        .where(and(
          eq(runtimeSessionPresence.sessionId, sessionId),
          gt(runtimeSessionPresence.leaseUntil, cutoff),
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
    const cutoff = query.now ?? sql<Date>`statement_timestamp()`;
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(runtimeSessionPresence)
        .where(and(
          eq(runtimeSessionPresence.userId, userId),
          eq(runtimeSessionPresence.status, 'active'),
          gt(runtimeSessionPresence.leaseUntil, cutoff),
        ))
        .orderBy(desc(runtimeSessionPresence.lastActiveAt), runtimeSessionPresence.sessionId)
        .limit(parsed.limit),
    );
    return rows.map(row => fromPresenceRow(row));
  }

  async listAllPresenceByUser(userId: string, now?: Date): Promise<RuntimeSessionPresence[]> {
    return withSystemContext(this.db, tx => listAllRuntimePresenceByUserWithTx(tx, userId, now));
  }

  // Known limitation: the keyset sorts/cursors on last_active_at, which a heartbeat
  // mutates. A session that heartbeats above the page cursor between page requests can
  // be skipped from a full paged sweep — acceptable for a live operational snapshot
  // (it re-appears near the top on the next sweep), but callers doing an exhaustive
  // cross-page audit should be aware it is best-effort, not a consistent point-in-time cut.
  async listOperationalPresence(query: RuntimeOperationalListQuery = {}): Promise<RuntimeOperationalPresencePage> {
    const parsed = validateRuntimeOperationalListQuery(query);
    const cutoff = query.now ?? sql<Date>`statement_timestamp()`;
    const conditions: SQL[] = [gt(runtimeSessionPresence.leaseUntil, cutoff)];
    if (parsed.status) conditions.push(eq(runtimeSessionPresence.status, parsed.status));
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
  // Registration may restore a durable presence snapshot (including an
  // already-expired one used by orphan reclamation), so preserve its absolute
  // timestamps. Subsequent heartbeats and every liveness decision use the
  // database clock and cannot extend a lease from replica wall-clock time.
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
  const leaseDurationMs = runtimeLeaseDurationMs(input.lastActiveAt, input.leaseUntil);
  const rows = await tx.update(runtimeSessionPresence).set({
    lastActiveAt: sql<Date>`statement_timestamp()`,
    requestCount: input.requestCount,
    errorCount: input.errorCount,
    leaseUntil: sql<Date>`statement_timestamp() + (${leaseDurationMs} * interval '1 millisecond')`,
  }).where(and(
    eq(runtimeSessionPresence.sessionId, input.sessionId),
    eq(runtimeSessionPresence.replicaId, input.replicaId),
    eq(runtimeSessionPresence.status, 'active'),
    lte(runtimeSessionPresence.requestCount, input.requestCount),
    lte(runtimeSessionPresence.errorCount, input.errorCount),
  )).returning();
  if (rows[0]) return { kind: 'updated', presence: fromPresenceRow(rows[0]) };

  const current = await tx.select().from(runtimeSessionPresence)
    .where(eq(runtimeSessionPresence.sessionId, input.sessionId))
    .limit(1);
  if (!current[0]) return { kind: 'lost', reason: 'missing' };
  if (current[0].replicaId !== input.replicaId) return { kind: 'lost', reason: 'replica_mismatch' };
  // An out-of-order heartbeat from the current owner is stale, not an
  // ownership loss. Preserve the newer durable snapshot and lease.
  if (current[0].status === 'active') {
    return { kind: 'updated', presence: fromPresenceRow(current[0]) };
  }
  return { kind: 'lost', reason: 'closing' };
}

export async function markRuntimePresenceClosingWithTx(
  tx: DrizzleTx,
  sessionId: string,
  replicaId: string,
  closedAt: Date,
): Promise<RuntimeSessionPresence | null> {
  validateSessionId(sessionId);
  validateReplicaId(replicaId);
  const rows = await tx.update(runtimeSessionPresence).set({
    status: 'closing',
    closedAt,
  }).where(and(
    eq(runtimeSessionPresence.sessionId, sessionId),
    eq(runtimeSessionPresence.replicaId, replicaId),
  )).returning();
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

export async function findRuntimePresenceWithTx(
  tx: DrizzleTx,
  sessionId: string,
  now?: Date,
): Promise<RuntimeSessionPresence | null> {
  validateSessionId(sessionId);
  const cutoff = now ?? sql<Date>`statement_timestamp()`;
  const rows = await tx.select().from(runtimeSessionPresence)
    .where(and(
      eq(runtimeSessionPresence.sessionId, sessionId),
      eq(runtimeSessionPresence.status, 'active'),
      gt(runtimeSessionPresence.leaseUntil, cutoff),
    ))
    .limit(1);
  return rows[0] ? fromPresenceRow(rows[0]) : null;
}

export async function listAllRuntimePresenceByUserWithTx(
  tx: DrizzleTx,
  userId: string,
  now?: Date,
): Promise<RuntimeSessionPresence[]> {
  assertUuid(userId, 'userId');
  const cutoff = now ?? sql<Date>`statement_timestamp()`;
  const rows = await tx.select().from(runtimeSessionPresence)
    .where(and(
      eq(runtimeSessionPresence.userId, userId),
      eq(runtimeSessionPresence.status, 'active'),
      gt(runtimeSessionPresence.leaseUntil, cutoff),
    ))
    .orderBy(runtimeSessionPresence.sessionId);
  return rows.map(row => fromPresenceRow(row));
}

export async function isRuntimePresenceActiveWithTx(
  tx: DrizzleTx,
  sessionId: string,
  userId: string,
): Promise<boolean> {
  validateSessionId(sessionId);
  assertUuid(userId, 'userId');
  const rows = await tx.select({ sessionId: runtimeSessionPresence.sessionId })
    .from(runtimeSessionPresence)
    .where(and(
      eq(runtimeSessionPresence.sessionId, sessionId),
      eq(runtimeSessionPresence.userId, userId),
      eq(runtimeSessionPresence.status, 'active'),
      gt(runtimeSessionPresence.leaseUntil, sql<Date>`statement_timestamp()`),
    ))
    .limit(1);
  return rows.length === 1;
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

function runtimeLeaseDurationMs(lastActiveAt: Date, leaseUntil: Date): number {
  const duration = leaseUntil.getTime() - lastActiveAt.getTime();
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new ConsoleStoreValidationError('runtime lease duration must be a positive safe integer');
  }
  return duration;
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
