import {
  ConsoleStoreValidationError,
  assertDisplayString,
  assertNullableDisplayString,
  assertNonEmptyBuffer,
  assertUuid,
  cloneBuffer,
  cloneDate,
} from './ConsoleStoreValidation.js';
import type {
  UserIntegrationProvider,
  UserIntegrationStatus,
  UserIntegrationErrorReason,
} from '../../database/schema/webConsole.js';

// The schema layer is the single source of truth for these persisted integration
// domain types (the user_integrations column is annotated with them). Re-exported
// here so store-layer consumers keep a stable import site.
export type {
  UserIntegrationProvider,
  UserIntegrationStatus,
  UserIntegrationErrorReason,
};
export const GITHUB_USER_INTEGRATION_PROVIDER = 'github' as const;

export class IntegrationCredentialCleanupPendingError extends Error {
  constructor() {
    super('integration credential cleanup must finish before reconnecting');
    this.name = 'IntegrationCredentialCleanupPendingError';
  }
}

export interface UserIntegrationRecord {
  readonly id: string;
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly integrationDescriptorId?: string | null;
  readonly externalAccountLabel: string | null;
  readonly externalInstallationId: string | null;
  readonly authorizedPermissions: Readonly<Record<string, unknown>>;
  readonly accessTokenCiphertext: Buffer | null;
  readonly refreshTokenCiphertext: Buffer | null;
  readonly credentialKeyVersion: string | null;
  readonly status: UserIntegrationStatus;
  readonly errorReason: UserIntegrationErrorReason | null;
  readonly cleanupAttemptCount: number;
  readonly cleanupNextAttemptAt: Date | null;
  readonly cleanupLeaseId: string | null;
  readonly cleanupLeaseExpiresAt: Date | null;
  readonly connectedAt: Date | null;
  readonly lastSyncAt: Date | null;
  readonly revokedAt: Date | null;
}

/**
 * A record is usable only if it is connected AND not revoked. Shared so the
 * gateway, remote-MCP bridge, and operation catalog apply the same predicate —
 * a revoked-but-stale record (status still 'connected' during a revocation race)
 * must never be treated as connected.
 */
export function isIntegrationConnected(
  record: UserIntegrationRecord | null,
): record is UserIntegrationRecord {
  return record?.status === 'connected' && record.revokedAt === null;
}

/** A configured credential may only be used by the descriptor that created it. */
export function isIntegrationConnectedToDescriptor(
  record: UserIntegrationRecord | null,
  descriptorId: string,
): record is UserIntegrationRecord {
  return isIntegrationConnected(record) && record.integrationDescriptorId === descriptorId;
}

/** True while an unrevoked row still holds credential material requiring cleanup. */
export function hasIntegrationCredentials(
  record: UserIntegrationRecord | null,
): boolean {
  return record?.revokedAt === null
    && (record.accessTokenCiphertext !== null || record.refreshTokenCiphertext !== null);
}

