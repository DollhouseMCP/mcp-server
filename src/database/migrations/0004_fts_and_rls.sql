-- Custom migration: Full-Text Search vector and Row-Level Security policies
-- These PostgreSQL-specific features are not expressible in Drizzle schema
-- and must be applied via raw SQL after all Drizzle-generated migrations.
--
-- Depends on: 0003_flat_rattler.sql (adds user_id to element_tags and element_relationships)
-- Phase 4, Steps 4.1–4.3

-- ═══════════════════════════════════════════════════════════════════════════
-- Full-Text Search (FTS)
-- Uses body_content (markdown after frontmatter) to avoid YAML noise.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'elements' AND column_name = 'fts_vector'
  ) THEN
    ALTER TABLE "elements" ADD COLUMN "fts_vector" TSVECTOR
      GENERATED ALWAYS AS (
        to_tsvector('english',
          COALESCE("name", '') || ' ' ||
          COALESCE("description", '') || ' ' ||
          COALESCE("body_content", ''))
      ) STORED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_elements_fts" ON "elements" USING GIN ("fts_vector");

-- ═══════════════════════════════════════════════════════════════════════════
-- Row-Level Security (RLS)
-- Enforces per-user data isolation at the database level.
-- FORCE ROW LEVEL SECURITY ensures even table owners obey policies.
-- Application sets user context via: set_config('app.current_user_id', $1, true)
--
-- The current_setting() calls pass `true` as the second argument (missing_ok)
-- so a session that forgot to set the context returns NULL rather than raising
-- an error — NULL then fails every `= user_id` comparison and the row stays
-- invisible. This is fail-secure.
-- ═══════════════════════════════════════════════════════════════════════════

-- Helper: drop-and-recreate the policy so amendments to this migration
-- (e.g. tightening the USING clause or switching FOR ALL → FOR SELECT)
-- actually take effect on environments that already applied an earlier
-- version of 0004. A previous IF NOT EXISTS variant silently skipped
-- stale policies, letting environments drift.
CREATE OR REPLACE FUNCTION _upsert_policy(
  p_table TEXT, p_name TEXT, p_using TEXT
) RETURNS VOID AS $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_name, p_table);
  EXECUTE format('CREATE POLICY %I ON %I USING (%s)', p_name, p_table, p_using);
END;
$$ LANGUAGE plpgsql;

-- Same helper, but creates a SELECT-only policy. Used for tables where the
-- app role should be able to read its own row but write paths go through the
-- admin role (e.g. `users`).
CREATE OR REPLACE FUNCTION _upsert_policy_select(
  p_table TEXT, p_name TEXT, p_using TEXT
) RETURNS VOID AS $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_name, p_table);
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', p_name, p_table, p_using);
END;
$$ LANGUAGE plpgsql;

-- Elements
ALTER TABLE "elements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "elements" FORCE ROW LEVEL SECURITY;
SELECT _upsert_policy('elements', 'elements_user_isolation',
  '"user_id" = current_setting(''app.current_user_id'', true)::uuid');

-- Memory entries
ALTER TABLE "memory_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memory_entries" FORCE ROW LEVEL SECURITY;
SELECT _upsert_policy('memory_entries', 'memory_entries_user_isolation',
  '"user_id" = current_setting(''app.current_user_id'', true)::uuid');

-- Ensemble members
ALTER TABLE "ensemble_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ensemble_members" FORCE ROW LEVEL SECURITY;
SELECT _upsert_policy('ensemble_members', 'ensemble_members_user_isolation',
  '"user_id" = current_setting(''app.current_user_id'', true)::uuid');

-- Agent states
ALTER TABLE "agent_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_states" FORCE ROW LEVEL SECURITY;
SELECT _upsert_policy('agent_states', 'agent_states_user_isolation',
  '"user_id" = current_setting(''app.current_user_id'', true)::uuid');

-- User settings
ALTER TABLE "user_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_settings" FORCE ROW LEVEL SECURITY;
SELECT _upsert_policy('user_settings', 'user_settings_isolation',
  '"user_id" = current_setting(''app.current_user_id'', true)::uuid');

-- Sessions
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
SELECT _upsert_policy('sessions', 'sessions_user_isolation',
  '"user_id" = current_setting(''app.current_user_id'', true)::uuid');

-- Element tags
ALTER TABLE "element_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "element_tags" FORCE ROW LEVEL SECURITY;
SELECT _upsert_policy('element_tags', 'element_tags_user_isolation',
  '"user_id" = current_setting(''app.current_user_id'', true)::uuid');

-- Element relationships
ALTER TABLE "element_relationships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "element_relationships" FORCE ROW LEVEL SECURITY;
SELECT _upsert_policy('element_relationships', 'element_relationships_user_isolation',
  '"user_id" = current_setting(''app.current_user_id'', true)::uuid');

-- Users: self-row SELECT only. Without RLS, the app role could enumerate every
-- username/email/externalId in the system (PII leak under multi-tenant). Writes
-- to this table happen during DatabaseBootstrap via the admin role (see
-- src/database/bootstrap.ts), so limiting the app-role policy to FOR SELECT
-- keeps the surface minimal while still letting users see their own row.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
SELECT _upsert_policy_select('users', 'users_self_read',
  '"id" = current_setting(''app.current_user_id'', true)::uuid');

-- Clean up helper functions
DROP FUNCTION IF EXISTS _upsert_policy;
DROP FUNCTION IF EXISTS _upsert_policy_select;

-- ═══════════════════════════════════════════════════════════════════════════
-- Reverse-lookup index: (user_id, target_name, target_type)
--
-- Replaces the older (target_name, target_type) index created in 0000. The old
-- index answered "who references this target?" but scanned across all tenants
-- before RLS filtered. The new user-leading composite lets every reverse
-- lookup sit on a single user's slice of the table and also subsumes the
-- (user_id) leading-column queries, keeping index count the same.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS "idx_relationships_user_target"
  ON "element_relationships" ("user_id", "target_name", "target_type");

-- Old (target_name, target_type) index — superseded by the user-leading composite
DROP INDEX IF EXISTS "idx_relationships_target";
-- Old (user_id) single-column index — redundant under the new composite's leading prefix
DROP INDEX IF EXISTS "idx_relationships_user";
