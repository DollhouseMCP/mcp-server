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

/** A descriptor-bound write lost a race with descriptor rotation or deletion. */
export class IntegrationDescriptorChangedError extends ConsoleStoreConflictError {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationDescriptorChangedError';
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return hasPostgresErrorCode(error, '23505');
}

/**
 * Postgres foreign-key violation (SQLSTATE 23503). Used by the account
 * deletion path to detect when a true `DELETE` is refused by a RESTRICT
 * reference (the tamper-evident audit chain, role-grant authorship, …) so it
 * can fall back to anonymize-tombstone instead.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  return hasPostgresErrorCode(error, '23503');
}

function hasPostgresErrorCode(error: unknown, code: string): boolean {
  const seen = new WeakSet<object>();
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if ('code' in current && current.code === code) return true;
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
  if (!isUuid(value)) {
    throw new ConsoleStoreValidationError(`${name} must be a UUID`);
  }
}

/** Non-throwing UUID-format check, for request parsers that return a 400 rather than throw. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Non-throwing form of the display-string record rule, so route-layer payload
 * validation can enforce the exact same contract BEFORE a store write instead
 * of discovering the violation post-persist.
 */
export function isValidDisplayString(value: string, maxLength: number): boolean {
  return typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= maxLength &&
    !containsControlCharacter(value);
}

export function assertDisplayString(value: string, name: string, maxLength: number): void {
  if (!isValidDisplayString(value, maxLength)) {
    throw new ConsoleStoreValidationError(`${name} must be a printable non-empty string up to ${maxLength} characters`);
  }
}

export function assertNullableDisplayString(value: string | null, name: string, maxLength: number): void {
  if (value === null) return;
  assertDisplayString(value, name, maxLength);
}

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return false;
    if (codePoint > 0xffff) {
      index += 1;
    }
  }
  return true;
}

export function assertWellFormedUnicode(value: string, name: string): void {
  if (!isWellFormedUnicode(value)) {
    throw new ConsoleStoreValidationError(`${name} must contain well-formed Unicode`);
  }
}

/**
 * Membership test for a readonly literal tuple against a wider string.
 * `tuple.includes(value)` won't type-check when value is a wider `string`
 * than the tuple's literal element type, so this widens internally and
 * narrows the result via a type guard.
 */
export function tupleIncludes<T extends string>(tuple: readonly T[], value: string): value is T {
  return (tuple as readonly string[]).includes(value);
}

export function assertCapability(value: string, name: string): asserts value is ConsoleCapability {
  if (!tupleIncludes(CONSOLE_CAPABILITIES, value)) {
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
  return value ? new Date(value) : null;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
