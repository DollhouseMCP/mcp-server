/**
 * Sign-In Allowlist Schema
 *
 * Gates which identities can complete a sign-in flow (GitHub OAuth callback,
 * magic-link consume, local-password invite redemption). The check runs
 * after identity verification and before account upsert.
 *
 * Three storage modes share this contract:
 *   - postgres (this schema) — DB mode, recommended for hosted deploys
 *   - filesystem — ~/.dollhouse/auth/allowlist.json, fsnotify-watched
 *   - in-memory — tests and dev
 *
 * Gate behavior:
 *   - `DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED=false` (initial default): empty
 *     table = no gate (back-compat). The gate only activates once an
 *     entry is added.
 *   - `DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED=true`: empty table = bootstrap
 *     admin only. Secure-by-default mode.
 *
 * The bootstrap admin always passes regardless of this setting or the
 * table contents — the `isBootstrapAdminFor()` check sits in front of
 * the allowlist query, so operators cannot lock themselves out.
 *
 * Match keys (kind column):
 *   - 'email' — verified primary email (lowercased)
 *   - 'github_username' — GitHub `login` (lowercased)
 *   - 'github_id' — GitHub numeric `id` as a string (stable across rename)
 *
 * No RLS — system-internal AS infrastructure, operated only via
 * `withSystemContext` from the admin role. Same convention as auth_kv,
 * auth_signing_keys, auth_accounts.
 *
 * Writes flow through:
 *   - MCP-AQL admin commands (`mcp_aql_create/update/delete` with
 *     `entity: 'allowlist_entry'`), admin role required
 *   - Filesystem file editor (fsnotify-watched hot reload)
 *
 * Every write emits an `auth.allowlist_changed` event to
 * `auth_identity_events`; every denied sign-in emits
 * `auth.allowlist_denied`.
 *
 * @since v2.2.x — sign-in allowlist
 */

import { pgTable, uuid, varchar, text, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const authAllowlist = pgTable('auth_allowlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Match key kind. Constrained at the DB layer to 'email' | 'github_username' | 'github_id'. */
  kind: varchar('kind', { length: 32 }).notNull(),
  /**
   * The match value. Lowercased on insert. For 'email' and 'github_username'
   * this is a stable lowercased string; for 'github_id' it's the numeric
   * GitHub ID stored as a string for index-key uniformity.
   */
  value: varchar('value', { length: 320 }).notNull(),
  /** Free-form note ("added 2026-05-19 for Mick onboarding"). Surfaces in the admin list view. */
  note: text('note'),
  /** Admin sub who added the entry. Audit trail; null only for the initial seed-file path. */
  createdBy: varchar('created_by', { length: 320 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
}, (table) => [
  uniqueIndex('idx_auth_allowlist_kind_value').on(table.kind, table.value),
  index('idx_auth_allowlist_created_by').on(table.createdBy),
  check('auth_allowlist_kind_check', sql`${table.kind} IN ('email', 'github_username', 'github_id')`),
]);

export type AuthAllowlistKind = 'email' | 'github_username' | 'github_id';

export interface AuthAllowlistEntry {
  id: string;
  kind: AuthAllowlistKind;
  value: string;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
}
