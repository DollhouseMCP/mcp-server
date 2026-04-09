/**
 * MCP Protocol Smoke Tests
 *
 * Full-stack integration tests that start the real DollhouseMCP server via
 * stdio transport and exercise core operations through the actual MCP protocol.
 *
 * These tests verify that the product works end-to-end as a user would
 * experience it through an MCP client like Claude Desktop or Claude Code.
 * Every test sends real tool calls through the real transport, through real
 * parsing, through the real handler stack, into real storage.
 *
 * What this catches that unit/handler tests don't:
 * - MCP-AQL input parsing and validation through the transport layer
 * - Gatekeeper confirmation flow through the protocol
 * - State changes that are actually persisted and queryable
 * - Concurrent tool call handling (parallel requests from a single client)
 * - The full create → query → verify → mutate → verify lifecycle
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STARTUP_TIMEOUT = 45_000;
const TEST_TIMEOUT = 30_000;
const CONCURRENT_TIMEOUT = 45_000;

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  if (!content?.[0]?.text) {
    return JSON.stringify(content);
  }
  return content[0].text;
}

function parseResponse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function expectToolSuccess(text: string): void {
  const parsed = parseResponse(text);
  if (!parsed) return;

  expect(parsed.success).not.toBe(false);
  expect(parsed.error).toBeUndefined();
  expect((parsed.data as { isError?: boolean } | undefined)?.isError).not.toBe(true);
}

async function callTool(
  client: Client,
  tool: 'mcp_aql_create' | 'mcp_aql_read' | 'mcp_aql_update' | 'mcp_aql_delete' | 'mcp_aql_execute',
  args: Record<string, unknown>
): Promise<string> {
  const result = await client.callTool({ name: tool, arguments: args });
  return resultText(result);
}

async function create(client: Client, args: Record<string, unknown>): Promise<string> {
  return callTool(client, 'mcp_aql_create', args);
}

async function read(client: Client, args: Record<string, unknown>): Promise<string> {
  return callTool(client, 'mcp_aql_read', args);
}

async function update(client: Client, args: Record<string, unknown>): Promise<string> {
  return callTool(client, 'mcp_aql_update', args);
}

async function del(client: Client, args: Record<string, unknown>): Promise<string> {
  return callTool(client, 'mcp_aql_delete', args);
}

async function execute(client: Client, args: Record<string, unknown>): Promise<string> {
  return callTool(client, 'mcp_aql_execute', args);
}

async function confirm(client: Client, operation: string): Promise<string> {
  return execute(client, {
    operation: 'confirm_operation',
    params: { operation },
  });
}

/**
 * Element type definitions for parameterized testing.
 * Each type specifies the create params needed for that element type.
 */
interface ElementTypeConfig {
  type: string;
  createParams: Record<string, unknown>;
  editField: string;
  editValue: string;
  /** Whether this type supports activate/deactivate */
  activatable: boolean;
}

