import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './users.js';
import type { ConsoleAdminRole } from './webConsole.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export type InvitationState = 'pending' | 'accepted' | 'expired' | 'revoked';
export type InvitationGenerationState = InvitationState | 'superseded';
export type InvitationClaimState = 'open' | 'completed' | 'revoked' | 'expired';
export type InvitationDeliveryState =
  | 'not_attempted'
  | 'submitting'
  | 'submitted'
  | 'failed'
  | 'unknown';

export const accountInvitations = pgTable('account_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  emailOriginal: text('email_original').notNull(),
  emailNormalized: text('email_normalized').notNull(),
  inviterUserId: uuid('inviter_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  intendedDisplayName: text('intended_display_name'),
  intendedUsername: text('intended_username').notNull(),
  state: text('state').$type<InvitationState>().notNull().default('pending'),
  currentGeneration: integer('current_generation').notNull().default(1),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
  correlationId: uuid('correlation_id').notNull(),
  version: bigint('version', { mode: 'number' }).notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`NOW()`),
}, (table) => [
  check('account_invitations_state_check', sql`${table.state} IN ('pending', 'accepted', 'expired', 'revoked')`),
  check('account_invitations_generation_check', sql`${table.currentGeneration} > 0`),
  check('account_invitations_version_check', sql`${table.version} > 0`),
  check('account_invitations_email_check', sql`btrim(${table.emailOriginal}) <> '' AND btrim(${table.emailNormalized}) <> ''`),
  check('account_invitations_username_check', sql`btrim(${table.intendedUsername}) <> ''`),
  check('account_invitations_state_timestamps_check', sql`
    (${table.state} = 'pending' AND ${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL AND ${table.expiredAt} IS NULL)
    OR (${table.state} = 'accepted' AND ${table.acceptedAt} IS NOT NULL AND ${table.revokedAt} IS NULL AND ${table.expiredAt} IS NULL)
    OR (${table.state} = 'revoked' AND ${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NOT NULL AND ${table.expiredAt} IS NULL)
    OR (${table.state} = 'expired' AND ${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL AND ${table.expiredAt} IS NOT NULL)
  `),
  uniqueIndex('idx_account_invitations_pending_email_unique')
    .on(table.emailNormalized)
    .where(sql`${table.state} = 'pending'`),
  uniqueIndex('idx_account_invitations_pending_user_unique')
    .on(table.userId)
    .where(sql`${table.state} = 'pending'`),
  uniqueIndex('idx_account_invitations_id_user_unique').on(table.id, table.userId),
  index('idx_account_invitations_user').on(table.userId, table.createdAt),
  index('idx_account_invitations_expiry_state').on(table.state, table.updatedAt),
]);

