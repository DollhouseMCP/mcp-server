-- Web console security-admin authentication policy singleton.

CREATE TABLE IF NOT EXISTS "console_auth_policy" (
  "id" INTEGER PRIMARY KEY DEFAULT 1,
  "max_admin_elevation_seconds" INTEGER NOT NULL DEFAULT 300,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "console_auth_policy_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "console_auth_policy_max_admin_elevation_check" CHECK (
    "max_admin_elevation_seconds" >= 60
    AND "max_admin_elevation_seconds" <= 300
  )
);
