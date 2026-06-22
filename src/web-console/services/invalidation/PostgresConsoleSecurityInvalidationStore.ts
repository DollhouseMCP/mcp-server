import { eq, gt, sql } from 'drizzle-orm';

import { ConsoleStoreValidationError } from '../../stores/ConsoleStoreValidation.js';
import { withSystemContext } from '../../../database/admin.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import type { DrizzleTx } from '../../../database/db-utils.js';
import {
  securityInvalidationAcks,
  securityInvalidationEvents,
  securityInvalidationReplicaCursors,
  securityInvalidationReplicaLeases,
} from '../../../database/schema/index.js';
import type {
  IConsoleSecurityInvalidationStore,
  ReplicaLease,
  SecurityInvalidationEvent,
  SecurityInvalidationEventInput,
} from './IConsoleSecurityInvalidationStore.js';
import {
  cloneSecurityInvalidationEvent,
  validateEventId,
  validateReplicaId,
  validateReplicaLease,
  validateSecurityInvalidationEventInput,
  validateSequenceId,
} from './IConsoleSecurityInvalidationStore.js';

export class PostgresConsoleSecurityInvalidationStore implements IConsoleSecurityInvalidationStore {
  constructor(private readonly db: DatabaseInstance) {}

  async appendEvent(input: SecurityInvalidationEventInput): Promise<SecurityInvalidationEvent> {
    return withSystemContext(this.db, tx => appendSecurityInvalidationEventWithTx(tx, input));
  }

  async listEventsAfter(sequenceId: number, limit = 100): Promise<SecurityInvalidationEvent[]> {
    validateSequenceId(sequenceId);
    validateLimit(limit);
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(securityInvalidationEvents)
        .where(gt(securityInvalidationEvents.sequenceId, sequenceId))
        .orderBy(securityInvalidationEvents.sequenceId)
        .limit(limit),
    );
    return rows.map(row => fromEventRow(row));
  }

  async getReplicaCursor(replicaId: string): Promise<number> {
    validateReplicaId(replicaId);
    const rows = await withSystemContext(this.db, tx =>
      tx.select({ lastSequenceId: securityInvalidationReplicaCursors.lastSequenceId })
        .from(securityInvalidationReplicaCursors)
        .where(eq(securityInvalidationReplicaCursors.replicaId, replicaId))
        .limit(1),
    );
    return rows[0]?.lastSequenceId ?? 0;
  }

  async recordReplicaCursor(
    replicaId: string,
    sequenceId: number,
    updatedAt: Date = new Date(),
  ): Promise<void> {
    validateReplicaId(replicaId);
    validateSequenceId(sequenceId);
    await withSystemContext(this.db, tx =>
      tx.insert(securityInvalidationReplicaCursors).values({
        replicaId,
        lastSequenceId: sequenceId,
        updatedAt,
      }).onConflictDoUpdate({
        target: securityInvalidationReplicaCursors.replicaId,
        set: {
          lastSequenceId: sql`GREATEST(${securityInvalidationReplicaCursors.lastSequenceId}, ${sequenceId})`,
          updatedAt,
        },
      }),
    );
  }

  async acquireReplicaLease(input: ReplicaLease): Promise<void> {
    validateReplicaLease(input);
    await withSystemContext(this.db, tx =>
      tx.insert(securityInvalidationReplicaLeases).values(input).onConflictDoUpdate({
        target: securityInvalidationReplicaLeases.replicaId,
        set: {
          leaseUntil: input.leaseUntil,
          renewedAt: input.renewedAt,
        },
      }),
    );
  }

  async listLiveReplicaIds(at: Date = new Date()): Promise<string[]> {
    const rows = await withSystemContext(this.db, tx =>
      tx.select({ replicaId: securityInvalidationReplicaLeases.replicaId })
        .from(securityInvalidationReplicaLeases)
        .where(gt(securityInvalidationReplicaLeases.leaseUntil, at))
        .orderBy(securityInvalidationReplicaLeases.replicaId),
    );
    return rows.map(row => row.replicaId);
  }

  async acknowledgeEvent(eventId: string, replicaId: string, acknowledgedAt: Date = new Date()): Promise<void> {
    validateEventId(eventId);
    validateReplicaId(replicaId);
    await withSystemContext(this.db, tx =>
      tx.insert(securityInvalidationAcks).values({
        eventId,
        replicaId,
        acknowledgedAt,
      }).onConflictDoNothing({
        target: [securityInvalidationAcks.eventId, securityInvalidationAcks.replicaId],
      }),
    );
  }

  async listAcknowledgedReplicaIds(eventId: string): Promise<string[]> {
    validateEventId(eventId);
    const rows = await withSystemContext(this.db, tx =>
      tx.select({ replicaId: securityInvalidationAcks.replicaId })
        .from(securityInvalidationAcks)
        .where(eq(securityInvalidationAcks.eventId, eventId))
        .orderBy(securityInvalidationAcks.replicaId),
    );
    return rows.map(row => row.replicaId);
  }
}

export async function appendSecurityInvalidationEventWithTx(
  tx: DrizzleTx,
  input: SecurityInvalidationEventInput,
): Promise<SecurityInvalidationEvent> {
  validateSecurityInvalidationEventInput(input);
  const rows = await tx.insert(securityInvalidationEvents).values({
    kind: input.kind,
    urgency: input.urgency,
    userId: input.userId,
    consoleSessionIdHash: input.consoleSessionIdHash ?? null,
    authzVersion: input.authzVersion ?? null,
    reason: input.reason,
    payload: { ...input.payload },
    createdAt: input.createdAt,
    createdByUserId: input.createdByUserId ?? null,
  }).returning();
  return fromEventRow(rows[0]);
}

function fromEventRow(row: typeof securityInvalidationEvents.$inferSelect): SecurityInvalidationEvent {
  return cloneSecurityInvalidationEvent({
    sequenceId: row.sequenceId,
    eventId: row.eventId,
    kind: row.kind,
    urgency: row.urgency,
    userId: row.userId,
    consoleSessionIdHash: row.consoleSessionIdHash,
    authzVersion: row.authzVersion,
    reason: row.reason,
    payload: asPayload(row.payload),
    createdAt: row.createdAt,
    createdByUserId: row.createdByUserId,
  });
}

function asPayload(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ConsoleStoreValidationError('security invalidation event limit must be between 1 and 1000');
  }
}