export interface IUserIntegrationStore {
  listByUser(
    userId: string,
    providers: readonly UserIntegrationProvider[],
  ): Promise<readonly UserIntegrationRecord[]>;
  findByProvider(userId: string, provider: UserIntegrationProvider): Promise<UserIntegrationRecord | null>;
  findCredentialCleanupPending(
    userId: string,
    provider: UserIntegrationProvider,
  ): Promise<UserIntegrationRecord | null>;
  findCredentialCleanupFailed(
    userId: string,
    provider: UserIntegrationProvider,
  ): Promise<UserIntegrationRecord | null>;
  connect(input: UserIntegrationConnectInput): Promise<UserIntegrationRecord>;
  /** Atomically persist a credential only while its descriptor revision is current. */
  connectDescriptorCredential?(input: DescriptorCredentialConnectInput): Promise<UserIntegrationRecord | null>;
  /**
   * Atomically verify a descriptor-bound callback and persist its credentials.
   * PostgreSQL implements this to serialize callback completion with descriptor
   * rotation; stores without shared descriptor state may omit it.
   */
  connectDescriptorCallback?(input: DescriptorCallbackConnectInput): Promise<UserIntegrationRecord | null>;
  refresh(input: UserIntegrationRefreshInput): Promise<UserIntegrationRefreshResult>;
  recordError(input: UserIntegrationErrorInput): Promise<UserIntegrationRecord | null>;
  beginCredentialCleanup(input: UserIntegrationDisconnectInput): Promise<UserIntegrationRecord | null>;
  claimCredentialCleanup(input: UserIntegrationCleanupClaimInput): Promise<UserIntegrationRecord | null>;
  releaseCredentialCleanup(input: UserIntegrationCleanupReleaseInput): Promise<UserIntegrationRecord | null>;
  failCredentialCleanup(input: UserIntegrationCleanupFailInput): Promise<UserIntegrationRecord | null>;
  abandonCredentialCleanupForUser(
    input: UserIntegrationCleanupAbandonInput,
  ): Promise<readonly UserIntegrationRecord[]>;
  completeCredentialCleanup(input: UserIntegrationCleanupCompleteInput): Promise<UserIntegrationRecord | null>;
  hasAnyCredentialMaterial(userId: string): Promise<boolean>;
  hasCredentialMaterialByDescriptor(integrationDescriptorId: string): Promise<boolean>;
  hasBlockingCredentialMaterial(userId: string): Promise<boolean>;
  hasBlockingCredentialMaterialByDescriptor(integrationDescriptorId: string): Promise<boolean>;
  disconnect(input: UserIntegrationDisconnectInput): Promise<UserIntegrationRecord | null>;
}

export interface UserIntegrationConnectInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly integrationDescriptorId?: string | null;
  readonly externalAccountLabel: string | null;
  readonly externalInstallationId: string | null;
  readonly authorizedPermissions: Readonly<Record<string, unknown>>;
  readonly accessTokenCiphertext: Buffer;
  readonly refreshTokenCiphertext: Buffer | null;
  readonly credentialKeyVersion?: string | null;
  readonly connectedAt: Date;
}

export interface DescriptorCallbackConnectInput {
  readonly transactionIdHash: Buffer;
  readonly descriptorId: string;
  readonly descriptorFingerprint: string;
  readonly connection: UserIntegrationConnectInput;
}

export interface DescriptorCredentialConnectInput {
  readonly descriptorId: string;
  readonly descriptorFingerprint: string;
  readonly connection: UserIntegrationConnectInput;
}

export interface UserIntegrationRefreshInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly integrationDescriptorId: string | null;
  readonly staleAccessTokenCiphertext: Buffer;
  readonly refreshedAt: Date;
  readonly refresh: (record: UserIntegrationRecord) => Promise<UserIntegrationRefreshDecision>;
}

export type UserIntegrationRefreshDecision =
  | {
      readonly kind: 'refreshed';
      readonly accessTokenCiphertext: Buffer;
      readonly refreshTokenCiphertext: Buffer | null;
      readonly authorizedPermissions?: Readonly<Record<string, unknown>>;
      readonly credentialKeyVersion?: string | null;
    }
  | {
      readonly kind: 'failed';
      readonly errorReason: Extract<UserIntegrationErrorReason, 'token_refresh_failed' | 'provider_unavailable'>;
    };

export type UserIntegrationRefreshResult =
  | { readonly kind: 'missing'; readonly record: null }
  | { readonly kind: 'reused'; readonly record: UserIntegrationRecord }
  | { readonly kind: 'refreshed'; readonly record: UserIntegrationRecord }
  | { readonly kind: 'failed'; readonly record: UserIntegrationRecord };

export interface UserIntegrationDisconnectInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly expectedActiveRecordId: string;
  readonly revokedAt: Date;
}

export interface UserIntegrationCleanupClaimInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly cleanupRecordId: string;
  readonly leaseId: string;
  readonly attemptedAt: Date;
  readonly leaseExpiresAt: Date;
}

export interface UserIntegrationCleanupReleaseInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly cleanupRecordId: string;
  readonly leaseId: string;
  readonly retryAt: Date;
}

export interface UserIntegrationCleanupFailInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly cleanupRecordId: string;
  readonly leaseId: string;
}

