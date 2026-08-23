/**
 * Dormant persistence tables for the rewritten `/api/v1` web console.
 *
 * These tables are platform-security state. Browser cookie and OAuth transient
 * values are stored only as keyed hashes or encrypted ciphertext.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  customType,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export type ConsoleAdminRole =
  | 'admin'
  | 'account_admin'
  | 'operator'
  | 'auditor'
  | 'security_admin';

export const userAdminRoles = pgTable('user_admin_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').$type<ConsoleAdminRole>().notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  grantedByUserId: uuid('granted_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
}, (table) => [
  index('idx_user_admin_roles_user').on(table.userId),
  uniqueIndex('idx_user_admin_roles_active_unique')
    .on(table.userId, table.role)
    .where(sql`${table.revokedAt} IS NULL`),
  index('idx_user_admin_roles_active_role')
    .on(table.role)
    .where(sql`${table.revokedAt} IS NULL`),
]);

/**
 * History-preserving account allowlist replacement surface.
 *
 * This relation is not authoritative for sign-in until the AS gate is cut over
 * from `auth_allowlist`; account allowlist routes stay feature-gated off by
 * default so operators cannot mistake this table for the live sign-in gate.
 */
export const accountAllowlistEntries = pgTable('account_allowlist_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').$type<'email' | 'github_username' | 'github_id'>().notNull(),
  normalizedValue: text('normalized_value').notNull(),
  displayValue: text('display_value').notNull(),
  note: text('note'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  check('account_allowlist_entries_kind_check', sql`${table.kind} IN ('email', 'github_username', 'github_id')`),
  check('account_allowlist_entries_shape_check', sql`
    btrim(${table.normalizedValue}) <> ''
    AND btrim(${table.displayValue}) <> ''
    AND char_length(${table.normalizedValue}) <= 320
    AND char_length(${table.displayValue}) <= 320
    AND (${table.note} IS NULL OR char_length(${table.note}) <= 500)
    AND (
      (${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL)
      OR (${table.revokedAt} IS NOT NULL AND ${table.revokedByUserId} IS NOT NULL)
    )
  `),
  uniqueIndex('idx_account_allowlist_entries_active_unique')
    .on(table.kind, table.normalizedValue)
    .where(sql`${table.revokedAt} IS NULL`),
  index('idx_account_allowlist_entries_created').on(table.createdAt),
]);

export const consoleSessions = pgTable('console_sessions', {
  idHash: bytea('id_hash').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  authSub: text('auth_sub').notNull(),
  csrfTokenHash: bytea('csrf_token_hash').notNull(),
  grantedCapabilities: text('granted_capabilities').array().notNull(),
  elevatedCapabilities: text('elevated_capabilities').array().notNull(),
  elevationExpiresAt: timestamp('elevation_expires_at', { withTimezone: true }),
  elevationAcr: text('elevation_acr'),
  elevationAmr: text('elevation_amr').array(),
  elevationAuthTime: timestamp('elevation_auth_time', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastIp: text('last_ip'),
  userAgent: text('user_agent'),
}, (table) => [
  index('idx_console_sessions_user_revocation_expiry')
    .on(table.userId, table.revokedAt, table.absoluteExpiresAt),
  index('idx_console_sessions_absolute_expiry').on(table.absoluteExpiresAt),
]);

export const consoleAuthPolicy = pgTable('console_auth_policy', {
  id: integer('id').primaryKey().default(1),
  maxAdminElevationSeconds: integer('max_admin_elevation_seconds').notNull().default(300),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`NOW()`),
}, (table) => [
  check('console_auth_policy_singleton_check', sql`${table.id} = 1`),
  check('console_auth_policy_max_admin_elevation_check', sql`
    ${table.maxAdminElevationSeconds} >= 60
    AND ${table.maxAdminElevationSeconds} <= 300
  `),
]);

export type ConsoleLoginFlowKind = 'login' | 'step_up' | 'integration_link';

