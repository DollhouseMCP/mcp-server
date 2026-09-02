-- Separate the logical OAuth client-secret revision from its randomized
-- at-rest encryption envelope. Existing NULL revisions remain valid legacy
-- state and are preserved until a detected logical secret rotation.

ALTER TABLE "integration_provider_descriptors"
  ADD COLUMN IF NOT EXISTS "client_secret_revision" UUID;

ALTER TABLE "integration_provider_descriptors"
  ADD CONSTRAINT "integration_provider_descriptors_secret_revision_check"
  CHECK (
    "client_secret_ciphertext" IS NOT NULL
    OR "client_secret_revision" IS NULL
  );
