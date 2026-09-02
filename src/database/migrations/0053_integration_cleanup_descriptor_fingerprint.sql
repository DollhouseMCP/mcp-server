ALTER TABLE "user_integrations"
  ADD COLUMN IF NOT EXISTS "cleanup_descriptor_fingerprint" TEXT;

ALTER TABLE "user_integrations"
  DROP CONSTRAINT IF EXISTS "user_integrations_cleanup_descriptor_fingerprint_check";

ALTER TABLE "user_integrations"
  ADD CONSTRAINT "user_integrations_cleanup_descriptor_fingerprint_check"
  CHECK (
    "cleanup_descriptor_fingerprint" IS NULL
    OR "cleanup_descriptor_fingerprint" ~ '^[a-f0-9]{64}$'
  ) NOT VALID;

ALTER TABLE "user_integrations"
  VALIDATE CONSTRAINT "user_integrations_cleanup_descriptor_fingerprint_check";