export const consoleLoginTransactions = pgTable('console_login_transactions', {
  idHash: bytea('id_hash').primaryKey(),
  flowKind: text('flow_kind').$type<ConsoleLoginFlowKind>().notNull(),
  stateHash: bytea('state_hash').notNull(),
  pkceVerifierEnc: bytea('pkce_verifier_enc').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  consoleSessionIdHash: bytea('console_session_id_hash'),
  requestedCapability: text('requested_capability'),
  returnTo: text('return_to'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, (table) => [
  index('idx_console_login_transactions_expiry').on(table.expiresAt),
]);

export type UserIntegrationProvider = string;
export type UserIntegrationStatus = 'connected' | 'revoked' | 'error';
export type UserIntegrationErrorReason =
  | 'token_exchange_failed'
  | 'revocation_failed'
  | 'scope_denied'
  | 'provider_unavailable';
export type IntegrationDescriptorOwnership = 'curated' | 'byo';
export type IntegrationAuthStrategy = 'oauth2_authorization_code' | 'static_api_key' | 'coded';

export const userIntegrations = pgTable('user_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').$type<UserIntegrationProvider>().notNull(),
  externalAccountLabel: text('external_account_label'),
  externalInstallationId: text('external_installation_id'),
  authorizedPermissions: jsonb('authorized_permissions').notNull().default({
    repository_selection: 'unknown',
    permissions: { contents: 'none' },
  }),
  accessTokenCiphertext: bytea('access_token_ciphertext'),
  refreshTokenCiphertext: bytea('refresh_token_ciphertext'),
  credentialKeyVersion: text('credential_key_version'),
  status: text('status').$type<UserIntegrationStatus>().notNull(),
  errorReason: text('error_reason').$type<UserIntegrationErrorReason>(),
  connectedAt: timestamp('connected_at', { withTimezone: true }),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  check('user_integrations_provider_check', sql`${table.provider} ~ '^[a-z][a-z0-9_-]{1,63}$'`),
  check('user_integrations_status_check', sql`${table.status} IN ('connected', 'revoked', 'error')`),
  check('user_integrations_shape_check', sql`
    (${table.externalAccountLabel} IS NULL OR (
      btrim(${table.externalAccountLabel}) <> ''
      AND char_length(${table.externalAccountLabel}) <= 200
    ))
    AND (${table.externalInstallationId} IS NULL OR (
      btrim(${table.externalInstallationId}) <> ''
      AND char_length(${table.externalInstallationId}) <= 200
    ))
    AND (${table.credentialKeyVersion} IS NULL OR (
      btrim(${table.credentialKeyVersion}) <> ''
      AND char_length(${table.credentialKeyVersion}) <= 128
    ))
    AND jsonb_typeof(${table.authorizedPermissions}) = 'object'
    AND char_length(${table.authorizedPermissions}::text) <= 4096
    AND NOT (${table.authorizedPermissions} ?| array[
      'access_token',
      'accessToken',
      'refresh_token',
      'refreshToken',
      'token',
      'token_hash',
      'tokenHash',
      'ciphertext',
      'credential_key_version',
      'credentialKeyVersion'
    ])
    AND (
      (
        ${table.provider} = 'github'
        AND (${table.authorizedPermissions} ?& array['repository_selection', 'permissions'])
        AND (${table.authorizedPermissions} - 'repository_selection' - 'permissions') = '{}'::jsonb
        AND (${table.authorizedPermissions}->>'repository_selection') IN ('selected', 'all', 'unknown')
        AND jsonb_typeof(${table.authorizedPermissions}->'permissions') = 'object'
        AND ((${table.authorizedPermissions}->'permissions') - 'contents') = '{}'::jsonb
        AND (${table.authorizedPermissions}->'permissions'->>'contents') IN ('none', 'read', 'write')
        AND NOT (${table.authorizedPermissions}->'permissions' ?| array[
          'administration',
          'actions',
          'workflows',
          'secrets',
          'metadata'
        ])
      )
      OR (
        ${table.provider} <> 'github'
        AND (${table.authorizedPermissions} ?& array['scopes'])
        AND (${table.authorizedPermissions} - 'scopes') = '{}'::jsonb
        AND jsonb_typeof(${table.authorizedPermissions}->'scopes') = 'array'
        AND jsonb_array_length(${table.authorizedPermissions}->'scopes') <= 100
      )
    )
    AND (
      (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL)
      OR (${table.status} <> 'revoked')
    )
    AND (
      (${table.status} = 'error'
        AND ${table.errorReason} IN (
          'token_exchange_failed',
          'revocation_failed',
          'scope_denied',
          'provider_unavailable'
        ))
      OR (${table.status} <> 'error' AND ${table.errorReason} IS NULL)
    )
  `),
  uniqueIndex('idx_user_integrations_active_provider_unique')
    .on(table.userId, table.provider)
    .where(sql`${table.revokedAt} IS NULL`),
  index('idx_user_integrations_user').on(table.userId, table.revokedAt),
]);

