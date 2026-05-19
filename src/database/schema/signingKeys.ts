/**
 * Signing Keys Schema
 *
 * Authorization server signing key material — replaces the filesystem
 * persistence in `src/auth/embedded-as/persistKeys.ts` (JWKS) and
 * `src/auth/embedded-as/cookieSecret.ts` (cookie HMAC secret) when the
 * DB backend is selected.
 *
 * Key material is discriminated by `kind`:
 *   'jwks'   — ECDSA signing keypair stored as a JWK (private + public)
 *              for /token issuance + /jwks publication.
 *   'cookie' — HMAC secret for signing interaction cookies (per-stream
 *              ticket binding, consent CSRF, etc.)
 *   'invite' — HMAC secret for invite, magic-link, and password-reset
 *              token signatures.
 *
 * Rotation marks the current row inactive WITHOUT deletion (audit trail).
 * A partial unique index enforces at most one active row per kind. See
 * migration 0015_auth_signing_keys.sql for the index DDL.
 *
 * Why this is necessary: in filesystem mode with a non-persistent run dir
 * (tmpfs, ephemeral container storage), every restart regenerates the
 * JWKS keyfile → fresh kid → mode-fingerprint mismatch in
 * `EmbeddedAuthorizationServer.initialize()` → all outstanding OAuth state
 * wiped → users must re-authenticate. DB-backed keys survive restart
 * AND let multiple replicas share signing material.
 *
 * No RLS — system-internal AS infrastructure, paired with auth_kv.
 *
 * @since Phase 4.5 storage completion
 */

import { pgTable, varchar, jsonb, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const authSigningKeys = pgTable('auth_signing_keys', {
  /** Stable key identifier. For JWKS this is the JWK `kid`; for cookie kind it's an opaque id. */
  kid: varchar('kid', { length: 255 }).primaryKey(),
  /** Discriminator: 'jwks', 'cookie', or 'invite'. */
  kind: varchar('kind', { length: 32 }).notNull(),
  /** The key material. For 'jwks' this is the full JWK (private + public). HMAC kinds store {secret: base64}. */
  payload: jsonb('payload').notNull(),
  /** Exactly one row per kind is active at a time (enforced by partial unique index). */
  active: boolean('active').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`NOW()`),
  /** Null while active; populated when the key is rotated out. */
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
}, (table) => [
  index('idx_auth_signing_keys_kind_active').on(table.kind, table.active),
  uniqueIndex('idx_auth_signing_keys_kind_active_unique')
    .on(table.kind)
    .where(sql`${table.active} = TRUE`),
]);
