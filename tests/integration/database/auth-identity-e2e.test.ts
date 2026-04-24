/**
 * Auth Identity E2E Integration Tests
 *
 * Tests the full authentication flow: JWT token → auth middleware →
 * session creation → DB user resolution → RLS-scoped queries.
 *
 * Spawns a real DollhouseMCP server with DOLLHOUSE_AUTH_ENABLED=true
 * and verifies that:
 * - Unauthenticated requests are rejected with 401
 * - Invalid tokens are rejected with 401
 * - Valid tokens create a DB user from the JWT sub claim
 * - The authenticated user's data is RLS-scoped
 * - Different tokens create different users with isolated data
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { eq, sql } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createDatabaseConnection, type DatabaseInstance } from '../../../src/database/connection.js';
import { elements } from '../../../src/database/schema/elements.js';
import { users } from '../../../src/database/schema/users.js';
import { LocalDevAuthProvider } from '../../../src/auth/LocalDevAuthProvider.js';

const STARTUP_TIMEOUT = 60_000;
const TEST_TIMEOUT = 30_000;
const DB_URL = 'postgres://dollhouse_app:dollhouse_app@localhost:5432/dollhousemcp_test';
const DB_ADMIN_URL = 'postgres://dollhouse:dollhouse@localhost:5432/dollhousemcp_test';
const SERVER_READY_REGEX = /Streamable HTTP server listening on (https?:\/\/[^\s]+)/;

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  if (!content?.[0]?.text) return JSON.stringify(content);
  return content[0].text;
}

async function callTool(client: Client, tool: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name: tool, arguments: args });
  return resultText(result);
}

async function confirm(client: Client, operation: string): Promise<string> {
  return callTool(client, 'mcp_aql_execute', { operation: 'confirm_operation', params: { operation } });
}

function spawnAuthServer(
  env: Record<string, string>,
): Promise<{ child: ChildProcessWithoutNullStreams; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['dist/index.js', '--http', '--port=0'], { // NOSONAR — E2E test spawns server
      env: { ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    const stderrBuf: string[] = [];

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf.push(chunk.toString('utf8'));
      if (!resolved) {
        const match = SERVER_READY_REGEX.exec(stderrBuf.join(''));
        if (match) {
          resolved = true;
          clearTimeout(startupTimer);
          const baseUrl = match[1];
          const mcpUrl = baseUrl.endsWith('/mcp') ? baseUrl : `${baseUrl}/mcp`;
          resolve({ child, url: mcpUrl });
        }
      }
    });
    child.stdout.on('data', () => {});

    child.once('exit', (code) => {
      if (!resolved) {
        clearTimeout(startupTimer);
        reject(new Error(`Server exited (code=${code})\nstderr:\n${stderrBuf.join('')}`));
      }
    });

    const startupTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill('SIGKILL');
        reject(new Error(`Server not ready within ${STARTUP_TIMEOUT}ms\nstderr:\n${stderrBuf.join('')}`));
      }
    }, STARTUP_TIMEOUT);
  });
}

async function killProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdout.removeAllListeners();
  child.stderr.removeAllListeners();
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>(resolve => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

async function connectWithToken(
  url: string,
  token: string,
  clientName: string,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: clientName, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

describe('Auth Identity E2E Tests', () => {
  let child: ChildProcessWithoutNullStreams;
  let serverUrl: string;
  let testDir: string;
  let keyFilePath: string;
  let authProvider: LocalDevAuthProvider;
  let adminDb: DatabaseInstance;
  let adminDbConnection: ReturnType<typeof createDatabaseConnection>;
  let dbAvailable = false;

  beforeAll(async () => {
    try {
      adminDbConnection = createDatabaseConnection({ connectionUrl: DB_ADMIN_URL, poolSize: 2, ssl: 'disable' });
      adminDb = adminDbConnection.db;
      await adminDb.execute(sql`SELECT 1`);
      dbAvailable = true;
    } catch {
      console.warn('Skipping auth identity E2E tests — PostgreSQL not available');
      return;
    }

    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-e2e-'));
    const elementTypes = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'];
    await Promise.all(elementTypes.map(t => fs.mkdir(path.join(testDir, t), { recursive: true })));

    keyFilePath = path.join(testDir, 'auth-keypair.json');
    authProvider = new LocalDevAuthProvider({ keyFilePath });

    const filteredEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;

    const serverEnv: Record<string, string> = {
      ...filteredEnv,
      TEST_MODE: 'true',
      NODE_ENV: 'test',
      DOLLHOUSE_PORTFOLIO_DIR: testDir,
      DOLLHOUSE_SESSION_ID: 'auth-e2e-test',
      MCP_INTERFACE_MODE: 'mcpaql',
      DOLLHOUSE_WEB_CONSOLE: 'false',
      DOLLHOUSE_HTTP_WEB_CONSOLE: 'false',
      DOLLHOUSE_PERMISSION_SERVER: 'false',
      DOLLHOUSE_STORAGE_BACKEND: 'database',
      DOLLHOUSE_DATABASE_URL: DB_URL,
      DOLLHOUSE_DATABASE_ADMIN_URL: DB_ADMIN_URL,
      DOLLHOUSE_DATABASE_POOL_SIZE: '5',
      DOLLHOUSE_DATABASE_SSL: 'disable',
      DOLLHOUSE_AUTH_ENABLED: 'true',
      DOLLHOUSE_AUTH_PROVIDER: 'local',
      DOLLHOUSE_AUTH_LOCAL_KEY_FILE: keyFilePath,
      DOLLHOUSE_LOG_FLUSH_INTERVAL_MS: '100',
      GITHUB_TOKEN: '',
      GITHUB_TEST_TOKEN: '',
    };

    const spawned = await spawnAuthServer(serverEnv);
    child = spawned.child;
    serverUrl = spawned.url;
  }, STARTUP_TIMEOUT);

  afterAll(async () => {
    if (child) await killProcess(child);

    // Clean up test users and elements
    if (dbAvailable) {
      try {
        await adminDb.delete(elements).where(
          sql`${elements.name} LIKE 'auth-e2e-%'`,
        );
        await adminDb.delete(users).where(
          sql`${users.username} IN ('alice-auth-test', 'bob-auth-test')`,
        );
      } catch { /* best effort */ }
      try { await adminDbConnection.close(); } catch { /* best effort */ }
    }
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('should reject requests without a token', async () => {
    if (!dbAvailable) return;

    const resp = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
        id: 1,
      }),
    });
    expect(resp.status).toBe(401);
  }, TEST_TIMEOUT);

  it('should reject requests with an invalid token', async () => {
    if (!dbAvailable) return;

    const resp = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': 'Bearer invalid-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
        id: 1,
      }),
    });
    expect(resp.status).toBe(401);
  }, TEST_TIMEOUT);

  it('should authenticate with a valid token and create a DB user', async () => {
    if (!dbAvailable) return;

    const token = await authProvider.issue('alice-auth-test', { displayName: 'Alice' });
    const { client, transport } = await connectWithToken(serverUrl, token, 'auth-e2e-alice');

    try {
      // Verify the user was created in the database
      const userRows = await adminDb.select({ id: users.id, username: users.username })
        .from(users)
        .where(eq(users.username, 'alice-auth-test'));
      expect(userRows).toHaveLength(1);
      expect(userRows[0].username).toBe('alice-auth-test');
    } finally {
      try { await transport.terminateSession(); } catch { /* best effort */ }
      try { await client.close(); } catch { /* best effort */ }
    }
  }, TEST_TIMEOUT);

  it('should scope element CRUD to the authenticated user via RLS', async () => {
    if (!dbAvailable) return;

    const aliceToken = await authProvider.issue('alice-auth-test');
    const { client: alice, transport: aliceTransport } = await connectWithToken(serverUrl, aliceToken, 'auth-e2e-alice-crud');

    try {
      await confirm(alice, 'create_element');
      await confirm(alice, 'delete_element');

      // Alice creates an element
      const createResp = await callTool(alice, 'mcp_aql_create', {
        operation: 'create_element',
        element_type: 'skill',
        params: {
          element_name: 'auth-e2e-alice-skill',
          description: 'Alice test skill',
          content: '# Alice Skill\n\nTest.',
        },
      });
      expect(createResp).not.toMatch(/"isError":\s*true/i);

      // Verify in DB — element belongs to alice
      const rows = await adminDb.select({ name: elements.name, userId: elements.userId })
        .from(elements)
        .where(eq(elements.name, 'auth-e2e-alice-skill'));
      expect(rows).toHaveLength(1);

      const aliceUserId = rows[0].userId;
      const aliceUser = await adminDb.select({ username: users.username })
        .from(users)
        .where(eq(users.id, aliceUserId));
      expect(aliceUser[0].username).toBe('alice-auth-test');

      // Clean up
      await callTool(alice, 'mcp_aql_delete', {
        operation: 'delete_element',
        params: { element_name: 'auth-e2e-alice-skill', element_type: 'skill' },
      });
    } finally {
      try { await aliceTransport.terminateSession(); } catch { /* best effort */ }
      try { await alice.close(); } catch { /* best effort */ }
    }
  }, TEST_TIMEOUT);

  it('should isolate data between different authenticated users', async () => {
    if (!dbAvailable) return;

    const aliceToken = await authProvider.issue('alice-auth-test');
    const bobToken = await authProvider.issue('bob-auth-test');

    const { client: alice, transport: aliceT } = await connectWithToken(serverUrl, aliceToken, 'auth-e2e-alice-iso');
    const { client: bob, transport: bobT } = await connectWithToken(serverUrl, bobToken, 'auth-e2e-bob-iso');

    try {
      await confirm(alice, 'create_element');
      await confirm(alice, 'delete_element');
      await confirm(bob, 'create_element');
      await confirm(bob, 'delete_element');

      // Alice creates a skill
      await callTool(alice, 'mcp_aql_create', {
        operation: 'create_element',
        element_type: 'skill',
        params: {
          element_name: 'auth-e2e-alice-private',
          description: 'Alice private',
          content: '# Alice Private\n\nOnly Alice should see this.',
        },
      });

      // Bob creates a skill
      await callTool(bob, 'mcp_aql_create', {
        operation: 'create_element',
        element_type: 'skill',
        params: {
          element_name: 'auth-e2e-bob-private',
          description: 'Bob private',
          content: '# Bob Private\n\nOnly Bob should see this.',
        },
      });

      // Alice lists skills — should see her own but not Bob's
      const aliceList = await callTool(alice, 'mcp_aql_read', {
        operation: 'list_elements',
        params: { element_type: 'skills' },
      });
      expect(aliceList).toContain('auth-e2e-alice-private');
      expect(aliceList).not.toContain('auth-e2e-bob-private');

      // Bob lists skills — should see his own but not Alice's
      const bobList = await callTool(bob, 'mcp_aql_read', {
        operation: 'list_elements',
        params: { element_type: 'skills' },
      });
      expect(bobList).toContain('auth-e2e-bob-private');
      expect(bobList).not.toContain('auth-e2e-alice-private');

      // Clean up
      await callTool(alice, 'mcp_aql_delete', {
        operation: 'delete_element',
        params: { element_name: 'auth-e2e-alice-private', element_type: 'skill' },
      });
      await callTool(bob, 'mcp_aql_delete', {
        operation: 'delete_element',
        params: { element_name: 'auth-e2e-bob-private', element_type: 'skill' },
      });
    } finally {
      try { await aliceT.terminateSession(); } catch { /* best effort */ }
      try { await alice.close(); } catch { /* best effort */ }
      try { await bobT.terminateSession(); } catch { /* best effort */ }
      try { await bob.close(); } catch { /* best effort */ }
    }
  }, TEST_TIMEOUT);
});
