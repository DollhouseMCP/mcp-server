import type { ConsoleHttpMethod } from '../platform/ConsolePlatformTypes.js';
import {
  ConsoleStoreValidationError,
  assertDigest,
  assertHash,
  assertUuid,
  cloneBuffer,
} from './ConsoleStoreValidation.js';

export interface IdempotencyRecord {
  readonly consoleSessionIdHash: Buffer;
  readonly idempotencyKey: string;
  readonly httpMethod: ConsoleHttpMethod;
  readonly canonicalTarget: string;
  readonly requestFingerprint: Buffer;
  readonly responseStatus: number;
  /**
   * Stored replay payload after response privacy projection/redaction.
   * Callers must not pass token, credential, or other secret-bearing output.
   */
  readonly responseBody: unknown;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export type IdempotencySaveResult =
  | { readonly kind: 'created'; readonly record: IdempotencyRecord }
  | { readonly kind: 'replay'; readonly record: IdempotencyRecord }
  | { readonly kind: 'mismatch'; readonly record: IdempotencyRecord };

export interface IIdempotencyStore {
  saveCompleted(record: IdempotencyRecord): Promise<IdempotencySaveResult>;
  find(consoleSessionIdHash: Buffer, idempotencyKey: string, at?: Date): Promise<IdempotencyRecord | null>;
  sweepExpired(before?: Date): Promise<number>;
}

export function validateIdempotencyRecord(record: IdempotencyRecord): void {
  assertHash(record.consoleSessionIdHash, 'consoleSessionIdHash');
  assertDigest(record.requestFingerprint, 'requestFingerprint');
  assertUuid(record.idempotencyKey, 'idempotencyKey');
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(record.httpMethod)) {
    throw new ConsoleStoreValidationError('idempotency is only valid for mutating routes');
  }
  if (!record.canonicalTarget.startsWith('/api/v1/')) {
    throw new ConsoleStoreValidationError('canonicalTarget must be a /api/v1 route');
  }
  if (record.responseStatus < 100 || record.responseStatus > 599) {
    throw new ConsoleStoreValidationError('responseStatus must be an HTTP status');
  }
  const duration = record.expiresAt.getTime() - record.createdAt.getTime();
  if (duration <= 0 || duration > 24 * 60 * 60 * 1000) {
    throw new ConsoleStoreValidationError('idempotency record retention must not exceed 24 hours');
  }
}

export function cloneIdempotencyRecord(record: IdempotencyRecord): IdempotencyRecord {
  return {
    ...record,
    consoleSessionIdHash: cloneBuffer(record.consoleSessionIdHash),
    requestFingerprint: cloneBuffer(record.requestFingerprint),
    responseBody: structuredClone(record.responseBody),
    createdAt: new Date(record.createdAt.getTime()),
    expiresAt: new Date(record.expiresAt.getTime()),
  };
}
