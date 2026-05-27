import { timingSafeEqual } from 'node:crypto';

import { CONSOLE_CAPABILITIES } from '../platform/ConsolePlatformTypes.js';
import type { ConsoleCapability } from '../platform/ConsolePlatformTypes.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CONSOLE_HASH_BYTES = 32;

export class ConsoleStoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleStoreValidationError';
  }
}

export class ConsoleStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleStoreConflictError';
  }
}

export function isUniqueViolation(error: unknown): boolean {
  const seen = new WeakSet<object>();
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if ('code' in current && current.code === '23505') return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}

export function assertHash(value: Buffer, name: string): void {
  if (!Buffer.isBuffer(value) || value.length !== CONSOLE_HASH_BYTES) {
    throw new ConsoleStoreValidationError(`${name} must be a 32-byte keyed hash`);
  }
}

export function assertNonEmptyBuffer(value: Buffer, name: string): void {
  // Shape guard only; AEAD authentication remains owned by ISecretEncryptionService.
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new ConsoleStoreValidationError(`${name} must be non-empty encrypted ciphertext`);
  }
}

export function assertDigest(value: Buffer, name: string): void {
  if (!Buffer.isBuffer(value) || value.length !== CONSOLE_HASH_BYTES) {
    throw new ConsoleStoreValidationError(`${name} must be a 32-byte digest`);
  }
}

export function assertUuid(value: string, name: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new ConsoleStoreValidationError(`${name} must be a UUID`);
  }
}

export function assertCapability(value: string, name: string): asserts value is ConsoleCapability {
  if (!CONSOLE_CAPABILITIES.some(capability => capability === value)) {
    throw new ConsoleStoreValidationError(`${name} contains unknown capability '${value}'`);
  }
}

export function hashKey(value: Buffer): string {
  return value.toString('hex');
}

export function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function cloneBuffer(value: Buffer): Buffer {
  return Buffer.from(value);
}

export function cloneDate(value: Date | null): Date | null {
  return value ? new Date(value.getTime()) : null;
}
