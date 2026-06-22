-- Sign-in allowlist for the embedded authorization server.
--
-- Gates which identities can complete the OAuth/email/invite-redemption
-- flows. The check runs after identity verification (GitHub callback,
-- magic-link consume, invite redeem) and before account upsert. Entries
-- are matched against the verified identity's email, GitHub username,
-- or GitHub numeric ID.
--
-- Three storage modes share this schema:
--   - postgres (this table) — DB mode, the recommended path
--   - filesystem — ~/.dollhouse/auth/allowlist.json, fsnotify-watched
--   - in-memory — tests and dev
--
-- Gate behavior is governed by DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED:
--   - false (initial default): empty table = no gate (back-compat)
--   - true: empty table = bootstrap admin only (secure-by-default)
--
-- The bootstrap admin always passes regardless of this setting or
-- table contents (isBootstrapAdminFor check sits in front of the
-- allowlist query) — operators cannot lock themselves out.
--
-- All writes go through MCP-AQL admin commands (roles: ['admin']) or
-- the filesystem file editor. Audit emission is the responsibility of
-- the write path (auth.allowlist_changed → auth_identity_events).
--
-- No RLS — system-internal AS infrastructure, operated only via
-- withSystemContext from the admin role. Matches the convention used
-- by auth_kv, auth_signing_keys, auth_accounts.
--
-- Depends on: 0018_agent_states_session_scope.sql (numerical ordering)

CREATE TABLE IF NOT EXISTS "auth_allowlist" (
  "id"         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"       VARCHAR(32)  NOT NULL,
  "value"      VARCHAR(320) NOT NULL,
  "note"       TEXT,
  "created_by" VARCHAR(320),
  "created_at" TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Restrict `kind` to the three supported identity match keys.
  -- Adding a new kind requires a schema migration AND a corresponding
  -- gate-check branch in the auth methods.
  CONSTRAINT "auth_allowlist_kind_check"
    CHECK ("kind" IN ('email', 'github_username', 'github_id'))
);
--> statement-breakpoint

-- The gate query is "is this (kind, value) on the list?" — every
-- sign-in. Make it O(log n). Unique constraint prevents duplicate
-- entries; the same email can't appear twice.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_auth_allowlist_kind_value"
  ON "auth_allowlist" ("kind", "value");
--> statement-breakpoint

-- Lookup by created_by for "show me entries this admin added" — used
-- by the audit view. Not on the hot path.
CREATE INDEX IF NOT EXISTS "idx_auth_allowlist_created_by"
  ON "auth_allowlist" ("created_by");
