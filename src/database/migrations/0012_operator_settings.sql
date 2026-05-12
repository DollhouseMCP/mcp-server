-- Phase 4.5 storage completion — Phase A.
--
-- operator_settings holds per-host / operator-level configuration: settings
-- that belong to the deployment as a whole, not to any individual user.
-- Singleton row enforced by check constraint on `id = 1`.
--
-- DB-backed sections (matches the per-host classification in the
-- ConfigManager surface review):
--   enhanced_index_config — elements.enhanced_index.* (limits, telemetry,
--                           verbPatterns, backgroundAnalysis, resources)
--   console_config        — console.port (web console bind port)
--   license_config        — license.* (commercial tier + attestation)
--   defaults_config       — elements.default_element_dir, schema version
--
-- No RLS — operator-level data, accessed only by the AS via system context.
-- App role has DML via ALTER DEFAULT PRIVILEGES from init-db.sql; no extra
-- grants required.
--
-- Authored manually (drizzle-kit generate is currently broken on this
-- branch; the §8.1 migrations 0009/0010/0011 follow the same convention).
--
-- Depends on: 0011_auth_kv_grant_id_index.sql

-- ═══════════════════════════════════════════════════════════════════════════
-- operator_settings — singleton row of per-host configuration.
--
-- The CHECK (id = 1) constraint enforces that this table can never have
-- more than one row, so consumers can `SELECT ... LIMIT 1` and rely on
-- finding either the operator config or nothing (first start).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "operator_settings" (
  "id"                     SMALLINT     PRIMARY KEY DEFAULT 1,
  "enhanced_index_config"  JSONB        NOT NULL DEFAULT '{}'::jsonb,
  "console_config"         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  "license_config"         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  "defaults_config"        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  "config_version"         INTEGER      NOT NULL DEFAULT 1,
  "created_at"             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "updated_at"             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT "operator_settings_singleton" CHECK ("id" = 1)
);
