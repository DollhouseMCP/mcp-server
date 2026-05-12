-- Phase 4.5 storage completion — Phase G addendum.
--
-- Adds a `user_identity_config` jsonb column to `user_settings` to hold
-- the operator-set / wizard-captured identity fields (`user.username`,
-- `user.email`, `user.display_name`) that ConfigManager exposes via the
-- `user.*` config path.
--
-- Why this isn't read from `users` directly:
--   - `users.username/email/displayName` is the canonical OAuth-derived
--     identity (populated by GitHubAuthMethod, etc.). It's authoritative
--     for "who is this user" in auth contexts.
--   - ConfigManager's `user.*` section is what the operator/user set via
--     the configuration wizard — not always the same as the OAuth identity.
--   - Mixing them at the storage layer would cross a boundary that
--     `users` (RLS as identity) and `user_settings` (RLS as preferences)
--     are deliberately separated by.
--
-- RLS continues from migration 0004 — the existing `user_settings_isolation`
-- policy applies to the new column the same way as every other column on
-- this table.
--
-- Depends on: 0015_auth_signing_keys.sql (numerical ordering only),
--             0000 (table existence), 0004 (RLS policy)

ALTER TABLE "user_settings"
  ADD COLUMN IF NOT EXISTS "user_identity_config" JSONB NOT NULL DEFAULT '{}'::jsonb;
