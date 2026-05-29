import {
  ConsoleStoreValidationError,
  assertNonEmptyBuffer,
  assertUuid,
  cloneBuffer,
  cloneDate,
} from './ConsoleStoreValidation.js';

export type UserIntegrationProvider = 'github';
export type UserIntegrationStatus = 'connected' | 'revoked' | 'error';

export interface UserIntegrationRecord {
  readonly id: string;
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly externalAccountLabel: string | null;
  readonly externalInstallationId: string | null;
  readonly authorizedPermissions: Readonly<Record<string, unknown>>;
  readonly accessTokenCiphertext: Buffer | null;
  readonly refreshTokenCiphertext: Buffer | null;
  readonly credentialKeyVersion: string | null;
  readonly status: UserIntegrationStatus;
  readonly connectedAt: Date | null;
  readonly lastSyncAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface IUserIntegrationStore {
  listByUser(userId: string): Promise<readonly UserIntegrationRecord[]>;
  findByProvider(userId: string, provider: UserIntegrationProvider): Promise<UserIntegrationRecord | null>;
}

export function validateUserIntegrationRecord(record: UserIntegrationRecord): void {
  assertUuid(record.id, 'id');
  assertUuid(record.userId, 'userId');
  if (!['connected', 'revoked', 'error'].includes(record.status)) {
    throw new ConsoleStoreValidationError(`unsupported integration status '${record.status}'`);
  }
  assertNullableDisplayString(record.externalAccountLabel, 'externalAccountLabel', 200);
  assertNullableDisplayString(record.externalInstallationId, 'externalInstallationId', 200);
  assertNullableDisplayString(record.credentialKeyVersion, 'credentialKeyVersion', 128);
  assertAuthorizedPermissions(record.provider, record.authorizedPermissions);
  if (record.accessTokenCiphertext) assertNonEmptyBuffer(record.accessTokenCiphertext, 'accessTokenCiphertext');
  if (record.refreshTokenCiphertext) assertNonEmptyBuffer(record.refreshTokenCiphertext, 'refreshTokenCiphertext');
  if (record.status === 'revoked' && !record.revokedAt) {
    throw new ConsoleStoreValidationError('revoked integration requires revokedAt');
  }
}

export function cloneUserIntegrationRecord(record: UserIntegrationRecord): UserIntegrationRecord {
  return {
    ...record,
    authorizedPermissions: cloneJsonRecord(record.authorizedPermissions),
    accessTokenCiphertext: record.accessTokenCiphertext ? cloneBuffer(record.accessTokenCiphertext) : null,
    refreshTokenCiphertext: record.refreshTokenCiphertext ? cloneBuffer(record.refreshTokenCiphertext) : null,
    connectedAt: cloneDate(record.connectedAt),
    lastSyncAt: cloneDate(record.lastSyncAt),
    revokedAt: cloneDate(record.revokedAt),
  };
}

function assertNullableDisplayString(value: string | null, name: string, maxLength: number): void {
  if (value === null) return;
  if (typeof value !== 'string'
      || value.trim() === ''
      || value.length > maxLength
      || containsControlCharacter(value)) {
    throw new ConsoleStoreValidationError(`${name} must be a printable non-empty string up to ${maxLength} characters`);
  }
}

function assertAuthorizedPermissions(
  provider: UserIntegrationProvider,
  value: Readonly<Record<string, unknown>>,
): void {
  void provider;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 4096) {
    throw new ConsoleStoreValidationError('authorizedPermissions must be at most 4096 bytes');
  }
  assertNoUnsafePermissionKeys(value);
  const topLevelKeys = Object.keys(value);
  if (topLevelKeys.length !== 2
      || !topLevelKeys.includes('repository_selection')
      || !topLevelKeys.includes('permissions')) {
    throw new ConsoleStoreValidationError('authorizedPermissions may contain only repository_selection and permissions');
  }
  const repositorySelection = value.repository_selection;
  if (repositorySelection !== 'selected' && repositorySelection !== 'all' && repositorySelection !== 'unknown') {
    throw new ConsoleStoreValidationError('authorizedPermissions.repository_selection must be selected, all, or unknown');
  }
  const permissions = value.permissions;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw new ConsoleStoreValidationError('authorizedPermissions.permissions must be a JSON object');
  }
  const permissionRecord = permissions as Record<string, unknown>;
  assertNoUnsafePermissionKeys(permissionRecord);
  const permissionKeys = Object.keys(permissionRecord);
  if (permissionKeys.length !== 1 || permissionKeys[0] !== 'contents') {
    throw new ConsoleStoreValidationError('authorizedPermissions.permissions may contain only contents');
  }
  const contents = permissionRecord.contents;
  if (contents !== 'none' && contents !== 'read' && contents !== 'write') {
    throw new ConsoleStoreValidationError('authorizedPermissions.permissions.contents must be none, read, or write');
  }
}

function assertNoUnsafePermissionKeys(value: Readonly<Record<string, unknown>>): void {
  const unsafeKeys = new Set([
    'access_token',
    'accessToken',
    'refresh_token',
    'refreshToken',
    'token',
    'token_hash',
    'tokenHash',
    'ciphertext',
    'credential_key_version',
    'credentialKeyVersion',
    'administration',
    'actions',
    'workflows',
    'secrets',
    'metadata',
  ]);
  for (const key of Object.keys(value)) {
    if (unsafeKeys.has(key)) {
      throw new ConsoleStoreValidationError(`authorizedPermissions contains unsafe key '${key}'`);
    }
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function cloneJsonRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
