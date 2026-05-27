import type { ConsoleHttpMethod } from '../platform/ConsolePlatformTypes.js';
import {
  ConsoleStoreValidationError,
  assertDigest,
  assertHash,
  assertUuid,
  cloneBuffer,
} from './ConsoleStoreValidation.js';

export interface IdempotencyRequestIdentity {
  readonly consoleSessionIdHash: Buffer;
  readonly idempotencyKey: string;
  readonly httpMethod: ConsoleHttpMethod;
  readonly canonicalTarget: string;
  readonly requestFingerprint: Buffer;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface IdempotencyClaim extends IdempotencyRequestIdentity {
  readonly claimId: string;
}

export interface IdempotencyCompletion {
  readonly responseStatus: number;
  readonly responseBodyPresent: boolean;
  /**
   * Stored replay payload after response privacy projection/redaction.
   * Callers must not pass token, credential, or other secret-bearing output.
   */
  readonly responseBody: unknown;
}

export interface IdempotencyRecord extends IdempotencyClaim, IdempotencyCompletion {
  readonly state: 'completed';
}

export type IdempotencyMismatchField =
  | 'http_method'
  | 'canonical_request_target'
  | 'request_body_fingerprint';

export type IdempotencyClaimResult =
  | { readonly kind: 'claimed'; readonly claim: IdempotencyClaim }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'replay'; readonly record: IdempotencyRecord }
  | { readonly kind: 'mismatch'; readonly mismatchField: IdempotencyMismatchField };

export interface IIdempotencyStore {
  claim(identity: IdempotencyRequestIdentity): Promise<IdempotencyClaimResult>;
  complete(claim: IdempotencyClaim, completion: IdempotencyCompletion): Promise<IdempotencyRecord>;
  find(consoleSessionIdHash: Buffer, idempotencyKey: string, at?: Date): Promise<IdempotencyRecord | null>;
  sweepExpired(before?: Date): Promise<number>;
}

export function validateIdempotencyIdentity(identity: IdempotencyRequestIdentity): void {
  assertHash(identity.consoleSessionIdHash, 'consoleSessionIdHash');
  assertDigest(identity.requestFingerprint, 'requestFingerprint');
  assertUuid(identity.idempotencyKey, 'idempotencyKey');
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(identity.httpMethod)) {
    throw new ConsoleStoreValidationError('idempotency is only valid for mutating routes');
  }
  if (!identity.canonicalTarget.startsWith('/api/v1/')) {
    throw new ConsoleStoreValidationError('canonicalTarget must be a /api/v1 route');
  }
  const duration = identity.expiresAt.getTime() - identity.createdAt.getTime();
  if (duration <= 0 || duration > 24 * 60 * 60 * 1000) {
    throw new ConsoleStoreValidationError('idempotency record retention must not exceed 24 hours');
  }
}

export function validateIdempotencyClaim(claim: IdempotencyClaim): void {
  validateIdempotencyIdentity(claim);
  assertUuid(claim.claimId, 'claimId');
}

export function validateIdempotencyCompletion(completion: IdempotencyCompletion): void {
  if (completion.responseStatus < 100 || completion.responseStatus > 599) {
    throw new ConsoleStoreValidationError('responseStatus must be an HTTP status');
  }
  if (!completion.responseBodyPresent && completion.responseBody !== null) {
    throw new ConsoleStoreValidationError('bodyless response completion must store a null response body');
  }
}

export function validateIdempotencyRecord(record: IdempotencyRecord): void {
  validateIdempotencyClaim(record);
  validateIdempotencyCompletion(record);
}

export function cloneIdempotencyClaim(claim: IdempotencyClaim): IdempotencyClaim {
  return {
    ...claim,
    consoleSessionIdHash: cloneBuffer(claim.consoleSessionIdHash),
    requestFingerprint: cloneBuffer(claim.requestFingerprint),
    createdAt: new Date(claim.createdAt.getTime()),
    expiresAt: new Date(claim.expiresAt.getTime()),
  };
}

export function cloneIdempotencyRecord(record: IdempotencyRecord): IdempotencyRecord {
  return {
    ...cloneIdempotencyClaim(record),
    state: 'completed',
    responseStatus: record.responseStatus,
    responseBodyPresent: record.responseBodyPresent,
    responseBody: structuredClone(record.responseBody),
  };
}
