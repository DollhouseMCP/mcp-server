-- Dormant account-administration and security-invalidation substrate for
-- Phase 4 of the modular `/api/v1` web console backend.
-- No application route is mounted by this migration.

CREATE TABLE IF NOT EXISTS "security_invalidation_events" (
  "sequence_id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "event_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "kind" TEXT NOT NULL CHECK ("kind" IN (
    'principal_disabled',
    'principal_reenabled',
    'principal_authz_changed',
    'principal_credentials_revoked',
    'admin_factor_disabled',
    'console_session_revoked',
    'console_elevation_revoked',
    'runtime_sessions_terminated'
  )),
  "urgency" TEXT NOT NULL CHECK ("urgency" IN ('eventual', 'acknowledged')),
  "user_id" UUID REFERENCES "users"("id") ON DELETE CASCADE,
  "console_session_id_hash" BYTEA,
  "authz_version" BIGINT,
  "reason" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "created_by_user_id" UUID REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "security_invalidation_events_shape_check"
    CHECK (
      btrim("reason") <> ''
      AND ("console_session_id_hash" IS NULL OR octet_length("console_session_id_hash") = 32)
      AND pg_column_size("payload") <= 4096
      AND (
        "kind" IN ('console_session_revoked')
        OR "user_id" IS NOT NULL
      )
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_security_invalidation_events_event_id"
  ON "security_invalidation_events" ("event_id");
CREATE INDEX IF NOT EXISTS "idx_security_invalidation_events_user"
  ON "security_invalidation_events" ("user_id", "sequence_id");
CREATE INDEX IF NOT EXISTS "idx_security_invalidation_events_created"
  ON "security_invalidation_events" ("created_at");
ALTER TABLE "security_invalidation_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "security_invalidation_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "security_invalidation_replica_cursors" (
  "replica_id" TEXT PRIMARY KEY,
  "last_sequence_id" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "security_invalidation_replica_cursors_check"
    CHECK (btrim("replica_id") <> '' AND "last_sequence_id" >= 0)
);
ALTER TABLE "security_invalidation_replica_cursors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "security_invalidation_replica_cursors" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "security_invalidation_replica_leases" (
  "replica_id" TEXT PRIMARY KEY,
  "lease_until" TIMESTAMPTZ NOT NULL,
  "renewed_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "security_invalidation_replica_leases_check"
    CHECK (btrim("replica_id") <> '' AND "lease_until" > "renewed_at")
);
CREATE INDEX IF NOT EXISTS "idx_security_invalidation_replica_leases_until"
  ON "security_invalidation_replica_leases" ("lease_until");
ALTER TABLE "security_invalidation_replica_leases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "security_invalidation_replica_leases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "security_invalidation_acks" (
  "event_id" UUID NOT NULL REFERENCES "security_invalidation_events"("event_id") ON DELETE CASCADE,
  "replica_id" TEXT NOT NULL,
  "acknowledged_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "security_invalidation_acks_check"
    CHECK (btrim("replica_id") <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_security_invalidation_acks_unique"
  ON "security_invalidation_acks" ("event_id", "replica_id");
ALTER TABLE "security_invalidation_acks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "security_invalidation_acks" FORCE ROW LEVEL SECURITY;
