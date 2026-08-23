-- Bind configured-provider OAuth callbacks to the routing-sensitive descriptor
-- state that initiated them. Pre-upgrade pending flows cannot be attributed to
-- a revision safely, so expire them and require the user to restart linking.

ALTER TABLE "console_login_transactions"
  ADD COLUMN IF NOT EXISTS "integration_descriptor_fingerprint" TEXT;

DELETE FROM "console_login_transactions"
WHERE "integration_descriptor_id" IS NOT NULL;

ALTER TABLE "console_login_transactions"
  ADD CONSTRAINT "console_login_transactions_descriptor_fingerprint_check"
  CHECK (
    ("integration_descriptor_id" IS NULL AND "integration_descriptor_fingerprint" IS NULL)
    OR ("integration_descriptor_id" IS NOT NULL
      AND "integration_descriptor_fingerprint" IS NOT NULL
      AND "integration_descriptor_fingerprint" ~ '^[a-f0-9]{64}$')
  );
