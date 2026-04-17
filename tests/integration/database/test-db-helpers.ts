/**
 * Database Integration Test Helpers
 *
 * Shared setup/teardown for integration tests that run against
 * the Docker PostgreSQL instance.
 *
 * Requires:
 * - DOLLHOUSE_DATABASE_URL env var set (defaults to Docker dev instance)
 * - Docker Postgres running: docker compose -f docker/docker-compose.db.yml up -d
 *
 * @since v2.2.0 — Phase 4, Step 4.3
 */

import { sql, eq } from 'drizzle-orm';
import { createDatabaseConnection, type DatabaseInstance } from '../../../src/database/connection.js';
import { users } from '../../../src/database/schema/users.js';
import { sessions } from '../../../src/database/schema/sessions.js';
import { elements } from '../../../src/database/schema/elements.js';
import { agentStates } from '../../../src/database/schema/agents.js';
import type { UserIdResolver } from '../../../src/database/UserContext.js';

/**
 * Storage-layer test convenience: convert a fixed userId to a resolver. The
 * production code path resolves userId per-call from ContextTracker, but
 * integration tests that construct a storage layer directly can just pin it.
 */
export function fixedUserId(userId: string): UserIdResolver {
  return () => userId;
}

// Use the application role (non-superuser) so RLS policies are enforced.
// The superuser 'dollhouse' bypasses RLS unconditionally.
const TEST_DB_URL = process.env.DOLLHOUSE_DATABASE_URL
  ?? 'postgres://dollhouse_app:dollhouse_app@localhost:5432/dollhousemcp';

// Admin URL used for identity writes (users table is RLS-protected and the
// app role only has self-read access). Admin role bypasses RLS so test user
// creation works before any user context can be set.
const TEST_DB_ADMIN_URL = process.env.DOLLHOUSE_DATABASE_ADMIN_URL
  ?? 'postgres://dollhouse:dollhouse@localhost:5432/dollhousemcp';

let dbConnection: ReturnType<typeof createDatabaseConnection> | null = null;
let adminConnection: ReturnType<typeof createDatabaseConnection> | null = null;
let testUserIdA: string | null = null;
let testUserIdB: string | null = null;

/**
 * Get or create a database connection for integration tests.
 * Reuses a single connection across all tests in a suite.
 */
export function getTestDb(): DatabaseInstance {
  if (!dbConnection) {
    dbConnection = createDatabaseConnection({
      connectionUrl: TEST_DB_URL,
      poolSize: 5,
      ssl: 'disable',
    });
  }
  return dbConnection.db;
}

/** Get or create an admin connection for identity bootstrap. */
function getAdminDb(): DatabaseInstance {
  if (!adminConnection) {
    adminConnection = createDatabaseConnection({
      connectionUrl: TEST_DB_ADMIN_URL,
      poolSize: 2,
      ssl: 'disable',
    });
  }
  return adminConnection.db;
}

/**
 * Ensure a test user exists and return its UUID.
 * Creates user with given username if not present. Runs via the admin
 * connection because users is RLS-protected (self_read only for app role).
 */
async function ensureUser(username: string): Promise<string> {
  const db = getAdminDb();
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (existing[0]) {
    return existing[0].id;
  }

  const inserted = await db
    .insert(users)
    .values({ username, displayName: `Test User (${username})` })
    .returning({ id: users.id });

  return inserted[0].id;
}

/** Primary test user (used by most tests). */
export async function ensureTestUser(): Promise<string> {
  if (!testUserIdA) {
    testUserIdA = await ensureUser('test-integration-a');
  }
  return testUserIdA;
}

/** Secondary test user (used for RLS isolation tests). */
export async function ensureTestUserB(): Promise<string> {
  if (!testUserIdB) {
    testUserIdB = await ensureUser('test-integration-b');
  }
  return testUserIdB;
}

/**
 * Clean up test sessions for the primary test user.
 * Uses withUserContext for FORCE ROW LEVEL SECURITY compatibility.
 */
export async function cleanupTestSessions(): Promise<void> {
  if (!testUserIdA) return;
  const { withUserContext } = await import('../../../src/database/rls.js');
  const db = getTestDb();
  await withUserContext(db, testUserIdA, async (tx) => {
    await tx.delete(sessions).where(eq(sessions.userId, testUserIdA!));
  });
}

/**
 * Clean up test elements for a given user.
 * Uses withUserContext for FORCE ROW LEVEL SECURITY compatibility.
 */
