/**
 * Global teardown for integration tests
 *
 * Cleans up filesystem test directories and drops the test database.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

const TEST_BASE_DIR = path.join(process.cwd(), '.test-tmp');
const TEST_DB_NAME = 'dollhousemcp_test';
const ADMIN_URL = 'postgres://dollhouse:dollhouse@localhost:5432/postgres';

export default async function globalTeardown() {
  console.log('\n🧹 Cleaning up integration test environment...\n');

  // Clean up test directories
  try {
    await fs.rm(TEST_BASE_DIR, { recursive: true, force: true });
    console.log('✅ Test directories cleaned up');
  } catch (error) {
    console.error('⚠️  Failed to clean up test directories:', error);
  }

  // Drop test database
  try {
    const pg = await import('postgres');
    const adminSql = pg.default(ADMIN_URL, { max: 1 });
    // Terminate any remaining connections first
    await adminSql.unsafe(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid()
    `);
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await adminSql.end();
    console.log(`✅ Test database '${TEST_DB_NAME}' dropped`);
  } catch {
    // Postgres not available — nothing to clean up
  }

  // Clear test environment variables
  delete process.env.TEST_MODE;
  delete process.env.TEST_BASE_DIR;
  delete process.env.TEST_PERSONAS_DIR;
  delete process.env.TEST_CACHE_DIR;

  console.log('✅ Teardown complete\n');
}