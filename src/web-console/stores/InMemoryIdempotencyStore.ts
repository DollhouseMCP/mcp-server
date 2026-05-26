import { buffersEqual, hashKey } from './ConsoleStoreValidation.js';
import type {
  IdempotencyRecord,
  IdempotencySaveResult,
  IIdempotencyStore,
} from './IIdempotencyStore.js';
import {
  cloneIdempotencyRecord,
  validateIdempotencyRecord,
} from './IIdempotencyStore.js';
import { assertHash, assertUuid } from './ConsoleStoreValidation.js';

export class InMemoryIdempotencyStore implements IIdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async saveCompleted(record: IdempotencyRecord): Promise<IdempotencySaveResult> {
    await Promise.resolve();
    validateIdempotencyRecord(record);
    const key = makeKey(record.consoleSessionIdHash, record.idempotencyKey);
    let existing = this.records.get(key);
    if (existing && existing.expiresAt <= record.createdAt) {
      this.records.delete(key);
      existing = undefined;
    }
    if (!existing) {
      const created = cloneIdempotencyRecord(record);
      this.records.set(key, created);
      return { kind: 'created', record: cloneIdempotencyRecord(created) };
    }
    return {
      kind: sameRequest(existing, record) ? 'replay' : 'mismatch',
      record: cloneIdempotencyRecord(existing),
    };
  }

  async find(
    consoleSessionIdHash: Buffer,
    idempotencyKey: string,
    at: Date = new Date(),
  ): Promise<IdempotencyRecord | null> {
    await Promise.resolve();
    assertHash(consoleSessionIdHash, 'consoleSessionIdHash');
    assertUuid(idempotencyKey, 'idempotencyKey');
    const record = this.records.get(makeKey(consoleSessionIdHash, idempotencyKey));
    return record && record.expiresAt > at ? cloneIdempotencyRecord(record) : null;
  }

  async sweepExpired(before: Date = new Date()): Promise<number> {
    await Promise.resolve();
    let deleted = 0;
    for (const [key, record] of this.records) {
      if (record.expiresAt <= before) {
        this.records.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}

function makeKey(sessionIdHash: Buffer, idempotencyKey: string): string {
  return `${hashKey(sessionIdHash)}\0${idempotencyKey}`;
}

function sameRequest(left: IdempotencyRecord, right: IdempotencyRecord): boolean {
  return left.httpMethod === right.httpMethod
    && left.canonicalTarget === right.canonicalTarget
    && buffersEqual(left.requestFingerprint, right.requestFingerprint);
}
