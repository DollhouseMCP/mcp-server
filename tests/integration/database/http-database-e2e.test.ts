/**
 * HTTP + Database E2E Tests
 *
 * Proves the HTTP-transport + database-backend combination works end-to-end.
 * Spawns a real DollhouseMCP server as a child process with
 * `--http --port=0 DOLLHOUSE_STORAGE_BACKEND=database`, parses the bound
 * port from the server's startup line, connects SDK clients via
 * StreamableHTTPClientTransport, and exercises MCP tool calls through the
 * full stack: HTTP transport → per-session container → element manager →
 * DatabaseStorageLayer → PostgreSQL.
 *
 * Phase 4 claimed this mode works architecturally but never exercised it.
 * This closes that gap. Multi-tenant auth (where each HTTP session carries
 * its own user identity) lands in Phase 5; until then every HTTP session
 * shares the bootstrapped user, which is sufficient to validate every
 * layer below identity.
 *
 * Requires: Docker Postgres running, migrations applied, dollhouse +
 * dollhouse_app roles configured.
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

// ── Constants ───────────────────────────────────────────────────────

const STARTUP_TIMEOUT = 60_000;
const TEST_TIMEOUT = 30_000;
const DB_URL = 'postgres://dollhouse_app:dollhouse_app@localhost:5432/dollhousemcp_test';
const DB_ADMIN_URL = 'postgres://dollhouse:dollhouse@localhost:5432/dollhousemcp_test';
const ELEMENT_TYPES = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'];

// Matches the server's startup log line: "[DollhouseMCP] Streamable HTTP server listening on <url>"
const SERVER_READY_REGEX = /Streamable HTTP server listening on (https?:\/\/[^\s]+)/;

// ── Helpers ─────────────────────────────────────────────────────────

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  if (!content?.[0]?.text) return JSON.stringify(content);
  return content[0].text;
}

async function callTool(client: Client, tool: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name: tool, arguments: args });
  return resultText(result);
}

const aql = {
  create: (client: Client, args: Record<string, unknown>) => callTool(client, 'mcp_aql_create', args),
  read: (client: Client, args: Record<string, unknown>) => callTool(client, 'mcp_aql_read', args),
  update: (client: Client, args: Record<string, unknown>) => callTool(client, 'mcp_aql_update', args),
  delete: (client: Client, args: Record<string, unknown>) => callTool(client, 'mcp_aql_delete', args),
  execute: (client: Client, args: Record<string, unknown>) => callTool(client, 'mcp_aql_execute', args),
};

async function confirm(client: Client, operation: string): Promise<string> {
  return aql.execute(client, { operation: 'confirm_operation', params: { operation } });
}

/**
 * Spawn the DollhouseMCP server in HTTP mode and wait for the "listening on"
 * line. Returns the child handle and the resolved base URL (`http://host:port/mcp`).
 *
 * Why a child process instead of in-process: `src/config/env.ts` parses
 * `process.env` at module-load time and caches the result. The container's
 * `preparePortfolio()` reads from that cache. Setting env vars from inside the
 * test file happens after the cache is populated, so the storage backend
 * stays on 'file'. Spawning a fresh Node process with the env already set
 * avoids the cache issue entirely — same pattern the stdio+DB E2E uses.
 */
