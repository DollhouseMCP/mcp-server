CREATE TABLE IF NOT EXISTS "rate_limit_state" (
  "scope" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "state" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "expires_at" TIMESTAMPTZ,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("scope", "key")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_rate_limit_state_expires"
  ON "rate_limit_state" ("expires_at")
  WHERE "expires_at" IS NOT NULL;
--> statement-breakpoint

-- Defense-in-depth: rate-limit state is system-scoped (no user_id column);
-- legitimate access only flows through `withSystemContext` on a BYPASSRLS role.
-- FORCE RLS with no permissive policy → deny-all for the app role. Prevents
-- a SQL-injection or accidental query in app code from reading or tampering
-- with rate-limit counters. ENABLE + FORCE are kept in one breakpoint block
-- so a crash between them can't leave the table in a partially-protected
-- state — matches the pattern from migration 0004.
ALTER TABLE "rate_limit_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_limit_state" FORCE ROW LEVEL SECURITY;
