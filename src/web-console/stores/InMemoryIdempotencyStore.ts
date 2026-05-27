import { randomUUID } from 'node:crypto';

import { buffersEqual, hashKey } from './ConsoleStoreValidation.js';
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
} from './IIdempotencyStore.js';
import { ConsoleStoreConflictError, assertHash, assertUuid } from './ConsoleStoreValidation.js';

type StoredClaim = IdempotencyClaim | IdempotencyRecord;

export class InMemoryIdempotencyStore implements IIdempotencyStore {
  private readonly claims = new Map<string, StoredClaim>();

  async claim(identity: IdempotencyRequestIdentity): Promise<IdempotencyClaimResult> {
    await Promise.resolve();
    validateIdempotencyIdentity(identity);
    const key = makeKey(identity.consoleSessionIdHash, identity.idempotencyKey);
    let existing = this.claims.get(key);
    if (existing && existing.expiresAt <= identity.createdAt) {
      this.claims.delete(key);
      existing = undefined;
    }
    if (!existing) {
      const claim = cloneIdempotencyClaim({ ...identity, claimId: randomUUID() });
      this.claims.set(key, claim);
      return { kind: 'claimed', claim: cloneIdempotencyClaim(claim) };
    }
    const mismatchField = mismatchedField(existing, identity);
    if (mismatchField) return { kind: 'mismatch', mismatchField };
    return 'state' in existing
      ? { kind: 'replay', record: cloneIdempotencyRecord(existing) }
      : { kind: 'in_progress' };
  }

  async complete(claim: IdempotencyClaim, completion: IdempotencyCompletion): Promise<IdempotencyRecord> {
    await Promise.resolve();
    validateIdempotencyClaim(claim);
    validateIdempotencyCompletion(completion);
    const key = makeKey(claim.consoleSessionIdHash, claim.idempotencyKey);
    const existing = this.claims.get(key);
    if (!existing || 'state' in existing || existing.claimId !== claim.claimId) {
      throw new ConsoleStoreConflictError('idempotency claim is not active');
    }
    const completed: IdempotencyRecord = { ...cloneIdempotencyClaim(claim), ...completion, state: 'completed' };
    this.claims.set(key, cloneIdempotencyRecord(completed));
    return cloneIdempotencyRecord(completed);
  }

  async find(
    consoleSessionIdHash: Buffer,
    idempotencyKey: string,
    at: Date = new Date(),
  ): Promise<IdempotencyRecord | null> {
    await Promise.resolve();
    assertHash(consoleSessionIdHash, 'consoleSessionIdHash');
    assertUuid(idempotencyKey, 'idempotencyKey');
    const record = this.claims.get(makeKey(consoleSessionIdHash, idempotencyKey));
    return record && 'state' in record && record.expiresAt > at ? cloneIdempotencyRecord(record) : null;
  }

  async sweepExpired(before: Date = new Date()): Promise<number> {
    await Promise.resolve();
    let deleted = 0;
    for (const [key, record] of this.claims) {
      if (record.expiresAt <= before) {
        this.claims.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}

function makeKey(sessionIdHash: Buffer, idempotencyKey: string): string {
  return `${hashKey(sessionIdHash)}\0${idempotencyKey}`;
}

function mismatchedField(
  left: Pick<IdempotencyClaim, 'httpMethod' | 'canonicalTarget' | 'requestFingerprint'>,
  right: IdempotencyRequestIdentity,
): IdempotencyMismatchField | null {
  if (left.httpMethod !== right.httpMethod) return 'http_method';
  if (left.canonicalTarget !== right.canonicalTarget) return 'canonical_request_target';
  return buffersEqual(left.requestFingerprint, right.requestFingerprint) ? null : 'request_body_fingerprint';
}
