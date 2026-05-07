-- Round 5 / B1: Add `roles` column to auth_accounts.
--
-- StoredAccount.roles?: string[] is defined in IAuthStorageLayer.ts and
-- set to ['admin'] by every IAuthMethod on first bootstrap-admin login.
-- extraTokenClaims reads account.roles to emit the JWT `roles` claim.
-- Without this column, Postgres deployments silently drop roles on
-- upsert and the admin's JWT never carries the role.
--
-- Default `'[]'::jsonb` so existing rows get the empty-array sentinel
-- automatically; no backfill needed. The column is NOT NULL so callers
-- never have to handle a null/undefined distinction at the storage
-- layer (StoredAccount.roles stays optional in the TS type — the
-- mapper coerces empty array to undefined and back, matching what
-- InMemory and Filesystem already do).
--
-- Depends on: 0009_auth_tables.sql
-- §8.1 Round 5

ALTER TABLE "auth_accounts"
  ADD COLUMN IF NOT EXISTS "roles" JSONB NOT NULL DEFAULT '[]'::jsonb;
