ALTER TABLE "agent_states" ADD COLUMN "session_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "idx_agent_states_agent";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_states_agent_session" ON "agent_states" USING btree ("agent_id","session_id");--> statement-breakpoint
CREATE INDEX "idx_agent_states_session" ON "agent_states" USING btree ("session_id");--> statement-breakpoint
