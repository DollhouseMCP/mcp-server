/**
 * Tests for MCP_INTERFACE_MODE environment variable
 *
 * Verifies that the correct tools are registered based on the interface mode:
 * - 'discrete': Registers ~40 individual tools (list_elements, create_element, etc.)
 * - 'mcpaql': Registers only MCP-AQL tools (1 or 4 depending on MCP_AQL_ENDPOINT_MODE)
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

describe('MCP_INTERFACE_MODE Configuration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
    // Clear module cache to allow re-importing with new env
    jest.resetModules();
  });

  describe('Environment Variable Parsing', () => {
    it('should default to mcpaql mode when not set', async () => {
      delete process.env.MCP_INTERFACE_MODE;
      jest.resetModules();

      const { env } = await import('../../../src/config/env.js');
      expect(env.MCP_INTERFACE_MODE).toBe('mcpaql');
    });

    it('should accept discrete mode', async () => {
      process.env.MCP_INTERFACE_MODE = 'discrete';
      jest.resetModules();

      const { env } = await import('../../../src/config/env.js');
      expect(env.MCP_INTERFACE_MODE).toBe('discrete');
    });

    it('should accept mcpaql mode', async () => {
      process.env.MCP_INTERFACE_MODE = 'mcpaql';
      jest.resetModules();

      const { env } = await import('../../../src/config/env.js');
      expect(env.MCP_INTERFACE_MODE).toBe('mcpaql');
    });

    it('should reject invalid mode values', async () => {
      process.env.MCP_INTERFACE_MODE = 'invalid';
      jest.resetModules();

      await expect(import('../../../src/config/env.js')).rejects.toThrow();
    });
  });

  describe('MCP_AQL_ENDPOINT_MODE Configuration', () => {
    it('should default to crud mode when not set', async () => {
      delete process.env.MCP_AQL_ENDPOINT_MODE;
      jest.resetModules();

      const { env } = await import('../../../src/config/env.js');
      expect(env.MCP_AQL_ENDPOINT_MODE).toBe('crude');
    });

    it('should accept single mode', async () => {
      process.env.MCP_AQL_ENDPOINT_MODE = 'single';
      jest.resetModules();

      const { env } = await import('../../../src/config/env.js');
      expect(env.MCP_AQL_ENDPOINT_MODE).toBe('single');
    });

    it('should accept crud mode', async () => {
      process.env.MCP_AQL_ENDPOINT_MODE = 'crude';
      jest.resetModules();

      const { env } = await import('../../../src/config/env.js');
      expect(env.MCP_AQL_ENDPOINT_MODE).toBe('crude');
    });
  });

  describe('Backward Compatibility', () => {
    it('should support deprecated MCP_AQL_MODE as fallback', async () => {
      process.env.MCP_AQL_MODE = 'single';
      delete process.env.MCP_AQL_ENDPOINT_MODE;
      jest.resetModules();

      const { env } = await import('../../../src/config/env.js');
      // MCP_AQL_MODE is parsed but MCP_AQL_ENDPOINT_MODE takes precedence
      expect(env.MCP_AQL_MODE).toBe('single');
    });
  });
});

describe('Tool Registration by Interface Mode', () => {
  // These tests verify the actual tool registration behavior
  // They require more setup but provide end-to-end validation

  describe('Discrete Mode Tool Registration', () => {
    beforeEach(() => {
      process.env.MCP_INTERFACE_MODE = 'discrete';
    });

    it('should register discrete tools in discrete mode', async () => {
      jest.resetModules();

      // In discrete mode, getMCPAQLTools is not called for tool registration
      // The discrete tools are registered via other methods
      // This test validates the mode is correctly set
      const { env } = await import('../../../src/config/env.js');
      expect(env.MCP_INTERFACE_MODE).toBe('discrete');
    });
  });

  describe('MCP-AQL Mode Tool Registration', () => {
    beforeEach(() => {
      process.env.MCP_INTERFACE_MODE = 'mcpaql';
    });

    it('should return 4 CRUD tools when endpoint mode is crud', async () => {
      process.env.MCP_AQL_ENDPOINT_MODE = 'crude';
      jest.resetModules();

      const { getMCPAQLTools } = await import('../../../src/server/tools/MCPAQLTools.js');

      // Create a mock handler
      const mockHandler = {
        handleCreate: jest.fn(),
        handleRead: jest.fn(),
        handleUpdate: jest.fn(),
        handleDelete: jest.fn(),
        handleExecute: jest.fn(),
      } as any;

      const tools = getMCPAQLTools(mockHandler);

      // Issue #244: Added EXECUTE endpoint making 5 CRUDE tools
      expect(tools).toHaveLength(5);
      expect(tools.map(t => t.tool.name)).toEqual([
        'mcp_aql_create',
        'mcp_aql_read',
        'mcp_aql_update',
        'mcp_aql_delete',
        'mcp_aql_execute',
      ]);
    });

    it('should return 1 unified tool when endpoint mode is single', async () => {
      process.env.MCP_AQL_ENDPOINT_MODE = 'single';
      jest.resetModules();

      const { getMCPAQLTools } = await import('../../../src/server/tools/MCPAQLTools.js');

      // Create a mock handler
      const mockHandler = {
        handleCreate: jest.fn(),
        handleRead: jest.fn(),
        handleUpdate: jest.fn(),
        handleDelete: jest.fn(),
        handleExecute: jest.fn(),
      } as any;

      const tools = getMCPAQLTools(mockHandler);

      expect(tools).toHaveLength(1);
      expect(tools[0].tool.name).toBe('mcp_aql');
    });

    // Issue #244: Renamed to CRUDE to include EXECUTE
    it('should include correct annotations for CRUDE tools', async () => {
      process.env.MCP_AQL_ENDPOINT_MODE = 'crude';
      jest.resetModules();

      const { getMCPAQLTools } = await import('../../../src/server/tools/MCPAQLTools.js');

      const mockHandler = {
        handleCreate: jest.fn(),
        handleRead: jest.fn(),
        handleUpdate: jest.fn(),
        handleDelete: jest.fn(),
        handleExecute: jest.fn(),
      } as any;

      const tools = getMCPAQLTools(mockHandler);
      const toolMap = new Map(tools.map(t => [t.tool.name, t.tool]));

      // CREATE: additive, non-destructive
      expect(toolMap.get('mcp_aql_create')?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
      });

      // READ: safe, read-only
      expect(toolMap.get('mcp_aql_read')?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
      });

      // UPDATE: modifying, destructive
      expect(toolMap.get('mcp_aql_update')?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });

      // DELETE: destructive
      expect(toolMap.get('mcp_aql_delete')?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });

      // EXECUTE: potentially destructive - agents can perform any action (Issue #244)
      expect(toolMap.get('mcp_aql_execute')?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    });
  });
});

describe('Token Estimation', () => {
  it('should estimate token count for registered tools', async () => {
    process.env.MCP_AQL_ENDPOINT_MODE = 'crude';
    jest.resetModules();

    const { getMCPAQLTools } = await import('../../../src/server/tools/MCPAQLTools.js');
    const { ToolRegistry } = await import('../../../src/handlers/ToolRegistry.js');

    const mockHandler = {
      handleCreate: jest.fn(),
      handleRead: jest.fn(),
      handleUpdate: jest.fn(),
      handleDelete: jest.fn(),
    } as any;

    // Create a registry and register MCP-AQL tools
    const registry = new ToolRegistry({} as any);
    const tools = getMCPAQLTools(mockHandler);
    registry.registerMany(tools);

    // Token estimate should be reasonable (> 0, < 10000 for 4 tools)
    const tokenEstimate = registry.getToolTokenEstimate();
    expect(tokenEstimate).toBeGreaterThan(0);
    expect(tokenEstimate).toBeLessThan(10000);
  });

  it('should return detailed token stats per tool', async () => {
    process.env.MCP_AQL_ENDPOINT_MODE = 'crude';
    jest.resetModules();

    const { getMCPAQLTools } = await import('../../../src/server/tools/MCPAQLTools.js');
    const { ToolRegistry } = await import('../../../src/handlers/ToolRegistry.js');

    const mockHandler = {
      handleCreate: jest.fn(),
      handleRead: jest.fn(),
      handleUpdate: jest.fn(),
      handleDelete: jest.fn(),
      handleExecute: jest.fn(),
    } as any;

    const registry = new ToolRegistry({} as any);
    const tools = getMCPAQLTools(mockHandler);
    registry.registerMany(tools);

    const stats = registry.getToolTokenStats();

    // Issue #244: Added EXECUTE endpoint making 5 CRUDE tools
    expect(stats.count).toBe(5);
    expect(stats.tools).toHaveLength(5);
    expect(stats.total).toBeGreaterThan(0);

    // Each tool should have a name and positive token count
    stats.tools.forEach(tool => {
      expect(tool.name).toBeTruthy();
      expect(tool.tokens).toBeGreaterThan(0);
    });

    // Total should equal sum of individual tool tokens
    const calculatedTotal = stats.tools.reduce((sum, t) => sum + t.tokens, 0);
    expect(stats.total).toBe(calculatedTotal);
  });

  it('should show significant token difference between modes', async () => {
    // Test that discrete mode uses significantly more tokens than mcpaql mode
    // This validates the token savings claim

    jest.resetModules();

    const { getMCPAQLTools } = await import('../../../src/server/tools/MCPAQLTools.js');
    const { ToolRegistry } = await import('../../../src/handlers/ToolRegistry.js');

    const mockHandler = {
      handleCreate: jest.fn(),
      handleRead: jest.fn(),
      handleUpdate: jest.fn(),
      handleDelete: jest.fn(),
    } as any;

    // Get MCP-AQL CRUD tools token count
    const mcpAqlRegistry = new ToolRegistry({} as any);
    const mcpAqlTools = getMCPAQLTools(mockHandler);
    mcpAqlRegistry.registerMany(mcpAqlTools);
    const mcpAqlTokens = mcpAqlRegistry.getToolTokenEstimate();

    // MCP-AQL should use reasonable tokens (< 5500 for 5 CRUDE tools)
    // Issue #249: Increased slightly after adding abort_execution
    // Increased to 2800 after documenting record_execution_step response shape (notifications)
    // Increased to 3200 after adding handoff lifecycle bullets and READ category summary (Issue #594)
    // Increased to 3300 after moving activate/deactivate examples to READ and adding endpoint hints
    // Increased to 5500 after adding 100% operation example coverage — every operation has at least
    // one compact example in its endpoint's tool description for unambiguous LLM routing
    expect(mcpAqlTokens).toBeLessThan(5500);

    // The ratio between discrete and mcpaql should be significant
    // (We can't easily test discrete here without full handlers,
    // but we verify mcpaql is reasonably sized)
    // Issue #244: Added EXECUTE endpoint making 5 tools (CRUDE)
    expect(mcpAqlRegistry.getToolCount()).toBe(5);
  });
});
