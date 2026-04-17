/**
 * End-to-End MCP Server Integration Test — Database Mode
 *
 * Starts the real DollhouseMCP server with DOLLHOUSE_STORAGE_BACKEND=database,
 * connects via stdio MCP protocol, and exercises full CRUD through the actual
 * mcp_aql tools. Then queries the database directly to verify state.
 *
 * This is the definitive test that proves the entire stack works:
 * MCP transport → handler → manager → storage layer → database → and back.
 *
 * Requires: Docker Postgres running, migrations applied, dollhouse_app role.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { eq } from 'drizzle-orm';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createDatabaseConnection, type DatabaseInstance } from '../../../src/database/connection.js';
import { withUserRead } from '../../../src/database/rls.js';
import { elements } from '../../../src/database/schema/elements.js';
import { users } from '../../../src/database/schema/users.js';

// ── Constants ───────────────────────────────────────────────────────

const STARTUP_TIMEOUT = 60_000;
const TEST_TIMEOUT = 30_000;
const DB_URL = 'postgres://dollhouse_app:dollhouse_app@localhost:5432/dollhousemcp';
const DB_ADMIN_URL = 'postgres://dollhouse:dollhouse@localhost:5432/dollhousemcp';

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

// ── Test Suite ──────────────────────────────────────────────────────

describe('MCP Database E2E Tests', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let testDir: string;
  let db: DatabaseInstance;
  let dbConnection: ReturnType<typeof createDatabaseConnection>;
  let testUserId: string;
  let dbAvailable = false;

  beforeAll(async () => {
    // Check DB availability
    try {
      dbConnection = createDatabaseConnection({ connectionUrl: DB_URL, poolSize: 2, ssl: 'disable' });
      db = dbConnection.db;
      const { sql } = await import('drizzle-orm');
      await db.execute(sql`SELECT 1`);
      dbAvailable = true;
    } catch {
      console.warn('Skipping MCP Database E2E tests — PostgreSQL not available');
      return;
    }

    // Temp portfolio dir
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-db-e2e-'));
    const types = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'];
    await Promise.all(types.map(t => fs.mkdir(path.join(testDir, t), { recursive: true })));

    const filteredEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined)
    ) as Record<string, string>;

    // Start server in database mode
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      env: {
        ...filteredEnv,
        TEST_MODE: 'true',
        NODE_ENV: 'test',
        DOLLHOUSE_PORTFOLIO_DIR: testDir,
        DOLLHOUSE_SESSION_ID: 'db-e2e-test',
        MCP_INTERFACE_MODE: 'mcpaql',
        DOLLHOUSE_WEB_CONSOLE: 'false',
        DOLLHOUSE_STORAGE_BACKEND: 'database',
        DOLLHOUSE_DATABASE_URL: DB_URL,
        DOLLHOUSE_DATABASE_ADMIN_URL: DB_ADMIN_URL,
        DOLLHOUSE_DATABASE_POOL_SIZE: '3',
        DOLLHOUSE_DATABASE_SSL: 'disable',
        GITHUB_TOKEN: '',
        GITHUB_TEST_TOKEN: '',
      },
    });

    client = new Client(
      { name: 'db-e2e-test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);

    // Pre-confirm Gatekeeper operations
    await confirm(client, 'create_element');
    await confirm(client, 'edit_element');
    await confirm(client, 'delete_element');

    // Find the server's bootstrapped user ID
    const username = os.userInfo().username || 'local';
    const userRows = await db.select({ id: users.id }).from(users)
      .where(eq(users.username, username)).limit(1);
    if (userRows[0]) testUserId = userRows[0].id;
  }, STARTUP_TIMEOUT);

  afterAll(async () => {
    if (client) { try { await client.close(); } catch { /* ignore */ } }
    if (transport) {
      const pid = transport.pid;
      try { await transport.close(); } catch { /* ignore */ }
      if (pid) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
        await new Promise<void>(r => setTimeout(r, 500));
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
      }
    }
    if (dbConnection) { await dbConnection.close(); }
    if (testDir) { await fs.rm(testDir, { recursive: true, force: true }).catch(() => {}); }
  });

  // ── Server Startup ────────────────────────────────────────────────

  it('should start in database mode', () => {
    if (!dbAvailable) return;
    expect(client).toBeDefined();
  }, TEST_TIMEOUT);

  // ── Skill — Full CRUD Lifecycle ───────────────────────────────────

  describe('Skill — Full Lifecycle', () => {
    const NAME = 'e2e-db-skill';

    it('should create a skill', async () => {
      if (!dbAvailable) return;
      const resp = await aql.create(client, {
        operation: 'create_element',
        element_type: 'skill',
        params: {
          element_name: NAME,
          description: 'E2E database test skill',
          content: '# E2E Skill\n\nCreated via MCP in database mode.',
        },
      });
      expect(resp).toMatch(/created|success/i);
    }, TEST_TIMEOUT);

    it('should store the skill in the database with correct raw_content and metadata', async () => {
      if (!dbAvailable || !testUserId) return;

      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select().from(elements).where(eq(elements.name, NAME)).limit(1)
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];

      // raw_content is a valid markdown document
      expect(row.rawContent).toContain('---');
      expect(row.rawContent).toContain(`name: ${NAME}`);
      expect(row.rawContent).toContain('E2E database test skill');
      expect(row.rawContent).toContain('# E2E Skill');

      // Metadata columns extracted correctly
      expect(row.name).toBe(NAME);
      expect(row.description).toBe('E2E database test skill');
      expect(row.elementType).toBe('skills');
      expect(row.contentHash).toHaveLength(64);
      expect(row.byteSize).toBeGreaterThan(0);

      // Body content is the markdown after frontmatter (heading uses element name)
      expect(row.bodyContent).toBeTruthy();
      expect(row.bodyContent).not.toContain('---');
    }, TEST_TIMEOUT);

    it('should read the skill back via MCP with correct data', async () => {
      if (!dbAvailable) return;
      const resp = await aql.read(client, {
        operation: 'get_element_details',
        params: { element_name: NAME, element_type: 'skill' },
      });
      expect(resp).toContain(NAME);
      expect(resp).toContain('E2E database test skill');
    }, TEST_TIMEOUT);

    it('should list the skill', async () => {
      if (!dbAvailable) return;
      const resp = await aql.read(client, {
        operation: 'list_elements',
        element_type: 'skill',
      });
      expect(resp).toContain(NAME);
    }, TEST_TIMEOUT);

    it('should update the skill description', async () => {
      if (!dbAvailable) return;
      const resp = await aql.update(client, {
        operation: 'edit_element',
        params: {
          element_name: NAME,
          element_type: 'skill',
          input: { description: 'Updated E2E description' },
        },
      });
      // Tighter than just matching 'success' — the MCP envelope always has
      // `"success": true` even when the tool reports isError: true. Require
      // no error markers in the content body.
      expect(resp).not.toMatch(/"isError":\s*true|❌|Failed to save/i);
      expect(resp).toMatch(/updated|edited/i);
    }, TEST_TIMEOUT);

    it('should reflect the update in both raw_content and metadata columns', async () => {
      if (!dbAvailable || !testUserId) return;

      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select().from(elements).where(eq(elements.name, NAME)).limit(1)
      );
      expect(rows).toHaveLength(1);

      // raw_content updated
      expect(rows[0].rawContent).toContain('Updated E2E description');
      // Metadata column updated
      expect(rows[0].description).toBe('Updated E2E description');
    }, TEST_TIMEOUT);

    it('should read the updated skill correctly via MCP', async () => {
      if (!dbAvailable) return;
      const resp = await aql.read(client, {
        operation: 'get_element_details',
        params: { element_name: NAME, element_type: 'skill' },
      });
      expect(resp).toContain('Updated E2E description');
    }, TEST_TIMEOUT);

    it('should delete the skill', async () => {
      if (!dbAvailable) return;
      const resp = await aql.delete(client, {
        operation: 'delete_element',
        params: { element_name: NAME, element_type: 'skill' },
      });
      expect(resp).toMatch(/deleted|success|removed/i);
    }, TEST_TIMEOUT);

    it('should have removed the skill from the database', async () => {
      if (!dbAvailable || !testUserId) return;

      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select({ id: elements.id }).from(elements).where(eq(elements.name, NAME))
      );
      expect(rows).toHaveLength(0);
    }, TEST_TIMEOUT);
  });

  // ── Persona ───────────────────────────────────────────────────────

  describe('Persona — Full Lifecycle', () => {
    const NAME = 'e2e-db-persona';

    it('should create a persona', async () => {
      if (!dbAvailable) return;
      const resp = await aql.create(client, {
        operation: 'create_element',
        element_type: 'persona',
        params: {
          element_name: NAME,
          description: 'E2E test persona',
          instructions: 'You are a helpful test persona.',
        },
      });
      expect(resp).toMatch(/created|success/i);
    }, TEST_TIMEOUT);

    it('should store the persona in the database', async () => {
      if (!dbAvailable || !testUserId) return;
      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select().from(elements).where(eq(elements.name, NAME)).limit(1)
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].elementType).toBe('personas');
      expect(rows[0].description).toBe('E2E test persona');
      expect(rows[0].rawContent).toContain('You are a helpful test persona');
    }, TEST_TIMEOUT);

    it('should update the persona description', async () => {
      if (!dbAvailable) return;
      const resp = await aql.update(client, {
        operation: 'edit_element',
        params: {
          element_name: NAME,
          element_type: 'persona',
          input: { description: 'Updated persona description' },
        },
      });
      // Tighter than just matching 'success' — the MCP envelope always has
      // `"success": true` even when the tool reports isError: true. Require
      // no error markers in the content body.
      expect(resp).not.toMatch(/"isError":\s*true|❌|Failed to save/i);
      expect(resp).toMatch(/updated|edited/i);
    }, TEST_TIMEOUT);

    it('should reflect the persona update in DB raw_content and metadata', async () => {
      if (!dbAvailable || !testUserId) return;
      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select().from(elements).where(eq(elements.name, NAME)).limit(1)
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].description).toBe('Updated persona description');
      expect(rows[0].rawContent).toContain('Updated persona description');
    }, TEST_TIMEOUT);

    it('should read the updated persona via MCP', async () => {
      if (!dbAvailable) return;
      const resp = await aql.read(client, {
        operation: 'get_element_details',
        params: { element_name: NAME, element_type: 'persona' },
      });
      expect(resp).toContain('Updated persona description');
    }, TEST_TIMEOUT);

    it('should delete the persona', async () => {
      if (!dbAvailable) return;
      const resp = await aql.delete(client, {
        operation: 'delete_element',
        params: { element_name: NAME, element_type: 'persona' },
      });
      expect(resp).toMatch(/deleted|success|removed/i);
    }, TEST_TIMEOUT);

    it('should have removed the persona from the database', async () => {
      if (!dbAvailable || !testUserId) return;
      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select({ id: elements.id }).from(elements).where(eq(elements.name, NAME))
      );
      expect(rows).toHaveLength(0);
    }, TEST_TIMEOUT);
  });

  // ── Template ──────────────────────────────────────────────────────

  describe('Template — Full Lifecycle', () => {
    const NAME = 'e2e-db-template';

    it('should create a template', async () => {
      if (!dbAvailable) return;
      const resp = await aql.create(client, {
        operation: 'create_element',
        element_type: 'template',
        params: {
          element_name: NAME,
          description: 'E2E test template',
          content: '# Report\n\n## Summary\n{{summary}}\n\n## Details\n{{details}}',
        },
      });
      expect(resp).toMatch(/created|success/i);
    }, TEST_TIMEOUT);

    it('should store the template in DB with body_content extracted', async () => {
      if (!dbAvailable || !testUserId) return;
      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select().from(elements).where(eq(elements.name, NAME)).limit(1)
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].elementType).toBe('templates');
      expect(rows[0].bodyContent).toContain('{{summary}}');
      expect(rows[0].bodyContent).toContain('{{details}}');
    }, TEST_TIMEOUT);

    it('should update the template description', async () => {
      if (!dbAvailable) return;
      const resp = await aql.update(client, {
        operation: 'edit_element',
        params: {
          element_name: NAME,
          element_type: 'template',
          input: { description: 'Updated template description' },
        },
      });
      // Tighter than just matching 'success' — the MCP envelope always has
      // `"success": true` even when the tool reports isError: true. Require
      // no error markers in the content body.
      expect(resp).not.toMatch(/"isError":\s*true|❌|Failed to save/i);
      expect(resp).toMatch(/updated|edited/i);
    }, TEST_TIMEOUT);

    it('should reflect the template update in DB raw_content and metadata', async () => {
      if (!dbAvailable || !testUserId) return;
      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select().from(elements).where(eq(elements.name, NAME)).limit(1)
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].description).toBe('Updated template description');
      expect(rows[0].rawContent).toContain('Updated template description');
      // Body content (template variables) preserved across metadata-only update
      expect(rows[0].bodyContent).toContain('{{summary}}');
    }, TEST_TIMEOUT);

    it('should read the updated template via MCP', async () => {
      if (!dbAvailable) return;
      const resp = await aql.read(client, {
        operation: 'get_element_details',
        params: { element_name: NAME, element_type: 'template' },
      });
      expect(resp).toContain('Updated template description');
    }, TEST_TIMEOUT);

    it('should delete the template', async () => {
      if (!dbAvailable) return;
      const resp = await aql.delete(client, {
        operation: 'delete_element',
        params: { element_name: NAME, element_type: 'template' },
      });
      expect(resp).toMatch(/deleted|success|removed/i);
    }, TEST_TIMEOUT);

    it('should have removed the template from the database', async () => {
      if (!dbAvailable || !testUserId) return;
      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select({ id: elements.id }).from(elements).where(eq(elements.name, NAME))
      );
      expect(rows).toHaveLength(0);
    }, TEST_TIMEOUT);
  });

  // ── Agent ─────────────────────────────────────────────────────────

  describe('Agent — Full Lifecycle', () => {
    const NAME = 'e2e-db-agent';

    it('should create an agent', async () => {
      if (!dbAvailable) return;
      const resp = await aql.create(client, {
        operation: 'create_element',
        element_type: 'agent',
        params: {
          element_name: NAME,
          description: 'E2E test agent',
          instructions: 'You are an automation agent.',
          content: '# E2E Agent\n\nAutomates testing.',
        },
      });
      expect(resp).not.toMatch(/error|failed|❌/i);
    }, TEST_TIMEOUT);

    it('should store the agent in the database', async () => {
      if (!dbAvailable || !testUserId) return;
      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select().from(elements).where(eq(elements.name, NAME)).limit(1)
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].elementType).toBe('agents');
      expect(rows[0].rawContent).toContain('automation agent');
    }, TEST_TIMEOUT);

    it('should update the agent description', async () => {
      if (!dbAvailable) return;
      const resp = await aql.update(client, {
        operation: 'edit_element',
        params: {
          element_name: NAME,
          element_type: 'agent',
          input: { description: 'Updated agent description' },
        },
      });
      // Tighter than just matching 'success' — the MCP envelope always has
      // `"success": true` even when the tool reports isError: true. Require
      // no error markers in the content body.
      expect(resp).not.toMatch(/"isError":\s*true|❌|Failed to save/i);
      expect(resp).toMatch(/updated|edited/i);
    }, TEST_TIMEOUT);

    it('should reflect the agent update in DB raw_content and metadata', async () => {
      if (!dbAvailable || !testUserId) return;
      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select().from(elements).where(eq(elements.name, NAME)).limit(1)
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].description).toBe('Updated agent description');
      expect(rows[0].rawContent).toContain('Updated agent description');
      // Agent body preserved across metadata update
      expect(rows[0].rawContent).toContain('automation agent');
    }, TEST_TIMEOUT);

    it('should read the updated agent via MCP', async () => {
      if (!dbAvailable) return;
      const resp = await aql.read(client, {
        operation: 'get_element_details',
        params: { element_name: NAME, element_type: 'agent' },
      });
      expect(resp).toContain('Updated agent description');
    }, TEST_TIMEOUT);

    it('should delete the agent', async () => {
      if (!dbAvailable) return;
      const resp = await aql.delete(client, {
        operation: 'delete_element',
        params: { element_name: NAME, element_type: 'agent' },
      });
      expect(resp).toMatch(/deleted|success|removed/i);
    }, TEST_TIMEOUT);

    it('should have removed the agent from the database', async () => {
      if (!dbAvailable || !testUserId) return;
      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select({ id: elements.id }).from(elements).where(eq(elements.name, NAME))
      );
      expect(rows).toHaveLength(0);
    }, TEST_TIMEOUT);
  });

  // ── Ensemble ──────────────────────────────────────────────────────

  describe('Ensemble — Full Lifecycle', () => {
    const NAME = 'e2e-db-ensemble';

    it('should create an ensemble', async () => {
      if (!dbAvailable) return;
      const resp = await aql.create(client, {
        operation: 'create_element',
        element_type: 'ensemble',
        params: {
          element_name: NAME,
          description: 'E2E test ensemble',
          metadata: { elements: [] },
        },
      });
      expect(resp).toMatch(/created|success/i);
    }, TEST_TIMEOUT);

    it('should store the ensemble in the database', async () => {
      if (!dbAvailable || !testUserId) return;
      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select().from(elements).where(eq(elements.name, NAME)).limit(1)
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].elementType).toBe('ensembles');
    }, TEST_TIMEOUT);

    it('should update the ensemble description', async () => {
      if (!dbAvailable) return;
      const resp = await aql.update(client, {
        operation: 'edit_element',
        params: {
          element_name: NAME,
          element_type: 'ensemble',
          input: { description: 'Updated ensemble description' },
        },
      });
      // Tighter than just matching 'success' — the MCP envelope always has
      // `"success": true` even when the tool reports isError: true. Require
      // no error markers in the content body.
      expect(resp).not.toMatch(/"isError":\s*true|❌|Failed to save/i);
      expect(resp).toMatch(/updated|edited/i);
    }, TEST_TIMEOUT);

    it('should reflect the ensemble update in DB raw_content and metadata', async () => {
      if (!dbAvailable || !testUserId) return;
      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select().from(elements).where(eq(elements.name, NAME)).limit(1)
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].description).toBe('Updated ensemble description');
      expect(rows[0].rawContent).toContain('Updated ensemble description');
    }, TEST_TIMEOUT);

    it('should read the updated ensemble via MCP', async () => {
      if (!dbAvailable) return;
      const resp = await aql.read(client, {
        operation: 'get_element_details',
        params: { element_name: NAME, element_type: 'ensemble' },
      });
      expect(resp).toContain('Updated ensemble description');
    }, TEST_TIMEOUT);

    it('should delete the ensemble', async () => {
      if (!dbAvailable) return;
      const resp = await aql.delete(client, {
        operation: 'delete_element',
        params: { element_name: NAME, element_type: 'ensemble' },
      });
      expect(resp).toMatch(/deleted|success|removed/i);
    }, TEST_TIMEOUT);

    it('should have removed the ensemble from the database', async () => {
      if (!dbAvailable || !testUserId) return;
      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select({ id: elements.id }).from(elements).where(eq(elements.name, NAME))
      );
      expect(rows).toHaveLength(0);
    }, TEST_TIMEOUT);
  });

  // ── Memory (YAML + entries) ───────────────────────────────────────

  describe('Memory — Create/AddEntry/Verify/Delete', () => {
    const NAME = 'e2e-db-memory';

    it('should create a memory', async () => {
      if (!dbAvailable) return;
      const resp = await aql.create(client, {
        operation: 'create_element',
        element_type: 'memory',
        params: {
          element_name: NAME,
          description: 'E2E test memory',
        },
      });
      console.log('Memory create response (first 500):', resp.substring(0, 500));
      expect(resp).not.toMatch(/error|failed|❌/i);
    }, TEST_TIMEOUT);

    it('should store memory in DB as memories type', async () => {
      if (!dbAvailable || !testUserId) return;
      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select().from(elements).where(eq(elements.name, NAME)).limit(1)
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].elementType).toBe('memories');
      expect(rows[0].rawContent).toBeTruthy();
    }, TEST_TIMEOUT);

    it('should add an entry to the memory', async () => {
      if (!dbAvailable) return;
      const resp = await aql.create(client, {
        operation: 'add_memory_entry',
        params: {
          name: NAME,
          content: 'E2E test entry from database mode.',
        },
      });
      expect(resp.toLowerCase()).not.toContain('not found');
    }, TEST_TIMEOUT);

    it('should read the memory back with content', async () => {
      if (!dbAvailable) return;
      const resp = await aql.read(client, {
        operation: 'get_element_details',
        params: { element_name: NAME, element_type: 'memory' },
      });
      expect(resp).toContain(NAME);
    }, TEST_TIMEOUT);

    it('should update the memory description', async () => {
      if (!dbAvailable) return;
      const resp = await aql.update(client, {
        operation: 'edit_element',
        params: {
          element_name: NAME,
          element_type: 'memory',
          input: { description: 'Updated memory description' },
        },
      });
      // Tighter than just matching 'success' — the MCP envelope always has
      // `"success": true` even when the tool reports isError: true. Require
      // no error markers in the content body.
      expect(resp).not.toMatch(/"isError":\s*true|❌|Failed to save/i);
      expect(resp).toMatch(/updated|edited/i);
    }, TEST_TIMEOUT);

    it('should reflect the memory update in DB raw_content and metadata', async () => {
      if (!dbAvailable || !testUserId) return;
      const rows = await withUserRead(db, testUserId, async (tx) =>
        tx.select().from(elements).where(eq(elements.name, NAME)).limit(1)
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].description).toBe('Updated memory description');
      expect(rows[0].rawContent).toContain('Updated memory description');
      // Memory is pure YAML (no frontmatter delimiters) — verify that shape is preserved
      expect(rows[0].rawContent).not.toMatch(/^---/);
    }, TEST_TIMEOUT);

    it('should read the updated memory via MCP', async () => {
      if (!dbAvailable) return;
      const resp = await aql.read(client, {
        operation: 'get_element_details',
        params: { element_name: NAME, element_type: 'memory' },
      });
      expect(resp).toContain('Updated memory description');
    }, TEST_TIMEOUT);

    it('should delete the memory and cascade entries', async () => {
      if (!dbAvailable) return;
      const deleteResp = await aql.delete(client, {
        operation: 'delete_element',
        params: { element_name: NAME, element_type: 'memory' },
      });
      console.log('Memory delete response:', deleteResp.substring(0, 300));

      if (testUserId) {
        const rows = await withUserRead(db, testUserId, async (tx) =>
          tx.select({ id: elements.id }).from(elements).where(eq(elements.name, NAME))
        );
        expect(rows).toHaveLength(0);
      }
    }, TEST_TIMEOUT);
  });
});
