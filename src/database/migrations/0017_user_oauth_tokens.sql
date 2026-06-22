-- Step 12 — DB-backed encrypted GitHub OAuth token storage.
--
-- Tokens are per-user tenant data. They use normal app/user RLS context,
-- never withSystemContext. The payload is envelope-encrypted in application
-- code: a fresh random DEK encrypts the token, then the master key wraps the
-- DEK. key_version supports operator-managed rotation in a later CLI.

CREATE TABLE IF NOT EXISTS "user_oauth_tokens" (
  "user_id"          UUID PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "token_ciphertext" BYTEA NOT NULL,
  "token_iv"         BYTEA NOT NULL,
  "token_tag"        BYTEA NOT NULL,
  "wrapped_dek"      BYTEA NOT NULL,
  "dek_iv"           BYTEA NOT NULL,
  "dek_tag"          BYTEA NOT NULL,
  "key_version"      INTEGER NOT NULL,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

ALTER TABLE "user_oauth_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE "user_oauth_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "user_oauth_tokens_owner" ON "user_oauth_tokens"
  FOR ALL TO PUBLIC
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
