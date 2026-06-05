-- Durable administrative audit substrate for the rewritten web console.
-- These tables remain dormant until production `/api/v1/*` mutation mount.

CREATE TABLE IF NOT EXISTS "admin_audit_chain_heads" (
  "stream_id" TEXT PRIMARY KEY,
  "last_sequence_id" BIGINT,
  "last_chain_hmac" BYTEA,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "admin_audit_chain_heads_shape_check"
    CHECK (
      btrim("stream_id") <> ''
      AND ("last_sequence_id" IS NULL OR "last_sequence_id" > 0)
      AND ("last_chain_hmac" IS NULL OR octet_length("last_chain_hmac") = 32)
    )
);
ALTER TABLE "admin_audit_chain_heads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_audit_chain_heads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

INSERT INTO "admin_audit_chain_heads" ("stream_id")
VALUES ('admin')
ON CONFLICT ("stream_id") DO NOTHING;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "admin_audit_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "sequence_id" BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  "occurred_at" TIMESTAMPTZ NOT NULL,
  "actor_user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "actor_sub" TEXT NOT NULL,
  "actor_role" TEXT,
  "actor_capability_role" TEXT NOT NULL,
  "actor_console_session_hash" BYTEA NOT NULL,
  "capability" TEXT NOT NULL,
  "elevation_acr" TEXT,
  "elevation_amr" TEXT[] NOT NULL,
  "elevation_auth_time" TIMESTAMPTZ,
  "endpoint" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "resource_kind" TEXT,
  "resource_id" TEXT,
  "target_user_id" UUID REFERENCES "users"("id") ON DELETE RESTRICT,
  "args_redacted" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "result" TEXT NOT NULL,
  "error_code" TEXT,
  "result_detail_redacted" JSONB,
  "correlation_id" UUID NOT NULL,
  "client_ip" INET,
  "user_agent" TEXT,
  "chain_key_id" TEXT NOT NULL,
  "chain_prev" BYTEA,
  "chain_hmac" BYTEA NOT NULL,
  CONSTRAINT "admin_audit_events_shape_check"
    CHECK (
      btrim("actor_sub") <> ''
      AND ("actor_role" IS NULL OR "actor_role" IN (
        'admin',
        'account_admin',
        'operator',
        'auditor',
        'security_admin'
      ))
      AND "actor_capability_role" IN (
        'admin',
        'account_admin',
        'operator',
        'auditor',
        'security_admin'
      )
      AND octet_length("actor_console_session_hash") = 32
      AND "capability" IN (
        'console:admin:accounts',
        'console:admin:operate',
        'console:admin:audit',
        'console:admin:security'
      )
      AND "result" IN ('approved', 'failed', 'replayed', 'rejected', 'conflict')
      AND btrim("endpoint") <> ''
      AND btrim("operation") <> ''
      AND pg_column_size("args_redacted") <= 4096
      AND ("result_detail_redacted" IS NULL OR pg_column_size("result_detail_redacted") <= 4096)
      AND btrim("chain_key_id") <> ''
      AND ("chain_prev" IS NULL OR octet_length("chain_prev") = 32)
      AND octet_length("chain_hmac") = 32
    )
);
CREATE INDEX IF NOT EXISTS "idx_admin_audit_events_occurred"
  ON "admin_audit_events" ("occurred_at", "sequence_id");
CREATE INDEX IF NOT EXISTS "idx_admin_audit_events_actor"
  ON "admin_audit_events" ("actor_user_id", "sequence_id");
CREATE INDEX IF NOT EXISTS "idx_admin_audit_events_target_user"
  ON "admin_audit_events" ("target_user_id", "sequence_id")
  WHERE "target_user_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_admin_audit_events_operation"
  ON "admin_audit_events" ("operation", "sequence_id");
CREATE INDEX IF NOT EXISTS "idx_admin_audit_events_correlation"
  ON "admin_audit_events" ("correlation_id");
ALTER TABLE "admin_audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_audit_events" FORCE ROW LEVEL SECURITY;
