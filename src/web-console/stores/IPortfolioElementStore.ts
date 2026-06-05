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
  /**
   * Legacy mirror-store revision retained only for older in-memory tests and
   * DTO compatibility. Manager-backed portfolio concurrency is defined by
   * contentHash/ETag, not this integer.
   */
  readonly version: number;
  readonly contentHash?: string;
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
  create(input: ConsolePortfolioElementCreateInput): Promise<ConsolePortfolioElementDetailRecord>;
  update(input: ConsolePortfolioElementUpdateInput): Promise<ConsolePortfolioElementDetailRecord | null>;
  delete(input: ConsolePortfolioElementDeleteInput): Promise<ConsolePortfolioElementDetailRecord | null>;
}

export interface ConsolePortfolioElementCreateInput {
  readonly userId: string;
  readonly type: ConsolePortfolioElementType;
  readonly name: string;
  readonly displayName: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly content: string;
  readonly tags: readonly string[];
  readonly now: Date;
}

export interface ConsolePortfolioElementUpdateInput {
  readonly userId: string;
  readonly type: ConsolePortfolioElementType;
  readonly canonicalName: string;
  /** Legacy mirror-store precondition; ignored by manager-backed stores when contentHash is supplied. */
  readonly expectedVersion: number;
  readonly expectedContentHash?: string;
  readonly displayName?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly now: Date;
}

export interface ConsolePortfolioElementDeleteInput {
  readonly userId: string;
  readonly type: ConsolePortfolioElementType;
  readonly canonicalName: string;
  /** Legacy mirror-store precondition; ignored by manager-backed stores when contentHash is supplied. */
  readonly expectedVersion: number;
  readonly expectedContentHash?: string;
  readonly now: Date;
}

export class PortfolioElementAlreadyExistsError extends Error {
  constructor(message = 'portfolio element already exists') {
    super(message);
    this.name = 'PortfolioElementAlreadyExistsError';
  }
}

export class PortfolioElementVersionConflictError extends Error {
  constructor(message = 'portfolio element version conflict') {
    super(message);
    this.name = 'PortfolioElementVersionConflictError';
  }
}

export const CONSOLE_PORTFOLIO_ELEMENT_TYPES = [
  'personas',
  'skills',
  'templates',
  'agents',
  'memories',
  'ensembles',
] as const satisfies readonly ConsolePortfolioElementType[];

export const PORTFOLIO_ELEMENT_CONTENT_MAX_BYTES = 1_048_576;
export const PORTFOLIO_ELEMENT_METADATA_MAX_BYTES = 65_536;
export const PORTFOLIO_ELEMENT_TAGS_MAX = 50;

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
  if (record.contentHash !== undefined && !/^[a-f0-9]{64}$/u.test(record.contentHash)) {
    throw new ConsoleStoreValidationError('contentHash must be a lowercase SHA-256 hex digest');
  }
  if (!['valid', 'invalid', 'unknown'].includes(record.validationStatus)) {
    throw new ConsoleStoreValidationError(`unsupported validation status '${record.validationStatus}'`);
  }
  if (record.tags.length > PORTFOLIO_ELEMENT_TAGS_MAX) {
    throw new ConsoleStoreValidationError(`tags must contain at most ${PORTFOLIO_ELEMENT_TAGS_MAX} entries`);
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
  let serializedMetadata: string;
  try {
    serializedMetadata = JSON.stringify(record.metadata);
  } catch {
    throw new ConsoleStoreValidationError('metadata must be JSON-serializable');
  }
  if (Buffer.byteLength(serializedMetadata, 'utf8') > PORTFOLIO_ELEMENT_METADATA_MAX_BYTES) {
    throw new ConsoleStoreValidationError(`metadata must be at most ${PORTFOLIO_ELEMENT_METADATA_MAX_BYTES} bytes`);
  }
  if (typeof record.content !== 'string') {
    throw new ConsoleStoreValidationError('content must be a string');
  }
  if (Buffer.byteLength(record.content, 'utf8') > PORTFOLIO_ELEMENT_CONTENT_MAX_BYTES) {
    throw new ConsoleStoreValidationError('content must be at most 1 MiB');
  }
}

export function clonePortfolioElementSummaryRecord(
  record: ConsolePortfolioElementSummaryRecord,
): ConsolePortfolioElementSummaryRecord {
  return {
    ...record,
    updatedAt: cloneDate(record.updatedAt) ?? new Date(record.updatedAt),
    tags: [...record.tags],
  };
}

export function clonePortfolioElementDetailRecord(
  record: ConsolePortfolioElementDetailRecord,
): ConsolePortfolioElementDetailRecord {
  return {
    ...clonePortfolioElementSummaryRecord(record),
    metadata: structuredClone(record.metadata) as Record<string, unknown>,
    content: record.content,
  };
}
