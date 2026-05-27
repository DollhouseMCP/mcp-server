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
  boolean,
  jsonb,
  customType,
  index,
  uniqueIndex,
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
  backupCodeHashes: bytea('backup_code_hashes').array().notNull(),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (table) => [
  index('idx_account_factors_user_active').on(table.userId, table.factorType, table.disabledAt),
  uniqueIndex('idx_account_factors_active_totp_unique')
    .on(table.userId, table.factorType)
    .where(sql`${table.factorType} = 'totp' AND ${table.disabledAt} IS NULL`),
]);
