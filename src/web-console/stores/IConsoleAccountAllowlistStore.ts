import type { AuthAllowlistKind } from '../../database/schema/index.js';
import type { AllowlistMatchValues } from '../../auth/embedded-as/storage/IAuthStorageLayer.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import {
  assertUuid,
  cloneDate,
  ConsoleStoreValidationError,
  tupleIncludes,
} from './ConsoleStoreValidation.js';

export type ConsoleAccountAllowlistKind = AuthAllowlistKind;

export interface ConsoleAccountAllowlistEntry {
  readonly id: string;
  readonly kind: ConsoleAccountAllowlistKind;
  readonly normalizedValue: string;
  readonly displayValue: string;
  readonly note: string | null;
  readonly createdByUserId: string;
  readonly createdAt: Date;
  readonly revokedByUserId: string | null;
  readonly revokedAt: Date | null;
}

export interface AllowlistAddInput {
  readonly kind: ConsoleAccountAllowlistKind;
  readonly value: string;
  readonly note?: string | null;
  readonly createdByUserId: string;
  readonly createdAt: Date;
}

export interface AllowlistUpdateInput {
  readonly id: string;
  readonly note?: string | null;
}

export interface AllowlistRemoveInput {
  readonly id: string;
  readonly revokedByUserId: string;
  readonly revokedAt: Date;
}

export interface IConsoleAccountAllowlistStore {
  listActive(): Promise<ConsoleAccountAllowlistEntry[]>;
  hasActiveEntries(): Promise<boolean>;
  matchesIdentity(values: AllowlistMatchValues): Promise<boolean>;
  findActive(id: string): Promise<ConsoleAccountAllowlistEntry | null>;
  add(input: AllowlistAddInput): Promise<ConsoleAccountAllowlistEntry>;
  update(input: AllowlistUpdateInput): Promise<ConsoleAccountAllowlistEntry | null>;
  remove(input: AllowlistRemoveInput): Promise<ConsoleAccountAllowlistEntry | null>;
}

export const CONSOLE_ACCOUNT_ALLOWLIST_KINDS = ['email', 'github_username', 'github_id'] as const;

export function validateAllowlistAddInput(input: AllowlistAddInput): void {
  assertAllowlistKind(input.kind, 'kind');
  validateAllowlistValue(input.kind, input.value, 'value');
  validateAllowlistNote(input.note);
  assertUuid(input.createdByUserId, 'createdByUserId');
  validateDate(input.createdAt, 'createdAt');
}

export function validateAllowlistUpdateInput(input: AllowlistUpdateInput): void {
  assertUuid(input.id, 'id');
  validateAllowlistNote(input.note);
}

export function validateAllowlistRemoveInput(input: AllowlistRemoveInput): void {
  assertUuid(input.id, 'id');
  assertUuid(input.revokedByUserId, 'revokedByUserId');
  validateDate(input.revokedAt, 'revokedAt');
}

export function assertAllowlistKind(value: string, name: string): asserts value is ConsoleAccountAllowlistKind {
  if (!tupleIncludes(CONSOLE_ACCOUNT_ALLOWLIST_KINDS, value)) {
    throw new ConsoleStoreValidationError(`${name} contains unknown allowlist kind '${value}'`);
  }
}

export function normalizeAllowlistValue(kind: ConsoleAccountAllowlistKind, value: string): string {
  const normalized = normalizeAllowlistDisplayValue(value);
  return kind === 'github_id' ? normalized : normalized.toLowerCase();
}

export function normalizeAllowlistDisplayValue(value: string): string {
  return UnicodeValidator.normalize(value).normalizedContent.trim();
}

export function validateAllowlistValue(kind: ConsoleAccountAllowlistKind, value: string, name: string): void {
  const normalized = normalizeAllowlistDisplayValue(value);
  if (normalized === '' || normalized.length > 320) {
    throw new ConsoleStoreValidationError(`${name} must be non-empty and at most 320 characters`);
  }
  if (kind === 'email' && !isLiteEmailAddress(normalized)) {
    throw new ConsoleStoreValidationError(`${name} must be a valid email address`);
  }
  if (kind === 'github_username' && !/^[A-Za-z0-9-]{1,39}$/.test(normalized)) {
    throw new ConsoleStoreValidationError(`${name} must be a valid GitHub username`);
  }
  if (kind === 'github_id' && !/^\d+$/.test(normalized)) {
    throw new ConsoleStoreValidationError(`${name} must be a numeric GitHub id`);
  }
}

function isLiteEmailAddress(value: string): boolean {
  if (/\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return false;
  const domain = value.slice(at + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

export function cloneAllowlistEntry(entry: ConsoleAccountAllowlistEntry): ConsoleAccountAllowlistEntry {
  return {
    ...entry,
    createdAt: new Date(entry.createdAt),
    revokedAt: cloneDate(entry.revokedAt),
  };
}

function validateAllowlistNote(note: string | null | undefined): void {
  if (note !== undefined && note !== null && note.length > 500) {
    throw new ConsoleStoreValidationError('note must be at most 500 characters');
  }
}

function validateDate(value: Date, name: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new ConsoleStoreValidationError(`${name} must be a valid date`);
  }
}
