-- Bind configured-provider OAuth flows and credentials to the descriptor that
-- created them. This prevents a late callback from crossing into a newly
-- revealed same-provider descriptor during rolling credential withdrawal.

ALTER TABLE "console_login_transactions"
  ADD COLUMN IF NOT EXISTS "integration_descriptor_id" UUID;
ALTER TABLE "user_integrations"
  ADD COLUMN IF NOT EXISTS "integration_descriptor_id" UUID;

-- Existing configured credentials predate descriptor binding. Curated
-- descriptors win over same-provider BYO descriptors, matching runtime
-- resolution; otherwise bind to the user's own BYO descriptor.
UPDATE "user_integrations" AS ui
SET "integration_descriptor_id" = (
  SELECT d."id"
  FROM "integration_provider_descriptors" AS d
  WHERE d."provider" = ui."provider"
    AND (d."ownership" = 'curated' OR d."owner_user_id" = ui."user_id")
  ORDER BY CASE WHEN d."ownership" = 'curated' THEN 0 ELSE 1 END
  LIMIT 1
)
WHERE ui."provider" <> 'github'
  AND ui."revoked_at" IS NULL;

-- Fail closed for orphaned legacy credentials that cannot be attributed to a
-- descriptor. Retain the row for audit/history while clearing all secrets.
UPDATE "user_integrations"
SET "access_token_ciphertext" = NULL,
    "refresh_token_ciphertext" = NULL,
    "status" = 'revoked',
    "error_reason" = NULL,
    "revoked_at" = NOW()
WHERE "provider" <> 'github'
  AND "integration_descriptor_id" IS NULL
  AND "revoked_at" IS NULL;

ALTER TABLE "console_login_transactions"
  ADD CONSTRAINT "console_login_transactions_descriptor_fk"
  FOREIGN KEY ("integration_descriptor_id")
  REFERENCES "integration_provider_descriptors"("id")
  ON DELETE CASCADE;

ALTER TABLE "user_integrations"
  ADD CONSTRAINT "user_integrations_descriptor_fk"
  FOREIGN KEY ("integration_descriptor_id")
  REFERENCES "integration_provider_descriptors"("id")
  ON DELETE SET NULL;

ALTER TABLE "user_integrations"
  ADD CONSTRAINT "user_integrations_descriptor_binding_check"
  CHECK (
    "provider" = 'github'
    OR "integration_descriptor_id" IS NOT NULL
    OR "revoked_at" IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS "idx_console_login_transactions_descriptor"
  ON "console_login_transactions" ("integration_descriptor_id");
CREATE INDEX IF NOT EXISTS "idx_user_integrations_descriptor"
  ON "user_integrations" ("integration_descriptor_id");

CREATE OR REPLACE FUNCTION "revoke_user_integrations_for_deleted_descriptor"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- The credential FK's key-share lock serializes inserts with this descriptor
  -- deletion: either this trigger revokes the committed row or the late insert
  -- fails its FK check after the descriptor disappears.
  UPDATE "user_integrations"
  SET "access_token_ciphertext" = NULL,
      "refresh_token_ciphertext" = NULL,
      "status" = 'revoked',
      "error_reason" = NULL,
      "revoked_at" = COALESCE("revoked_at", NOW())
  WHERE "integration_descriptor_id" = OLD."id"
    AND "revoked_at" IS NULL;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS "integration_descriptor_revoke_credentials" ON "integration_provider_descriptors";
CREATE TRIGGER "integration_descriptor_revoke_credentials"
BEFORE DELETE ON "integration_provider_descriptors"
FOR EACH ROW
EXECUTE FUNCTION "revoke_user_integrations_for_deleted_descriptor"();
