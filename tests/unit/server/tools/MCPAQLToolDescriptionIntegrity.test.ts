/**
 * Tool Description ↔ Operation Route Integrity (Issue #535)
 *
 * Cross-validates that operation examples in CRUDE tool descriptions only
 * reference operations belonging to that endpoint per OPERATION_ROUTES.
 *
 * This prevents LLM misrouting caused by misleading examples — e.g., an
 * activate_element example in the CREATE description causes LLMs to call
 * activate_element via mcp_aql_create instead of mcp_aql_read.
 *
 * Intentional cross-references (e.g., "Discover required parameters — use
 * mcp_aql_read: { operation: "introspect" ... }") are exempted when the
 * surrounding text explicitly directs users to the correct endpoint.
 */

import { OPERATION_ROUTES, getOperationsForEndpoint } from '../../../../src/handlers/mcp-aql/OperationRouter.js';
import type { CRUDEndpoint } from '../../../../src/handlers/mcp-aql/OperationRouter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map from tool name suffix to CRUDE endpoint.
 * mcp_aql_create → CREATE, mcp_aql_read → READ, etc.
 */
const TOOL_ENDPOINT_MAP: Record<string, CRUDEndpoint> = {
  create: 'CREATE',
  read: 'READ',
  update: 'UPDATE',
  delete: 'DELETE',
  execute: 'EXECUTE',
};

/**
 * Extract operation names from JSON-like example objects in a description string.
 * Matches patterns like: operation: "some_operation" or "operation": "some_operation"
 */
