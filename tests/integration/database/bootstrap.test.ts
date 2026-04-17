/**
 * Integration tests for database bootstrap.
 * Tests user creation and idempotency against real Docker PostgreSQL.
 */

import os from 'node:os';
import { eq } from 'drizzle-orm';
import { bootstrapDatabase } from '../../../src/database/bootstrap.js';
import { createDatabaseConnection } from '../../../src/database/connection.js';
import { users } from '../../../src/database/schema/users.js';
import { isDatabaseAvailable } from './test-db-helpers.js';

let dbAvailable = false;

const TEST_DB_URL = process.env.DOLLHOUSE_DATABASE_URL
  ?? 'postgres://dollhouse_app:dollhouse_app@localhost:5432/dollhousemcp';
const TEST_DB_ADMIN_URL = process.env.DOLLHOUSE_DATABASE_ADMIN_URL
  ?? 'postgres://dollhouse:dollhouse@localhost:5432/dollhousemcp';

const bootstrapConfig = {
  connectionUrl: TEST_DB_URL,
  adminConnectionUrl: TEST_DB_ADMIN_URL,
  poolSize: 2,
  ssl: 'disable' as const,
};

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    console.warn('Skipping bootstrap tests — PostgreSQL not available');
  }
});

afterAll(async () => {
  // Clean up bootstrap user via admin connection (users is RLS-protected).
  if (dbAvailable) {
    let osUsername: string;
    try {
      osUsername = os.userInfo().username || 'local';
    } catch {
      osUsername = 'local';
    }
    const adminConn = createDatabaseConnection({
      connectionUrl: TEST_DB_ADMIN_URL,
      poolSize: 2,
      ssl: 'disable',
    });
    try {
      await adminConn.db.delete(users).where(eq(users.username, osUsername));
    } finally {
      await adminConn.close();
    }
  }
});

describe('bootstrapDatabase', () => {
  it('should create a database connection and bootstrap user', async () => {
    if (!dbAvailable) return;

    const result = await bootstrapDatabase(bootstrapConfig);

    expect(result.db).toBeDefined();
    expect(result.connection).toBeDefined();
    expect(typeof result.connection.close).toBe('function');
    expect(result.userId).toBeTruthy();
    // UUID format
    expect(result.userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    await result.connection.close();
  });

  it('should return the same userId on repeated calls (idempotent)', async () => {
    if (!dbAvailable) return;

    const result1 = await bootstrapDatabase(bootstrapConfig);
    const result2 = await bootstrapDatabase(bootstrapConfig);

    expect(result1.userId).toBe(result2.userId);

    await result1.connection.close();
    await result2.connection.close();
  });
});
