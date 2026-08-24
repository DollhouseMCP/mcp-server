-- Descriptors created after 0041 but before configured OAuth execution was
-- introduced did not carry a clientId. Preserve those rows as explicitly
-- unconfigured metadata; operators can complete them through a later upsert.

WITH oauth_descriptors AS (
  SELECT id, oauth->'clientId' AS client_id
  FROM "integration_provider_descriptors"
  WHERE "auth_strategy" = 'oauth2_authorization_code'
    AND jsonb_typeof(oauth) = 'object'
)
UPDATE "integration_provider_descriptors" AS descriptor
SET oauth = jsonb_set(descriptor.oauth, '{clientId}', 'null'::jsonb, true)
FROM oauth_descriptors AS candidate
WHERE descriptor.id = candidate.id
  AND (
    candidate.client_id IS NULL
    OR jsonb_typeof(candidate.client_id) <> 'string'
    OR btrim(candidate.client_id #>> '{}') = ''
    OR char_length(candidate.client_id #>> '{}') > 200
  );
