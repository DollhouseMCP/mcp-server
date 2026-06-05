-- User-owned external integration credential state for the modular `/api/v1`
-- web console. This table is for per-user OAuth/GitHub App credential state
-- only; portfolio, activation, approval, execution, and Gatekeeper domains own
-- their separate persistence models.

CREATE TABLE IF NOT EXISTS "user_integrations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL,
  "external_account_label" TEXT,
  "external_installation_id" TEXT,
  "authorized_permissions" JSONB NOT NULL DEFAULT '{"repository_selection":"unknown","permissions":{"contents":"none"}}'::jsonb,
  "access_token_ciphertext" BYTEA,
  "refresh_token_ciphertext" BYTEA,
  "credential_key_version" TEXT,
  "status" TEXT NOT NULL,
  "connected_at" TIMESTAMPTZ,
  "last_sync_at" TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ,
  CONSTRAINT "user_integrations_provider_check"
    CHECK ("provider" IN ('github')),
  CONSTRAINT "user_integrations_status_check"
    CHECK ("status" IN ('connected', 'revoked', 'error')),
  CONSTRAINT "user_integrations_shape_check"
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
      AND ("authorized_permissions" ?& array[
        'repository_selection',
        'permissions'
      ])
      AND ("authorized_permissions" - 'repository_selection' - 'permissions') = '{}'::jsonb
      AND NOT ("authorized_permissions" ?| array[
        'access_token',
        'accessToken',
        'refresh_token',
        'refreshToken',
        'token',
        'token_hash',
        'tokenHash',
        'ciphertext',
        'credential_key_version',
        'credentialKeyVersion'
      ])
      AND (
        ("authorized_permissions"->>'repository_selection') IN ('selected', 'all', 'unknown')
      )
      AND jsonb_typeof("authorized_permissions"->'permissions') = 'object'
      AND (("authorized_permissions"->'permissions') - 'contents') = '{}'::jsonb
      AND (
        ("authorized_permissions"->'permissions'->>'contents') IN ('none', 'read', 'write')
      )
      AND NOT (("authorized_permissions"->'permissions') ?| array[
        'administration',
        'actions',
        'workflows',
        'secrets',
        'metadata'
      ])
      AND (
        ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
        OR ("status" <> 'revoked')
      )
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_integrations_active_provider_unique"
  ON "user_integrations" ("user_id", "provider")
  WHERE "revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_user_integrations_user"
  ON "user_integrations" ("user_id", "revoked_at");
ALTER TABLE "user_integrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_integrations" FORCE ROW LEVEL SECURITY;
