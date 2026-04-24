/**
 * Global setup for integration tests
 *
 * Creates filesystem test directories AND (if Postgres is reachable)
 * a dedicated test database so integration tests never touch live data.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// Test directories
export const TEST_BASE_DIR = path.join(process.cwd(), '.test-tmp');
export const TEST_PERSONAS_DIR = path.join(TEST_BASE_DIR, 'personas');
export const TEST_CACHE_DIR = path.join(TEST_BASE_DIR, 'cache');

// Test database — separate from the live dollhousemcp database
const TEST_DB_NAME = 'dollhousemcp_test';
const ADMIN_URL = 'postgres://dollhouse:dollhouse@localhost:5432/postgres';
const TEST_DB_ADMIN_URL = `postgres://dollhouse:dollhouse@localhost:5432/${TEST_DB_NAME}`;

export default async function globalSetup() {
  console.log('\n🔧 Setting up integration test environment...\n');

  // ── Filesystem setup ────────────────────────────────────────────
  try {
    await fs.rm(TEST_BASE_DIR, { recursive: true, force: true });
  } catch {
    // Directory might not exist
  }

  await fs.mkdir(TEST_BASE_DIR, { recursive: true });
  await fs.mkdir(TEST_PERSONAS_DIR, { recursive: true });
  await fs.mkdir(TEST_CACHE_DIR, { recursive: true });

  process.env.TEST_MODE = 'integration';
  process.env.TEST_BASE_DIR = TEST_BASE_DIR;
  process.env.TEST_PERSONAS_DIR = TEST_PERSONAS_DIR;
  process.env.TEST_CACHE_DIR = TEST_CACHE_DIR;

  console.log(`✅ Test directories created at: ${TEST_BASE_DIR}`);

  // ── Test database setup ─────────────────────────────────────────
  // Uses dynamic import so postgres.js stays out of the static graph
  // when the database isn't reachable (CI without Docker, local dev
  // without Postgres, etc.).
  try {
    const pg = await import('postgres');
    const adminSql = pg.default(ADMIN_URL, { max: 1 });

    // Create test database (idempotent)
    await adminSql.unsafe(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid()
    `);
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME} OWNER dollhouse`);
    await adminSql.end();

    // Run init-db.sql grants on the test database
    const testSql = pg.default(TEST_DB_ADMIN_URL, { max: 1 });

    // Create app role if not exists (shared across databases)
    await testSql.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dollhouse_app') THEN
          CREATE ROLE dollhouse_app WITH LOGIN PASSWORD 'dollhouse_app'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
      END $$
    `);
    await testSql.unsafe(`GRANT CONNECT ON DATABASE ${TEST_DB_NAME} TO dollhouse_app`);
    await testSql.unsafe(`GRANT USAGE ON SCHEMA public TO dollhouse_app`);
    await testSql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dollhouse_app`);
    await testSql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dollhouse_app`);
    await testSql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dollhouse_app`);
    await testSql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO dollhouse_app`);
    await testSql.end();

    // Run Drizzle migrations on the test database
    const { execSync } = await import('node:child_process');
    execSync(
      `DOLLHOUSE_DATABASE_ADMIN_URL="${TEST_DB_ADMIN_URL}" npx drizzle-kit migrate`,
      { stdio: 'pipe', cwd: process.cwd(), timeout: 30000 },
    );

    // Re-run grants after migrations (tables now exist)
    const postMigSql = pg.default(TEST_DB_ADMIN_URL, { max: 1 });
    await postMigSql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dollhouse_app`);
    await postMigSql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dollhouse_app`);
    await postMigSql.unsafe(`REVOKE INSERT, UPDATE, DELETE ON TABLE users FROM dollhouse_app`);
    await postMigSql.unsafe(`
      DO $$ BEGIN
        EXECUTE 'GRANT USAGE ON SCHEMA drizzle TO dollhouse_app';
        EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO dollhouse_app';
      EXCEPTION WHEN invalid_schema_name THEN NULL;
      END $$
    `);
    await postMigSql.end();

    console.log(`✅ Test database '${TEST_DB_NAME}' created and migrated`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  Test database setup skipped (Postgres not available: ${msg})`);
    console.warn('   DB integration tests will skip gracefully.\n');
  }

  console.log('✅ Integration test environment ready\n');
}