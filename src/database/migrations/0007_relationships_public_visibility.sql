-- Custom migration: visibility-aware RLS for element_relationships.
-- Mirrors 0006's split on element_tags. Relationships attached to a public
-- element become readable cross-user; mutations stay strictly owner-only.
--
-- Without this change, any code path that surfaces relationships for a
-- cross-user public element (ensemble membership, agent activates-template
-- lookups, cross-element references in discovery surfaces, etc.) would
-- silently return an empty array — the same class of silent-empty bug that
-- 0005 fixed for elements and 0006 fixed for element_tags.
--
-- Depends on: 0006_tags_public_visibility.sql
-- Phase 4, Step 4.4 Piece 2 (discovery-flag hardening, relationship parity)

-- ═══════════════════════════════════════════════════════════════════════════
-- Replace the single FOR ALL element_relationships policy with per-operation
-- policies mirroring the 0005 / 0006 pattern.
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "element_relationships_user_isolation" ON "element_relationships";
DROP POLICY IF EXISTS "element_relationships_select"         ON "element_relationships";
DROP POLICY IF EXISTS "element_relationships_insert"         ON "element_relationships";
DROP POLICY IF EXISTS "element_relationships_update"         ON "element_relationships";
DROP POLICY IF EXISTS "element_relationships_delete"         ON "element_relationships";

-- Read: own relationships OR relationships whose source element is public.
-- The EXISTS subquery hits the `elements` table, whose own elements_select
-- policy (from 0005) restricts visible rows to own + public — so this
-- predicate is equivalent to "relationships attached to a row I can see."
-- Note: we gate on the SOURCE element's visibility (source_id), not the
-- target's — a public element's outbound references are part of its public
-- surface; a private element's references remain private regardless of
-- where they point.
CREATE POLICY "element_relationships_select" ON "element_relationships" FOR SELECT
  USING (
    "user_id" = current_setting('app.current_user_id', true)::uuid
    OR EXISTS (
      SELECT 1 FROM "elements"
      WHERE "elements"."id" = "element_relationships"."source_id"
        AND "elements"."visibility" = 'public'
    )
  );

-- Write (all forms): owner-only. WITH CHECK prevents user_id spoofing.
CREATE POLICY "element_relationships_insert" ON "element_relationships" FOR INSERT
  WITH CHECK (
    "user_id" = current_setting('app.current_user_id', true)::uuid
  );

CREATE POLICY "element_relationships_update" ON "element_relationships" FOR UPDATE
  USING      ("user_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY "element_relationships_delete" ON "element_relationships" FOR DELETE
  USING      ("user_id" = current_setting('app.current_user_id', true)::uuid);
