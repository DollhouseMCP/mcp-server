import {
  ConsoleStoreValidationError,
  assertDisplayString,
  assertUuid,
  cloneDate,
} from './ConsoleStoreValidation.js';

export type ConsolePortfolioElementType =
  | 'personas'
  | 'skills'
  | 'templates'
  | 'agents'
  | 'memories'
  | 'ensembles';

export type ConsolePortfolioValidationStatus = 'valid' | 'invalid' | 'unknown';

export interface ConsolePortfolioElementSummaryRecord {
  readonly userId: string;
  readonly type: ConsolePortfolioElementType;
  readonly name: string;
  readonly canonicalName: string;
  readonly displayName: string | null;
  readonly version: number;
  readonly updatedAt: Date;
  readonly validationStatus: ConsolePortfolioValidationStatus;
  readonly tags: readonly string[];
}

export interface ConsolePortfolioElementDetailRecord extends ConsolePortfolioElementSummaryRecord {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly content: string;
}

export interface ConsolePortfolioListFilters {
  readonly type?: ConsolePortfolioElementType;
  readonly tag?: string;
}

export interface IPortfolioElementStore {
  summarizeByUser(userId: string): Promise<readonly ConsolePortfolioElementSummaryRecord[]>;
  listByUser(
    userId: string,
    filters?: ConsolePortfolioListFilters,
  ): Promise<readonly ConsolePortfolioElementSummaryRecord[]>;
  findByName(
    userId: string,
    type: ConsolePortfolioElementType,
    canonicalName: string,
  ): Promise<ConsolePortfolioElementDetailRecord | null>;
}

export const CONSOLE_PORTFOLIO_ELEMENT_TYPES = [
  'personas',
  'skills',
  'templates',
  'agents',
  'memories',
  'ensembles',
] as const satisfies readonly ConsolePortfolioElementType[];

export function isConsolePortfolioElementType(value: string): value is ConsolePortfolioElementType {
  return CONSOLE_PORTFOLIO_ELEMENT_TYPES.includes(value as ConsolePortfolioElementType);
}

export function canonicalizePortfolioElementName(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.replace(/\.md$|\.ya?ml$/u, '');
}

export function validatePortfolioElementSummaryRecord(record: ConsolePortfolioElementSummaryRecord): void {
  assertUuid(record.userId, 'userId');
  if (!isConsolePortfolioElementType(record.type)) {
    throw new ConsoleStoreValidationError(`unsupported portfolio element type '${record.type}'`);
  }
  assertDisplayString(record.name, 'name', 200);
  assertDisplayString(record.canonicalName, 'canonicalName', 200);
  if (canonicalizePortfolioElementName(record.name) !== record.canonicalName) {
    throw new ConsoleStoreValidationError('canonicalName must match canonicalized name');
  }
  if (record.displayName !== null) assertDisplayString(record.displayName, 'displayName', 200);
  if (!Number.isSafeInteger(record.version) || record.version < 1) {
    throw new ConsoleStoreValidationError('version must be a positive safe integer');
  }
  if (!['valid', 'invalid', 'unknown'].includes(record.validationStatus)) {
    throw new ConsoleStoreValidationError(`unsupported validation status '${record.validationStatus}'`);
  }
  for (const tag of record.tags) {
    assertDisplayString(tag, 'tag', 80);
  }
}

export function validatePortfolioElementDetailRecord(record: ConsolePortfolioElementDetailRecord): void {
  validatePortfolioElementSummaryRecord(record);
  if (typeof record.metadata !== 'object' || Array.isArray(record.metadata)) {
    throw new ConsoleStoreValidationError('metadata must be a JSON object');
  }
  JSON.stringify(record.metadata);
  if (typeof record.content !== 'string') {
    throw new ConsoleStoreValidationError('content must be a string');
  }
}

export function clonePortfolioElementSummaryRecord(
  record: ConsolePortfolioElementSummaryRecord,
): ConsolePortfolioElementSummaryRecord {
  return {
    ...record,
    updatedAt: cloneDate(record.updatedAt) ?? new Date(record.updatedAt.getTime()),
    tags: [...record.tags],
  };
}

export function clonePortfolioElementDetailRecord(
  record: ConsolePortfolioElementDetailRecord,
): ConsolePortfolioElementDetailRecord {
  return {
    ...clonePortfolioElementSummaryRecord(record),
    metadata: JSON.parse(JSON.stringify(record.metadata)) as Record<string, unknown>,
    content: record.content,
  };
}
