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
    super('integration credential cleanup must finish before connecting again');
    this.name = 'IntegrationCredentialCleanupPendingError';
  }
}

export class IntegrationAlreadyConnectedError extends Error {
  constructor() {
    super('integration is already connected');
    this.name = 'IntegrationAlreadyConnectedError';
  }
}

export class IntegrationPrincipalInactiveError extends Error {
  constructor() {
    super('integration principal is disabled, deleted, or missing');
    this.name = 'IntegrationPrincipalInactiveError';
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
  /** Monotonic generation of the persisted credential and permission state. */
  readonly credentialGeneration: number;
  readonly status: UserIntegrationStatus;
  readonly errorReason: UserIntegrationErrorReason | null;
  readonly authorizationStartedAt?: Date | null;
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

/** True while a row still holds credential material requiring use or cleanup. */
export function hasIntegrationCredentials(
  record: UserIntegrationRecord | null,
): boolean {
  return record !== null
    && (record.accessTokenCiphertext !== null || record.refreshTokenCiphertext !== null);
}

export interface IUserIntegrationStore {
  listByUser(userId: string): Promise<readonly UserIntegrationRecord[]>;
  findByProvider(userId: string, provider: UserIntegrationProvider): Promise<UserIntegrationRecord | null>;
  /** Capture request ordering using the store's own clock authority. */
  captureCredentialOperationStartedAt(requestedAt: Date): Promise<Date>;
  connect(input: UserIntegrationConnectInput): Promise<UserIntegrationRecord>;
  /** Atomically persist a credential only while its descriptor revision is current. */
  connectDescriptorCredential?(input: DescriptorCredentialConnectInput): Promise<UserIntegrationRecord | null>;
  /**
   * Atomically verify a descriptor-bound callback and persist its credentials.
   * Every store must serialize callback completion with descriptor rotation.
   */
  connectDescriptorCallback(input: DescriptorCallbackConnectInput): Promise<UserIntegrationRecord | null>;
  /** In-memory composition hook; durable stores fence against their own descriptor table. */
  configureDescriptorCallbackFence?(fence: IntegrationDescriptorCallbackFence): void;
  /** In-memory parity seam for pending OAuth authorization ordering. */
  configureAuthorizationFreshnessFence?(fence: IntegrationAuthorizationFreshnessFence): void;
  /** In-memory parity seam for account disable/delete fencing. */
  configurePrincipalLifecycleFence?(fence: IntegrationPrincipalLifecycleFence): void;
  refresh(input: UserIntegrationRefreshInput): Promise<UserIntegrationRefreshResult>;
  recordError(input: UserIntegrationErrorInput): Promise<UserIntegrationRecord | null>;
  /** Persist an uncommitted or superseded credential until provider revocation succeeds. */
  queueCredentialCleanup(input: UserIntegrationCleanupConnectInput): Promise<UserIntegrationRecord>;
  /** Move the active credential out of service without discarding its encrypted material. */
  markCredentialCleanupPending(input: UserIntegrationDisconnectInput): Promise<UserIntegrationRecord | null>;
  /**
   * Atomically record disconnect intent and move the current credential out of
   * service. PostgreSQL implementations use database time for the watermark.
   */
  beginAuthorizationDisconnect(
    userId: string,
    provider: UserIntegrationProvider,
    requestedAt: Date,
  ): Promise<UserIntegrationRecord | null>;
  /** Claim one pending credential before provider-side revocation. */
  claimCredentialCleanup(input: UserIntegrationCleanupClaimInput): Promise<UserIntegrationRecord | null>;
  /** Extend a cleanup lease only while the same generation and owner still hold it. */
  renewCredentialCleanupClaim(input: UserIntegrationCleanupRenewInput): Promise<boolean>;
  /** Release a failed cleanup claim immediately; its lease still bounds crash recovery. */
  releaseCredentialCleanupClaim(input: UserIntegrationCleanupReleaseInput): Promise<void>;
  listCredentialCleanup(userId: string, provider: UserIntegrationProvider): Promise<readonly UserIntegrationRecord[]>;
  completeCredentialCleanup(input: UserIntegrationCleanupCompleteInput): Promise<UserIntegrationRecord | null>;
  hasCredentialCleanupPending(userId: string, provider: UserIntegrationProvider): Promise<boolean>;
  /** Whether any active or cleanup row still contains a provider credential. */
  hasAnyCredentialMaterial(userId: string): Promise<boolean>;
  /** Whether a descriptor still owns any provider credential material. */
  hasCredentialMaterialByDescriptor(integrationDescriptorId: string): Promise<boolean>;
  /** Whether a descriptor still has credential material eligible for execution. */
  hasExecutableCredentialMaterialByDescriptor(integrationDescriptorId: string): Promise<boolean>;
  disconnect(input: UserIntegrationDisconnectInput): Promise<UserIntegrationRecord | null>;
  revokeAllByDescriptor(integrationDescriptorId: string, revokedAt: Date): Promise<number>;
}

export interface IntegrationDescriptorCallbackFence {
  runIfCurrent<T>(
    descriptorId: string,
    descriptorFingerprint: string,
    operation: () => Promise<T>,
  ): Promise<T | null>;
}

export interface IntegrationAuthorizationFreshnessFence {
  hasNewerAuthorization(
    userId: string,
    descriptorId: string | null,
    transactionIdHash: Buffer,
  ): Promise<boolean>;
  isCompletionCurrent(transactionIdHash: Buffer): Promise<boolean>;
}

export interface IntegrationPrincipalLifecycleFence {
  isPrincipalActive(userId: string): Promise<boolean>;
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
  /** Start of the authorization that minted this credential; defaults to connectedAt for non-OAuth input. */
  readonly authorizationStartedAt?: Date;
  readonly connectedAt: Date;
}

export interface DescriptorCallbackConnectInput {
  readonly transactionIdHash: Buffer;
  readonly descriptorId: string | null;
  readonly descriptorFingerprint: string | null;
  /** Start time of this authorization attempt, used to reject stale callback completion. */
  readonly authorizationStartedAt: Date;
  readonly connection: UserIntegrationConnectInput;
}

export interface UserIntegrationCleanupConnectInput extends UserIntegrationConnectInput {
  readonly cleanupRequestedAt: Date;
}

export interface UserIntegrationCleanupCompleteInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly integrationId: string;
  readonly credentialGeneration: number;
  readonly cleanupLeaseId: string;
  readonly completedAt: Date;
}

export interface UserIntegrationCleanupClaimInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly integrationId: string;
  readonly credentialGeneration: number;
  readonly cleanupLeaseId: string;
  /** Store-local clock authority computes the absolute expiry. */
  readonly leaseDurationMs: number;
}

export interface UserIntegrationCleanupReleaseInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly integrationId: string;
  readonly cleanupLeaseId: string;
}

export interface UserIntegrationCleanupRenewInput extends UserIntegrationCleanupReleaseInput {
  readonly credentialGeneration: number;
  readonly leaseDurationMs: number;
}

export interface DescriptorCredentialConnectInput {
  readonly descriptorId: string;
  readonly descriptorFingerprint: string;
  /** Request-entry watermark used to reject a connect superseded by disconnect. */
  readonly operationStartedAt: Date;
  readonly connection: UserIntegrationConnectInput;
}

export interface UserIntegrationRefreshInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly integrationDescriptorId: string | null;
  readonly staleAccessTokenCiphertext: Buffer;
  readonly staleCredentialGeneration: number;
  readonly staleAuthorizedPermissions: Readonly<Record<string, unknown>>;
  readonly refreshedAt: Date;
  readonly refresh: (record: UserIntegrationRecord) => Promise<UserIntegrationRefreshDecision>;
}

export type UserIntegrationRefreshDecision =
  | {
      readonly kind: 'refreshed';
      readonly accessTokenCiphertext: Buffer;
      readonly refreshTokenCiphertext: Buffer | null;
      readonly credentialKeyVersion?: string | null;
      readonly authorizedPermissions?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'failed';
      readonly errorReason: Extract<UserIntegrationErrorReason, 'token_refresh_failed' | 'provider_unavailable'>;
    }
  | {
      /** Operational failure; leave the connected credential unchanged and release the lease. */
      readonly kind: 'retryable';
    };

