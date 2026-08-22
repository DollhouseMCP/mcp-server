-- Persist a deployment-authored monotonic revision for curated integration
-- descriptors. NULL keeps legacy rows and unversioned seed files compatible;
-- once a positive revision is present, the store rejects stale replicas.

ALTER TABLE "integration_provider_descriptors"
  ADD COLUMN IF NOT EXISTS "curated_seed_revision" INTEGER;

ALTER TABLE "integration_provider_descriptors"
  ADD CONSTRAINT "integration_provider_descriptors_seed_revision_check"
  CHECK (
    "curated_seed_revision" IS NULL
    OR (
      "ownership" = 'curated'
      AND "curated_seed_revision" > 0
    )
  );
