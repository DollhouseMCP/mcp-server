ALTER TABLE "agent_states" DROP CONSTRAINT "agent_states_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "ensemble_members" DROP CONSTRAINT "ensemble_members_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "memory_entries" DROP CONSTRAINT "memory_entries_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "idx_sessions_user";--> statement-breakpoint
DROP INDEX "idx_sessions_session_id";--> statement-breakpoint
ALTER TABLE "agent_states" ADD CONSTRAINT "agent_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ensemble_members" ADD CONSTRAINT "ensemble_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sessions_user_session" ON "sessions" USING btree ("user_id","session_id");--> statement-breakpoint
ALTER TABLE "user_settings" DROP COLUMN "username";--> statement-breakpoint
ALTER TABLE "user_settings" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "user_settings" DROP COLUMN "display_name";