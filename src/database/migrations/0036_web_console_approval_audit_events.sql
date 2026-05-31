-- Metadata-only approval audit rows for privileged admin audit reads.
-- Raw prompt/tool input/output content remains in owner-scoped approval state
-- and is deliberately not copied into this administrative audit surface.

CREATE TABLE IF NOT EXISTS "approval_audit_events" (
  "id" TEXT PRIMARY KEY,
  "occurred_at" TIMESTAMPTZ NOT NULL,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "account_correlation_id" UUID NOT NULL,
  "session_id" TEXT NOT NULL,
  "tool_name" TEXT NOT NULL,
  "operation" TEXT,
  "result" TEXT NOT NULL,
  "decision_source" TEXT,
  "correlation_id" UUID,
  CONSTRAINT "approval_audit_events_result_check"
    CHECK ("result" IN ('approved', 'denied', 'errored')),
  CONSTRAINT "approval_audit_events_shape_check"
    CHECK (
      btrim("id") <> ''
      AND char_length("id") <= 120
      AND btrim("session_id") <> ''
      AND char_length("session_id") <= 200
      AND btrim("tool_name") <> ''
      AND char_length("tool_name") <= 200
      AND ("operation" IS NULL OR (
        btrim("operation") <> ''
        AND char_length("operation") <= 200
      ))
      AND ("decision_source" IS NULL OR (
        btrim("decision_source") <> ''
        AND char_length("decision_source") <= 100
      ))
    )
);
CREATE INDEX IF NOT EXISTS "idx_approval_audit_events_occurred"
  ON "approval_audit_events" ("occurred_at");
CREATE INDEX IF NOT EXISTS "idx_approval_audit_events_account"
  ON "approval_audit_events" ("account_correlation_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "idx_approval_audit_events_session"
  ON "approval_audit_events" ("session_id", "occurred_at");
ALTER TABLE "approval_audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_audit_events" FORCE ROW LEVEL SECURITY;