export const accountInvitationGenerations = pgTable('account_invitation_generations', {
  invitationId: uuid('invitation_id').notNull().references(() => accountInvitations.id, { onDelete: 'restrict' }),
  generation: integer('generation').notNull(),
  state: text('state').$type<InvitationGenerationState>().notNull().default('pending'),
  credentialHash: bytea('credential_hash').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  credentialConsumedAt: timestamp('credential_consumed_at', { withTimezone: true }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  version: bigint('version', { mode: 'number' }).notNull().default(1),
}, (table) => [
  primaryKey({ columns: [table.invitationId, table.generation] }),
  uniqueIndex('idx_account_invitation_generations_hash_unique').on(table.credentialHash),
  index('idx_account_invitation_generations_expiry').on(table.state, table.expiresAt),
  check('account_invitation_generations_number_check', sql`${table.generation} > 0`),
  check('account_invitation_generations_hash_check', sql`octet_length(${table.credentialHash}) = 32`),
  check('account_invitation_generations_version_check', sql`${table.version} > 0`),
  check('account_invitation_generations_expiry_check', sql`${table.expiresAt} > ${table.issuedAt}`),
  check('account_invitation_generations_state_check', sql`${table.state} IN ('pending', 'accepted', 'expired', 'revoked', 'superseded')`),
  check('account_invitation_generations_state_timestamps_check', sql`
    (${table.state} = 'pending' AND ${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL AND ${table.expiredAt} IS NULL AND ${table.supersededAt} IS NULL)
    OR (${table.state} = 'accepted' AND ${table.acceptedAt} IS NOT NULL AND ${table.revokedAt} IS NULL AND ${table.expiredAt} IS NULL AND ${table.supersededAt} IS NULL)
    OR (${table.state} = 'revoked' AND ${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NOT NULL AND ${table.expiredAt} IS NULL AND ${table.supersededAt} IS NULL)
    OR (${table.state} = 'expired' AND ${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL AND ${table.expiredAt} IS NOT NULL AND ${table.supersededAt} IS NULL)
    OR (${table.state} = 'superseded' AND ${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL AND ${table.expiredAt} IS NULL AND ${table.supersededAt} IS NOT NULL)
  `),
]);

export const accountInvitationIntendedRoles = pgTable('account_invitation_intended_roles', {
  invitationId: uuid('invitation_id').notNull().references(() => accountInvitations.id, { onDelete: 'restrict' }),
  role: text('role').$type<ConsoleAdminRole>().notNull(),
}, (table) => [
  primaryKey({ columns: [table.invitationId, table.role] }),
  check('account_invitation_intended_roles_role_check', sql`${table.role} IN ('admin', 'account_admin', 'operator', 'auditor', 'security_admin')`),
]);

export const accountInvitationClaimAssertions = pgTable('account_invitation_claim_assertions', {
  id: uuid('id').primaryKey().defaultRandom(),
  invitationId: uuid('invitation_id').notNull(),
  generation: integer('generation').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  claimOwnerHash: bytea('claim_owner_hash').notNull(),
  state: text('state').$type<InvitationClaimState>().notNull().default('open'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastExchangedAt: timestamp('last_exchanged_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
  version: bigint('version', { mode: 'number' }).notNull().default(1),
}, (table) => [
  foreignKey({
    columns: [table.invitationId, table.generation],
    foreignColumns: [accountInvitationGenerations.invitationId, accountInvitationGenerations.generation],
    name: 'account_invitation_claim_generation_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [table.invitationId, table.userId],
    foreignColumns: [accountInvitations.id, accountInvitations.userId],
    name: 'account_invitation_claim_user_fk',
  }).onDelete('restrict'),
  uniqueIndex('idx_account_invitation_claim_generation_unique').on(table.invitationId, table.generation),
  index('idx_account_invitation_claim_user').on(table.userId, table.createdAt),
  check('account_invitation_claim_owner_hash_check', sql`octet_length(${table.claimOwnerHash}) = 32`),
  check('account_invitation_claim_state_check', sql`${table.state} IN ('open', 'completed', 'revoked', 'expired')`),
  check('account_invitation_claim_version_check', sql`${table.version} > 0`),
  check('account_invitation_claim_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
  check('account_invitation_claim_state_timestamps_check', sql`
    (${table.state} = 'open' AND ${table.completedAt} IS NULL AND ${table.revokedAt} IS NULL AND ${table.expiredAt} IS NULL)
    OR (${table.state} = 'completed' AND ${table.completedAt} IS NOT NULL AND ${table.revokedAt} IS NULL AND ${table.expiredAt} IS NULL)
    OR (${table.state} = 'revoked' AND ${table.completedAt} IS NULL AND ${table.revokedAt} IS NOT NULL AND ${table.expiredAt} IS NULL)
    OR (${table.state} = 'expired' AND ${table.completedAt} IS NULL AND ${table.revokedAt} IS NULL AND ${table.expiredAt} IS NOT NULL)
  `),
]);

export const accountInvitationDeliveryAttempts = pgTable('account_invitation_delivery_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  invitationId: uuid('invitation_id').notNull(),
  generation: integer('generation').notNull(),
  attemptNumber: integer('attempt_number').notNull(),
  state: text('state').$type<InvitationDeliveryState>().notNull(),
  provider: text('provider'),
  providerMessageId: text('provider_message_id'),
  failureClass: text('failure_class'),
  sanitizedDetail: jsonb('sanitized_detail'),
  correlationId: uuid('correlation_id').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  version: bigint('version', { mode: 'number' }).notNull().default(1),
}, (table) => [
  foreignKey({
    columns: [table.invitationId, table.generation],
    foreignColumns: [accountInvitationGenerations.invitationId, accountInvitationGenerations.generation],
    name: 'account_invitation_delivery_generation_fk',
  }).onDelete('restrict'),
  uniqueIndex('idx_account_invitation_delivery_attempt_unique').on(table.invitationId, table.generation, table.attemptNumber),
  index('idx_account_invitation_delivery_state').on(table.state, table.requestedAt),
  check('account_invitation_delivery_attempt_number_check', sql`${table.attemptNumber} > 0`),
  check('account_invitation_delivery_state_check', sql`${table.state} IN ('not_attempted', 'submitting', 'submitted', 'failed', 'unknown')`),
  check('account_invitation_delivery_version_check', sql`${table.version} > 0`),
]);