export interface UserIntegrationCleanupAbandonInput {
  readonly userId: string;
}

export interface UserIntegrationCleanupCompleteInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly cleanupRecordId: string;
  readonly leaseId: string;
  readonly completedAt: Date;
}

export interface UserIntegrationErrorInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly expectedActiveRecordId: string | null;
  readonly integrationDescriptorId?: string | null;
  readonly errorReason: UserIntegrationErrorReason;
  readonly occurredAt: Date;
}

export function validateUserIntegrationRecord(record: UserIntegrationRecord): void {
  assertUuid(record.id, 'id');
  assertUuid(record.userId, 'userId');
  assertUserIntegrationProvider(record.provider);
  if (record.integrationDescriptorId) {
    assertUuid(record.integrationDescriptorId, 'integrationDescriptorId');
  }
  if (!['connected', 'cleanup_pending', 'cleanup_failed', 'revoked', 'error'].includes(record.status)) {
    throw new ConsoleStoreValidationError(`unsupported integration status '${record.status}'`);
  }
  if (record.errorReason !== null && !isIntegrationErrorReason(record.errorReason)) {
    throw new ConsoleStoreValidationError(`unsupported integration error reason '${record.errorReason}'`);
  }
  assertNullableDisplayString(record.externalAccountLabel, 'externalAccountLabel', 200);
  assertNullableDisplayString(record.externalInstallationId, 'externalInstallationId', 200);
  assertNullableDisplayString(record.credentialKeyVersion, 'credentialKeyVersion', 128);
  assertAuthorizedPermissions(record.provider, record.authorizedPermissions);
  if (record.accessTokenCiphertext) assertNonEmptyBuffer(record.accessTokenCiphertext, 'accessTokenCiphertext');
  if (record.refreshTokenCiphertext) assertNonEmptyBuffer(record.refreshTokenCiphertext, 'refreshTokenCiphertext');
  assertIntegrationCleanupMetadata(record);
  assertIntegrationErrorState(record);
}

function assertIntegrationCleanupMetadata(record: UserIntegrationRecord): void {
  if (!Number.isSafeInteger(record.cleanupAttemptCount) || record.cleanupAttemptCount < 0) {
    throw new ConsoleStoreValidationError('cleanupAttemptCount must be a non-negative safe integer');
  }
  if ((record.cleanupLeaseId === null) !== (record.cleanupLeaseExpiresAt === null)) {
    throw new ConsoleStoreValidationError('cleanup lease id and expiry must be present together');
  }
  if (record.cleanupLeaseId !== null) assertUuid(record.cleanupLeaseId, 'cleanupLeaseId');
  if ((record.status === 'revoked' || record.status === 'cleanup_pending'
      || record.status === 'cleanup_failed') && !record.revokedAt) {
    throw new ConsoleStoreValidationError(`${record.status} integration requires revokedAt`);
  }
  if (record.status === 'cleanup_pending') {
    assertCleanupPendingRecord(record);
    return;
  }
  if (record.status === 'cleanup_failed') {
    assertCleanupFailedRecord(record);
    return;
  }
  if (record.cleanupAttemptCount !== 0 || record.cleanupNextAttemptAt !== null
      || record.cleanupLeaseId !== null || record.cleanupLeaseExpiresAt !== null) {
    throw new ConsoleStoreValidationError('cleanup metadata requires cleanup_pending status');
  }
}

function assertCleanupFailedRecord(record: UserIntegrationRecord): void {
  if (record.errorReason !== 'revocation_failed') {
    throw new ConsoleStoreValidationError('cleanup_failed integration requires revocation_failed');
  }
  if (!record.accessTokenCiphertext && !record.refreshTokenCiphertext) {
    throw new ConsoleStoreValidationError('cleanup_failed integration requires credential material');
  }
  if (record.cleanupNextAttemptAt !== null || record.cleanupLeaseId !== null
      || record.cleanupLeaseExpiresAt !== null) {
    throw new ConsoleStoreValidationError('cleanup_failed integration cannot retain retry or lease metadata');
  }
}

