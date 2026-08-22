CREATE TABLE IF NOT EXISTS "agent_replacement_journals" (
  "operation_id" UUID PRIMARY KEY,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "session_id" TEXT NOT NULL,
  "agent_id" UUID NOT NULL REFERENCES "elements"("id") ON DELETE CASCADE,
  "agent_name" TEXT NOT NULL,
  "owner_host" TEXT NOT NULL,
  "owner_pid" INTEGER NOT NULL,
  "owner_process_incarnation" JSONB,
  "owner_instance_id" UUID NOT NULL,
  "lease_token" UUID NOT NULL,
  "heartbeat_at" TIMESTAMPTZ NOT NULL,
  "lease_expires_at" TIMESTAMPTZ NOT NULL,
  "payload" JSONB NOT NULL,
  "quarantined_at" TIMESTAMPTZ,
  "quarantine_reason" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "agent_replacement_journals_owner_pid_check" CHECK ("owner_pid" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_agent_replacement_journal_scope"
  ON "agent_replacement_journals" ("user_id", "agent_id")
  WHERE "quarantined_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_agent_replacement_journal_lease"
  ON "agent_replacement_journals" ("lease_expires_at");

ALTER TABLE "agent_replacement_journals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_replacement_journals" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_replacement_journals_user_isolation"
  ON "agent_replacement_journals";
CREATE POLICY "agent_replacement_journals_user_isolation"
  ON "agent_replacement_journals"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true)::uuid);
