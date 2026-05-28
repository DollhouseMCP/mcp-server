-- Runtime MCP session control-plane substrate for Milestone 2 of the modular `/api/v1` web console backend.
-- Presence and command rows are control-plane metadata only; persisted session
-- content remains in the existing session ownership boundary.

CREATE TABLE IF NOT EXISTS "runtime_session_presence" (
  "session_id" TEXT PRIMARY KEY,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "account_correlation_id" UUID NOT NULL,
  "replica_id" TEXT NOT NULL,
  "transport" TEXT NOT NULL,
  "client_name" TEXT,
  "client_version" TEXT,
  "started_at" TIMESTAMPTZ NOT NULL,
  "last_active_at" TIMESTAMPTZ NOT NULL,
  "request_count" INTEGER NOT NULL DEFAULT 0,
  "error_count" INTEGER NOT NULL DEFAULT 0,
  "lease_until" TIMESTAMPTZ NOT NULL,
  "status" TEXT NOT NULL,
  "closed_at" TIMESTAMPTZ,
  CONSTRAINT "runtime_session_presence_transport_check"
    CHECK ("transport" IN ('streamable-http')),
  CONSTRAINT "runtime_session_presence_status_check"
    CHECK ("status" IN ('active', 'closing')),
  CONSTRAINT "runtime_session_presence_shape_check"
    CHECK (
      btrim("session_id") <> ''
      AND char_length("session_id") <= 200
      AND btrim("replica_id") <> ''
      AND char_length("replica_id") <= 128
      AND ("client_name" IS NULL OR char_length("client_name") <= 100)
      AND ("client_version" IS NULL OR char_length("client_version") <= 100)
      AND "request_count" >= 0
      AND "error_count" >= 0
      AND "last_active_at" >= "started_at"
      AND "lease_until" > "last_active_at"
      AND (
        ("status" = 'active' AND "closed_at" IS NULL)
        OR ("status" = 'closing')
      )
    )
);
CREATE INDEX IF NOT EXISTS "idx_runtime_session_presence_user"
  ON "runtime_session_presence" ("user_id", "status", "lease_until");
CREATE INDEX IF NOT EXISTS "idx_runtime_session_presence_replica"
  ON "runtime_session_presence" ("replica_id", "lease_until");
CREATE INDEX IF NOT EXISTS "idx_runtime_session_presence_correlation"
  ON "runtime_session_presence" ("account_correlation_id");
ALTER TABLE "runtime_session_presence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "runtime_session_presence" FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "runtime_control_commands" (
  "command_id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "target_replica_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "requested_at" TIMESTAMPTZ NOT NULL,
  "requested_by_kind" TEXT NOT NULL,
  "requested_by_user_id" UUID REFERENCES "users"("id") ON DELETE RESTRICT,
  "invalidation_event_id" UUID REFERENCES "security_invalidation_events"("event_id") ON DELETE SET NULL,
  CONSTRAINT "runtime_control_commands_kind_check"
    CHECK ("kind" = 'terminate_session'),
  CONSTRAINT "runtime_control_commands_reason_check"
    CHECK ("reason" IN (
      'user_requested',
      'admin_disabled',
      'admin_terminated',
      'operator_terminated',
      'credential_revoked',
      'idle_expired'
    )),
  CONSTRAINT "runtime_control_commands_requester_check"
    CHECK (
      "requested_by_kind" IN ('self', 'admin', 'operator', 'system')
      AND (
        ("requested_by_kind" = 'system' AND "requested_by_user_id" IS NULL)
        OR ("requested_by_kind" <> 'system' AND "requested_by_user_id" IS NOT NULL)
      )
    ),
  CONSTRAINT "runtime_control_commands_shape_check"
    CHECK (
      btrim("session_id") <> ''
      AND char_length("session_id") <= 200
      AND btrim("target_replica_id") <> ''
      AND char_length("target_replica_id") <= 128
    )
);
CREATE INDEX IF NOT EXISTS "idx_runtime_control_commands_target"
  ON "runtime_control_commands" ("target_replica_id", "requested_at");
CREATE INDEX IF NOT EXISTS "idx_runtime_control_commands_session"
  ON "runtime_control_commands" ("session_id");
ALTER TABLE "runtime_control_commands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "runtime_control_commands" FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "runtime_control_acks" (
  "command_id" UUID PRIMARY KEY REFERENCES "runtime_control_commands"("command_id") ON DELETE CASCADE,
  "replica_id" TEXT NOT NULL,
  "acknowledged_at" TIMESTAMPTZ NOT NULL,
  "result" TEXT NOT NULL,
  "error_code" TEXT,
  CONSTRAINT "runtime_control_acks_result_check"
    CHECK ("result" IN ('terminated', 'already_absent', 'failed')),
  CONSTRAINT "runtime_control_acks_shape_check"
    CHECK (
      btrim("replica_id") <> ''
      AND char_length("replica_id") <= 128
      AND (
        ("result" = 'failed' AND "error_code" IS NOT NULL AND btrim("error_code") <> '')
        OR ("result" <> 'failed' AND "error_code" IS NULL)
      )
    )
);
CREATE INDEX IF NOT EXISTS "idx_runtime_control_acks_replica"
  ON "runtime_control_acks" ("replica_id", "acknowledged_at");
ALTER TABLE "runtime_control_acks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "runtime_control_acks" FORCE ROW LEVEL SECURITY;