function assertCleanupPendingRecord(record: UserIntegrationRecord): void {
  if (record.errorReason !== 'revocation_failed') {
    throw new ConsoleStoreValidationError('cleanup_pending integration requires revocation_failed');
  }
  if (!record.accessTokenCiphertext && !record.refreshTokenCiphertext) {
    throw new ConsoleStoreValidationError('cleanup_pending integration requires credential material');
  }
  if (!record.cleanupNextAttemptAt) {
    throw new ConsoleStoreValidationError('cleanup_pending integration requires cleanupNextAttemptAt');
  }
}

function assertIntegrationErrorState(record: UserIntegrationRecord): void {
  if (record.status === 'error' && record.errorReason === null) {
    throw new ConsoleStoreValidationError('error integration requires errorReason');
  }
  if (record.status !== 'error' && record.status !== 'cleanup_pending'
      && record.status !== 'cleanup_failed' && record.errorReason !== null) {
    throw new ConsoleStoreValidationError(
      'integration error reason requires error, cleanup_pending, or cleanup_failed status',
    );
  }
}

export function cloneUserIntegrationRecord(record: UserIntegrationRecord): UserIntegrationRecord {
  return {
    ...record,
    authorizedPermissions: cloneJsonRecord(record.authorizedPermissions),
    accessTokenCiphertext: record.accessTokenCiphertext ? cloneBuffer(record.accessTokenCiphertext) : null,
    refreshTokenCiphertext: record.refreshTokenCiphertext ? cloneBuffer(record.refreshTokenCiphertext) : null,
    cleanupNextAttemptAt: cloneDate(record.cleanupNextAttemptAt),
    cleanupLeaseExpiresAt: cloneDate(record.cleanupLeaseExpiresAt),
    connectedAt: cloneDate(record.connectedAt),
    lastSyncAt: cloneDate(record.lastSyncAt),
    revokedAt: cloneDate(record.revokedAt),
  };
}

function assertAuthorizedPermissions(
  provider: UserIntegrationProvider,
  value: Readonly<Record<string, unknown>>,
): void {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 4096) {
    throw new ConsoleStoreValidationError('authorizedPermissions must be at most 4096 bytes');
  }
  assertNoUnsafePermissionKeys(value);
  if (provider === GITHUB_USER_INTEGRATION_PROVIDER) {
    assertGitHubAuthorizedPermissions(value);
    return;
  }
  assertGenericAuthorizedPermissions(value);
}

export function assertUserIntegrationProvider(provider: string): asserts provider is UserIntegrationProvider {
  assertDisplayString(provider, 'provider', 64);
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(provider)) {
    throw new ConsoleStoreValidationError('provider must be a lowercase provider id (2-64 chars: a-z, 0-9, _, -)');
  }
}

function assertGitHubAuthorizedPermissions(value: Readonly<Record<string, unknown>>): void {
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

function assertGenericAuthorizedPermissions(value: Readonly<Record<string, unknown>>): void {
  const topLevelKeys = Object.keys(value);
  if (topLevelKeys.length !== 1 || topLevelKeys[0] !== 'scopes') {
    throw new ConsoleStoreValidationError('authorizedPermissions for configured providers may contain only scopes');
  }
  const scopes = value.scopes;
  if (!Array.isArray(scopes)) {
    throw new ConsoleStoreValidationError('authorizedPermissions.scopes must be an array');
  }
  if (scopes.length > 100) {
    throw new ConsoleStoreValidationError('authorizedPermissions.scopes must contain at most 100 entries');
  }
  for (const scope of scopes) {
    if (typeof scope !== 'string') {
      throw new ConsoleStoreValidationError('authorizedPermissions.scopes entries must be strings');
    }
    assertDisplayString(scope, 'authorizedPermissions.scopes entry', 200);
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

function isIntegrationErrorReason(value: string): value is UserIntegrationErrorReason {
  return value === 'token_exchange_failed' ||
    value === 'token_refresh_failed' ||
    value === 'revocation_failed' ||
    value === 'scope_denied' ||
    value === 'provider_unavailable';
}

function cloneJsonRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return structuredClone(value) as Record<string, unknown>;
}
