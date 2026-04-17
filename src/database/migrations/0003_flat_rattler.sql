ALTER TABLE "element_relationships" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "element_tags" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "element_relationships" ADD CONSTRAINT "element_relationships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "element_tags" ADD CONSTRAINT "element_tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_relationships_user" ON "element_relationships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_tags_user" ON "element_tags" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_elements_scan" ON "elements" USING btree ("user_id","element_type","updated_at");