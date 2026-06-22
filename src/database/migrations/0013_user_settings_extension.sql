-- Phase 4.5 storage completion — Phase B.
--
-- Extends user_settings (created in 0000, identity columns dropped in 0001,
-- RLS enabled in 0004) with five new jsonb sections so it can hold the
-- full per-user ConfigManager surface — not just the four sections that
-- were scaffolded in Phase 4 and never wired:
--
--   wizard_config          — wizard.* setup-wizard state per user
--   display_config         — display.* UI preferences (indicators, verbose
--                            logging, progress display)
--   collection_config      — collection.* (auto_submit, require_review,
--                            add_attribution)
--   auto_activate_config   — elements.auto_activate.* per-user activation
--                            lists (personas, skills, templates, agents,
--                            memories, ensembles)
--   source_priority_config — element source preference order (local,
--                            github, collection)
--
-- All default to '{}'::jsonb NOT NULL so existing rows stay valid without
-- backfill. The RLS policy from 0004 (`user_settings_isolation`, scoped
-- on `current_setting('app.current_user_id')`) continues to apply — same
-- table, same enforcement, just additional columns.
--
-- Existing four columns (github_config, sync_config, autoload_config,
-- retention_config) remain untouched.
--
-- Depends on: 0012_operator_settings.sql (numerical ordering only),
--             0000 (table existence), 0004 (RLS policy)

ALTER TABLE "user_settings"
  ADD COLUMN IF NOT EXISTS "wizard_config"          JSONB NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "user_settings"
  ADD COLUMN IF NOT EXISTS "display_config"         JSONB NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "user_settings"
  ADD COLUMN IF NOT EXISTS "collection_config"      JSONB NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "user_settings"
  ADD COLUMN IF NOT EXISTS "auto_activate_config"   JSONB NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "user_settings"
  ADD COLUMN IF NOT EXISTS "source_priority_config" JSONB NOT NULL DEFAULT '{}'::jsonb;
