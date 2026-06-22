CREATE TABLE "agent_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"goals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_active" timestamp with time zone,
	"session_count" integer DEFAULT 0 NOT NULL,
	"state_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "element_relationships" (
	"source_id" uuid NOT NULL,
	"target_name" varchar(255) NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"relationship" varchar(64) NOT NULL,
	CONSTRAINT "element_relationships_source_id_target_name_target_type_pk" PRIMARY KEY("source_id","target_name","target_type")
);
--> statement-breakpoint
CREATE TABLE "element_tags" (
	"element_id" uuid NOT NULL,
	"tag" varchar(128) NOT NULL,
	CONSTRAINT "element_tags_element_id_tag_pk" PRIMARY KEY("element_id","tag")
);
--> statement-breakpoint
CREATE TABLE "elements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"raw_content" text NOT NULL,
	"body_content" text,
	"content_hash" char(64) NOT NULL,
	"byte_size" integer NOT NULL,
	"element_type" varchar(32) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"version" varchar(32),
	"author" varchar(255),
	"element_created" date,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" varchar(32) DEFAULT 'private' NOT NULL,
	"memory_type" varchar(16),
	"auto_load" boolean,
	"priority" integer,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ensemble_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ensemble_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"member_name" varchar(255) NOT NULL,
	"member_type" varchar(32) NOT NULL,
	"role" varchar(32) DEFAULT 'core' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"activation" varchar(32) DEFAULT 'always' NOT NULL,
	"condition" text,
	"purpose" text,
	"dependencies" text[] DEFAULT '{}'
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"entry_id" varchar(255) NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"content" text NOT NULL,
	"sanitized_content" text,
	"sanitized_patterns" jsonb DEFAULT '{}'::jsonb,
	"tags" text[] DEFAULT '{}',
	"entry_metadata" jsonb DEFAULT '{}'::jsonb,
	"privacy_level" varchar(32),
	"trust_level" varchar(32),
	"source" varchar(64),
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" varchar(255) NOT NULL,
	"transport" varchar(16) DEFAULT 'stdio' NOT NULL,
	"activations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confirmations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cli_approvals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cli_session_approvals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"permission_prompt_active" boolean DEFAULT false NOT NULL,
	"challenges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_active" timestamp with time zone DEFAULT NOW() NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"username" varchar(255),
	"email" varchar(255),
	"display_name" varchar(255),
	"github_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sync_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"autoload_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retention_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" varchar(255),
	"username" varchar(255) NOT NULL,
	"email" varchar(255),
	"display_name" varchar(255),
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_states" ADD CONSTRAINT "agent_states_agent_id_elements_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."elements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_states" ADD CONSTRAINT "agent_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "element_relationships" ADD CONSTRAINT "element_relationships_source_id_elements_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."elements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "element_tags" ADD CONSTRAINT "element_tags_element_id_elements_id_fk" FOREIGN KEY ("element_id") REFERENCES "public"."elements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elements" ADD CONSTRAINT "elements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ensemble_members" ADD CONSTRAINT "ensemble_members_ensemble_id_elements_id_fk" FOREIGN KEY ("ensemble_id") REFERENCES "public"."elements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ensemble_members" ADD CONSTRAINT "ensemble_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_memory_id_elements_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."elements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_states_agent" ON "agent_states" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_states_user" ON "agent_states" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_relationships_target" ON "element_relationships" USING btree ("target_name","target_type");--> statement-breakpoint
CREATE INDEX "idx_tags_tag" ON "element_tags" USING btree ("tag");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_elements_user_type_name" ON "elements" USING btree ("user_id","element_type","name");--> statement-breakpoint
CREATE INDEX "idx_elements_user_type" ON "elements" USING btree ("user_id","element_type");--> statement-breakpoint
CREATE INDEX "idx_elements_name" ON "elements" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "idx_elements_author" ON "elements" USING btree ("author");--> statement-breakpoint
CREATE INDEX "idx_elements_metadata" ON "elements" USING gin ("metadata");--> statement-breakpoint
CREATE INDEX "idx_elements_autoload" ON "elements" USING btree ("user_id") WHERE auto_load = true;--> statement-breakpoint
CREATE INDEX "idx_elements_memory_type" ON "elements" USING btree ("user_id","memory_type") WHERE element_type = 'memories';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ensemble_members_unique" ON "ensemble_members" USING btree ("ensemble_id","member_name","member_type");--> statement-breakpoint
CREATE INDEX "idx_ensemble_members_ensemble" ON "ensemble_members" USING btree ("ensemble_id");--> statement-breakpoint
CREATE INDEX "idx_ensemble_members_user" ON "ensemble_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_entries_unique" ON "memory_entries" USING btree ("memory_id","entry_id");--> statement-breakpoint
CREATE INDEX "idx_memory_entries_user" ON "memory_entries" USING btree ("user_id","memory_id");--> statement-breakpoint
CREATE INDEX "idx_memory_entries_time" ON "memory_entries" USING btree ("memory_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_memory_entries_tags" ON "memory_entries" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "idx_memory_entries_privacy" ON "memory_entries" USING btree ("memory_id","privacy_level");--> statement-breakpoint
CREATE INDEX "idx_sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_session_id" ON "sessions" USING btree ("session_id");