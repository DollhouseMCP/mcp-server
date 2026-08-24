-- Descriptors created after 0041 but before configured OAuth execution was
-- introduced did not carry a clientId. Preserve those rows as explicitly
-- unconfigured metadata; operators can complete them through a later upsert.

UPDATE "integration_provider_descriptors"
SET "oauth" = jsonb_set("oauth", '{clientId}', 'null'::jsonb, true)
WHERE "auth_strategy" = 'oauth2_authorization_code'
  AND jsonb_typeof("oauth") = 'object' -- NOSONAR: immutable migration predicates intentionally repeat the column
  AND (
    NOT ("oauth" ? 'clientId')
    OR jsonb_typeof("oauth"->'clientId') <> 'string'
    OR btrim("oauth"->>'clientId') = ''
    OR char_length("oauth"->>'clientId') > 200
  );