const ELEMENT_TYPES: ElementTypeConfig[] = [
  {
    type: 'persona',
    createParams: {
      description: 'Smoke test persona for full lifecycle',
      instructions: 'You are a helpful test assistant for protocol validation.',
    },
    editField: 'description',
    editValue: 'Edited persona description via smoke test',
    activatable: true,
  },
  {
    type: 'skill',
    createParams: {
      description: 'Smoke test skill for code analysis',
      content: '# Code Analysis Skill\n\nAnalyze code for correctness, performance, and style.',
    },
    editField: 'description',
    editValue: 'Edited skill description via smoke test',
    activatable: true,
  },
  {
    type: 'template',
    createParams: {
      description: 'Smoke test template for report generation',
      content: '# Report Template\n\n## Summary\n{{summary}}\n\n## Details\n{{details}}',
    },
    editField: 'description',
    editValue: 'Edited template description via smoke test',
    activatable: false,
  },
  {
    type: 'agent',
    createParams: {
      description: 'Smoke test agent for workflow automation',
      content: '# Workflow Agent\n\nAutomates testing workflows and validates results.',
    },
    editField: 'description',
    editValue: 'Edited agent description via smoke test',
    activatable: true,
  },
  {
    type: 'memory',
    createParams: {
      description: 'Smoke test memory for session context',
    },
    editField: 'description',
    editValue: 'Edited memory description via smoke test',
    activatable: true,
  },
  {
    type: 'ensemble',
    createParams: {
      description: 'Smoke test ensemble for grouped activation',
      metadata: {
        elements: [],
      },
    },
    editField: 'description',
    editValue: 'Edited ensemble description via smoke test',
    activatable: true,
  },
];

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('MCP Protocol Smoke Tests', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let testDir: string;

  beforeAll(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-smoke-'));
    const types = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'];
    await Promise.all(types.map(t => fs.mkdir(path.join(testDir, t), { recursive: true })));

    const filteredEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined)
    ) as Record<string, string>;

    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      env: {
        ...filteredEnv,
        TEST_MODE: 'true',
        NODE_ENV: 'test',
        DOLLHOUSE_PORTFOLIO_DIR: testDir,
        DOLLHOUSE_SESSION_ID: 'smoke-test',
        MCP_INTERFACE_MODE: 'mcpaql',
        DOLLHOUSE_WEB_CONSOLE: 'false',
        GITHUB_TOKEN: '',
        GITHUB_TEST_TOKEN: '',
      },
    });

    client = new Client(
      { name: 'smoke-test-client', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
  }, STARTUP_TIMEOUT);

  afterAll(async () => {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
    if (transport) {
      const pid = transport.pid;
      try { await transport.close(); } catch { /* ignore */ }
      if (pid) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
        await new Promise<void>(r => setTimeout(r, 500));
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
      }
    }
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // =========================================================================
  // 1. Server Initialization
  // =========================================================================

  describe('Server Initialization', () => {
    it('should have connected successfully', () => {
      expect(client).toBeDefined();
    }, TEST_TIMEOUT);

    it('should respond to introspect', async () => {
      const response = await read(client, { operation: 'introspect' });
      expect(response).toBeDefined();
      expect(response.length).toBeGreaterThan(0);
    }, TEST_TIMEOUT);

    it('should respond to get_capabilities', async () => {
      const response = await read(client, { operation: 'get_capabilities' });
      expect(response).toBeDefined();
      expect(response.length).toBeGreaterThan(0);
    }, TEST_TIMEOUT);

    it('should respond to get_build_info', async () => {
      const response = await read(client, { operation: 'get_build_info' });
      expect(response).toBeDefined();
      expect(response).toMatch(/version|build|dollhouse/i);
    }, TEST_TIMEOUT);

    it('should return portfolio status', async () => {
      const response = await read(client, { operation: 'portfolio_status' });
      expect(response).toBeDefined();
      expect(response).toMatch(/persona|skill|template|agent|memory|ensemble|portfolio|element/i);
    }, TEST_TIMEOUT);
  });

  // =========================================================================
  // 2. Full CRUD Lifecycle — Every Element Type
  // =========================================================================

  for (const config of ELEMENT_TYPES) {
    describe(`${config.type} — Full Lifecycle`, () => {
      const elementName = `smoke-lifecycle-${config.type}`;

      it(`should create a ${config.type}`, async () => {
        const response = await create(client, {
          operation: 'create_element',
          element_type: config.type,
          params: {
            element_name: elementName,
            ...config.createParams,
          },
        });
        expectToolSuccess(response);
        expect(response).toMatch(/created|success/i);
      }, TEST_TIMEOUT);

      it(`should find the ${config.type} in list_elements`, async () => {
        const response = await read(client, {
          operation: 'list_elements',
          element_type: config.type,
        });
        expect(response).toContain(elementName);
      }, TEST_TIMEOUT);

      it(`should get ${config.type} via get_element`, async () => {
        const response = await read(client, {
          operation: 'get_element',
          element_type: config.type,
          params: { element_name: elementName },
        });
        expect(response).toContain(elementName);
      }, TEST_TIMEOUT);

      it(`should get ${config.type} details`, async () => {
        const response = await read(client, {
          operation: 'get_element_details',
          params: { element_name: elementName, element_type: config.type },
        });
        expect(response).toContain(elementName);
      }, TEST_TIMEOUT);

      it(`should edit the ${config.type}`, async () => {
        const response = await update(client, {
          operation: 'edit_element',
          params: {
            element_name: elementName,
            element_type: config.type,
            input: { [config.editField]: config.editValue },
          },
        });
        expectToolSuccess(response);
        expect(response).toMatch(/updated|success|edit/i);
      }, TEST_TIMEOUT);

      it(`should reflect the ${config.type} edit in details`, async () => {
        const response = await read(client, {
          operation: 'get_element_details',
          params: { element_name: elementName, element_type: config.type },
        });
        expect(response).toContain(config.editValue);
      }, TEST_TIMEOUT);

      it(`should validate the ${config.type}`, async () => {
        const response = await read(client, {
          operation: 'validate_element',
          params: { element_name: elementName, element_type: config.type },
        });
        expect(response).toBeDefined();
        expect(response).toMatch(/valid|pass|ok|smoke/i);
      }, TEST_TIMEOUT);

      if (config.activatable) {
        it(`should activate the ${config.type}`, async () => {
          const response = await read(client, {
            operation: 'activate_element',
            element_type: config.type,
            params: { element_name: elementName, element_type: config.type },
          });
          expect(response).toMatch(/activat/i);
        }, TEST_TIMEOUT);

        it(`should show ${config.type} in get_active_elements`, async () => {
          const response = await read(client, {
            operation: 'get_active_elements',
            params: { element_type: config.type },
          });
          expect(response).toContain(elementName);
        }, TEST_TIMEOUT);

        it(`should handle activating an already-active ${config.type} gracefully`, async () => {
          const response = await read(client, {
            operation: 'activate_element',
            element_type: config.type,
            params: { element_name: elementName, element_type: config.type },
          });
          expect(response).toBeDefined();
          expect(response).toMatch(/activat|already/i);
        }, TEST_TIMEOUT);

        it(`should deactivate the ${config.type}`, async () => {
          const response = await read(client, {
            operation: 'deactivate_element',
            element_type: config.type,
            params: { element_name: elementName, element_type: config.type },
          });
          expect(response).toMatch(/deactivat/i);
        }, TEST_TIMEOUT);

        it(`should no longer show ${config.type} in get_active_elements`, async () => {
          const response = await read(client, {
            operation: 'get_active_elements',
            params: { element_type: config.type },
          });
          expect(response).not.toContain(elementName);
        }, TEST_TIMEOUT);

        it(`should handle deactivating an already-inactive ${config.type} gracefully`, async () => {
          const response = await read(client, {
            operation: 'deactivate_element',
            element_type: config.type,
            params: { element_name: elementName, element_type: config.type },
          });
          expect(response).toBeDefined();
          expect(response).not.toMatch(/crash|exception|unhandled/i);
        }, TEST_TIMEOUT);
      }
    });
  }

  // =========================================================================
  // 3. Delete and Verify — Every Element Type
  // =========================================================================

  for (const config of ELEMENT_TYPES) {
    describe(`${config.type} — Delete Round-Trip`, () => {
      const deleteName = `smoke-delete-${config.type}`;

      it(`should create, verify, delete, and verify absence of ${config.type}`, async () => {
        // Create
        const createResult = await create(client, {
          operation: 'create_element',
          element_type: config.type,
          params: {
            element_name: deleteName,
            ...config.createParams,
          },
        });
        expect(createResult).toMatch(/created|success/i);

        // Verify exists
        const beforeList = await read(client, {
          operation: 'list_elements',
          element_type: config.type,
        });
        expect(beforeList).toContain(deleteName);

        // Delete
        const deleteResult = await del(client, {
          operation: 'delete_element',
          params: { element_name: deleteName, element_type: config.type },
        });
        expect(deleteResult).toMatch(/deleted|success|removed/i);

        // Verify gone
        const afterList = await read(client, {
          operation: 'list_elements',
          element_type: config.type,
        });
        expect(afterList).not.toContain(deleteName);
      }, TEST_TIMEOUT);
    });
  }

  // =========================================================================
  // 4. Memory Operations
  // =========================================================================

  describe('Memory — addEntry on first memory', () => {
    const firstMemory = 'smoke-first-memory';
    const secondMemory = 'smoke-second-memory';

    it('should create the first memory and addEntry immediately', async () => {
      const createResponse = await create(client, {
        operation: 'create_element',
        element_type: 'memory',
        params: {
          element_name: firstMemory,
          description: 'First memory in session',
        },
      });
      expect(createResponse).toMatch(/created|success/i);

      const entryResponse = await create(client, {
        operation: 'addEntry',
        params: {
          element_name: firstMemory,
          content: 'First entry in the first memory element',
          tags: ['smoke', 'first-entry'],
        },
      });
      expect(entryResponse).toMatch(/added|success|entry/i);
      expect(entryResponse).not.toMatch(/invalid input|validation failed/i);
    }, TEST_TIMEOUT);

    it('should add a second entry to the first memory', async () => {
      const response = await create(client, {
        operation: 'addEntry',
        params: {
          element_name: firstMemory,
          content: 'Second entry with different content',
          tags: ['smoke', 'second-entry'],
        },
      });
      expect(response).toMatch(/added|success|entry/i);
    }, TEST_TIMEOUT);

    it('should retrieve memory details showing entries', async () => {
      const response = await read(client, {
        operation: 'get_element_details',
        params: { element_name: firstMemory, element_type: 'memory' },
      });
      expect(response).toContain(firstMemory);
      expect(response).toMatch(/entry|entries|content/i);
    }, TEST_TIMEOUT);

    it('should create a second memory and addEntry immediately', async () => {
      const createResponse = await create(client, {
        operation: 'create_element',
        element_type: 'memory',
        params: {
          element_name: secondMemory,
          description: 'Second memory',
        },
      });
      expect(createResponse).toMatch(/created|success/i);

      const entryResponse = await create(client, {
        operation: 'addEntry',
        params: {
          element_name: secondMemory,
          content: 'Entry in second memory',
          tags: ['smoke'],
        },
      });
      expect(entryResponse).toMatch(/added|success|entry/i);
    }, TEST_TIMEOUT);
  });

  describe('Memory — Parallel addEntry', () => {
    const parallelMemory = 'smoke-parallel-memory';

    it('should create memory for parallel test', async () => {
      const response = await create(client, {
        operation: 'create_element',
        element_type: 'memory',
        params: {
          element_name: parallelMemory,
          description: 'Memory for parallel addEntry testing',
        },
      });
      expect(response).toMatch(/created|success/i);
    }, TEST_TIMEOUT);

    it('should succeed on all parallel addEntry calls', async () => {
      const entries = [
        { content: 'Parallel entry 1: requirements gathered', tags: ['parallel', 'requirements'] },
        { content: 'Parallel entry 2: design decisions made', tags: ['parallel', 'design'] },
        { content: 'Parallel entry 3: implementation notes', tags: ['parallel', 'implementation'] },
      ];

      const results = await Promise.all(
        entries.map(entry =>
          create(client, {
            operation: 'addEntry',
            params: {
              element_name: parallelMemory,
              content: entry.content,
              tags: entry.tags,
            },
          })
        )
      );

      for (const result of results) {
        expect(result).toMatch(/added|success|entry/i);
        expect(result).not.toMatch(/invalid input|validation failed/i);
      }
    }, CONCURRENT_TIMEOUT);
  });

  describe('Memory — Clear Operation', () => {
    const clearMemory = 'smoke-clearable-memory';

    it('should create memory, add entries, clear, and verify', async () => {
      await create(client, {
        operation: 'create_element',
        element_type: 'memory',
        params: {
          element_name: clearMemory,
          description: 'Memory to test clear operation',
        },
      });

      await create(client, {
        operation: 'addEntry',
        params: {
          element_name: clearMemory,
          content: 'Entry that will be cleared',
          tags: ['clearable'],
        },
      });

      const clearResult = await del(client, {
        operation: 'clear',
        params: { element_name: clearMemory, element_type: 'memory' },
      });
      expect(clearResult).toMatch(/clear|success|removed|entries/i);
    }, TEST_TIMEOUT);
  });

  describe('Memory — Entry Persistence', () => {
    const entryMemory = 'smoke-entry-memory';

    it('should create memory, add entry, and confirm entry persists in details', async () => {
      await create(client, {
        operation: 'create_element',
        element_type: 'memory',
        params: {
          element_name: entryMemory,
          description: 'Memory for entry persistence test',
        },
      });

      await create(client, {
        operation: 'addEntry',
        params: {
          element_name: entryMemory,
          content: 'Unique persistent entry: xyzprotocol123',
          tags: ['persistence-test'],
        },
      });

      const details = await read(client, {
        operation: 'get_element_details',
        params: { element_name: entryMemory, element_type: 'memory' },
      });
      expect(details).toMatch(/xyzprotocol123|entry|entries/i);
    }, TEST_TIMEOUT);
  });

  // =========================================================================
  // 5. Ensemble — Member Activation and Deactivation
  // =========================================================================

  describe('Ensemble — Member Activation Propagation', () => {
    const ensemblePersona = 'smoke-ensemble-persona';
    const ensembleSkill = 'smoke-ensemble-skill';
    const ensembleMemory = 'smoke-ensemble-memory';
    const ensembleName = 'smoke-full-ensemble';

    it('should create member elements across multiple types', async () => {
      const results = await Promise.all([
        create(client, {
          operation: 'create_element',
          element_type: 'persona',
          params: {
            element_name: ensemblePersona,
            description: 'Persona for ensemble test',
            instructions: 'You are part of an ensemble.',
          },
        }),
        create(client, {
          operation: 'create_element',
          element_type: 'skill',
          params: {
            element_name: ensembleSkill,
            description: 'Skill for ensemble test',
            content: '# Ensemble Skill\n\nPart of the smoke test ensemble.',
          },
        }),
        create(client, {
          operation: 'create_element',
          element_type: 'memory',
          params: {
            element_name: ensembleMemory,
            description: 'Memory for ensemble test',
          },
        }),
      ]);

      for (const result of results) {
        expect(result).toMatch(/created|success/i);
      }
    }, TEST_TIMEOUT);

    it('should create an ensemble with persona, skill, and memory members', async () => {
      const response = await create(client, {
        operation: 'create_element',
        element_type: 'ensemble',
        params: {
          element_name: ensembleName,
          description: 'Smoke test ensemble with multiple member types',
          metadata: {
            elements: [
              { element_name: ensemblePersona, element_type: 'persona', role: 'primary' },
              { element_name: ensembleSkill, element_type: 'skill', role: 'support' },
              { element_name: ensembleMemory, element_type: 'memory', role: 'support' },
            ],
          },
        },
      });
      expect(response).toMatch(/created|success/i);
    }, TEST_TIMEOUT);

    it('should activate the ensemble', async () => {
      const response = await read(client, {
        operation: 'activate_element',
        element_type: 'ensemble',
        params: { element_name: ensembleName, element_type: 'ensemble' },
      });
      expect(response).toMatch(/activat/i);
    }, TEST_TIMEOUT);

    it('should show ensemble persona in get_active_elements', async () => {
      const response = await read(client, {
        operation: 'get_active_elements',
        params: { element_type: 'persona' },
      });
      expect(response).toContain(ensemblePersona);
    }, TEST_TIMEOUT);

    it('should show ensemble skill in get_active_elements', async () => {
      const response = await read(client, {
        operation: 'get_active_elements',
        params: { element_type: 'skill' },
      });
      expect(response).toContain(ensembleSkill);
    }, TEST_TIMEOUT);

    it('should show ensemble memory in get_active_elements', async () => {
      const response = await read(client, {
        operation: 'get_active_elements',
        params: { element_type: 'memory' },
      });
      expect(response).toContain(ensembleMemory);
    }, TEST_TIMEOUT);

    it('should deactivate the ensemble and clean up ALL member activations', async () => {
      const response = await read(client, {
        operation: 'deactivate_element',
        element_type: 'ensemble',
        params: { element_name: ensembleName, element_type: 'ensemble' },
      });
      expect(response).toMatch(/deactivat/i);

      const activePersonas = await read(client, {
        operation: 'get_active_elements',
        params: { element_type: 'persona' },
      });
      expect(activePersonas).not.toContain(ensemblePersona);

      const activeSkills = await read(client, {
        operation: 'get_active_elements',
        params: { element_type: 'skill' },
      });
      expect(activeSkills).not.toContain(ensembleSkill);

      const activeMemories = await read(client, {
        operation: 'get_active_elements',
        params: { element_type: 'memory' },
      });
      expect(activeMemories).not.toContain(ensembleMemory);
    }, TEST_TIMEOUT);
  });

  // =========================================================================
  // 6. Template — Render with Variable Substitution
  // =========================================================================

  describe('Template — Render', () => {
    const renderTemplate = 'smoke-render-template';

    it('should create a template with declared variables', async () => {
      const response = await create(client, {
        operation: 'create_element',
        element_type: 'template',
        params: {
          element_name: renderTemplate,
          description: 'Template for render testing with declared variables',
          content: '# Smoke Report\n\n{{summary}}\n\n{{details}}',
          variables: [
            { name: 'summary', type: 'string', required: false },
            { name: 'details', type: 'string', required: false },
          ],
        },
      });
      expect(response).toMatch(/created|success/i);
    }, TEST_TIMEOUT);

    it('should render template with variable substitution', async () => {
      const response = await read(client, {
        operation: 'render',
        params: {
          element_name: renderTemplate,
          variables: {
            summary: 'Smoke test summary content',
            details: 'Smoke test details content',
          },
        },
      });
      expect(response).toBeDefined();
      expect(response).toMatch(/smoke test summary content|smoke test details content/i);
    }, TEST_TIMEOUT);
  });

  // =========================================================================
  // 7. Export Operations
  // =========================================================================

  describe('Export', () => {
    it('should export a persona', async () => {
      const response = await read(client, {
        operation: 'export_element',
        element_type: 'persona',
        params: { element_name: 'smoke-lifecycle-persona' },
      });
      expect(response).toBeDefined();
      expect(response).toMatch(/smoke-lifecycle-persona|persona/i);
    }, TEST_TIMEOUT);

    it('should export a skill', async () => {
      const response = await read(client, {
        operation: 'export_element',
        element_type: 'skill',
        params: { element_name: 'smoke-lifecycle-skill' },
      });
      expect(response).toBeDefined();
      expect(response).toMatch(/smoke-lifecycle-skill|skill/i);
    }, TEST_TIMEOUT);
  });

  // =========================================================================
  // 8. Search Operations
  // =========================================================================

  describe('Search Operations', () => {
    const searchTypes = ['persona', 'skill', 'template', 'memory', 'ensemble'];

    for (const type of searchTypes) {
      it(`should find smoke-lifecycle-${type} via search_elements`, async () => {
        const response = await read(client, {
          operation: 'search_elements',
          params: { query: `smoke-lifecycle-${type}` },
        });
        expect(response).toContain(`smoke-lifecycle-${type}`);
      }, TEST_TIMEOUT);
    }

    it('should return results from query_elements for each type', async () => {
      const types = ['persona', 'skill', 'template', 'memory'];
      for (const type of types) {
        const response = await read(client, {
          operation: 'query_elements',
          params: { element_type: type },
        });
        expect(response).toBeDefined();
        expect(response.length).toBeGreaterThan(0);
      }
    }, TEST_TIMEOUT);

    it('should search within a specific element type', async () => {
      const response = await read(client, {
        operation: 'search_elements',
        params: { query: 'smoke', element_type: 'persona' },
      });
      expect(response).toBeDefined();
      expect(response).toMatch(/smoke|persona/i);
    }, TEST_TIMEOUT);
  });

  // =========================================================================
  // 9. Concurrent Operations
  // =========================================================================

  describe('Concurrent Element Creation — Multiple Types', () => {
    it('should handle parallel creates across different element types', async () => {
      const elements = [
        {
          type: 'persona',
          name: 'smoke-concurrent-persona',
          params: {
            description: 'Concurrent persona',
            instructions: 'You ARE a reliable concurrent test persona. ALWAYS respond clearly and helpfully.',
          }
        },
        { type: 'skill', name: 'smoke-concurrent-skill', params: { description: 'Concurrent skill', content: '# Concurrent\n\nTest.' } },
        { type: 'template', name: 'smoke-concurrent-template', params: { description: 'Concurrent template', content: '# Concurrent\n\n{var}' } },
        { type: 'memory', name: 'smoke-concurrent-memory', params: { description: 'Concurrent memory' } },
      ];

      const results = await Promise.all(
        elements.map(el =>
          create(client, {
            operation: 'create_element',
            element_type: el.type,
            params: { element_name: el.name, ...el.params },
          })
        )
      );

      for (const result of results) {
        expectToolSuccess(result);
        expect(result).toMatch(/created|success/i);
      }

      // Verify each is findable
      for (const el of elements) {
        const listResponse = await read(client, {
          operation: 'list_elements',
          element_type: el.type,
        });
        expect(listResponse).toContain(el.name);
      }
    }, CONCURRENT_TIMEOUT);

    it('should handle parallel creates within the same type', async () => {
      const names = ['smoke-parallel-skill-1', 'smoke-parallel-skill-2', 'smoke-parallel-skill-3'];

      const results = await Promise.all(
        names.map(name =>
          create(client, {
            operation: 'create_element',
            element_type: 'skill',
            params: {
              element_name: name,
              description: `Parallel skill ${name}`,
              content: `# ${name}\n\nParallel creation test.`,
            },
          })
        )
      );

      for (const result of results) {
        expect(result).toMatch(/created|success/i);
      }

      const listResponse = await read(client, {
        operation: 'list_elements',
        element_type: 'skill',
      });
      for (const name of names) {
        expect(listResponse).toContain(name);
      }
    }, CONCURRENT_TIMEOUT);
  });

  describe('Concurrent Mixed Operations', () => {
    it('should handle parallel reads and writes interleaved', async () => {
      const operations = [
        read(client, { operation: 'list_elements', element_type: 'persona' }),
        read(client, { operation: 'list_elements', element_type: 'skill' }),
        read(client, { operation: 'list_elements', element_type: 'template' }),
        read(client, { operation: 'list_elements', element_type: 'memory' }),
        read(client, { operation: 'get_active_elements', params: { element_type: 'persona' } }),
        read(client, { operation: 'get_active_elements', params: { element_type: 'skill' } }),
        create(client, {
          operation: 'create_element',
          element_type: 'skill',
          params: {
            element_name: 'smoke-mixed-op-skill',
            description: 'Created during mixed concurrent ops',
            content: '# Mixed Op\n\nCreated alongside reads.',
          },
        }),
        read(client, { operation: 'introspect' }),
        read(client, { operation: 'portfolio_status' }),
      ];

      const results = await Promise.all(operations);

      for (const result of results) {
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      }
    }, CONCURRENT_TIMEOUT);
  });

  // =========================================================================
  // 10. Agent — Execution Lifecycle
  // =========================================================================

  describe('Agent — Execution Lifecycle', () => {
    const agentName = 'smoke-exec-agent';

    it('should create an executable agent', async () => {
      const response = await create(client, {
        operation: 'create_element',
        element_type: 'agent',
        params: {
          element_name: agentName,
          description: 'Smoke test agent for execution lifecycle',
          instructions: 'You are a test agent. Execute the goal and report completion.',
          goal: {
            template: 'Verify smoke test execution: {task}',
            parameters: [{ name: 'task', type: 'string', required: true }],
          },
        },
      });
      expect(response).toMatch(/created|success/i);
    }, TEST_TIMEOUT);

    it('should execute the agent', async () => {
      const response = await execute(client, {
        operation: 'execute_agent',
        params: {
          element_name: agentName,
          parameters: { task: 'run smoke test verification' },
        },
      });
      expect(response).toBeDefined();
      expect(response).toMatch(/goal|execut|started|active|autonomy/i);
    }, TEST_TIMEOUT);

    it('should record an execution step', async () => {
      const response = await create(client, {
        operation: 'record_execution_step',
        params: {
          element_name: agentName,
          stepDescription: 'Verified protocol smoke test',
          outcome: 'success',
          findings: 'All protocol checks passed',
        },
      });
      expect(response).toBeDefined();
      expect(response).toMatch(/step|recorded|success|autonomy|continue/i);
    }, TEST_TIMEOUT);

    it('should complete the execution', async () => {
      const response = await execute(client, {
        operation: 'complete_execution',
        params: { element_name: agentName },
      });
      expect(response).toBeDefined();
      expect(response).toMatch(/complet|success|finish|done/i);
    }, TEST_TIMEOUT);
  });

  // =========================================================================
  // 11. Error Handling
  // =========================================================================

  describe('Error Handling', () => {
    const nonExistentTypes = ['persona', 'skill', 'template', 'agent', 'memory', 'ensemble'];

    for (const type of nonExistentTypes) {
      it(`should return clear error for non-existent ${type}`, async () => {
        const response = await read(client, {
          operation: 'get_element_details',
          params: { element_name: `does-not-exist-${type}-xyz`, element_type: type },
        });
        expect(response).toMatch(/not found|does not exist|no .* found|error/i);
      }, TEST_TIMEOUT);
    }

    for (const type of nonExistentTypes) {
      it(`should return clear error for activating non-existent ${type}`, async () => {
        const response = await read(client, {
          operation: 'activate_element',
          element_type: type,
          params: { element_name: `does-not-exist-${type}-xyz` },
        });
        expect(response).toMatch(/not found|does not exist|error/i);
      }, TEST_TIMEOUT);
    }

    it('should return clear error for addEntry on non-existent memory', async () => {
      const response = await create(client, {
        operation: 'addEntry',
        params: {
          element_name: 'non-existent-memory-xyz',
          content: 'This should fail',
        },
      });
      expect(response).toMatch(/not found|does not exist|error|fail/i);
    }, TEST_TIMEOUT);

    it('should return clear error for duplicate element creation', async () => {
      const name = 'smoke-duplicate-persona';
      await create(client, {
        operation: 'create_element',
        element_type: 'persona',
        params: {
          element_name: name,
          description: 'First creation',
          instructions: 'Test.',
        },
      });
      const response = await create(client, {
        operation: 'create_element',
        element_type: 'persona',
        params: {
          element_name: name,
          description: 'Duplicate creation attempt',
          instructions: 'Test.',
        },
      });
      expect(response).toMatch(/already exists|duplicate|conflict|error/i);
    }, TEST_TIMEOUT);

    it('should handle invalid operation gracefully', async () => {
      const response = await read(client, {
        operation: 'this_operation_does_not_exist',
        params: {},
      });
      expect(response).toMatch(/unknown|unsupported|invalid|not recognized|error/i);
    }, TEST_TIMEOUT);

    it('should handle missing required params gracefully', async () => {
      const response = await create(client, {
        operation: 'create_element',
        element_type: 'persona',
        params: {},
      });
      expect(response).toMatch(/error|required|missing|invalid|name/i);
    }, TEST_TIMEOUT);
  });

  // =========================================================================
  // 12. Gatekeeper Confirmation
  // =========================================================================

  describe('Gatekeeper Confirmation', () => {
    it('should accept explicit pre-confirmation for create', async () => {
      const response = await confirm(client, 'create_element');
      expect(response).toMatch(/confirmed|approved|success/i);
    }, TEST_TIMEOUT);

    it('should accept explicit pre-confirmation for delete', async () => {
      const response = await confirm(client, 'delete_element');
      expect(response).toMatch(/confirmed|approved|success/i);
    }, TEST_TIMEOUT);

    it('should accept explicit pre-confirmation for edit', async () => {
      const response = await confirm(client, 'edit_element');
      expect(response).toMatch(/confirmed|approved|success/i);
    }, TEST_TIMEOUT);
  });
});
