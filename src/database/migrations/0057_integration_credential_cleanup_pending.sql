-- Retain encrypted OAuth credentials until provider-side revocation succeeds.
-- cleanup_pending rows are locally unusable (revoked_at is set) but remain
-- durable so a later disconnect/cleanup attempt can finish remote revocation.

ALTER TABLE "user_integrations"
  ADD COLUMN IF NOT EXISTS "authorization_started_at" TIMESTAMPTZ;

-- Older constraints allowed a connected row without connected_at. Preserve the
-- row and give it a conservative migration-time watermark before enforcing the
-- stricter readable-record contract.
UPDATE "user_integrations"
SET "connected_at" = COALESCE("last_sync_at", statement_timestamp())
WHERE "status" = 'connected'
  AND "connected_at" IS NULL;

UPDATE "user_integrations"
SET "authorization_started_at" = "connected_at"
WHERE "authorization_started_at" IS NULL
  AND "connected_at" IS NOT NULL;

-- PostgreSQL does not permit a subquery directly inside a CHECK constraint.
-- Keep the set-returning JSON inspection in a strict immutable helper so the
-- database can enforce the same bounded, string-only scope contract as the
-- application validator.
CREATE OR REPLACE FUNCTION "dollhouse_valid_integration_scopes"(JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof($1) = 'array'
    AND jsonb_array_length($1) <= 100
    AND COALESCE((
      SELECT bool_and(
        jsonb_typeof(scope.value) = 'string'
        AND btrim(scope.value #>> '{}') <> ''
        AND char_length(scope.value #>> '{}') <= 200
      )
      FROM jsonb_array_elements($1) AS scope(value)
    ), TRUE)
$$;

-- The former constraint could accept SQL UNKNOWN and did not inspect each
-- generic scope entry. Refuse an ambiguous upgrade with an actionable error
-- instead of silently changing or under-reporting a live provider grant.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "user_integrations"
    WHERE NOT ((
      jsonb_typeof("authorized_permissions") = 'object'
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
        )
        OR (
          "provider" <> 'github'
          AND ("authorized_permissions" ?& array['scopes'])
          AND ("authorized_permissions" - 'scopes') = '{}'::jsonb
          AND "dollhouse_valid_integration_scopes"("authorized_permissions"->'scopes')
        )
      )
      AND (
        ("status" = 'error' AND "error_reason" IN (
          'token_exchange_failed', 'token_refresh_failed', 'revocation_failed',
          'scope_denied', 'provider_unavailable'
        ))
        OR ("status" = 'cleanup_pending' AND "error_reason" = 'revocation_failed')
        OR ("status" NOT IN ('error', 'cleanup_pending') AND "error_reason" IS NULL)
      )
    ) IS TRUE)
  ) THEN
    RAISE EXCEPTION 'user_integrations contains legacy rows that violate the strict permission/status contract; remediate them before applying migration 0057'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "user_integrations"
  DROP CONSTRAINT IF EXISTS "user_integrations_status_check",
  DROP CONSTRAINT IF EXISTS "user_integrations_shape_check";

ALTER TABLE "user_integrations"
  ADD CONSTRAINT "user_integrations_status_check"
  CHECK ("status" IN ('connected', 'cleanup_pending', 'revoked', 'error')),
  ADD CONSTRAINT "user_integrations_shape_check"
  CHECK ((
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
        AND "dollhouse_valid_integration_scopes"("authorized_permissions"->'scopes')
      )
    )
    AND (
      ("status" IN ('cleanup_pending', 'revoked') AND "revoked_at" IS NOT NULL)
      OR ("status" NOT IN ('cleanup_pending', 'revoked'))
    )
    AND (
      ("status" = 'error' AND "error_reason" IN (
        'token_exchange_failed', 'token_refresh_failed', 'revocation_failed',
        'scope_denied', 'provider_unavailable'
      ))
      OR ("status" = 'cleanup_pending' AND "error_reason" = 'revocation_failed')
      OR ("status" NOT IN ('error', 'cleanup_pending') AND "error_reason" IS NULL)
    )
    AND (
      "status" <> 'cleanup_pending'
      OR "access_token_ciphertext" IS NOT NULL
      OR "refresh_token_ciphertext" IS NOT NULL
    )
    AND (
      "status" <> 'connected'
      OR ("authorization_started_at" IS NOT NULL AND "connected_at" IS NOT NULL)
    )
    AND (
      "provider" = 'github'
      OR "integration_descriptor_id" IS NOT NULL
      OR "revoked_at" IS NOT NULL
    )
  ) IS TRUE);

-- A descriptor is the only routing context capable of safely revoking its
-- credentials. Refuse direct SQL deletion while any encrypted handle remains;
-- application flows must disconnect and finish durable cleanup first.
CREATE OR REPLACE FUNCTION "revoke_user_integrations_for_deleted_descriptor"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "user_integrations"
    WHERE "integration_descriptor_id" = OLD."id"
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
      "revoked_at" = COALESCE("revoked_at", statement_timestamp())
  WHERE "integration_descriptor_id" = OLD."id"
    AND "revoked_at" IS NULL;
  RETURN OLD;
END;
$$;
