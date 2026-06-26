-- Storage contracts for Integrations v2 descriptors and OpenAPI specs.
-- These tables are inert metadata storage only; executable configured
-- providers and integration_request land in later groups.

CREATE TABLE IF NOT EXISTS "integration_provider_descriptors" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider" TEXT NOT NULL,
  "ownership" TEXT NOT NULL,
  "owner_user_id" UUID REFERENCES "users"("id") ON DELETE CASCADE,
  "display_name" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "auth_strategy" TEXT NOT NULL,
  "api_hosts" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "oauth" JSONB,
  "static_api_key" JSONB,
  "client_secret_ciphertext" BYTEA,
  "credential_key_version" TEXT,
  "operation_promotion" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "integration_provider_descriptors_provider_check"
    CHECK ("provider" ~ '^[a-z][a-z0-9_-]{1,63}$'),
  CONSTRAINT "integration_provider_descriptors_ownership_check"
    CHECK ("ownership" IN ('curated', 'byo')),
  CONSTRAINT "integration_provider_descriptors_auth_strategy_check"
    CHECK ("auth_strategy" IN ('oauth2_authorization_code', 'static_api_key', 'coded')),
  CONSTRAINT "integration_provider_descriptors_shape_check"
    CHECK (
      btrim("display_name") <> ''
      AND char_length("display_name") <= 120
      AND btrim("category") <> ''
      AND char_length("category") <= 80
      AND jsonb_typeof("api_hosts") = 'array'
      AND jsonb_array_length("api_hosts") BETWEEN 1 AND 25
      AND jsonb_typeof("operation_promotion") = 'object'
      AND char_length("operation_promotion"::text) <= 8192
      AND ("credential_key_version" IS NULL OR (
        btrim("credential_key_version") <> ''
        AND char_length("credential_key_version") <= 128
      ))
      AND ("client_secret_ciphertext" IS NOT NULL OR "credential_key_version" IS NULL)
      AND (
        ("ownership" = 'curated' AND "owner_user_id" IS NULL)
        OR ("ownership" = 'byo' AND "owner_user_id" IS NOT NULL)
      )
      AND (
        ("auth_strategy" = 'oauth2_authorization_code'
          AND "oauth" IS NOT NULL
          AND jsonb_typeof("oauth") = 'object'
          AND "static_api_key" IS NULL)
        OR ("auth_strategy" = 'static_api_key'
          AND "static_api_key" IS NOT NULL
          AND jsonb_typeof("static_api_key") = 'object'
          AND "oauth" IS NULL)
        OR ("auth_strategy" = 'coded'
          AND "oauth" IS NULL
          AND "static_api_key" IS NULL
          AND "client_secret_ciphertext" IS NULL)
      )
      AND "updated_at" >= "created_at"
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_integration_provider_descriptors_curated_unique"
  ON "integration_provider_descriptors" ("provider")
  WHERE "ownership" = 'curated';
CREATE UNIQUE INDEX IF NOT EXISTS "idx_integration_provider_descriptors_byo_unique"
  ON "integration_provider_descriptors" ("owner_user_id", "provider")
  WHERE "ownership" = 'byo';
CREATE INDEX IF NOT EXISTS "idx_integration_provider_descriptors_owner"
  ON "integration_provider_descriptors" ("owner_user_id");

ALTER TABLE "integration_provider_descriptors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_provider_descriptors" FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "integration_openapi_specs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "descriptor_id" UUID NOT NULL REFERENCES "integration_provider_descriptors"("id") ON DELETE CASCADE,
  "spec" JSONB NOT NULL,
  "source_url" TEXT,
  "spec_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "integration_openapi_specs_shape_check"
    CHECK (
      jsonb_typeof("spec") = 'object'
      AND char_length("spec"::text) <= 1048576
      AND "spec"->>'openapi' LIKE '3.%'
      AND jsonb_typeof("spec"->'paths') = 'object'
      AND ("source_url" IS NULL OR (
        "source_url" LIKE 'https://%'
        AND char_length("source_url") <= 2048
        AND "source_url" NOT LIKE '%#%'
      ))
      AND "spec_hash" ~ '^[a-f0-9]{64}$'
      AND "updated_at" >= "created_at"
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_integration_openapi_specs_descriptor_unique"
  ON "integration_openapi_specs" ("descriptor_id");

ALTER TABLE "integration_openapi_specs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_openapi_specs" FORCE ROW LEVEL SECURITY;
