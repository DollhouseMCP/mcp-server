import { randomUUID } from 'node:crypto';

import { and, eq, lte, gt } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { idempotencyRecords } from '../../database/schema/index.js';
import type {
  IdempotencyClaim,
  IdempotencyClaimResult,
  IdempotencyCompletion,
  IdempotencyMismatchField,
  IdempotencyRecord,
  IdempotencyRequestIdentity,
  IIdempotencyStore,
} from './IIdempotencyStore.js';
import {
  cloneIdempotencyClaim,
  cloneIdempotencyRecord,
  validateIdempotencyClaim,
  validateIdempotencyCompletion,
  validateIdempotencyIdentity,
  validateIdempotencyRecord,
} from './IIdempotencyStore.js';
import {
  ConsoleStoreConflictError,
  assertHash,
  assertUuid,
  buffersEqual,
} from './ConsoleStoreValidation.js';
import type { ConsoleHttpMethod } from '../platform/ConsolePlatformTypes.js';

type IdempotencyRow = typeof idempotencyRecords.$inferSelect;

export class PostgresIdempotencyStore implements IIdempotencyStore {
  constructor(private readonly db: DatabaseInstance) {}

  async claim(identity: IdempotencyRequestIdentity): Promise<IdempotencyClaimResult> {
    validateIdempotencyIdentity(identity);
    const claim = { ...identity, claimId: randomUUID() };
    return withSystemContext(this.db, async tx => {
      await tx.delete(idempotencyRecords).where(and(
        eq(idempotencyRecords.consoleSessionIdHash, identity.consoleSessionIdHash),
        eq(idempotencyRecords.idempotencyKey, identity.idempotencyKey),
        lte(idempotencyRecords.expiresAt, identity.createdAt),
      ));
      const inserted = await tx.insert(idempotencyRecords).values(toPendingRow(claim))
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return { kind: 'claimed', claim: cloneIdempotencyClaim(claim) };

      const rows = await tx.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.consoleSessionIdHash, identity.consoleSessionIdHash),
        eq(idempotencyRecords.idempotencyKey, identity.idempotencyKey),
      )).limit(1);
      if (!rows[0]) {
        throw new ConsoleStoreConflictError('idempotency claim conflicted but cannot be read');
      }
      const existingClaim = claimFromRow(rows[0]);
      const mismatchField = mismatchedField(existingClaim, identity);
      if (mismatchField) return { kind: 'mismatch', mismatchField };
      return rows[0].state === 'completed'
        ? { kind: 'replay', record: completedFromRow(rows[0]) }
        : { kind: 'in_progress' };
    });
  }

  async complete(claim: IdempotencyClaim, completion: IdempotencyCompletion): Promise<IdempotencyRecord> {
    validateIdempotencyClaim(claim);
    validateIdempotencyCompletion(completion);
    const rows = await withSystemContext(this.db, tx =>
      tx.update(idempotencyRecords).set({
        state: 'completed',
        responseStatus: completion.responseStatus,
        responseBodyPresent: completion.responseBodyPresent,
        responseBody: completion.responseBody,
      }).where(and(
        eq(idempotencyRecords.consoleSessionIdHash, claim.consoleSessionIdHash),
        eq(idempotencyRecords.idempotencyKey, claim.idempotencyKey),
        eq(idempotencyRecords.claimId, claim.claimId),
        eq(idempotencyRecords.state, 'pending'),
      )).returning(),
    );
    if (!rows[0]) throw new ConsoleStoreConflictError('idempotency claim is not active');
    return completedFromRow(rows[0]);
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
        eq(idempotencyRecords.state, 'completed'),
        gt(idempotencyRecords.expiresAt, at),
      )).limit(1),
    );
    return rows[0] ? completedFromRow(rows[0]) : null;
  }

  async sweepExpired(before: Date = new Date()): Promise<number> {
    const rows = await withSystemContext(this.db, tx =>
      tx.delete(idempotencyRecords).where(lte(idempotencyRecords.expiresAt, before))
        .returning({ idempotencyKey: idempotencyRecords.idempotencyKey }),
    );
    return rows.length;
  }
}

function toPendingRow(claim: IdempotencyClaim): typeof idempotencyRecords.$inferInsert {
  return {
    ...claim,
    state: 'pending',
    responseStatus: null,
    responseBodyPresent: null,
    responseBody: null,
  };
}

function completedFromRow(row: IdempotencyRow): IdempotencyRecord {
  if (row.state !== 'completed' || row.responseStatus === null || row.responseBodyPresent === null) {
    throw new ConsoleStoreConflictError('idempotency row is not a completed response');
  }
  const record: IdempotencyRecord = {
    ...row,
    state: 'completed',
    httpMethod: row.httpMethod as ConsoleHttpMethod,
    responseStatus: row.responseStatus,
    responseBodyPresent: row.responseBodyPresent,
  };
  validateIdempotencyRecord(record);
  return cloneIdempotencyRecord(record);
}

function claimFromRow(row: IdempotencyRow): IdempotencyClaim {
  const state: string = row.state;
  // Runtime guard: selected database values are not trusted to satisfy Drizzle's static union.
  if (state !== 'pending' && state !== 'completed') {
    throw new ConsoleStoreConflictError('idempotency row has an invalid state');
  }
  const claim: IdempotencyClaim = {
    ...row,
    httpMethod: row.httpMethod as ConsoleHttpMethod,
  };
  validateIdempotencyClaim(claim);
  return cloneIdempotencyClaim(claim);
}

function mismatchedField(
  left: Pick<IdempotencyClaim, 'httpMethod' | 'canonicalTarget' | 'requestFingerprint'>,
  right: IdempotencyRequestIdentity,
): IdempotencyMismatchField | null {
  if (left.httpMethod !== right.httpMethod) return 'http_method';
  if (left.canonicalTarget !== right.canonicalTarget) return 'canonical_request_target';
  return buffersEqual(left.requestFingerprint, right.requestFingerprint) ? null : 'request_body_fingerprint';
}
