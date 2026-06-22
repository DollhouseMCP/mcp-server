-- Durable owner-private per-session activity events.
-- The web-console self telemetry routes scope reads by authenticated user_id
-- and runtime session ownership before projecting these rows.

CREATE TABLE IF NOT EXISTS "session_activity_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "session_id" TEXT NOT NULL,
  "occurred_at" TIMESTAMPTZ NOT NULL,
  "level" TEXT NOT NULL,
  "subsystem" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "message" TEXT,
  "correlation_id" UUID,
  "stable_error_code" TEXT,
  CONSTRAINT "session_activity_events_level_check"
    CHECK ("level" IN ('debug', 'info', 'warn', 'error')),
  CONSTRAINT "session_activity_events_shape_check"
    CHECK (
      btrim("session_id") <> ''
      AND char_length("session_id") <= 200
      AND btrim("subsystem") <> ''
      AND char_length("subsystem") <= 80
      AND btrim("event") <> ''
      AND char_length("event") <= 160
      AND ("message" IS NULL OR char_length("message") <= 500)
      AND ("stable_error_code" IS NULL OR (
        btrim("stable_error_code") <> ''
        AND char_length("stable_error_code") <= 100
      ))
    )
);
CREATE INDEX IF NOT EXISTS "idx_session_activity_events_user_session"
  ON "session_activity_events" ("user_id", "session_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "idx_session_activity_events_session"
  ON "session_activity_events" ("session_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "idx_session_activity_events_event"
  ON "session_activity_events" ("event", "occurred_at");
ALTER TABLE "session_activity_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_activity_events" FORCE ROW LEVEL SECURITY;
