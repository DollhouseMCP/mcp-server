import {
  ConsoleStoreValidationError,
  assertDisplayString,
  assertUuid,
  cloneDate,
} from './ConsoleStoreValidation.js';

export interface IntegrationOpenApiSpecRecord {
  readonly id: string;
  readonly descriptorId: string;
  readonly spec: Readonly<Record<string, unknown>>;
  readonly sourceUrl: string | null;
  readonly specHash: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IntegrationOpenApiSpecUpsertInput {
  readonly descriptorId: string;
  readonly spec: Readonly<Record<string, unknown>>;
  readonly sourceUrl?: string | null;
  readonly specHash: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IIntegrationOpenApiSpecStore {
  findByDescriptorId(descriptorId: string): Promise<IntegrationOpenApiSpecRecord | null>;
  upsert(input: IntegrationOpenApiSpecUpsertInput): Promise<IntegrationOpenApiSpecRecord>;
}

export function validateIntegrationOpenApiSpecRecord(record: IntegrationOpenApiSpecRecord): void {
  assertUuid(record.id, 'id');
  validateIntegrationOpenApiSpecShape(record);
}

export function validateIntegrationOpenApiSpecInput(input: IntegrationOpenApiSpecUpsertInput): void {
  validateIntegrationOpenApiSpecShape({
    id: '00000000-0000-4000-8000-000000000000',
    descriptorId: input.descriptorId,
    spec: input.spec,
    sourceUrl: input.sourceUrl ?? null,
    specHash: input.specHash,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
}

export function cloneIntegrationOpenApiSpecRecord(
  record: IntegrationOpenApiSpecRecord,
): IntegrationOpenApiSpecRecord {
  return {
    ...record,
    spec: structuredClone(record.spec) as Record<string, unknown>,
    createdAt: cloneDate(record.createdAt) ?? new Date(record.createdAt),
    updatedAt: cloneDate(record.updatedAt) ?? new Date(record.updatedAt),
  };
}

function validateIntegrationOpenApiSpecShape(
  record: Omit<IntegrationOpenApiSpecRecord, 'id'> & { readonly id?: string },
): void {
  assertUuid(record.descriptorId, 'descriptorId');
  validateOpenApiSpec(record.spec);
  if (record.sourceUrl !== null) validateHttpsUrl(record.sourceUrl, 'sourceUrl');
  if (!/^[a-f0-9]{64}$/.test(record.specHash)) {
    throw new ConsoleStoreValidationError('specHash must be a lowercase SHA-256 hex digest');
  }
  if (record.updatedAt < record.createdAt) {
    throw new ConsoleStoreValidationError('updatedAt must be at or after createdAt');
  }
}

function validateOpenApiSpec(spec: unknown): void {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new ConsoleStoreValidationError('spec must be a JSON object');
  }
  if (Buffer.byteLength(JSON.stringify(spec), 'utf8') > 1024 * 1024) {
    throw new ConsoleStoreValidationError('spec must be at most 1MB');
  }
  const record = spec as Record<string, unknown>;
  const version = record.openapi;
  if (typeof version !== 'string' || !version.startsWith('3.')) {
    throw new ConsoleStoreValidationError('spec.openapi must declare OpenAPI 3.x');
  }
  if (!record.paths || typeof record.paths !== 'object' || Array.isArray(record.paths)) {
    throw new ConsoleStoreValidationError('spec.paths must be a JSON object');
  }
}

function validateHttpsUrl(value: string, name: string): void {
  assertDisplayString(value, name, 2048);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConsoleStoreValidationError(`${name} must be a valid HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new ConsoleStoreValidationError(`${name} must be an HTTPS URL without credentials or fragments`);
  }
}
