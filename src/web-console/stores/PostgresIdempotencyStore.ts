import { and, eq, lte, gt } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { idempotencyRecords } from '../../database/schema/index.js';
import type {
  IdempotencyRecord,
  IdempotencySaveResult,
  IIdempotencyStore,
} from './IIdempotencyStore.js';
import { cloneIdempotencyRecord, validateIdempotencyRecord } from './IIdempotencyStore.js';
import {
  ConsoleStoreConflictError,
  assertHash,
  assertUuid,
  buffersEqual,
} from './ConsoleStoreValidation.js';
import type { ConsoleHttpMethod } from '../platform/ConsolePlatformTypes.js';

export class PostgresIdempotencyStore implements IIdempotencyStore {
  constructor(private readonly db: DatabaseInstance) {}

  async saveCompleted(record: IdempotencyRecord): Promise<IdempotencySaveResult> {
    validateIdempotencyRecord(record);
    return withSystemContext(this.db, async tx => {
      await tx.delete(idempotencyRecords).where(and(
        eq(idempotencyRecords.consoleSessionIdHash, record.consoleSessionIdHash),
        eq(idempotencyRecords.idempotencyKey, record.idempotencyKey),
        lte(idempotencyRecords.expiresAt, record.createdAt),
      ));
      const inserted = await tx.insert(idempotencyRecords).values(toRow(record))
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return { kind: 'created', record: fromRow(inserted[0]) };

      const rows = await tx.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.consoleSessionIdHash, record.consoleSessionIdHash),
        eq(idempotencyRecords.idempotencyKey, record.idempotencyKey),
      )).limit(1);
      if (rows.length === 0) {
        throw new ConsoleStoreConflictError('idempotency record conflicted but cannot be read');
      }
      const existing = fromRow(rows[0]);
      return {
        kind: sameRequest(existing, record) ? 'replay' : 'mismatch',
        record: existing,
      };
    });
  }

  async find(
    consoleSessionIdHash: Buffer,
    idempotencyKey: string,
    at: Date = new Date(),
  ): Promise<IdempotencyRecord | null> {
    assertHash(consoleSessionIdHash, 'consoleSessionIdHash');
    assertUuid(idempotencyKey, 'idempotencyKey');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.consoleSessionIdHash, consoleSessionIdHash),
        eq(idempotencyRecords.idempotencyKey, idempotencyKey),
        gt(idempotencyRecords.expiresAt, at),
      )).limit(1),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async sweepExpired(before: Date = new Date()): Promise<number> {
    const rows = await withSystemContext(this.db, tx =>
      tx.delete(idempotencyRecords).where(lte(idempotencyRecords.expiresAt, before))
        .returning({ idempotencyKey: idempotencyRecords.idempotencyKey }),
    );
    return rows.length;
  }
}

function toRow(record: IdempotencyRecord): typeof idempotencyRecords.$inferInsert {
  return {
    ...record,
    responseBody: record.responseBody,
  };
}

function fromRow(row: typeof idempotencyRecords.$inferSelect): IdempotencyRecord {
  const record: IdempotencyRecord = {
    ...row,
    httpMethod: row.httpMethod as ConsoleHttpMethod,
  };
  validateIdempotencyRecord(record);
  return cloneIdempotencyRecord(record);
}

function sameRequest(left: IdempotencyRecord, right: IdempotencyRecord): boolean {
  return left.httpMethod === right.httpMethod
    && left.canonicalTarget === right.canonicalTarget
    && buffersEqual(left.requestFingerprint, right.requestFingerprint);
}