export const integrationProviderDescriptors = pgTable('integration_provider_descriptors', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  ownership: text('ownership').$type<IntegrationDescriptorOwnership>().notNull(),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  category: text('category').notNull(),
  authStrategy: text('auth_strategy').$type<IntegrationAuthStrategy>().notNull(),
  apiHosts: jsonb('api_hosts').$type<readonly string[]>().notNull().default([]),
  oauth: jsonb('oauth').$type<Record<string, unknown> | null>(),
  staticApiKey: jsonb('static_api_key').$type<Record<string, unknown> | null>(),
  clientSecretCiphertext: bytea('client_secret_ciphertext'),
  credentialKeyVersion: text('credential_key_version'),
  operationPromotion: jsonb('operation_promotion').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`NOW()`),
}, (table) => [
  check('integration_provider_descriptors_provider_check', sql`${table.provider} ~ '^[a-z][a-z0-9_-]{1,63}$'`),
  check('integration_provider_descriptors_ownership_check', sql`${table.ownership} IN ('curated', 'byo')`),
  check('integration_provider_descriptors_auth_strategy_check', sql`${table.authStrategy} IN ('oauth2_authorization_code', 'static_api_key', 'coded')`),
  check('integration_provider_descriptors_shape_check', sql`
    btrim(${table.displayName}) <> ''
    AND char_length(${table.displayName}) <= 120
    AND btrim(${table.category}) <> ''
    AND char_length(${table.category}) <= 80
    AND jsonb_typeof(${table.apiHosts}) = 'array'
    AND jsonb_array_length(${table.apiHosts}) BETWEEN 1 AND 25
    AND jsonb_typeof(${table.operationPromotion}) = 'object'
    AND char_length(${table.operationPromotion}::text) <= 8192
    AND (${table.credentialKeyVersion} IS NULL OR (
      btrim(${table.credentialKeyVersion}) <> ''
      AND char_length(${table.credentialKeyVersion}) <= 128
    ))
    AND (${table.clientSecretCiphertext} IS NOT NULL OR ${table.credentialKeyVersion} IS NULL)
    AND (
      (${table.ownership} = 'curated' AND ${table.ownerUserId} IS NULL)
      OR (${table.ownership} = 'byo' AND ${table.ownerUserId} IS NOT NULL)
    )
    AND (
      (${table.authStrategy} = 'oauth2_authorization_code'
        AND ${table.oauth} IS NOT NULL
        AND jsonb_typeof(${table.oauth}) = 'object'
        AND ${table.staticApiKey} IS NULL)
      OR (${table.authStrategy} = 'static_api_key'
        AND ${table.staticApiKey} IS NOT NULL
        AND jsonb_typeof(${table.staticApiKey}) = 'object'
        AND ${table.oauth} IS NULL)
      OR (${table.authStrategy} = 'coded'
        AND ${table.oauth} IS NULL
        AND ${table.staticApiKey} IS NULL
        AND ${table.clientSecretCiphertext} IS NULL)
    )
    AND ${table.updatedAt} >= ${table.createdAt}
  `),
  uniqueIndex('idx_integration_provider_descriptors_curated_unique')
    .on(table.provider)
    .where(sql`${table.ownership} = 'curated'`),
  uniqueIndex('idx_integration_provider_descriptors_byo_unique')
    .on(table.ownerUserId, table.provider)
    .where(sql`${table.ownership} = 'byo'`),
  index('idx_integration_provider_descriptors_owner').on(table.ownerUserId),
]);

