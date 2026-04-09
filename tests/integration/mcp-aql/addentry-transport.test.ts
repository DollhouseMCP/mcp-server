import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

type CrudTool =
  | 'mcp_aql_create'
  | 'mcp_aql_read'
  | 'mcp_aql_update'
  | 'mcp_aql_delete'
  | 'mcp_aql_execute';

type OperationResult = {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
};

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content?.[0]?.text ?? '';
}

async function callToolJson(
  client: Client,
  tool: CrudTool,
  args: Record<string, unknown>
): Promise<OperationResult> {
  const raw = await client.callTool({ name: tool, arguments: args });
  const text = resultText(raw);
  return JSON.parse(text) as OperationResult;
}

describe('Memory addEntry Transport Regression', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let testDir: string;
  let logDir: string;

  beforeAll(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-addentry-transport-'));
    logDir = path.join(testDir, 'logs');

    await Promise.all([
      fs.mkdir(path.join(testDir, 'personas'), { recursive: true }),
      fs.mkdir(path.join(testDir, 'skills'), { recursive: true }),
      fs.mkdir(path.join(testDir, 'templates'), { recursive: true }),
      fs.mkdir(path.join(testDir, 'agents'), { recursive: true }),
      fs.mkdir(path.join(testDir, 'memories'), { recursive: true }),
      fs.mkdir(path.join(testDir, 'ensembles'), { recursive: true }),
      fs.mkdir(logDir, { recursive: true }),
    ]);

    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined)
    ) as Record<string, string>;

    delete childEnv.JEST_WORKER_ID;
    delete childEnv.NODE_OPTIONS;

    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      env: {
        ...childEnv,
        TEST_MODE: 'true',
        NODE_ENV: 'test',
        HOME: testDir,
        DOLLHOUSE_PORTFOLIO_DIR: testDir,
        DOLLHOUSE_LOG_DIR: logDir,
        DOLLHOUSE_SESSION_ID: 'addentry-transport-test',
        MCP_INTERFACE_MODE: 'mcpaql',
        DOLLHOUSE_WEB_CONSOLE: 'false',
        GITHUB_TOKEN: '',
        GITHUB_TEST_TOKEN: '',
      },
    });

    client = new Client(
      { name: 'addentry-transport-test-client', version: '1.0.0' },
      { capabilities: {} }
    );

    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore cleanup failures in test teardown.
      }
    }

    if (transport) {
      const pid = transport.pid;
      try {
        await transport.close();
      } catch {
        // Ignore cleanup failures in test teardown.
      }

      if (pid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Ignore if the process has already exited.
        }
      }
    }

    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it('should add an entry to the first created memory after explicit confirmation', async () => {
    const createMemory = await callToolJson(client, 'mcp_aql_create', {
      operation: 'create_element',
      element_type: 'memory',
      params: {
        element_name: 'first-memory-regression',
        description: 'First memory created in the transport regression test',
      },
    });
    expect(createMemory.success).toBe(true);

    const confirmAddEntry = await callToolJson(client, 'mcp_aql_execute', {
      operation: 'confirm_operation',
      params: { operation: 'addEntry' },
    });
    expect(confirmAddEntry.success).toBe(true);

    const addEntry = await callToolJson(client, 'mcp_aql_create', {
      operation: 'addEntry',
      params: {
        element_name: 'first-memory-regression',
        content: 'First entry should succeed on the first created memory.',
        tags: ['regression', 'first-memory'],
      },
    });

    expect(addEntry.success).toBe(true);
    expect(addEntry.error).toBeUndefined();

    const secondEntry = await callToolJson(client, 'mcp_aql_create', {
      operation: 'addEntry',
      params: {
        element_name: 'first-memory-regression',
        content: 'Second entry should also succeed on that same first memory.',
        tags: ['regression', 'first-memory', 'follow-up'],
      },
    });

    expect(secondEntry.success).toBe(true);
    expect(secondEntry.error).toBeUndefined();

    const details = await callToolJson(client, 'mcp_aql_read', {
      operation: 'get_element_details',
      params: {
        element_name: 'first-memory-regression',
        element_type: 'memory',
      },
    });

    expect(details.success).toBe(true);
    const rendered = JSON.stringify(details.data ?? {});
    expect(rendered).toContain('First entry should succeed on the first created memory.');
    expect(rendered).toContain('Second entry should also succeed on that same first memory.');
  });

  it('should allow parallel addEntry calls over stdio after confirmation', async () => {
    const createMemory = await callToolJson(client, 'mcp_aql_create', {
      operation: 'create_element',
      element_type: 'memory',
      params: {
        element_name: 'parallel-memory-regression',
        description: 'Memory for parallel addEntry transport regression coverage',
      },
    });
    expect(createMemory.success).toBe(true);

    const confirmAddEntry = await callToolJson(client, 'mcp_aql_execute', {
      operation: 'confirm_operation',
      params: { operation: 'addEntry' },
    });
    expect(confirmAddEntry.success).toBe(true);

    const entries = [
      'Parallel entry 1: requirements gathered.',
      'Parallel entry 2: design decisions made.',
      'Parallel entry 3: implementation notes recorded.',
    ];

    const results = await Promise.all(
      entries.map(content => callToolJson(client, 'mcp_aql_create', {
        operation: 'addEntry',
        params: {
          element_name: 'parallel-memory-regression',
          content,
          tags: ['regression', 'parallel'],
        },
      }))
    );

    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    }

    const details = await callToolJson(client, 'mcp_aql_read', {
      operation: 'get_element_details',
      params: {
        element_name: 'parallel-memory-regression',
        element_type: 'memory',
      },
    });

    expect(details.success).toBe(true);
    const rendered = JSON.stringify(details.data ?? {});
    for (const content of entries) {
      expect(rendered).toContain(content);
    }
  });
});