function spawnHttpServer(env: Record<string, string>, portfolioDir: string): Promise<{
  child: ChildProcessWithoutNullStreams;
  url: string;
  stderrBuf: string[];
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['dist/index.js', '--http', '--port=0'], { // NOSONAR — E2E test spawns server
      env: { ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    const stderrBuf: string[] = [];

    // Keep buffering stderr past the startup line — tests use the tail
    // on failure to diagnose 5xx responses from the server.
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrBuf.push(text);
      // Forward everything to the test runner's stderr for live debugging.
      // Output is large but helpful when diagnosing session init failures.
      if (process.env.VERBOSE_HTTP_DB_E2E) {
        process.stderr.write(`[server] ${text}`);
      }
      if (!resolved) {
        const match = SERVER_READY_REGEX.exec(stderrBuf.join(''));
        if (match) {
          resolved = true;
          clearTimeout(startupTimer);
          const baseUrl = match[1];
          const mcpUrl = baseUrl.endsWith('/mcp') ? baseUrl : `${baseUrl}/mcp`;
          resolve({ child, url: mcpUrl, stderrBuf });
        }
      }
    });
    child.stdout.on('data', () => { /* drain */ });

    child.once('exit', (code) => {
      if (!resolved) {
        clearTimeout(startupTimer);
        reject(new Error(
          `Server exited before startup (code=${code})\n` +
          `stderr:\n${stderrBuf.join('')}\n` +
          `portfolio=${portfolioDir}`,
        ));
      }
    });

    const startupTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill('SIGKILL');
        reject(new Error(
          `Server did not become ready within ${STARTUP_TIMEOUT}ms\n` +
          `stderr:\n${stderrBuf.join('')}`,
        ));
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
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

// ── Test Suite ──────────────────────────────────────────────────────

describe('MCP HTTP+Database E2E Tests', () => {
  let child: ChildProcessWithoutNullStreams;
  let serverUrl: string;
  let stderrBuf: string[] = [];
  let primaryClient: Client;
  let primaryTransport: StreamableHTTPClientTransport;
  let testDir: string;
  let db: DatabaseInstance;
  let dbConnection: ReturnType<typeof createDatabaseConnection>;
  let adminDbConnection: ReturnType<typeof createDatabaseConnection>;
  let adminDb: DatabaseInstance;
  let testUserId: string;
  let dbAvailable = false;

  beforeAll(async () => {
    try {
      dbConnection = createDatabaseConnection({ connectionUrl: DB_URL, poolSize: 2, ssl: 'disable' });
      db = dbConnection.db;
      await db.execute(sql`SELECT 1`);
      // Admin connection — needed to query the `users` table (RLS-protected,
      // only self_read for the app role) and to clean up cross-user state.
      adminDbConnection = createDatabaseConnection({ connectionUrl: DB_ADMIN_URL, poolSize: 2, ssl: 'disable' });
      adminDb = adminDbConnection.db;
      dbAvailable = true;
    } catch {
      console.warn('Skipping MCP HTTP+Database E2E tests — PostgreSQL not available');
      return;
    }

    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-http-db-e2e-'));
    await Promise.all(
      ELEMENT_TYPES.map(t => fs.mkdir(path.join(testDir, t), { recursive: true })),
    );

    const filteredEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;

    const serverEnv: Record<string, string> = {
      ...filteredEnv,
      TEST_MODE: 'true',
      NODE_ENV: 'test',
      DOLLHOUSE_PORTFOLIO_DIR: testDir,
      DOLLHOUSE_SESSION_ID: 'http-db-e2e-test',
      MCP_INTERFACE_MODE: 'mcpaql',
      DOLLHOUSE_WEB_CONSOLE: 'false',
      DOLLHOUSE_HTTP_WEB_CONSOLE: 'false',
      DOLLHOUSE_PERMISSION_SERVER: 'false',
      DOLLHOUSE_STORAGE_BACKEND: 'database',
      DOLLHOUSE_DATABASE_URL: DB_URL,
      DOLLHOUSE_DATABASE_ADMIN_URL: DB_ADMIN_URL,
      DOLLHOUSE_DATABASE_POOL_SIZE: '5',
      DOLLHOUSE_DATABASE_SSL: 'disable',
      // Shorten the log flush interval so errors reach application-*.log
      // within the test teardown window (default is 5000ms; we SIGTERM
      // the child faster than that on failure).
      DOLLHOUSE_LOG_FLUSH_INTERVAL_MS: '100',
      DOLLHOUSE_AUTH_ENABLED: 'false',
      GITHUB_TOKEN: '',
      GITHUB_TEST_TOKEN: '',
    };

    const spawned = await spawnHttpServer(serverEnv, testDir);
    child = spawned.child;
    serverUrl = spawned.url;
    stderrBuf = spawned.stderrBuf;

    // Connect the primary client — if this fails, surface the server stderr so
    // 5xx responses have context instead of being opaque "Internal server error".
    primaryTransport = new StreamableHTTPClientTransport(new URL(serverUrl));
    primaryClient = new Client(
      { name: 'http-db-e2e-primary', version: '1.0.0' },
      { capabilities: {} },
    );
    try {
      await primaryClient.connect(primaryTransport);
    } catch (err) {
      // Give the server a moment to flush its error logs before bailing.
      // Paired with DOLLHOUSE_LOG_FLUSH_INTERVAL_MS=100 above so at least
      // a couple of flush ticks land before we surface the error.
      await new Promise(r => setTimeout(r, 300));
      throw new Error(
        `Failed to connect to HTTP server.\n\n` +
        `Error: ${err instanceof Error ? err.message : String(err)}\n\n` +
        `Server stderr (last 4KB):\n${stderrBuf.join('').slice(-4096)}`,
      );
    }

    // Pre-confirm Gatekeeper operations
    await confirm(primaryClient, 'create_element');
    await confirm(primaryClient, 'edit_element');
    await confirm(primaryClient, 'delete_element');

    // Resolve the bootstrapped user's ID. The server uses DOLLHOUSE_USER
    // (from env or .env.local) or falls back to OS username. Query for the
    // most recently created non-system, non-test user.
    const userRows = await adminDb.select({ id: users.id, username: users.username }).from(users)
      .where(sql`${users.id} != '00000000-0000-0000-0000-000000000001' AND ${users.username} NOT LIKE 'test-%'`)
      .orderBy(sql`${users.createdAt} DESC`).limit(1);
    if (!userRows[0]) {
      throw new Error('Expected at least one bootstrapped user row, found none');
    }
    testUserId = userRows[0].id;
  }, STARTUP_TIMEOUT);

  afterAll(async () => {
    if (primaryClient) {
      try { await primaryTransport.terminateSession(); } catch { /* best effort */ }
      try { await primaryClient.close(); } catch { /* best effort */ }
    }
    if (child) {
      await killProcess(child);
    }
    if (dbConnection) {
      try { await dbConnection.close(); } catch { /* best effort */ }
    }
    if (adminDbConnection) {
      try { await adminDbConnection.close(); } catch { /* best effort */ }
    }
    if (testDir) {
      try { await fs.rm(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  // ── Server startup ──────────────────────────────────────────────

  it('should start in HTTP database mode with a valid bootstrapped user', () => {
    if (!dbAvailable) return;
    expect(serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(testUserId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  // ── Skill — full lifecycle over HTTP ────────────────────────────

  describe('Skill — Full Lifecycle', () => {
    const NAME = 'http-db-skill';

    it('should create a skill over HTTP with DB backend', async () => {
      if (!dbAvailable) return;
      const resp = await aql.create(primaryClient, {
        operation: 'create_element',
        element_type: 'skill',
        params: {
          element_name: NAME,
          description: 'HTTP+DB test skill',
          content: '# HTTP+DB Skill\n\nCreated via HTTP transport to DB.',
        },
      });
      expect(resp).toMatch(/created|success/i);
      expect(resp).not.toMatch(/"isError":\s*true|❌/i);
    }, TEST_TIMEOUT);

    it('should persist the skill to Postgres (not filesystem)', async () => {
      if (!dbAvailable) return;
      // Use admin connection (bypasses RLS) to verify the element exists
      // regardless of which user the server bootstrapped as.
      const rows = await adminDb.select().from(elements)
        .where(eq(elements.name, NAME)).limit(1);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.elementType).toBe('skills');
      expect(row.description).toBe('HTTP+DB test skill');
      expect(row.rawContent).toContain('HTTP+DB Skill');
      // Capture the actual userId for subsequent RLS-scoped queries
      testUserId = row.userId;

      // No .md file in the portfolio skills dir — DB mode should bypass disk
      const files = await fs.readdir(path.join(testDir, 'skills')).catch(() => []);
      expect(files.filter(f => f.includes(NAME))).toHaveLength(0);
    }, TEST_TIMEOUT);

    it('should read the skill back through HTTP', async () => {
      if (!dbAvailable) return;
      const resp = await aql.read(primaryClient, {
        operation: 'get_element_details',
        params: { element_name: NAME, element_type: 'skill' },
      });
      expect(resp).toContain(NAME);
      expect(resp).toContain('HTTP+DB test skill');
    }, TEST_TIMEOUT);

    it('should list the skill via HTTP', async () => {
      if (!dbAvailable) return;
      const resp = await aql.read(primaryClient, {
        operation: 'list_elements',
        element_type: 'skill',
      });
      expect(resp).toContain(NAME);
    }, TEST_TIMEOUT);

    it('should update the skill description via HTTP', async () => {
      if (!dbAvailable) return;
      const resp = await aql.update(primaryClient, {
        operation: 'edit_element',
        params: {
          element_name: NAME,
          element_type: 'skill',
          input: { description: 'Updated over HTTP' },
        },
      });
      expect(resp).not.toMatch(/"isError":\s*true|❌|Failed to save/i);
      expect(resp).toMatch(/updated|edited/i);
    }, TEST_TIMEOUT);

    it('should reflect the update in DB raw_content and metadata', async () => {
      if (!dbAvailable) return;
      const rows = await adminDb.select().from(elements)
        .where(eq(elements.name, NAME)).limit(1);
      expect(rows).toHaveLength(1);
      expect(rows[0].description).toBe('Updated over HTTP');
      expect(rows[0].rawContent).toContain('Updated over HTTP');
    }, TEST_TIMEOUT);

    it('should delete the skill via HTTP and remove the DB row', async () => {
      if (!dbAvailable) return;
      const deleteResp = await aql.delete(primaryClient, {
        operation: 'delete_element',
        params: { element_name: NAME, element_type: 'skill' },
      });
      expect(deleteResp).toMatch(/deleted|success|removed/i);

      const rows = await adminDb.select({ id: elements.id }).from(elements)
        .where(eq(elements.name, NAME));
      expect(rows).toHaveLength(0);
    }, TEST_TIMEOUT);
  });

  // ── Memory — pure-YAML element with separate entries table ──────

  describe('Memory — HTTP+DB smoke', () => {
    const NAME = 'http-db-memory';

    it('should create a memory and store it as elementType=memories', async () => {
      if (!dbAvailable) return;
      const resp = await aql.create(primaryClient, {
        operation: 'create_element',
        element_type: 'memory',
        params: { element_name: NAME, description: 'HTTP+DB memory test' },
      });
      expect(resp).not.toMatch(/"isError":\s*true|❌|Failed/i);

      const rows = await adminDb.select().from(elements)
        .where(eq(elements.name, NAME)).limit(1);
      expect(rows).toHaveLength(1);
      expect(rows[0].elementType).toBe('memories');
      expect(rows[0].rawContent).not.toMatch(/^---/);
    }, TEST_TIMEOUT);

    it('should delete the memory via HTTP', async () => {
      if (!dbAvailable) return;
      await aql.delete(primaryClient, {
        operation: 'delete_element',
        params: { element_name: NAME, element_type: 'memory' },
      });
      const rows = await adminDb.select({ id: elements.id }).from(elements)
        .where(eq(elements.name, NAME));
      expect(rows).toHaveLength(0);
    }, TEST_TIMEOUT);
  });

  // ── Concurrent HTTP sessions ────────────────────────────────────

  describe('Concurrent HTTP sessions', () => {
    it('should handle two independent HTTP clients writing concurrently', async () => {
      if (!dbAvailable) return;

      // Clean up any leftover elements from prior failed runs
      await adminDb.delete(elements).where(eq(elements.name, 'http-db-concurrent-a'));
      await adminDb.delete(elements).where(eq(elements.name, 'http-db-concurrent-b'));

      const t2 = new StreamableHTTPClientTransport(new URL(serverUrl));
      const c2 = new Client(
        { name: 'http-db-e2e-secondary', version: '1.0.0' },
        { capabilities: {} },
      );
      await c2.connect(t2);
      await confirm(c2, 'create_element');
      await confirm(c2, 'delete_element');

      try {
        const [r1, r2] = await Promise.all([
          aql.create(primaryClient, {
            operation: 'create_element',
            element_type: 'skill',
            params: { element_name: 'http-db-concurrent-a', description: 'client 1', content: '# Client A\n\nConcurrent session test.' },
          }),
          aql.create(c2, {
            operation: 'create_element',
            element_type: 'skill',
            params: { element_name: 'http-db-concurrent-b', description: 'client 2', content: '# Client B\n\nConcurrent session test.' },
          }),
        ]);
        expect(r1).not.toMatch(/"isError":\s*true|❌/i);
        expect(r2).not.toMatch(/"isError":\s*true|❌/i);

        const rows = await adminDb.select({ name: elements.name }).from(elements)
          .where(eq(elements.elementType, 'skills'));
        const names = rows.map(r => r.name);
        expect(names).toContain('http-db-concurrent-a');
        expect(names).toContain('http-db-concurrent-b');

        await Promise.all([
          aql.delete(primaryClient, {
            operation: 'delete_element',
            params: { element_name: 'http-db-concurrent-a', element_type: 'skill' },
          }),
          aql.delete(c2, {
            operation: 'delete_element',
            params: { element_name: 'http-db-concurrent-b', element_type: 'skill' },
          }),
        ]);
      } finally {
        try { await t2.terminateSession(); } catch { /* best effort */ }
        try { await c2.close(); } catch { /* best effort */ }
      }
    }, TEST_TIMEOUT);
  });

  // ── Session lifecycle ──────────────────────────────────────────

  describe('Session lifecycle', () => {
    it('should allow a new HTTP session to see DB state from a closed session', async () => {
      if (!dbAvailable) return;

      const t = new StreamableHTTPClientTransport(new URL(serverUrl));
      const c = new Client(
        { name: 'http-db-e2e-throwaway', version: '1.0.0' },
        { capabilities: {} },
      );
      await c.connect(t);
      await confirm(c, 'create_element');
      const name = 'http-db-cycle-skill';
      const createResp = await aql.create(c, {
        operation: 'create_element',
        element_type: 'skill',
        params: { element_name: name, description: 'cycle', content: '# Cycle test\n\nSession lifecycle fixture.' },
      });
      expect(createResp).not.toMatch(/"isError":\s*true|❌/i);
      try { await t.terminateSession(); } catch { /* best effort */ }
      try { await c.close(); } catch { /* best effort */ }

      const t2 = new StreamableHTTPClientTransport(new URL(serverUrl));
      const c2 = new Client(
        { name: 'http-db-e2e-fresh', version: '1.0.0' },
        { capabilities: {} },
      );
      await c2.connect(t2);
      try {
        const listResp = await aql.read(c2, {
          operation: 'list_elements',
          element_type: 'skill',
        });
        expect(listResp).toContain(name);

        await confirm(c2, 'delete_element');
        await aql.delete(c2, {
          operation: 'delete_element',
          params: { element_name: name, element_type: 'skill' },
        });
      } finally {
        try { await t2.terminateSession(); } catch { /* best effort */ }
        try { await c2.close(); } catch { /* best effort */ }
      }
    }, TEST_TIMEOUT);
  });
});
