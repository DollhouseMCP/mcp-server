-- Durable, versioned deployment intent for curated integration providers.
-- Credential absence remains replica-local; only an explicit disabled state
-- hides a shared descriptor. Existing descriptors are backfilled as enabled.

CREATE TABLE IF NOT EXISTS "integration_curated_provider_state" (
  "provider" TEXT PRIMARY KEY,
  "seed_revision" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "integration_curated_provider_state_provider_check"
    CHECK ("provider" ~ '^[a-z][a-z0-9_-]{1,63}$'),
  CONSTRAINT "integration_curated_provider_state_revision_check"
    CHECK ("seed_revision" > 0)
);

INSERT INTO "integration_curated_provider_state" (
  "provider",
  "seed_revision",
  "enabled",
  "updated_at"
)
SELECT
  "provider",
  "curated_seed_revision",
  TRUE,
  "updated_at"
FROM "integration_provider_descriptors"
WHERE "ownership" = 'curated'
  AND "curated_seed_revision" IS NOT NULL
ON CONFLICT ("provider") DO NOTHING;

ALTER TABLE "integration_curated_provider_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_curated_provider_state" FORCE ROW LEVEL SECURITY;
