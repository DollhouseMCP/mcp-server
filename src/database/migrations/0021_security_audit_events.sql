CREATE TABLE IF NOT EXISTS "security_audit_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_type" TEXT NOT NULL,
  "actor_id" TEXT,
  "target_id" TEXT,
  "metadata" JSONB NOT NULL,
  "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_security_audit_events_occurred"
  ON "security_audit_events" ("occurred_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_security_audit_events_type"
  ON "security_audit_events" ("event_type");
--> statement-breakpoint

-- Composite index for "all events for operator X, newest first" queries
-- that the audit CLI's investigative paths will exercise. occurred_at is
-- the second column so the index also serves time-range filters scoped
-- to one actor.
CREATE INDEX IF NOT EXISTS "idx_security_audit_events_actor"
  ON "security_audit_events" ("actor_id", "occurred_at" DESC)
  WHERE "actor_id" IS NOT NULL;
--> statement-breakpoint

-- Defense-in-depth: audit events are operator/admin material; the app role
-- must never read or write directly. Only `withSystemContext` (BYPASSRLS)
-- and the `dollhouse-audit` CLI are legitimate paths. ENABLE + FORCE
-- together in one block, matching the pattern from migration 0004.
ALTER TABLE "security_audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "security_audit_events" FORCE ROW LEVEL SECURITY;
