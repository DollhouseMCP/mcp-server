/**
 * Auth Schema (§8.1)
 *
 * Three tables backing the embedded authorization server. All
 * AS-internal state — operated only via withSystemContext from the
 * admin/app role; no per-user RLS on these tables.
 *
 *   auth_accounts          — OAuth identity mapping (provider, external_sub
 *                            → users.id). Per spec must-fix #18 the account
 *                            key is (provider, external_sub), not email.
 *                            Optional FK to the canonical Phase 4 users
 *                            table; nullable so the OAuth identity record
 *                            can exist before a user record is created
 *                            (e.g. between processCallback and the first
 *                            interactionFinished login).
 *   auth_identity_events   — Audit log for must-fix #21 identity-change
 *                            and rate-limit events. Append-only.
 *   auth_kv                — oidc-provider's Adapter-shaped K/V state:
 *                            Sessions, Grants, Interactions, AuthorizationCodes,
 *                            RefreshTokens, AccessTokens, etc.
 *
 * Option C (per recovery plan): users table stays the canonical user
 * record; auth_accounts is the explicit OAuth-mapping concept that
 * matches spec §5.1a. No schema migration on existing Phase 4 deployments.
 *
 * @since v2.2.0 — §8.1 auth recovery
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  boolean,
  timestamp,
  bigint,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * OAuth identity mapping. Primary key is composite (provider, external_sub)
 * per must-fix #18 — this is what the spec calls the "account key".
 * `sub` is the JWT-friendly derived form (`${provider}_${externalSub}`)
 * and is uniquely indexed for fast getAccount(sub) lookups.
 */
export const authAccounts = pgTable('auth_accounts', {
  provider: varchar('provider', { length: 64 }).notNull(),
  externalSub: varchar('external_sub', { length: 255 }).notNull(),
  /** Derived: `${provider}_${externalSub}`. Stored for indexed sub→row lookup. */
  sub: varchar('sub', { length: 320 }).notNull(),
  /** Optional FK to canonical Phase 4 user record. Null when unlinked. */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  email: varchar('email', { length: 255 }),
  emailVerified: boolean('email_verified').notNull().default(false),
  displayName: varchar('display_name', { length: 255 }),
  /** Audit-only snapshot of upstream profile. Never used for claim assembly. */
  rawProfile: jsonb('raw_profile'),
  /** Argon2id hash for local-password method. Null for non-password methods. */
  passwordHash: text('password_hash'),
  /** Epoch ms of most recent successful authentication (must-fix #12 auth_time source). */
  lastAuthAt: bigint('last_auth_at', { mode: 'number' }),
  // (Removed `roles`: authorization roles are per-user in `user_admin_roles`,
  // the authoritative store. Auth accounts no longer carry roles.)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`NOW()`),
}, (table) => [
  primaryKey({ columns: [table.provider, table.externalSub] }),
  uniqueIndex('idx_auth_accounts_sub').on(table.sub),
  index('idx_auth_accounts_user_id').on(table.userId),
]);

/**
 * Identity audit events (must-fix #21). Append-only. Operator audit
 * consumption + downstream anomaly detection (planned §5.7b) read this.
 */
export const authIdentityEvents = pgTable('auth_identity_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** e.g. 'auth.social.identity_changed', 'auth.local.brute_force_suspected'. */
  type: varchar('type', { length: 128 }).notNull(),
  sub: varchar('sub', { length: 320 }),
  provider: varchar('provider', { length: 64 }),
  externalSub: varchar('external_sub', { length: 255 }),
  details: jsonb('details'),
  /**
   * Caller-supplied event time (epoch ms). Tests use deterministic values;
   * production code passes Date.now(). Stored as bigint for fidelity with
   * the in-memory backend's IdentityAuditEvent.timestamp field.
   */
  timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
}, (table) => [
  index('idx_auth_events_type').on(table.type),
  index('idx_auth_events_sub').on(table.sub),
  index('idx_auth_events_timestamp').on(table.timestamp),
]);

/**
 * oidc-provider Adapter-shaped K/V state. The composite key is
 * (model, id) so different oidc-provider models can share an id without
 * collision (matches the in-memory backend's `model|id` keying).
 *
 * `expires_at` is a TIMESTAMPTZ — null means "no TTL". oidc-provider
 * passes expiresInSec as seconds; the backend converts to a wall-clock
 * timestamp for indexed pruning.
 *
 * Two expression indexes (model='Session' on payload->>'uid' and
 * model='Grant' on payload->>'accountId') replace the in-memory linear
 * scans for genericFindByUid and findGrantsByAccountId; defined in the
 * companion SQL migration since Drizzle doesn't express partial-
 * expression indexes natively.
 */
export const authKv = pgTable('auth_kv', {
  model: varchar('model', { length: 64 }).notNull(),
  id: varchar('id', { length: 255 }).notNull(),
  payload: jsonb('payload').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
}, (table) => [
  primaryKey({ columns: [table.model, table.id] }),
  index('idx_auth_kv_expires').on(table.expiresAt),
]);
