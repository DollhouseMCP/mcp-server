-- Custom migration: §8.1 auth tables.
--
-- Three tables backing the embedded authorization server. All AS-internal
-- state — operated only via withSystemContext from the admin role; no
-- per-user RLS on these tables (system data, not tenant data).
--
-- Authored manually because drizzle-kit generate is currently broken on
-- this branch (parser issue in drizzle-orm/drizzle-kit version pair). The
-- shape exactly mirrors src/database/schema/auth.ts.
--
-- Depends on: 0008_shared_pool_provenance.sql
-- §8.1 Storage Phase 1.4

-- ═══════════════════════════════════════════════════════════════════════════
-- auth_accounts — OAuth identity mapping (must-fix #18)
--
-- Primary key is composite (provider, external_sub) per spec §8.1 line 933.
-- `sub` is the JWT-friendly derived form (`${provider}_${externalSub}`),
-- uniquely indexed for fast getAccount(sub) lookups.
--
-- Optional FK to canonical Phase 4 users table; nullable so the OAuth
-- identity record can exist before a Phase 4 user record is created
-- (e.g. between processCallback and the first interactionFinished login).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "auth_accounts" (
  "provider"       VARCHAR(64)  NOT NULL,
  "external_sub"   VARCHAR(255) NOT NULL,
  "sub"            VARCHAR(320) NOT NULL,
  "user_id"        UUID         REFERENCES "users"("id") ON DELETE SET NULL,
  "email"          VARCHAR(255),
  "email_verified" BOOLEAN      NOT NULL DEFAULT FALSE,
  "display_name"   VARCHAR(255),
  "raw_profile"    JSONB,
  "password_hash"  TEXT,
  "last_auth_at"   BIGINT,
  "created_at"     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "updated_at"     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("provider", "external_sub")
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_auth_accounts_sub"     ON "auth_accounts" ("sub");--> statement-breakpoint
CREATE INDEX        IF NOT EXISTS "idx_auth_accounts_user_id" ON "auth_accounts" ("user_id");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- auth_identity_events — append-only audit log (must-fix #21).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "auth_identity_events" (
  "id"           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "type"         VARCHAR(128) NOT NULL,
  "sub"          VARCHAR(320),
  "provider"     VARCHAR(64),
  "external_sub" VARCHAR(255),
  "details"      JSONB,
  "timestamp"    BIGINT       NOT NULL,
  "created_at"   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_auth_events_type"      ON "auth_identity_events" ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auth_events_sub"       ON "auth_identity_events" ("sub");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auth_events_timestamp" ON "auth_identity_events" ("timestamp");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- auth_kv — oidc-provider Adapter-shaped K/V state.
--
-- Composite PK so different oidc-provider models can share an id without
-- collision (matches the in-memory/filesystem backends' `model|id` keying).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "auth_kv" (
  "model"      VARCHAR(64)  NOT NULL,
  "id"         VARCHAR(255) NOT NULL,
  "payload"    JSONB        NOT NULL,
  "expires_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("model", "id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_auth_kv_expires" ON "auth_kv" ("expires_at");--> statement-breakpoint

-- Partial expression indexes that replace the in-memory linear scans for
-- genericFindByUid (Session by uid) and findGrantsByAccountId (Grant by
-- accountId). Drizzle doesn't express partial-expression indexes natively;
-- defined here so the queries the storage layer issues are O(log n).

CREATE INDEX IF NOT EXISTS "idx_auth_kv_session_uid"
  ON "auth_kv" (((payload ->> 'uid')))
  WHERE "model" = 'Session';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_auth_kv_grant_account"
  ON "auth_kv" (((payload ->> 'accountId')))
  WHERE "model" = 'Grant';
