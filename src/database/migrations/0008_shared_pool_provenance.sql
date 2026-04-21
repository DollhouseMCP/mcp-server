-- Custom migration: element_provenance table + SYSTEM user for the shared pool.
-- Provides provenance tracking for shared-pool elements (origin, source URL,
-- content hash, version, fork lineage) and a dedicated SYSTEM user identity
-- that owns shared/public elements in DB mode.
--
-- Depends on: 0007_relationships_public_visibility.sql
-- Phase 4, Step 4.6 (Shared Public Element Pool)

-- ═══════════════════════════════════════════════════════════════════════════
-- SYSTEM user — the deployment-scoped identity that owns shared-pool elements.
--
-- Pinned UUID so every deployment agrees on the identity and application code
-- can reference it as a constant. The username 'dollhousemcp-system' is
-- recognizable in queries and logs. INSERT ... ON CONFLICT DO NOTHING makes
-- this idempotent across re-runs (migrations may replay on fresh DBs).
--
-- The SYSTEM user is NOT a regular user — it has no auth credentials, no
-- settings row, and no session. It exists solely as the FK target for
-- shared-pool element rows. The app role can read this row (via the
-- users_select RLS policy) but cannot create or modify it — only the admin
-- role used for migrations and bootstrap can write to the users table.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO "users" ("id", "username", "display_name")
VALUES ('00000000-0000-0000-0000-000000000001', 'dollhousemcp-system', 'DollhouseMCP System')
ON CONFLICT ("id") DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- element_provenance — side table for shared-pool metadata.
--
-- Deliberately separate from the `elements` table so the feature is
-- schema-modular: dropping the shared-pool feature means dropping this
-- table and the SYSTEM user row; the `elements` table is untouched.
--
-- The canonical identity within a deployment is (origin, source_url,
-- source_version). This triple is UNIQUE so duplicate installs are
-- detected at the DB level, not just in application code.
--
-- content_hash stores the SHA-256 hex digest of the raw element content
-- at install time. Subsequent installs with the same canonical identity
-- must match this hash — a mismatch indicates tampering or re-publishing.
--
-- forked_from links fork provenance back to the shared original. It is
-- populated only when origin='fork'; for collection and deployment_seed
-- origins it is NULL. The FK is ON DELETE SET NULL rather than CASCADE
-- because deleting a shared element should not silently delete users'
-- forks — the fork stands on its own as user-owned content.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "element_provenance" (
  "element_id"     uuid        NOT NULL PRIMARY KEY
                               REFERENCES "elements"("id") ON DELETE CASCADE,
  "origin"         varchar(32) NOT NULL,
  "source_url"     text,
  "source_version" varchar(128),
  "content_hash"   char(64)    NOT NULL,
  "forked_from"    uuid        REFERENCES "elements"("id") ON DELETE SET NULL,
  "installed_at"   timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT "element_provenance_origin_check"
    CHECK ("origin" IN ('collection', 'deployment_seed', 'fork')),

  CONSTRAINT "element_provenance_fork_requires_forked_from"
    CHECK ("origin" != 'fork' OR "forked_from" IS NOT NULL)
);

-- Canonical identity: one record per (origin, source_url, source_version).
-- NULL-safe: two NULLs in the same column are treated as distinct by
-- PostgreSQL's UNIQUE constraint, which is correct here — a deployment
-- seed with no source_url is a different canonical identity from another
-- seed with no source_url (they're distinguished by element_id, which is
-- the PK). The UNIQUE constraint prevents duplicate installs for the
-- same versioned source.
--
-- Partial: only enforced when source_url IS NOT NULL, since NULL source_url
-- entries (local seeds without a URL) are inherently distinct by PK.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_provenance_canonical"
  ON "element_provenance" ("origin", "source_url", "source_version")
  WHERE "source_url" IS NOT NULL;

-- Lookup by origin — used by DeploymentSeedLoader for orphan detection
-- and by administrative queries.
CREATE INDEX IF NOT EXISTS "idx_provenance_origin"
  ON "element_provenance" ("origin");

-- Lookup by forked_from — used to find all forks of a shared element
-- (e.g. for upgrade notification: "your fork is based on v1.0, v1.1 is
-- available").
CREATE INDEX IF NOT EXISTS "idx_provenance_forked_from"
  ON "element_provenance" ("forked_from")
  WHERE "forked_from" IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS for element_provenance
--
-- Provenance is read-through: if you can see the element (via elements_select
-- policy: own OR public), you can see its provenance. Writes are restricted
-- to the admin role — the app role never writes provenance directly; the
-- SharedPoolInstaller uses withSystemContext() to bypass RLS for the narrow
-- admin-elevated code path.
--
-- We enable RLS and create a permissive SELECT policy. The absence of
-- INSERT/UPDATE/DELETE policies for the app role means those operations
-- are denied by default (RLS default-deny). The admin/superuser role
-- bypasses RLS entirely via BYPASSRLS.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "element_provenance" ENABLE ROW LEVEL SECURITY;

-- Force RLS even for the table owner (defense-in-depth). The admin role
-- bypasses via BYPASSRLS attribute, not via table ownership.
ALTER TABLE "element_provenance" FORCE ROW LEVEL SECURITY;

-- Read: visible if the element itself is visible (own or public).
-- Delegates visibility to the elements table's RLS policy, so provenance
-- access tracks element access automatically.
CREATE POLICY "element_provenance_select" ON "element_provenance" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "elements"
      WHERE "elements"."id" = "element_provenance"."element_id"
    )
  );
