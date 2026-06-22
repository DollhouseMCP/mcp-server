-- DollhouseMCP Database Initialization
--
-- Creates the application role (non-superuser) used by the running server.
-- The superuser 'dollhouse' is used only for migrations and admin tasks.
--
-- This script runs automatically on first container startup via
-- the /docker-entrypoint-initdb.d/ mount in docker-compose.db.yml.
--
-- Two-role architecture:
--   dollhouse      (superuser)  — migrations, DDL, admin
--   dollhouse_app  (app role)   — application queries, RLS enforced
--
-- Principle of least privilege: app role gets only SELECT, INSERT, UPDATE, DELETE.
-- No TRUNCATE, TRIGGER, REFERENCES, or schema modification.

-- Create application role (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dollhouse_app') THEN
    CREATE ROLE dollhouse_app WITH LOGIN PASSWORD 'dollhouse_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- Grant connect and schema usage
GRANT CONNECT ON DATABASE dollhousemcp TO dollhouse_app;
GRANT USAGE ON SCHEMA public TO dollhouse_app;

-- Grant DML-only on all current and future tables (no TRUNCATE, TRIGGER, REFERENCES)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dollhouse_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dollhouse_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dollhouse_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO dollhouse_app;

-- Explicit write-deny on `users` for the app role.
-- Defense-in-depth: migration 0004 applies `users_self_read` (FOR SELECT only)
-- under FORCE ROW LEVEL SECURITY, so writes already fail at the policy check.
-- This REVOKE makes the boundary structural rather than policy-dependent —
-- even if a future migration accidentally adds a `FOR ALL` policy on `users`,
-- the app role still cannot INSERT/UPDATE/DELETE. Identity writes MUST go
-- through the admin role via DatabaseBootstrap (see src/database/bootstrap.ts).
REVOKE INSERT, UPDATE, DELETE ON TABLE users FROM dollhouse_app;

-- Grant read-only access to drizzle migration tracking schema
-- (app role should not modify migration state)
DO $$
BEGIN
  EXECUTE 'GRANT USAGE ON SCHEMA drizzle TO dollhouse_app';
  EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO dollhouse_app';
EXCEPTION WHEN invalid_schema_name THEN
  NULL; -- drizzle schema created later by migration tool
END
$$;
