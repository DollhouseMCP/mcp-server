-- Custom migration: visibility-aware RLS for element_tags.
-- Mirror of 0005's split on `elements`: tags attached to a public element are
-- readable cross-user (so discovery via list_elements { include_public: true }
-- returns meaningful tag metadata). Mutations remain strictly owner-only.
--
-- Depends on: 0005_visibility_rls.sql
-- Phase 4, Step 4.4 Piece 2 (discovery-flag hardening)

-- ═══════════════════════════════════════════════════════════════════════════
-- Replace the single FOR ALL element_tags policy with per-operation policies
--
-- Previously: `element_tags_user_isolation FOR ALL USING (user_id = :me)` —
-- strict owner-only for every op. This silently returned empty tag arrays
-- for cross-user public elements surfaced by list_elements' include_public
-- flag. Users relying on tags as a trust/search signal would see public
-- elements stripped of their tags with no indication.
--
-- Now: SELECT permits own rows OR rows attached to a public element;
-- INSERT/UPDATE/DELETE remain owner-only. Each operation gets its own
-- explicit policy for auditability.
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "element_tags_user_isolation" ON "element_tags";
DROP POLICY IF EXISTS "element_tags_select"         ON "element_tags";
DROP POLICY IF EXISTS "element_tags_insert"         ON "element_tags";
DROP POLICY IF EXISTS "element_tags_update"         ON "element_tags";
DROP POLICY IF EXISTS "element_tags_delete"         ON "element_tags";

-- Read: own tags OR tags attached to any public element.
-- The EXISTS subquery runs against the `elements` table whose own RLS
-- (elements_select from migration 0005) already restricts to own + public —
-- so this predicate is equivalent to "tags attached to a row I can see."
CREATE POLICY "element_tags_select" ON "element_tags" FOR SELECT
  USING (
    "user_id" = current_setting('app.current_user_id', true)::uuid
    OR EXISTS (
      SELECT 1 FROM "elements"
      WHERE "elements"."id" = "element_tags"."element_id"
        AND "elements"."visibility" = 'public'
    )
  );

-- Write (all forms): owner-only. The WITH CHECK prevents user_id spoofing.
CREATE POLICY "element_tags_insert" ON "element_tags" FOR INSERT
  WITH CHECK (
    "user_id" = current_setting('app.current_user_id', true)::uuid
  );

CREATE POLICY "element_tags_update" ON "element_tags" FOR UPDATE
  USING      ("user_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY "element_tags_delete" ON "element_tags" FOR DELETE
  USING      ("user_id" = current_setting('app.current_user_id', true)::uuid);