export type UserIntegrationRefreshResult =
  | { readonly kind: 'missing'; readonly record: null }
  | { readonly kind: 'reused'; readonly record: UserIntegrationRecord }
  | { readonly kind: 'refreshed'; readonly record: UserIntegrationRecord }
  | { readonly kind: 'failed'; readonly record: UserIntegrationRecord }
  | { readonly kind: 'retryable'; readonly record: UserIntegrationRecord };

export interface UserIntegrationDisconnectInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly integrationId: string;
  readonly credentialGeneration: number;
  readonly revokedAt: Date;
}

export interface UserIntegrationErrorInput {
  readonly userId: string;
  readonly provider: UserIntegrationProvider;
  readonly integrationDescriptorId?: string | null;
  readonly integrationId: string;
  readonly credentialGeneration: number;
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
  if (!['connected', 'cleanup_pending', 'revoked', 'error'].includes(record.status)) {
    throw new ConsoleStoreValidationError(`unsupported integration status '${record.status}'`);
  }
  if (record.errorReason !== null && !isIntegrationErrorReason(record.errorReason)) {
    throw new ConsoleStoreValidationError(`unsupported integration error reason '${record.errorReason}'`);
  }
  assertNullableDisplayString(record.externalAccountLabel, 'externalAccountLabel', 200);
  assertNullableDisplayString(record.externalInstallationId, 'externalInstallationId', 200);
  assertNullableDisplayString(record.credentialKeyVersion, 'credentialKeyVersion', 128);
  if (!Number.isSafeInteger(record.credentialGeneration) || record.credentialGeneration < 0) {
    throw new ConsoleStoreValidationError('credentialGeneration must be a non-negative safe integer');
  }
  assertAuthorizedPermissions(record.provider, record.authorizedPermissions);
  if (record.accessTokenCiphertext) assertNonEmptyBuffer(record.accessTokenCiphertext, 'accessTokenCiphertext');
  if (record.refreshTokenCiphertext) assertNonEmptyBuffer(record.refreshTokenCiphertext, 'refreshTokenCiphertext');
  if (record.authorizationStartedAt !== null && record.authorizationStartedAt !== undefined
      && (!(record.authorizationStartedAt instanceof Date)
        || Number.isNaN(record.authorizationStartedAt.getTime()))) {
    throw new ConsoleStoreValidationError('authorizationStartedAt must be a valid date or null');
  }
  if (record.status === 'connected' && (!record.authorizationStartedAt || !record.connectedAt)) {
    throw new ConsoleStoreValidationError('connected integration requires authorization and connection timestamps');
  }
  if ((record.status === 'revoked' || record.status === 'cleanup_pending') && !record.revokedAt) {
    throw new ConsoleStoreValidationError(`${record.status} integration requires revokedAt`);
  }
  if (record.status === 'cleanup_pending') {
    if (record.errorReason !== 'revocation_failed') {
      throw new ConsoleStoreValidationError('cleanup_pending integration requires revocation_failed');
    }
    if (!record.accessTokenCiphertext && !record.refreshTokenCiphertext) {
      throw new ConsoleStoreValidationError('cleanup_pending integration requires credential material');
    }
  } else if (record.status !== 'error' && record.errorReason !== null) {
    throw new ConsoleStoreValidationError('integration error reason requires error or cleanup_pending status');
  }
  if (record.status === 'error' && record.errorReason === null) {
    throw new ConsoleStoreValidationError('error integration requires errorReason');
  }
}

export function cloneUserIntegrationRecord(record: UserIntegrationRecord): UserIntegrationRecord {
  return {
    ...record,
    authorizedPermissions: cloneJsonRecord(record.authorizedPermissions),
    accessTokenCiphertext: record.accessTokenCiphertext ? cloneBuffer(record.accessTokenCiphertext) : null,
    refreshTokenCiphertext: record.refreshTokenCiphertext ? cloneBuffer(record.refreshTokenCiphertext) : null,
    authorizationStartedAt: cloneDate(record.authorizationStartedAt ?? null),
    connectedAt: cloneDate(record.connectedAt),
    lastSyncAt: cloneDate(record.lastSyncAt),
    revokedAt: cloneDate(record.revokedAt),
  };
}

/** Compare validated JSON permission snapshots without depending on object realm or key order. */
export function areAuthorizedPermissionsEqual(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  return stableJsonValue(left) === stableJsonValue(right);
}

function stableJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonValue).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJsonValue(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
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
