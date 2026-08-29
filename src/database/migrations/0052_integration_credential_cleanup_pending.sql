-- Keep provider credentials encrypted and locally unusable until remote
-- revocation succeeds. Cleanup leases fence concurrent retry workers and
-- expire after a crash so a later request can safely resume the work.

ALTER TABLE "user_integrations"
  ADD COLUMN IF NOT EXISTS "cleanup_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cleanup_next_attempt_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "cleanup_lease_id" UUID,
  ADD COLUMN IF NOT EXISTS "cleanup_lease_expires_at" TIMESTAMPTZ;

ALTER TABLE "user_integrations"
  -- Older databases can still carry the standalone error-reason constraint
  -- from migration 0029. The replacement shape constraint below owns this
  -- invariant and permits revocation_failed during cleanup_pending.
  DROP CONSTRAINT IF EXISTS "user_integrations_error_reason_check",
  DROP CONSTRAINT IF EXISTS "user_integrations_status_check",
  DROP CONSTRAINT IF EXISTS "user_integrations_shape_check";

ALTER TABLE "user_integrations"
  ADD CONSTRAINT "user_integrations_status_check"
  CHECK ("status" IN ('connected', 'cleanup_pending', 'cleanup_failed', 'revoked', 'error')),
  ADD CONSTRAINT "user_integrations_shape_check"
  CHECK (
    ("external_account_label" IS NULL OR (
      btrim("external_account_label") <> ''
      AND char_length("external_account_label") <= 200
    ))
    AND ("external_installation_id" IS NULL OR (
      btrim("external_installation_id") <> ''
      AND char_length("external_installation_id") <= 200
    ))
    AND ("credential_key_version" IS NULL OR (
      btrim("credential_key_version") <> ''
      AND char_length("credential_key_version") <= 128
    ))
    AND jsonb_typeof("authorized_permissions") = 'object'
    AND char_length("authorized_permissions"::text) <= 4096
    AND NOT ("authorized_permissions" ?| array[
      'access_token', 'accessToken', 'refresh_token', 'refreshToken', 'token',
      'token_hash', 'tokenHash', 'ciphertext', 'credential_key_version',
      'credentialKeyVersion'
    ])
    AND (
      (
        "provider" = 'github'
        AND ("authorized_permissions" ?& array['repository_selection', 'permissions'])
        AND ("authorized_permissions" - 'repository_selection' - 'permissions') = '{}'::jsonb
        AND ("authorized_permissions"->>'repository_selection') IN ('selected', 'all', 'unknown')
        AND jsonb_typeof("authorized_permissions"->'permissions') = 'object'
        AND (("authorized_permissions"->'permissions') - 'contents') = '{}'::jsonb
        AND ("authorized_permissions"->'permissions'->>'contents') IN ('none', 'read', 'write')
        AND NOT ("authorized_permissions"->'permissions' ?| array[
          'administration', 'actions', 'workflows', 'secrets', 'metadata'
        ])
      )
      OR (
        "provider" <> 'github'
        AND ("authorized_permissions" ?& array['scopes'])
        AND ("authorized_permissions" - 'scopes') = '{}'::jsonb
        AND jsonb_typeof("authorized_permissions"->'scopes') = 'array'
        AND jsonb_array_length("authorized_permissions"->'scopes') <= 100
      )
    )
    AND (
      ("status" IN ('cleanup_pending', 'cleanup_failed', 'revoked') AND "revoked_at" IS NOT NULL)
      OR "status" NOT IN ('cleanup_pending', 'cleanup_failed', 'revoked')
    )
    AND (
      ("status" = 'error' AND "error_reason" IN (
        'token_exchange_failed', 'token_refresh_failed', 'revocation_failed',
        'scope_denied', 'provider_unavailable'
      ))
      OR ("status" = 'cleanup_pending' AND "error_reason" = 'revocation_failed')
      OR ("status" = 'cleanup_failed' AND "error_reason" = 'revocation_failed')
      OR ("status" NOT IN ('error', 'cleanup_pending', 'cleanup_failed') AND "error_reason" IS NULL)
    )
    AND (
      "status" NOT IN ('cleanup_pending', 'cleanup_failed')
      OR "access_token_ciphertext" IS NOT NULL
      OR "refresh_token_ciphertext" IS NOT NULL
    )
    AND "cleanup_attempt_count" >= 0
    AND (
      ("cleanup_lease_id" IS NULL AND "cleanup_lease_expires_at" IS NULL)
      OR ("cleanup_lease_id" IS NOT NULL AND "cleanup_lease_expires_at" IS NOT NULL)
    )
    AND (
      ("status" = 'cleanup_pending' AND "cleanup_next_attempt_at" IS NOT NULL)
      OR ("status" = 'cleanup_failed'
        AND "cleanup_next_attempt_at" IS NULL
        AND "cleanup_lease_id" IS NULL
        AND "cleanup_lease_expires_at" IS NULL)
      OR ("status" NOT IN ('cleanup_pending', 'cleanup_failed')
        AND "cleanup_attempt_count" = 0
        AND "cleanup_next_attempt_at" IS NULL
        AND "cleanup_lease_id" IS NULL
        AND "cleanup_lease_expires_at" IS NULL)
    )
    AND (
      "provider" = 'github'
      OR "integration_descriptor_id" IS NOT NULL
      OR "revoked_at" IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_integrations_cleanup_provider_unique"
  ON "user_integrations" ("user_id", "provider")
  WHERE "status" = 'cleanup_pending';

-- Descriptor deletion must retain the routing context needed to revoke any
-- still-encrypted credential. Application code disconnects it first.
CREATE OR REPLACE FUNCTION "revoke_user_integrations_for_deleted_descriptor"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "user_integrations"
    WHERE "integration_descriptor_id" = OLD."id"
      AND "status" <> 'cleanup_failed'
      AND (
        "access_token_ciphertext" IS NOT NULL
        OR "refresh_token_ciphertext" IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'integration descriptor still owns revocable credentials'
      USING ERRCODE = '55006';
  END IF;

  UPDATE "user_integrations"
  SET "status" = 'revoked',
      "error_reason" = NULL,
      "cleanup_attempt_count" = 0,
      "cleanup_next_attempt_at" = NULL,
      "cleanup_lease_id" = NULL,
      "cleanup_lease_expires_at" = NULL,
      "revoked_at" = COALESCE("revoked_at", statement_timestamp())
  WHERE "integration_descriptor_id" = OLD."id"
    AND "revoked_at" IS NULL;
  RETURN OLD;
END;
$$;

-- Account deletion cascades through this table. Refuse that delete while a
-- credential can still be revoked; otherwise the retry handle would vanish.
CREATE OR REPLACE FUNCTION "protect_pending_integration_credentials_from_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" <> 'cleanup_failed'
     AND (OLD."access_token_ciphertext" IS NOT NULL
       OR OLD."refresh_token_ciphertext" IS NOT NULL) THEN
    RAISE EXCEPTION 'user integration still owns revocable credentials'
      USING ERRCODE = '55006';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS "user_integration_protect_revocable_credentials" ON "user_integrations";
CREATE TRIGGER "user_integration_protect_revocable_credentials"
BEFORE DELETE ON "user_integrations"
FOR EACH ROW
EXECUTE FUNCTION "protect_pending_integration_credentials_from_delete"();
