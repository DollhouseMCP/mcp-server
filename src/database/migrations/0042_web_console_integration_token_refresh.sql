-- Allow token refresh failures to be represented without deleting the
-- previous encrypted credential. Refresh retry/gateway behavior lands in
-- later Integrations v2 groups.

ALTER TABLE "user_integrations"
  DROP CONSTRAINT IF EXISTS "user_integrations_shape_check";
ALTER TABLE "user_integrations"
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
        (
          "provider" = 'github'
          AND ("authorized_permissions" ?& array[
            'repository_selection',
            'permissions'
          ])
          AND ("authorized_permissions" - 'repository_selection' - 'permissions') = '{}'::jsonb
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
        ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
        OR ("status" <> 'revoked')
      )
      AND (
        ("status" = 'error'
          AND "error_reason" IN (
            'token_exchange_failed',
            'token_refresh_failed',
            'revocation_failed',
            'scope_denied',
            'provider_unavailable'
          ))
        OR ("status" <> 'error' AND "error_reason" IS NULL)
      )
    );
