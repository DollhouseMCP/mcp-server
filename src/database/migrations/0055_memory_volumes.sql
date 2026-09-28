-- Additive archive storage. The live memory head remains in elements and
-- memory_entries; no existing rows are rewritten by this migration.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_elements_id_user_type_unique"
  ON "elements" ("id", "user_id", "element_type");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "memory_volumes" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "memory_id" UUID NOT NULL,
  "element_type" VARCHAR(32) NOT NULL DEFAULT 'memories',
  "volume" BIGINT NOT NULL,
  "raw_content" TEXT NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "entry_count" INTEGER NOT NULL,
  "first_entry_at" TIMESTAMPTZ,
  "last_entry_at" TIMESTAMPTZ,
  "sealed_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "memory_volumes_memory_owner_fk"
    FOREIGN KEY ("memory_id", "user_id", "element_type")
    REFERENCES "elements" ("id", "user_id", "element_type") ON DELETE CASCADE,
  CONSTRAINT "memory_volumes_type_check" CHECK ("element_type" = 'memories'),
  CONSTRAINT "memory_volumes_number_check" CHECK ("volume" > 0 AND "volume" <= 9007199254740991),
  CONSTRAINT "memory_volumes_entry_count_check" CHECK ("entry_count" >= 0),
  CONSTRAINT "memory_volumes_sha256_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_memory_volumes_memory_number_unique"
  ON "memory_volumes" ("memory_id", "volume");
CREATE INDEX IF NOT EXISTS "idx_memory_volumes_user_memory"
  ON "memory_volumes" ("user_id", "memory_id");
ALTER TABLE "memory_volumes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memory_volumes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- A public live memory does not make its sealed archive publicly readable.
-- No UPDATE policy: archive bytes and metadata cannot be changed in place.
CREATE POLICY "memory_volumes_owner_select" ON "memory_volumes"
  FOR SELECT USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY "memory_volumes_owner_insert" ON "memory_volumes"
  FOR INSERT WITH CHECK ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY "memory_volumes_owner_delete" ON "memory_volumes"
  FOR DELETE USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