function extractExampleOperations(description: string): Array<{ operation: string; context: string }> {
  const results: Array<{ operation: string; context: string }> = [];
  // Match both { operation: "name" } and "operation": "name" patterns
  const regex = /["']?operation["']?\s*:\s*["']([a-zA-Z_]+)["']/g;
  let match;
  while ((match = regex.exec(description)) !== null) {
    // Get ~80 chars of surrounding context to check for endpoint hints
    const start = Math.max(0, match.index - 80);
    const end = Math.min(description.length, match.index + match[0].length + 80);
    const context = description.slice(start, end);
    results.push({ operation: match[1], context });
  }
  return results;
}

/**
 * Check if an example has an explicit cross-reference hint directing the user
 * to the correct endpoint. E.g., "use mcp_aql_read:" or "via mcp_aql_execute"
 */
function hasExplicitEndpointHint(context: string, correctEndpoint: CRUDEndpoint): boolean {
  const correctToolName = `mcp_aql_${correctEndpoint.toLowerCase()}`;
  // Check for patterns like "use mcp_aql_read", "via mcp_aql_execute"
  return context.includes(correctToolName);
}

// ---------------------------------------------------------------------------
// Dynamically load tool descriptions
// ---------------------------------------------------------------------------

/**
 * We read MCPAQLTools.ts source to extract tool descriptions because:
 * 1. getCRUDETools() requires an MCPAQLHandler instance (needs full DI container)
 * 2. The descriptions are template literals with dynamic getOperationsString() calls
 *
 * Instead we parse the built output which has the interpolated strings.
 */
async function getToolDescriptions(): Promise<Record<string, string>> {
  // Import the built module to get access to getMCPAQLTools
  // We need a mock handler since we only care about descriptions
  const { getMCPAQLTools } = await import('../../../../src/server/tools/MCPAQLTools.js');

  // Create a minimal mock handler — we only access .tool.description, never call handlers
  const mockHandler = new Proxy({}, {
    get: () => () => Promise.resolve({ success: true }),
  });

  // Force CRUDE mode
  const originalMode = process.env.MCP_AQL_ENDPOINT_MODE;
  process.env.MCP_AQL_ENDPOINT_MODE = 'crude';

  try {
    const tools = getMCPAQLTools(mockHandler as any);
    const descriptions: Record<string, string> = {};
    for (const { tool } of tools) {
      descriptions[tool.name] = tool.description;
    }
    return descriptions;
  } finally {
    if (originalMode !== undefined) {
      process.env.MCP_AQL_ENDPOINT_MODE = originalMode;
    } else {
      delete process.env.MCP_AQL_ENDPOINT_MODE;
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tool Description ↔ Operation Route Integrity (Issue #535)', () => {
  let toolDescriptions: Record<string, string>;

  beforeAll(async () => {
    toolDescriptions = await getToolDescriptions();
  });

  it('should have descriptions for all 5 CRUDE tools', () => {
    expect(Object.keys(toolDescriptions).sort()).toEqual([
      'mcp_aql_create',
      'mcp_aql_delete',
      'mcp_aql_execute',
      'mcp_aql_read',
      'mcp_aql_update',
    ]);
  });

  describe('Example operations match their tool endpoint', () => {
    for (const [suffix, endpoint] of Object.entries(TOOL_ENDPOINT_MAP)) {
      const toolName = `mcp_aql_${suffix}`;

      it(`${toolName}: all example operations belong to ${endpoint} or have explicit cross-reference hints`, async () => {
        const descriptions = await getToolDescriptions();
        const description = descriptions[toolName];
        expect(description).toBeDefined();

        const examples = extractExampleOperations(description);
        expect(examples.length).toBeGreaterThan(0);

        const violations: string[] = [];

        for (const { operation, context } of examples) {
          const route = OPERATION_ROUTES[operation];
          if (!route) {
            // Unknown operation in example — flag it
            violations.push(`Unknown operation "${operation}" in ${toolName} examples`);
            continue;
          }

          if (route.endpoint === endpoint) {
            // Correct endpoint — no problem
            continue;
          }

          // Wrong endpoint — check for explicit cross-reference hint
          if (hasExplicitEndpointHint(context, route.endpoint)) {
            // Has a hint like "use mcp_aql_read:" or "via mcp_aql_execute"
            continue;
          }

          violations.push(
            `Operation "${operation}" is a ${route.endpoint} operation but appears as an example ` +
            `in ${toolName} (${endpoint}) without an explicit endpoint hint. ` +
            `Add "use mcp_aql_${route.endpoint.toLowerCase()}" near the example or move it to the correct tool.`
          );
        }

        expect(violations).toEqual([]);
      });
    }
  });

  describe('"Supported operations" line matches OPERATION_ROUTES', () => {
    for (const [suffix, endpoint] of Object.entries(TOOL_ENDPOINT_MAP)) {
      const toolName = `mcp_aql_${suffix}`;

      it(`${toolName}: "Supported operations" lists exactly the ${endpoint} operations from OPERATION_ROUTES`, async () => {
        const descriptions = await getToolDescriptions();
        const description = descriptions[toolName];

        // Extract the "Supported operations: ..." line
        const supportedMatch = description.match(/Supported operations:\s*([^\n]+)/);
        expect(supportedMatch).toBeTruthy();

        const listedOps = supportedMatch![1].split(',').map(s => s.trim()).filter(Boolean).sort();
        const routerOps = getOperationsForEndpoint(endpoint as CRUDEndpoint).sort();

        expect(listedOps).toEqual(routerOps);
      });
    }
  });

  describe('Agent execution guidance remains actionable', () => {
    it('mcp_aql_execute documents the canonical loop and paused-only continue semantics', async () => {
      const descriptions = await getToolDescriptions();
      const description = descriptions.mcp_aql_execute;

      expect(description).toContain('mcp_aql_create');
      expect(description).toContain('record_execution_step');
      expect(description).toContain('complete_execution');
      expect(description).toContain('paused');
      expect(description).toContain('not the normal next call after execute_agent');
      expect(description).toContain('deliverable_path');
    });

    it('mcp_aql_create documents record_execution_step as the normal post-execute call', async () => {
      const descriptions = await getToolDescriptions();
      const description = descriptions.mcp_aql_create;

      expect(description).toContain('normal next lifecycle call after mcp_aql_execute');
      expect(description).toContain('record_execution_step');
    });
  });

  describe('100% operation example coverage', () => {
    for (const [suffix, endpoint] of Object.entries(TOOL_ENDPOINT_MAP)) {
      const toolName = `mcp_aql_${suffix}`;

      it(`${toolName}: every ${endpoint} operation has at least one example`, async () => {
        const descriptions = await getToolDescriptions();
        const description = descriptions[toolName];
        expect(description).toBeDefined();

        // Extract all operation names mentioned in examples
        const examples = extractExampleOperations(description);
        const exampledOps = new Set(
          examples
            .map(e => e.operation)
            .filter(op => {
              // Only count operations that belong to THIS endpoint
              // (cross-references to other endpoints don't count as coverage)
              const route = OPERATION_ROUTES[op];
              return route && route.endpoint === endpoint;
            })
        );

        const requiredOps = getOperationsForEndpoint(endpoint as CRUDEndpoint);
        const missing = requiredOps.filter(op => !exampledOps.has(op));

        expect(missing).toEqual([]);
      });
    }
  });

  describe('Audit: operation endpoint semantic alignment', () => {
    /**
     * Documents operations whose endpoint assignment may seem surprising
     * but is a deliberate design choice. These are NOT tensions — they
     * are intentional trade-offs that should be preserved.
     *
     * If an operation is moved to a different endpoint, update OPERATION_ROUTES
     * and these expectations will automatically enforce the new assignment.
     */
    const DELIBERATE_PLACEMENTS: Record<string, { endpoint: CRUDEndpoint; rationale: string }> = {
      activate_element: {
        endpoint: 'READ',
        rationale: 'Semantically a read: the element file is read and its content consumed into session context. No data is created, modified, or destroyed.',
      },
      deactivate_element: {
        endpoint: 'READ',
        rationale: 'Semantically a read: signals the element content has been consumed and the session no longer needs it. The element file itself is unchanged.',
      },
      record_execution_step: {
        endpoint: 'CREATE',
        rationale: 'Appends step records — semantically additive (like addEntry). Lower friction than EXECUTE (CONFIRM_SESSION vs CONFIRM_SINGLE_USE)',
      },
    };

    it.each(Object.entries(DELIBERATE_PLACEMENTS))(
      '%s is on %s endpoint (deliberate placement)',
      (operation, { endpoint }) => {
        const route = OPERATION_ROUTES[operation];
        expect(route).toBeDefined();
        expect(route.endpoint).toBe(endpoint);
      }
    );

    it('documents all deliberate non-obvious placements', () => {
      // If you add an operation whose endpoint seems surprising,
      // document it here so future developers understand the rationale.
      expect(Object.keys(DELIBERATE_PLACEMENTS).sort()).toEqual([
        'activate_element',
        'deactivate_element',
        'record_execution_step',
      ]);
    });
  });
});