export async function cleanupTestElements(userId: string): Promise<void> {
  const { withUserContext } = await import('../../../src/database/rls.js');
  const db = getTestDb();
  await withUserContext(db, userId, async (tx) => {
    await tx.delete(elements).where(eq(elements.userId, userId));
  });
}

/**
 * Clean up agent states for a given user.
 * Uses withUserContext for FORCE ROW LEVEL SECURITY compatibility.
 */
export async function cleanupTestAgentStates(userId: string): Promise<void> {
  const { withUserContext } = await import('../../../src/database/rls.js');
  const db = getTestDb();
  await withUserContext(db, userId, async (tx) => {
    await tx.delete(agentStates).where(eq(agentStates.userId, userId));
  });
}

/**
 * Clean up ALL test data for both test users.
 * Uses withUserContext because FORCE ROW LEVEL SECURITY requires
 * a user context even for DELETE operations.
 */
export async function cleanupAllTestData(): Promise<void> {
  const { withUserContext } = await import('../../../src/database/rls.js');
  const db = getTestDb();
  if (testUserIdA) {
    await withUserContext(db, testUserIdA, async (tx) => {
      await tx.delete(elements).where(eq(elements.userId, testUserIdA));
      await tx.delete(sessions).where(eq(sessions.userId, testUserIdA));
    });
  }
  if (testUserIdB) {
    await withUserContext(db, testUserIdB, async (tx) => {
      await tx.delete(elements).where(eq(elements.userId, testUserIdB));
      await tx.delete(sessions).where(eq(sessions.userId, testUserIdB));
    });
  }
}

/**
 * Close the database connection pool.
 * Call in afterAll of the outermost describe block.
 */
export async function closeTestDb(): Promise<void> {
  if (dbConnection) {
    await dbConnection.close();
    dbConnection = null;
  }
  if (adminConnection) {
    await adminConnection.close();
    adminConnection = null;
  }
  testUserIdA = null;
  testUserIdB = null;
}

/**
 * Check if the database is reachable. Use in beforeAll to skip
 * tests gracefully when Postgres isn't running.
 */
export async function isDatabaseAvailable(): Promise<boolean> {
  try {
    const db = getTestDb();
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a minimal valid skill element YAML content for testing.
 */
export function buildSkillContent(name: string, opts?: {
  description?: string;
  author?: string;
  version?: string;
  tags?: string[];
}): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${opts?.description ?? `Test skill ${name}`}`,
    `author: ${opts?.author ?? 'test-author'}`,
    `version: ${opts?.version ?? '1.0.0'}`,
    opts?.tags?.length ? `tags:\n${opts.tags.map(t => `  - ${t}`).join('\n')}` : 'tags: []',
    '---',
    '',
    `This is the body content for ${name}.`,
  ].join('\n');
}

/**
 * Build a minimal valid agent element YAML with activates fields.
 */
export function buildAgentContent(name: string, activates?: {
  personas?: string[];
  skills?: string[];
}): string {
  const activatesBlock = activates
    ? [
        'activates:',
        ...(activates.personas?.length ? [`  personas:\n${activates.personas.map(p => `    - ${p}`).join('\n')}`] : []),
        ...(activates.skills?.length ? [`  skills:\n${activates.skills.map(s => `    - ${s}`).join('\n')}`] : []),
      ].join('\n')
    : '';

  return [
    '---',
    `name: ${name}`,
    `description: Test agent ${name}`,
    'author: test-author',
    'version: 1.0.0',
    activatesBlock,
    '---',
    '',
    `Agent body for ${name}.`,
  ].join('\n');
}

/**
 * Build a minimal valid memory YAML with entries.
 */
export function buildMemoryContent(name: string, entries?: Array<{
  id: string;
  content: string;
  timestamp?: string;
}>): string {
  const entryBlock = entries?.length
    ? [
        'entries:',
        ...entries.map(e => [
          `  - id: "${e.id}"`,
          `    content: "${e.content}"`,
          `    timestamp: "${e.timestamp ?? new Date().toISOString()}"`,
        ].join('\n')),
      ].join('\n')
    : '';

  return [
    `name: ${name}`,
    `description: Test memory ${name}`,
    'author: test-author',
    'version: 1.0.0',
    'memoryType: user',
    'autoLoad: false',
    'tags:',
    '  - test',
    entryBlock,
  ].join('\n');
}
