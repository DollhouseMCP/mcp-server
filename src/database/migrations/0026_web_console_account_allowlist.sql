-- History-preserving account allowlist for the modular `/api/v1` web console.
-- Not authoritative for sign-in until the AS gate is cut over from `auth_allowlist`;
-- web-console account allowlist routes are feature-gated off by default.

CREATE TABLE IF NOT EXISTS "account_allowlist_entries" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" TEXT NOT NULL CHECK ("kind" IN ('email', 'github_username', 'github_id')),
  "normalized_value" TEXT NOT NULL,
  "display_value" TEXT NOT NULL,
  "note" TEXT,
  "created_by_user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "revoked_by_user_id" UUID REFERENCES "users"("id") ON DELETE RESTRICT,
  "revoked_at" TIMESTAMPTZ,
  CONSTRAINT "account_allowlist_entries_shape_check"
    CHECK (
      btrim("normalized_value") <> ''
      AND btrim("display_value") <> ''
      AND char_length("normalized_value") <= 320
      AND char_length("display_value") <= 320
      AND ("note" IS NULL OR char_length("note") <= 500)
      AND (
        ("revoked_at" IS NULL AND "revoked_by_user_id" IS NULL)
        OR ("revoked_at" IS NOT NULL AND "revoked_by_user_id" IS NOT NULL)
      )
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_allowlist_entries_active_unique"
  ON "account_allowlist_entries" ("kind", "normalized_value")
  WHERE "revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_account_allowlist_entries_created"
  ON "account_allowlist_entries" ("created_at");
ALTER TABLE "account_allowlist_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_allowlist_entries" FORCE ROW LEVEL SECURITY;
