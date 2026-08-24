-- Descriptors created before credential-bearing account-label fields were
-- rejected may still select secrets such as access_token for display. Remove
-- only those unsafe selectors so legacy rows remain readable but cannot expose
-- credentials when configured OAuth execution is enabled.

WITH reserved_fields(canonical) AS (
  VALUES
    ('access_token'),
    ('api_key'),
    ('assertion'),
    ('authorization_code'),
    ('client_secret'),
    ('code'),
    ('credential'),
    ('credentials'),
    ('device_code'),
    ('id_token'),
    ('password'),
    ('refresh_token'),
    ('secret'),
    ('token'),
    ('user_code')
),
unsafe_account_labels AS (
  SELECT
    descriptor.id,
    COALESCE(
      lower(regexp_replace(
        regexp_replace(
          btrim(descriptor.oauth #>> '{accountLabel,field}'),
          '([a-z0-9])([A-Z])',
          '\1_\2',
          'g'
        ),
        '[^a-zA-Z0-9]+',
        '_',
        'g'
      )) IN (SELECT canonical FROM reserved_fields),
      FALSE
    ) AS unsafe_field,
    COALESCE(
      lower(regexp_replace(
        regexp_replace(
          btrim(descriptor.oauth #>> '{accountLabel,tokenResponseField}'),
          '([a-z0-9])([A-Z])',
          '\1_\2',
          'g'
        ),
        '[^a-zA-Z0-9]+',
        '_',
        'g'
      )) IN (SELECT canonical FROM reserved_fields),
      FALSE
    ) AS unsafe_token_response_field
  FROM "integration_provider_descriptors" AS descriptor
  WHERE descriptor.auth_strategy = 'oauth2_authorization_code'
    AND jsonb_typeof(descriptor.oauth) = 'object'
    AND jsonb_typeof(descriptor.oauth->'accountLabel') = 'object'
)
UPDATE "integration_provider_descriptors" AS descriptor
SET
  oauth = CASE
    WHEN candidate.unsafe_field AND candidate.unsafe_token_response_field
      THEN (descriptor.oauth #- '{accountLabel,field}') #- '{accountLabel,tokenResponseField}'
    WHEN candidate.unsafe_field
      THEN descriptor.oauth #- '{accountLabel,field}'
    WHEN candidate.unsafe_token_response_field
      THEN descriptor.oauth #- '{accountLabel,tokenResponseField}'
    ELSE descriptor.oauth
  END,
  updated_at = GREATEST(descriptor.updated_at, NOW())
FROM unsafe_account_labels AS candidate
WHERE descriptor.id = candidate.id
  AND (candidate.unsafe_field OR candidate.unsafe_token_response_field);
