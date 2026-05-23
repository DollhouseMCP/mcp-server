CREATE TABLE IF NOT EXISTS "audit_hmac_keys" (
  "kid" VARCHAR(255) PRIMARY KEY,
  "secret" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "rotated_at" TIMESTAMPTZ
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_audit_hmac_keys_active"
  ON "audit_hmac_keys" ("active");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_audit_hmac_keys_active_unique"
  ON "audit_hmac_keys" ("active")
  WHERE "active" = TRUE;
--> statement-breakpoint

-- Defense-in-depth: the HMAC secret is the keying material that prevents
-- offline guess-confirmation against the audit log. A SQLi that exfiltrates
-- this row defeats the entire audit hash design. FORCE RLS with no permissive
-- policy denies the app role; only `withSystemContext` (BYPASSRLS) can read
-- the row, which is what `AuditHmacKeyResolver.resolveFromDatabase` uses.
-- ENABLE + FORCE together in one block, matching the pattern from
-- migration 0004.
ALTER TABLE "audit_hmac_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_hmac_keys" FORCE ROW LEVEL SECURITY;