export const integrationOpenApiSpecs = pgTable('integration_openapi_specs', {
  id: uuid('id').primaryKey().defaultRandom(),
  descriptorId: uuid('descriptor_id').notNull().references(() => integrationProviderDescriptors.id, { onDelete: 'cascade' }),
  spec: jsonb('spec').notNull(),
  sourceUrl: text('source_url'),
  specHash: text('spec_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`NOW()`),
}, (table) => [
  check('integration_openapi_specs_shape_check', sql`
    jsonb_typeof(${table.spec}) = 'object'
    AND char_length(${table.spec}::text) <= 1048576
    AND ${table.spec}->>'openapi' LIKE '3.%'
    AND jsonb_typeof(${table.spec}->'paths') = 'object'
    AND (${table.sourceUrl} IS NULL OR (
      ${table.sourceUrl} LIKE 'https://%'
      AND char_length(${table.sourceUrl}) <= 2048
      AND ${table.sourceUrl} NOT LIKE '%#%'
    ))
    AND ${table.specHash} ~ '^[a-f0-9]{64}$'
    AND ${table.updatedAt} >= ${table.createdAt}
  `),
  uniqueIndex('idx_integration_openapi_specs_descriptor_unique').on(table.descriptorId),
]);

export type PortfolioSyncDirection = 'pull' | 'push' | 'bidirectional';
export type PortfolioSyncConflictPolicy = 'fail' | 'prefer_local' | 'prefer_remote';
export type PortfolioSyncJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export const portfolioSyncJobs = pgTable('portfolio_sync_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  integrationId: uuid('integration_id').notNull().references(() => userIntegrations.id, { onDelete: 'restrict' }),
  direction: text('direction').$type<PortfolioSyncDirection>().notNull(),
  conflictPolicy: text('conflict_policy').$type<PortfolioSyncConflictPolicy>().notNull(),
  status: text('status').$type<PortfolioSyncJobStatus>().notNull(),
  claimVersion: bigint('claim_version', { mode: 'number' }).notNull().default(0),
  claimedByWorkerId: text('claimed_by_worker_id'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  attemptCount: integer('attempt_count').notNull().default(0),
  resultSummary: jsonb('result_summary'),
  operationalErrorCode: text('operational_error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
  check('portfolio_sync_jobs_direction_check', sql`${table.direction} IN ('pull', 'push', 'bidirectional')`),
  check('portfolio_sync_jobs_conflict_policy_check', sql`${table.conflictPolicy} IN ('fail', 'prefer_local', 'prefer_remote')`),
  check('portfolio_sync_jobs_status_check', sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`),
  check('portfolio_sync_jobs_shape_check', sql`
    ${table.claimVersion} >= 0
    AND ${table.attemptCount} >= 0
    AND (${table.claimedByWorkerId} IS NULL OR (
      btrim(${table.claimedByWorkerId}) <> ''
      AND char_length(${table.claimedByWorkerId}) <= 128
    ))
    AND (${table.operationalErrorCode} IS NULL OR (
      btrim(${table.operationalErrorCode}) <> ''
      AND char_length(${table.operationalErrorCode}) <= 100
    ))
    AND (${table.resultSummary} IS NULL OR (
      jsonb_typeof(${table.resultSummary}) = 'object'
      AND char_length(${table.resultSummary}::text) <= 4096
    ))
    AND (
      (${table.status} = 'running'
        AND ${table.claimedByWorkerId} IS NOT NULL
        AND ${table.leaseUntil} IS NOT NULL
        AND ${table.completedAt} IS NULL)
      OR (${table.status} <> 'running'
        AND ${table.claimedByWorkerId} IS NULL
        AND ${table.leaseUntil} IS NULL)
    )
    AND (
      (${table.status} IN ('succeeded', 'failed', 'cancelled') AND ${table.completedAt} IS NOT NULL)
      OR (${table.status} NOT IN ('succeeded', 'failed', 'cancelled') AND ${table.completedAt} IS NULL)
    )
    AND (
      (${table.status} = 'failed' AND ${table.operationalErrorCode} IS NOT NULL)
      OR (${table.status} <> 'failed' AND ${table.operationalErrorCode} IS NULL)
    )
  `),
  index('idx_portfolio_sync_jobs_user').on(table.userId, table.createdAt),
  uniqueIndex('idx_portfolio_sync_jobs_user_pending_unique')
    .on(table.userId)
    .where(sql`${table.status} IN ('queued', 'running')`),
  index('idx_portfolio_sync_jobs_claimable').on(table.status, table.leaseUntil, table.createdAt),
  index('idx_portfolio_sync_jobs_integration').on(table.integrationId),
]);

export const idempotencyRecords = pgTable('idempotency_records', {
  consoleSessionIdHash: bytea('console_session_id_hash').notNull(),
  idempotencyKey: uuid('idempotency_key').notNull(),
  claimId: uuid('claim_id').notNull(),
  state: text('state').$type<'pending' | 'completed'>().notNull(),
  httpMethod: text('http_method').notNull(),
  canonicalTarget: text('canonical_target').notNull(),
  requestFingerprint: bytea('request_fingerprint').notNull(),
  responseStatus: integer('response_status'),
  responseBodyPresent: boolean('response_body_present'),
  responseBody: jsonb('response_body'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex('idx_idempotency_records_session_key_unique')
    .on(table.consoleSessionIdHash, table.idempotencyKey),
  index('idx_idempotency_records_expiry').on(table.expiresAt),
]);

export type ConsoleAccountFactorType = 'totp';

export const accountFactors = pgTable('account_factors', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  factorId: uuid('factor_id').primaryKey().defaultRandom(),
  factorType: text('factor_type').$type<ConsoleAccountFactorType>().notNull(),
  secretCiphertext: bytea('secret_ciphertext'),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (table) => [
  index('idx_account_factors_user_active').on(table.userId, table.factorType, table.disabledAt),
  uniqueIndex('idx_account_factors_active_totp_unique')
    .on(table.userId, table.factorType)
    .where(sql`${table.factorType} = 'totp' AND ${table.disabledAt} IS NULL`),
]);

export const accountFactorBackupCodes = pgTable('account_factor_backup_codes', {
  factorId: uuid('factor_id').notNull().references(() => accountFactors.factorId, { onDelete: 'cascade' }),
  codeId: uuid('code_id').primaryKey().defaultRandom(),
  codeHash: bytea('code_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  usedAt: timestamp('used_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('idx_account_factor_backup_codes_factor_hash_unique')
    .on(table.factorId, table.codeHash),
  index('idx_account_factor_backup_codes_factor_unused')
    .on(table.factorId, table.usedAt),
]);

export type ConsoleSecurityInvalidationKind =
  | 'principal_disabled'
  | 'principal_reenabled'
  | 'principal_authz_changed'
  | 'principal_credentials_revoked'
  | 'admin_factor_disabled'
  | 'console_session_revoked'
  | 'console_elevation_revoked'
  | 'runtime_sessions_terminated';

export type ConsoleSecurityInvalidationUrgency = 'eventual' | 'acknowledged';

export const securityInvalidationEvents = pgTable('security_invalidation_events', {
  sequenceId: bigint('sequence_id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  eventId: uuid('event_id').notNull().defaultRandom(),
  kind: text('kind').$type<ConsoleSecurityInvalidationKind>().notNull(),
  urgency: text('urgency').$type<ConsoleSecurityInvalidationUrgency>().notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  consoleSessionIdHash: bytea('console_session_id_hash'),
  authzVersion: bigint('authz_version', { mode: 'number' }),
  reason: text('reason').notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
}, (table) => [
  uniqueIndex('idx_security_invalidation_events_event_id').on(table.eventId),
  index('idx_security_invalidation_events_user').on(table.userId, table.sequenceId),
  index('idx_security_invalidation_events_created').on(table.createdAt),
  check('security_invalidation_events_payload_size_check', sql`pg_column_size(${table.payload}) <= 4096`),
]);

export const securityInvalidationReplicaCursors = pgTable('security_invalidation_replica_cursors', {
  replicaId: text('replica_id').primaryKey(),
  lastSequenceId: bigint('last_sequence_id', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`NOW()`),
});

export const securityInvalidationReplicaLeases = pgTable('security_invalidation_replica_leases', {
  replicaId: text('replica_id').primaryKey(),
  leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
  renewedAt: timestamp('renewed_at', { withTimezone: true }).notNull(),
}, (table) => [
  index('idx_security_invalidation_replica_leases_until').on(table.leaseUntil),
]);

export const securityInvalidationAcks = pgTable('security_invalidation_acks', {
  eventId: uuid('event_id').notNull().references(() => securityInvalidationEvents.eventId, { onDelete: 'cascade' }),
  replicaId: text('replica_id').notNull(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex('idx_security_invalidation_acks_unique').on(table.eventId, table.replicaId),
]);

export type RuntimeSessionTransport = 'streamable-http';
export type RuntimeSessionStatus = 'active' | 'closing';
export type RuntimeTerminationReason =
  | 'user_requested'
  | 'admin_disabled'
  | 'admin_terminated'
  | 'operator_terminated'
  | 'credential_revoked'
  | 'idle_expired';
export type RuntimeTerminationRequesterKind = 'self' | 'admin' | 'operator' | 'system';
export type RuntimeTerminationAckResult = 'terminated' | 'already_absent' | 'failed';

export const runtimeSessionPresence = pgTable('runtime_session_presence', {
  sessionId: text('session_id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountCorrelationId: uuid('account_correlation_id').notNull(),
  replicaId: text('replica_id').notNull(),
  transport: text('transport').$type<RuntimeSessionTransport>().notNull(),
  clientName: text('client_name'),
  clientVersion: text('client_version'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull(),
  requestCount: integer('request_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
  status: text('status').$type<RuntimeSessionStatus>().notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (table) => [
  check('runtime_session_presence_transport_check', sql`${table.transport} IN ('streamable-http')`),
  check('runtime_session_presence_status_check', sql`${table.status} IN ('active', 'closing')`),
  check('runtime_session_presence_shape_check', sql`
    btrim(${table.sessionId}) <> ''
    AND char_length(${table.sessionId}) <= 200
    AND btrim(${table.replicaId}) <> ''
    AND char_length(${table.replicaId}) <= 128
    AND (${table.clientName} IS NULL OR char_length(${table.clientName}) <= 100)
    AND (${table.clientVersion} IS NULL OR char_length(${table.clientVersion}) <= 100)
    AND ${table.requestCount} >= 0
    AND ${table.errorCount} >= 0
    AND ${table.lastActiveAt} >= ${table.startedAt}
    AND ${table.leaseUntil} > ${table.lastActiveAt}
    AND (
      (${table.status} = 'active' AND ${table.closedAt} IS NULL)
      OR (${table.status} = 'closing')
    )
  `),
  index('idx_runtime_session_presence_user').on(table.userId, table.status, table.leaseUntil),
  index('idx_runtime_session_presence_replica').on(table.replicaId, table.leaseUntil),
  index('idx_runtime_session_presence_correlation').on(table.accountCorrelationId),
]);

export type SessionActivationElementType =
  | 'personas'
  | 'skills'
  | 'agents'
  | 'memories'
  | 'ensembles';
export type SessionActivationAction = 'activated' | 'deactivated';

export const sessionActivationRecords = pgTable('session_activation_records', {
  sessionId: text('session_id').notNull().references(() => runtimeSessionPresence.sessionId, { onDelete: 'cascade' }),
  elementType: text('element_type').$type<SessionActivationElementType>().notNull(),
  elementName: text('element_name').notNull(),
  activatedAt: timestamp('activated_at', { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({
    name: 'pk_session_activation_records',
    columns: [table.sessionId, table.elementType, table.elementName],
  }),
  check('session_activation_records_type_check', sql`
    ${table.elementType} IN ('personas', 'skills', 'agents', 'memories', 'ensembles')
  `),
  check('session_activation_records_shape_check', sql`
    btrim(${table.sessionId}) <> ''
    AND char_length(${table.sessionId}) <= 200
    AND btrim(${table.elementName}) <> ''
    AND char_length(${table.elementName}) <= 200
  `),
  index('idx_session_activation_records_session').on(table.sessionId, table.activatedAt),
]);

export const sessionActivationEvents = pgTable('session_activation_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull(),
  elementType: text('element_type').$type<SessionActivationElementType>().notNull(),
  elementName: text('element_name').notNull(),
  action: text('action').$type<SessionActivationAction>().notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
}, (table) => [
  check('session_activation_events_type_check', sql`
    ${table.elementType} IN ('personas', 'skills', 'agents', 'memories', 'ensembles')
  `),
  check('session_activation_events_action_check', sql`${table.action} IN ('activated', 'deactivated')`),
  check('session_activation_events_shape_check', sql`
    btrim(${table.sessionId}) <> ''
    AND char_length(${table.sessionId}) <= 200
    AND btrim(${table.elementName}) <> ''
    AND char_length(${table.elementName}) <= 200
  `),
  index('idx_session_activation_events_user_session').on(table.userId, table.sessionId, table.occurredAt),
  index('idx_session_activation_events_session').on(table.sessionId, table.occurredAt),
]);

export type SessionActivityLevel = 'debug' | 'info' | 'warn' | 'error';

export const sessionActivityEvents = pgTable('session_activity_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  level: text('level').$type<SessionActivityLevel>().notNull(),
  subsystem: text('subsystem').notNull(),
  event: text('event').notNull(),
  message: text('message'),
  correlationId: uuid('correlation_id'),
  stableErrorCode: text('stable_error_code'),
}, (table) => [
  check('session_activity_events_level_check', sql`${table.level} IN ('debug', 'info', 'warn', 'error')`),
  check('session_activity_events_shape_check', sql`
    btrim(${table.sessionId}) <> ''
    AND char_length(${table.sessionId}) <= 200
    AND btrim(${table.subsystem}) <> ''
    AND char_length(${table.subsystem}) <= 80
    AND btrim(${table.event}) <> ''
    AND char_length(${table.event}) <= 160
    AND (${table.message} IS NULL OR char_length(${table.message}) <= 500)
    AND (${table.stableErrorCode} IS NULL OR (
      btrim(${table.stableErrorCode}) <> ''
      AND char_length(${table.stableErrorCode}) <= 100
    ))
  `),
  index('idx_session_activity_events_user_session').on(table.userId, table.sessionId, table.occurredAt),
  index('idx_session_activity_events_session').on(table.sessionId, table.occurredAt),
  index('idx_session_activity_events_event').on(table.event, table.occurredAt),
]);

export const approvalAuditEvents = pgTable('approval_audit_events', {
  id: text('id').primaryKey(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountCorrelationId: uuid('account_correlation_id').notNull(),
  sessionId: text('session_id').notNull(),
  toolName: text('tool_name').notNull(),
  operation: text('operation'),
  result: text('result').notNull(),
  decisionSource: text('decision_source'),
  correlationId: uuid('correlation_id'),
}, (table) => [
  check('approval_audit_events_result_check', sql`${table.result} IN ('approved', 'denied', 'errored')`),
  check('approval_audit_events_shape_check', sql`
    btrim(${table.id}) <> ''
    AND char_length(${table.id}) <= 120
    AND btrim(${table.sessionId}) <> ''
    AND char_length(${table.sessionId}) <= 200
    AND btrim(${table.toolName}) <> ''
    AND char_length(${table.toolName}) <= 200
    AND (${table.operation} IS NULL OR (
      btrim(${table.operation}) <> ''
      AND char_length(${table.operation}) <= 200
    ))
    AND (${table.decisionSource} IS NULL OR (
      btrim(${table.decisionSource}) <> ''
      AND char_length(${table.decisionSource}) <= 100
    ))
  `),
  index('idx_approval_audit_events_occurred').on(table.occurredAt),
  index('idx_approval_audit_events_account').on(table.accountCorrelationId, table.occurredAt),
  index('idx_approval_audit_events_session').on(table.sessionId, table.occurredAt),
]);

export const runtimeControlCommands = pgTable('runtime_control_commands', {
  commandId: uuid('command_id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  sessionId: text('session_id').notNull(),
  targetReplicaId: text('target_replica_id').notNull(),
  reason: text('reason').$type<RuntimeTerminationReason>().notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  requestedByKind: text('requested_by_kind').$type<RuntimeTerminationRequesterKind>().notNull(),
  requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
  invalidationEventId: uuid('invalidation_event_id').references(() => securityInvalidationEvents.eventId, {
    onDelete: 'set null',
  }),
}, (table) => [
  check('runtime_control_commands_kind_check', sql`${table.kind} = 'terminate_session'`),
  check('runtime_control_commands_reason_check', sql`
    ${table.reason} IN (
      'user_requested',
      'admin_disabled',
      'admin_terminated',
      'operator_terminated',
      'credential_revoked',
      'idle_expired'
    )
  `),
  check('runtime_control_commands_requester_check', sql`
    ${table.requestedByKind} IN ('self', 'admin', 'operator', 'system')
    AND (
      (${table.requestedByKind} = 'system' AND ${table.requestedByUserId} IS NULL)
      OR (${table.requestedByKind} <> 'system' AND ${table.requestedByUserId} IS NOT NULL)
    )
  `),
  check('runtime_control_commands_shape_check', sql`
    btrim(${table.sessionId}) <> ''
    AND char_length(${table.sessionId}) <= 200
    AND btrim(${table.targetReplicaId}) <> ''
    AND char_length(${table.targetReplicaId}) <= 128
  `),
  index('idx_runtime_control_commands_target').on(table.targetReplicaId, table.requestedAt),
  index('idx_runtime_control_commands_session').on(table.sessionId),
]);

export const runtimeControlAcks = pgTable('runtime_control_acks', {
  commandId: uuid('command_id').primaryKey().references(() => runtimeControlCommands.commandId, { onDelete: 'cascade' }),
  replicaId: text('replica_id').notNull(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }).notNull(),
  result: text('result').$type<RuntimeTerminationAckResult>().notNull(),
  errorCode: text('error_code'),
}, (table) => [
  check('runtime_control_acks_result_check', sql`${table.result} IN ('terminated', 'already_absent', 'failed')`),
  check('runtime_control_acks_shape_check', sql`
    btrim(${table.replicaId}) <> ''
    AND char_length(${table.replicaId}) <= 128
    AND (
      (${table.result} = 'failed' AND ${table.errorCode} IS NOT NULL AND btrim(${table.errorCode}) <> '')
      OR (${table.result} <> 'failed' AND ${table.errorCode} IS NULL)
    )
  `),
  index('idx_runtime_control_acks_replica').on(table.replicaId, table.acknowledgedAt),
]);

export const adminAuditChainHeads = pgTable('admin_audit_chain_heads', {
  streamId: text('stream_id').primaryKey(),
  lastSequenceId: bigint('last_sequence_id', { mode: 'number' }),
  lastChainHmac: bytea('last_chain_hmac'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`NOW()`),
});

export const adminAuditEvents = pgTable('admin_audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  sequenceId: bigint('sequence_id', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  actorSub: text('actor_sub').notNull(),
  actorRole: text('actor_role'),
  actorCapabilityRole: text('actor_capability_role').notNull(),
  actorConsoleSessionHash: bytea('actor_console_session_hash').notNull(),
  capability: text('capability').notNull(),
  elevationAcr: text('elevation_acr'),
  elevationAmr: text('elevation_amr').array().notNull(),
  elevationAuthTime: timestamp('elevation_auth_time', { withTimezone: true }),
  endpoint: text('endpoint').notNull(),
  operation: text('operation').notNull(),
  resourceKind: text('resource_kind'),
  resourceId: text('resource_id'),
  targetUserId: uuid('target_user_id').references(() => users.id, { onDelete: 'restrict' }),
  argsRedacted: jsonb('args_redacted').notNull().default({}),
  result: text('result').notNull(),
  errorCode: text('error_code'),
  resultDetailRedacted: jsonb('result_detail_redacted'),
  correlationId: uuid('correlation_id').notNull(),
  clientIp: text('client_ip'),
  userAgent: text('user_agent'),
  chainKeyId: text('chain_key_id').notNull(),
  chainPrev: bytea('chain_prev'),
  chainHmac: bytea('chain_hmac').notNull(),
}, (table) => [
  uniqueIndex('idx_admin_audit_events_sequence').on(table.sequenceId),
  index('idx_admin_audit_events_occurred').on(table.occurredAt, table.sequenceId),
  index('idx_admin_audit_events_actor').on(table.actorUserId, table.sequenceId),
  index('idx_admin_audit_events_target_user').on(table.targetUserId, table.sequenceId)
    .where(sql`${table.targetUserId} IS NOT NULL`),
  index('idx_admin_audit_events_operation').on(table.operation, table.sequenceId),
  index('idx_admin_audit_events_correlation').on(table.correlationId),
]);
