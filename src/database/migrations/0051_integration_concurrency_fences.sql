-- Fence refresh/disconnect races across replicas and prevent stale curated
-- descriptor replicas from rolling protected seed fields backward.

ALTER TABLE "user_integrations"
  ADD COLUMN IF NOT EXISTS "credential_generation" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "refresh_fence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "refresh_lease_id" UUID,
  ADD COLUMN IF NOT EXISTS "refresh_lease_expires_at" TIMESTAMPTZ;

ALTER TABLE "user_integrations"
  ADD CONSTRAINT "user_integrations_refresh_state_check"
  CHECK (
    "credential_generation" >= 0
    AND "refresh_fence" >= 0
    AND (
      ("refresh_lease_id" IS NULL AND "refresh_lease_expires_at" IS NULL)
      OR ("refresh_lease_id" IS NOT NULL AND "refresh_lease_expires_at" IS NOT NULL)
    )
  );

CREATE OR REPLACE FUNCTION enforce_curated_descriptor_revision_monotonicity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.ownership = 'curated' AND OLD.curated_seed_revision IS NOT NULL THEN
    IF NEW.curated_seed_revision IS NULL
       OR NEW.curated_seed_revision < OLD.curated_seed_revision THEN
      RAISE EXCEPTION 'curated descriptor seed revision cannot move backward'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.curated_seed_revision = OLD.curated_seed_revision
       AND ROW(
         NEW.provider,
         NEW.ownership,
         NEW.owner_user_id,
         NEW.display_name,
         NEW.category,
         NEW.auth_strategy,
         NEW.api_hosts,
         NEW.oauth,
         NEW.static_api_key,
         NEW.client_secret_revision,
         NEW.operation_promotion,
         NEW.created_at
       ) IS DISTINCT FROM ROW(
         OLD.provider,
         OLD.ownership,
         OLD.owner_user_id,
         OLD.display_name,
         OLD.category,
         OLD.auth_strategy,
         OLD.api_hosts,
         OLD.oauth,
         OLD.static_api_key,
         OLD.client_secret_revision,
         OLD.operation_promotion,
         OLD.created_at
       ) THEN
      RAISE EXCEPTION 'curated descriptor protected fields require a newer seed revision'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS integration_descriptor_revision_monotonicity
  ON "integration_provider_descriptors";
CREATE TRIGGER integration_descriptor_revision_monotonicity
  BEFORE UPDATE ON "integration_provider_descriptors"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_curated_descriptor_revision_monotonicity();
