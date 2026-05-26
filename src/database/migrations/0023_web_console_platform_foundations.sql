-- Dormant data foundation for the modular `/api/v1` web console backend.
-- No application route is mounted by this migration.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "disabled_at" TIMESTAMPTZ;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "authz_version" BIGINT NOT NULL DEFAULT 1;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "account_correlation_id" UUID;
--> statement-breakpoint

UPDATE "users"
SET "account_correlation_id" = gen_random_uuid()
WHERE "account_correlation_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "users" ALTER COLUMN "account_correlation_id" SET DEFAULT gen_random_uuid();
ALTER TABLE "users" ALTER COLUMN "account_correlation_id" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_account_correlation_id"
  ON "users" ("account_correlation_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "user_admin_roles" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL CHECK ("role" IN ('admin', 'account_admin', 'operator', 'auditor', 'security_admin')),
  "granted_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "granted_by_user_id" UUID REFERENCES "users"("id") ON DELETE RESTRICT,
  "revoked_at" TIMESTAMPTZ,
  "revoked_by_user_id" UUID REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "user_admin_roles_revocation_actor_check"
    CHECK (("revoked_at" IS NULL AND "revoked_by_user_id" IS NULL)
      OR ("revoked_at" IS NOT NULL AND "revoked_by_user_id" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "idx_user_admin_roles_user" ON "user_admin_roles" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_admin_roles_active_unique"
  ON "user_admin_roles" ("user_id", "role")
  WHERE "revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_user_admin_roles_active_role"
  ON "user_admin_roles" ("role")
  WHERE "revoked_at" IS NULL;
ALTER TABLE "user_admin_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_admin_roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "console_sessions" (
  "id_hash" BYTEA PRIMARY KEY,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "auth_sub" TEXT NOT NULL,
  "csrf_token_hash" BYTEA NOT NULL,
  "granted_capabilities" TEXT[] NOT NULL,
  "elevated_capabilities" TEXT[] NOT NULL DEFAULT '{}',
  "elevation_expires_at" TIMESTAMPTZ,
  "elevation_acr" TEXT,
  "elevation_amr" TEXT[],
  "elevation_auth_time" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "last_used_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "idle_expires_at" TIMESTAMPTZ NOT NULL,
  "absolute_expires_at" TIMESTAMPTZ NOT NULL,
  "revoked_at" TIMESTAMPTZ,
  "last_ip" TEXT,
  "user_agent" TEXT,
  CONSTRAINT "console_sessions_hash_length_check"
    CHECK (octet_length("id_hash") = 32 AND octet_length("csrf_token_hash") = 32
      AND btrim("auth_sub") <> ''),
  CONSTRAINT "console_sessions_lifecycle_check"
    CHECK ("created_at" <= "last_used_at"
      AND "last_used_at" <= "idle_expires_at"
      AND "idle_expires_at" <= "absolute_expires_at"),
  CONSTRAINT "console_sessions_capability_check"
    CHECK ('console:self' = ANY ("granted_capabilities")
      AND "granted_capabilities" <@ ARRAY[
        'console:self', 'console:admin:accounts', 'console:admin:operate',
        'console:admin:audit', 'console:admin:security'
      ]::TEXT[]
      AND "elevated_capabilities" <@ "granted_capabilities"),
  CONSTRAINT "console_sessions_elevation_check"
    CHECK (
      (cardinality("elevated_capabilities") = 0
        AND "granted_capabilities" <@ ARRAY['console:self']::TEXT[]
        AND "elevation_expires_at" IS NULL AND "elevation_acr" IS NULL
        AND "elevation_amr" IS NULL AND "elevation_auth_time" IS NULL)
      OR
      (cardinality("elevated_capabilities") > 0
        AND "elevation_expires_at" IS NOT NULL AND "elevation_acr" IS NOT NULL
        AND btrim("elevation_acr") <> ''
        AND "elevation_amr" IS NOT NULL AND 'otp' = ANY ("elevation_amr")
        AND "elevation_auth_time" IS NOT NULL
        AND "elevation_auth_time" < "elevation_expires_at"
        AND "elevation_expires_at" <= "absolute_expires_at")
    )
);
CREATE INDEX IF NOT EXISTS "idx_console_sessions_user_revocation_expiry"
  ON "console_sessions" ("user_id", "revoked_at", "absolute_expires_at");
CREATE INDEX IF NOT EXISTS "idx_console_sessions_absolute_expiry"
  ON "console_sessions" ("absolute_expires_at");
ALTER TABLE "console_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "console_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "console_login_transactions" (
  "id_hash" BYTEA PRIMARY KEY,
  "flow_kind" TEXT NOT NULL CHECK ("flow_kind" IN ('login', 'step_up', 'integration_link')),
  "state_hash" BYTEA NOT NULL,
  "pkce_verifier_enc" BYTEA NOT NULL,
  "user_id" UUID REFERENCES "users"("id") ON DELETE CASCADE,
  "console_session_id_hash" BYTEA,
  "requested_capability" TEXT,
  "return_to" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "expires_at" TIMESTAMPTZ NOT NULL,
  "consumed_at" TIMESTAMPTZ,
  CONSTRAINT "console_login_transactions_hash_length_check"
    CHECK (octet_length("id_hash") = 32 AND octet_length("state_hash") = 32
      AND octet_length("pkce_verifier_enc") > 0
      AND ("console_session_id_hash" IS NULL OR octet_length("console_session_id_hash") = 32)),
  CONSTRAINT "console_login_transactions_duration_check"
    CHECK ("expires_at" > "created_at"
      AND "expires_at" <= "created_at" + INTERVAL '10 minutes'),
  CONSTRAINT "console_login_transactions_return_to_check"
    CHECK ("return_to" IS NULL OR ("return_to" LIKE '/%'
      AND "return_to" NOT LIKE '//%'
      AND strpos("return_to", chr(92)) = 0)),
  CONSTRAINT "console_login_transactions_flow_binding_check"
    CHECK (
      ("flow_kind" = 'login' AND "user_id" IS NULL AND "console_session_id_hash" IS NULL
        AND "requested_capability" IS NULL)
      OR
      ("flow_kind" = 'step_up' AND "user_id" IS NOT NULL AND "console_session_id_hash" IS NOT NULL
        AND "requested_capability" IN (
          'console:admin:accounts', 'console:admin:operate',
          'console:admin:audit', 'console:admin:security'
        ))
      OR
      ("flow_kind" = 'integration_link' AND "user_id" IS NOT NULL AND "console_session_id_hash" IS NOT NULL
        AND "requested_capability" IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS "idx_console_login_transactions_expiry"
  ON "console_login_transactions" ("expires_at");
ALTER TABLE "console_login_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "console_login_transactions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "idempotency_records" (
  "console_session_id_hash" BYTEA NOT NULL,
  "idempotency_key" UUID NOT NULL,
  "http_method" TEXT NOT NULL,
  "canonical_target" TEXT NOT NULL,
  "request_fingerprint" BYTEA NOT NULL,
  "response_status" INTEGER NOT NULL,
  "response_body" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "expires_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "idempotency_records_hash_length_check"
    CHECK (octet_length("console_session_id_hash") = 32 AND octet_length("request_fingerprint") = 32),
  CONSTRAINT "idempotency_records_method_target_check"
    CHECK ("http_method" IN ('POST', 'PUT', 'PATCH', 'DELETE')
      AND "canonical_target" LIKE '/api/v1/%'
      AND "response_status" BETWEEN 100 AND 599),
  CONSTRAINT "idempotency_records_retention_check"
    CHECK ("expires_at" > "created_at"
      AND "expires_at" <= "created_at" + INTERVAL '24 hours')
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_idempotency_records_session_key_unique"
  ON "idempotency_records" ("console_session_id_hash", "idempotency_key");
CREATE INDEX IF NOT EXISTS "idx_idempotency_records_expiry"
  ON "idempotency_records" ("expires_at");
ALTER TABLE "idempotency_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_records" FORCE ROW LEVEL SECURITY;
