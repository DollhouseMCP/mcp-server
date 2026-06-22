-- Custom migration: visibility-aware Row-Level Security for elements.
-- The `visibility` column has existed since 0000 but has been ignored by
-- RLS — every policy checked ownership only, so a row marked 'public' was
-- still invisible to non-owners. This migration wires the column into RLS
-- and constrains the accepted values at the database layer.
--
-- Depends on: 0004_fts_and_rls.sql
-- Phase 4, Step 4.4 Piece 1

-- ═══════════════════════════════════════════════════════════════════════════
-- CHECK constraint on elements.visibility
-- The Drizzle schema declares varchar(32) with default 'private' but imposes
-- no value constraint, so any app-layer bug could slip arbitrary strings into
-- the column. Constrain the set explicitly. Additional states (e.g. tenant-
-- scoped) would arrive as separate concepts, not new visibility values.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "elements" DROP CONSTRAINT IF EXISTS "elements_visibility_check";
ALTER TABLE "elements" ADD CONSTRAINT "elements_visibility_check"
  CHECK ("visibility" IN ('private', 'public'));

-- ═══════════════════════════════════════════════════════════════════════════
-- Split the single FOR ALL policy into per-operation policies
--
-- Previously: `elements_user_isolation FOR ALL USING (user_id = :me)` — this
-- ignored the visibility column entirely, so public rows were unreachable
-- from other users.
--
-- Now: reads expand to "own OR public"; mutations stay strictly owner-only.
-- Each operation gets its own explicit policy so auditors can read each in
-- isolation rather than reasoning about an omnibus FOR ALL.
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "elements_user_isolation" ON "elements";
DROP POLICY IF EXISTS "elements_select"         ON "elements";
DROP POLICY IF EXISTS "elements_insert"         ON "elements";
DROP POLICY IF EXISTS "elements_update"         ON "elements";
DROP POLICY IF EXISTS "elements_delete"         ON "elements";

-- Read: own rows OR any public row
CREATE POLICY "elements_select" ON "elements" FOR SELECT
  USING (
    "user_id" = current_setting('app.current_user_id', true)::uuid
    OR "visibility" = 'public'
  );

-- Insert: caller may only create rows they own. The WITH CHECK prevents
-- spoofing user_id to impersonate another account.
CREATE POLICY "elements_insert" ON "elements" FOR INSERT
  WITH CHECK (
    "user_id" = current_setting('app.current_user_id', true)::uuid
  );

-- Update: caller may only update rows they own, and may not rewrite user_id
-- to move a row to another owner.
CREATE POLICY "elements_update" ON "elements" FOR UPDATE
  USING (
    "user_id" = current_setting('app.current_user_id', true)::uuid
  )
  WITH CHECK (
    "user_id" = current_setting('app.current_user_id', true)::uuid
  );

-- Delete: caller may only delete rows they own. Cross-user delete attempts
-- match zero rows silently rather than erroring — matches the existing
-- contract other RLS-protected tables follow.
CREATE POLICY "elements_delete" ON "elements" FOR DELETE
  USING (
    "user_id" = current_setting('app.current_user_id', true)::uuid
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- Partial index for cross-user public lookups
--
-- The primary-key lookup in readContent (WHERE id = :uuid) remains O(1), so
-- direct-fetch of a public element by UUID does not need help. This partial
-- index supports future discovery queries of the form:
--   WHERE visibility = 'public' AND element_type = :type
-- where the partial predicate keeps the index small (only public rows) and
-- the (element_type, name) ordering serves both listing and by-name lookups
-- within the public pool.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS "idx_elements_public"
  ON "elements" ("element_type", "name")
  WHERE "visibility" = 'public';
