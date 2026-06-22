-- Phase 4.5 storage completion — Phase C.
--
-- shared_cache holds operator-shared, network-fetched cache entries that
-- are not per-user. First consumer is the public collection-catalog cache
-- (today: ~/.dollhouse/cache/collection-index.json on filesystem; this
-- table replaces that in DB-backend mode).
--
-- cache_key is the only identifying field — natural primary key that lets
-- consumers store multiple cache types in one table (e.g. 'collection-index',
-- 'remote-element-source-XYZ') without joining.
--
-- HTTP conditional-refresh fields (etag, last_modified) let consumers
-- issue If-None-Match / If-Modified-Since requests on refresh.
--
-- TTL-based invalidation via expires_at — caller decides per entry; null
-- means no expiry (refresh purely on demand).
--
-- No RLS — operator-shared resource. App role has DML via ALTER DEFAULT
-- PRIVILEGES from init-db.sql.
--
-- Depends on: 0013_user_settings_extension.sql (numerical ordering only)

CREATE TABLE IF NOT EXISTS "shared_cache" (
  "cache_key"     VARCHAR(128) PRIMARY KEY,
  "payload"       JSONB        NOT NULL,
  "etag"          TEXT,
  "last_modified" TEXT,
  "version"       TEXT,
  "checksum"      TEXT,
  "fetched_at"    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "expires_at"    TIMESTAMPTZ
);
--> statement-breakpoint

-- Partial index for the "what's stale" sweep — let the future
-- cleanup task efficiently find expired entries without scanning
-- the whole table.
CREATE INDEX IF NOT EXISTS "idx_shared_cache_expires_at"
  ON "shared_cache" ("expires_at")
  WHERE "expires_at" IS NOT NULL;
