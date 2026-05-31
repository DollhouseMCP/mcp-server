-- Durable user-owned portfolio element persistence for the rewritten web console.
-- Route handlers access this table only through the typed portfolio store.

CREATE TABLE IF NOT EXISTS "portfolio_elements" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "canonical_name" TEXT NOT NULL,
  "display_name" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "validation_status" TEXT NOT NULL DEFAULT 'valid',
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "content" TEXT NOT NULL,
  CONSTRAINT "portfolio_elements_type_check"
    CHECK ("type" IN ('personas', 'skills', 'templates', 'agents', 'memories', 'ensembles')),
  CONSTRAINT "portfolio_elements_validation_status_check"
    CHECK ("validation_status" IN ('valid', 'invalid', 'unknown')),
  CONSTRAINT "portfolio_elements_shape_check"
    CHECK (
      btrim("name") <> ''
      AND btrim("canonical_name") <> ''
      AND char_length("name") <= 200
      AND char_length("canonical_name") <= 200
      AND ("display_name" IS NULL OR (
        btrim("display_name") <> ''
        AND char_length("display_name") <= 200
      ))
      AND "version" >= 1
      AND coalesce(array_length("tags", 1), 0) <= 50
      AND jsonb_typeof("metadata") = 'object'
      AND char_length("metadata"::text) <= 65536
      AND octet_length("content") <= 1048576
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_portfolio_elements_user_type_name_unique"
  ON "portfolio_elements" ("user_id", "type", "canonical_name");
CREATE INDEX IF NOT EXISTS "idx_portfolio_elements_user_updated"
  ON "portfolio_elements" ("user_id", "updated_at");
CREATE INDEX IF NOT EXISTS "idx_portfolio_elements_user_type"
  ON "portfolio_elements" ("user_id", "type");
ALTER TABLE "portfolio_elements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portfolio_elements" FORCE ROW LEVEL SECURITY;
