-- Durable per-runtime-session activation state and private activation events.
-- Activation routes are scoped by runtime_session_presence ownership before
-- using these tables.

CREATE TABLE IF NOT EXISTS "session_activation_records" (
  "session_id" TEXT NOT NULL REFERENCES "runtime_session_presence"("session_id") ON DELETE CASCADE,
  "element_type" TEXT NOT NULL,
  "element_name" TEXT NOT NULL,
  "activated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "pk_session_activation_records"
    PRIMARY KEY ("session_id", "element_type", "element_name"),
  CONSTRAINT "session_activation_records_type_check"
    CHECK ("element_type" IN ('personas', 'skills', 'agents', 'memories', 'ensembles')),
  CONSTRAINT "session_activation_records_shape_check"
    CHECK (
      btrim("session_id") <> ''
      AND char_length("session_id") <= 200
      AND btrim("element_name") <> ''
      AND char_length("element_name") <= 200
    )
);
CREATE INDEX IF NOT EXISTS "idx_session_activation_records_session"
  ON "session_activation_records" ("session_id", "activated_at");
ALTER TABLE "session_activation_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_activation_records" FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "session_activation_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "session_id" TEXT NOT NULL,
  "element_type" TEXT NOT NULL,
  "element_name" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "occurred_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "session_activation_events_type_check"
    CHECK ("element_type" IN ('personas', 'skills', 'agents', 'memories', 'ensembles')),
  CONSTRAINT "session_activation_events_action_check"
    CHECK ("action" IN ('activated', 'deactivated')),
  CONSTRAINT "session_activation_events_shape_check"
    CHECK (
      btrim("session_id") <> ''
      AND char_length("session_id") <= 200
      AND btrim("element_name") <> ''
      AND char_length("element_name") <= 200
    )
);
CREATE INDEX IF NOT EXISTS "idx_session_activation_events_user_session"
  ON "session_activation_events" ("user_id", "session_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "idx_session_activation_events_session"
  ON "session_activation_events" ("session_id", "occurred_at");
ALTER TABLE "session_activation_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_activation_events" FORCE ROW LEVEL SECURITY;
