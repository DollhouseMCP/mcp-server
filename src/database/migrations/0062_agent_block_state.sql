CREATE TABLE "danger_zone_blocks" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "agent_name" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "block" jsonb NOT NULL,
  "blocked_at" timestamptz NOT NULL,
  PRIMARY KEY ("user_id", "agent_name")
);
--> statement-breakpoint
ALTER TABLE "danger_zone_blocks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "danger_zone_blocks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "danger_zone_blocks_user" ON "danger_zone_blocks" FOR ALL
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint
CREATE TABLE "danger_zone_block_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "snapshot" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
ALTER TABLE "danger_zone_block_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "danger_zone_block_evidence_user_id_idx" ON "danger_zone_block_evidence" ("user_id");
--> statement-breakpoint
ALTER TABLE "danger_zone_block_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- No UPDATE/DELETE policy for the app role: evidence is immutable there; purge and cascade run as the owner.
CREATE POLICY "danger_zone_block_evidence_read" ON "danger_zone_block_evidence" FOR SELECT
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "danger_zone_block_evidence_insert" ON "danger_zone_block_evidence" FOR INSERT
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
