-- Web console security-admin signing-key lifecycle.
--
-- Adds explicit persisted retirement state so emergency retire/delete API
-- actions are not cosmetic overlays over auth_signing_keys.

ALTER TABLE "auth_signing_keys"
  ADD COLUMN IF NOT EXISTS "retired_at" TIMESTAMPTZ;
