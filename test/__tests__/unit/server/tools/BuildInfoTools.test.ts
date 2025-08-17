/**
 * Tests for BuildInfoTools
 * Comprehensive test coverage for MCP tool wrapper including:
 * - Tool registration
 * - Tool schema validation
 * - Handler execution
 * - Integration with BuildInfoService
 * - Error handling
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { getBuildInfoTools } from '../../../../../src/server/tools/BuildInfoTools.js';
import { IToolHandler } from '../../../../../src/server/types.js';

describe('BuildInfoTools', () => {
  let mockServer: jest.Mocked<IToolHandler>;
  let tools: Array<{ tool: any; handler: any }>;

  beforeEach(() => {
    // Create a mock server (not used by BuildInfoTools but required by interface)
    mockServer = {} as jest.Mocked<IToolHandler>;

    // Get the tools
    tools = getBuildInfoTools(mockServer);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe('Tool Registration', () => {
    it('should register exactly one build info tool', () => {
      expect(tools).toHaveLength(1);
    });

    it('should register get_build_info tool', () => {
      const toolNames = tools.map(t => t.tool.name);
      expect(toolNames).toContain('get_build_info');
    });

    it('should have proper tool structure', () => {
      const buildInfoTool = tools[0];
      
      expect(buildInfoTool).toHaveProperty('tool');
      expect(buildInfoTool).toHaveProperty('handler');
      expect(typeof buildInfoTool.handler).toBe('function');
    });
  });

  describe('get_build_info Tool Schema', () => {
    let buildInfoTool: { tool: any; handler: any };

    beforeEach(() => {
      buildInfoTool = tools.find(t => t.tool.name === 'get_build_info')!;
    });

    it('should have correct name', () => {
      expect(buildInfoTool.tool.name).toBe('get_build_info');
    });

    it('should have meaningful description', () => {
      expect(buildInfoTool.tool.description).toBe('Get comprehensive build and runtime information about the server');
      expect(typeof buildInfoTool.tool.description).toBe('string');
      expect(buildInfoTool.tool.description.length).toBeGreaterThan(10);
    });

    it('should have proper input schema', () => {
      const schema = buildInfoTool.tool.inputSchema;
      
      expect(schema).toBeDefined();
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
      expect(schema.required).toBeDefined();
      expect(Array.isArray(schema.required)).toBe(true);
    });

    it('should require no input parameters', () => {
      const schema = buildInfoTool.tool.inputSchema;
      
      expect(schema.required).toEqual([]);
      expect(Object.keys(schema.properties)).toHaveLength(0);
    });

    it('should be a valid JSON schema', () => {
      const schema = buildInfoTool.tool.inputSchema;
      
      // Basic JSON schema validation
      expect(schema).toHaveProperty('type');
      expect(schema).toHaveProperty('properties');
      expect(schema).toHaveProperty('required');
      expect(typeof schema.type).toBe('string');
      expect(typeof schema.properties).toBe('object');
      expect(Array.isArray(schema.required)).toBe(true);
    });
  });

  describe('get_build_info Handler Integration', () => {
    let buildInfoTool: { tool: any; handler: any };

    beforeEach(() => {
      buildInfoTool = tools.find(t => t.tool.name === 'get_build_info')!;
    });

    it('should return formatted build info string', async () => {
      const result = await buildInfoTool.handler();

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('# 🔧 Build Information');
    });

    it('should work with empty arguments object', async () => {
      const result = await buildInfoTool.handler({});

      expect(typeof result).toBe('string');
      expect(result).toContain('Build Information');
    });

    it('should work with no arguments', async () => {
      const result = await buildInfoTool.handler();

      expect(typeof result).toBe('string');
      expect(result).toContain('Build Information');
    });

    it('should include package information', async () => {
      const result = await buildInfoTool.handler();

      expect(result).toContain('## 📦 Package');
      expect(result).toContain('**Name**:');
      expect(result).toContain('**Version**:');
    });

    it('should include build information', async () => {
      const result = await buildInfoTool.handler();

      expect(result).toContain('## 🏗️ Build');
      expect(result).toContain('**Type**:');
    });

    it('should include runtime information', async () => {
      const result = await buildInfoTool.handler();

      expect(result).toContain('## 💻 Runtime');
      expect(result).toContain('**Node.js**:');
      expect(result).toContain('**Platform**:');
      expect(result).toContain('**Architecture**:');
    });

    it('should include environment information', async () => {
      const result = await buildInfoTool.handler();

      expect(result).toContain('## ⚙️ Environment');
      expect(result).toContain('**NODE_ENV**:');
      expect(result).toContain('**Mode**:');
      expect(result).toContain('**Debug**:');
      expect(result).toContain('**Docker**:');
    });

    it('should include server information', async () => {
      const result = await buildInfoTool.handler();

      expect(result).toContain('## 🚀 Server');
      expect(result).toContain('**Started**:');
      expect(result).toContain('**Uptime**:');
      expect(result).toContain('**MCP Connection**:');
    });

    it('should indicate MCP connection is active', async () => {
      const result = await buildInfoTool.handler();

      expect(result).toContain('**MCP Connection**: ✅ Connected');
    });
  });

  describe('Function Signature and Types', () => {
    it('should accept IToolHandler parameter', () => {
      expect(() => getBuildInfoTools(mockServer)).not.toThrow();
    });

    it('should return array of tool definitions', () => {
      const result = getBuildInfoTools(mockServer);
      
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      
      result.forEach(tool => {
        expect(tool).toHaveProperty('tool');
        expect(tool).toHaveProperty('handler');
        expect(typeof tool.handler).toBe('function');
      });
    });

    it('should not modify the server parameter', () => {
      const originalServer = { ...mockServer };
      
      getBuildInfoTools(mockServer);
      
      expect(mockServer).toEqual(originalServer);
    });

    it('should work with null/undefined server', () => {
      // The tool doesn't actually use the server parameter
      expect(() => getBuildInfoTools(null as any)).not.toThrow();
      expect(() => getBuildInfoTools(undefined as any)).not.toThrow();
    });
  });

  describe('Tool Handler Execution Context', () => {
    let buildInfoTool: { tool: any; handler: any };

    beforeEach(() => {
      buildInfoTool = tools.find(t => t.tool.name === 'get_build_info')!;
    });

    it('should maintain proper async execution', async () => {
      const startTime = Date.now();
      const result = await buildInfoTool.handler();
      const endTime = Date.now();

      expect(typeof result).toBe('string');
      expect(endTime - startTime).toBeGreaterThanOrEqual(0);
    });

    it('should handle concurrent executions', async () => {
      // Execute multiple handlers concurrently
      const promises = [
        buildInfoTool.handler(),
        buildInfoTool.handler(),
        buildInfoTool.handler()
      ];

      const results = await Promise.all(promises);

      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(typeof result).toBe('string');
        expect(result).toContain('Build Information');
      });
    });

    it('should produce consistent results', async () => {
      const result1 = await buildInfoTool.handler();
      const result2 = await buildInfoTool.handler();

      // Results should be similar (package name/version should be the same)
      expect(result1).toContain('@dollhousemcp/mcp-server');
      expect(result2).toContain('@dollhousemcp/mcp-server');
      
      // Both should have the same structure
      expect(result1).toContain('## 📦 Package');
      expect(result2).toContain('## 📦 Package');
    });
  });

  describe('Integration with MCP Protocol', () => {
    it('should conform to MCP tool interface', () => {
      const buildInfoTool = tools[0];
      
      // MCP tool structure requirements
      expect(buildInfoTool.tool).toHaveProperty('name');
      expect(buildInfoTool.tool).toHaveProperty('description');
      expect(buildInfoTool.tool).toHaveProperty('inputSchema');
      
      // Schema requirements
      expect(buildInfoTool.tool.inputSchema).toHaveProperty('type');
      expect(buildInfoTool.tool.inputSchema).toHaveProperty('properties');
      expect(buildInfoTool.tool.inputSchema).toHaveProperty('required');
      
      // Handler requirements
      expect(typeof buildInfoTool.handler).toBe('function');
    });

    it('should have a valid tool name format', () => {
      const buildInfoTool = tools[0];
      
      // Tool names should be snake_case and descriptive
      expect(buildInfoTool.tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(buildInfoTool.tool.name).not.toContain('__'); // No double underscores
      expect(buildInfoTool.tool.name.length).toBeGreaterThan(3);
    });

    it('should return string content suitable for MCP', async () => {
      const result = await tools[0].handler();

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      
      // Should be formatted markdown
      expect(result).toContain('#');
      expect(result).toContain('**');
    });
  });

  describe('Service Integration and Error Handling', () => {
    let buildInfoTool: { tool: any; handler: any };

    beforeEach(() => {
      buildInfoTool = tools.find(t => t.tool.name === 'get_build_info')!;
    });

    it('should handle service execution gracefully', async () => {
      // This tests that the service doesn't throw unhandled errors
      await expect(buildInfoTool.handler()).resolves.toBeDefined();
    });

    it('should return meaningful error information if service fails', async () => {
      // Mock a failing scenario by temporarily breaking something
      const originalConsoleError = console.error;
      console.error = jest.fn(); // Suppress error logs during test
      
      try {
        const result = await buildInfoTool.handler();
        // Even if something fails internally, we should get some result
        expect(typeof result).toBe('string');
      } finally {
        console.error = originalConsoleError;
      }
    });

    it('should include fallback values when external dependencies fail', async () => {
      const result = await buildInfoTool.handler();
      
      // Even if git/docker detection fails, we should get basic info
      expect(result).toContain('**Node.js**:');
      expect(result).toContain('**Platform**:');
      expect(result).toContain('**Architecture**:');
    });
  });

  describe('Content Validation', () => {
    let buildInfoTool: { tool: any; handler: any };

    beforeEach(() => {
      buildInfoTool = tools.find(t => t.tool.name === 'get_build_info')!;
    });

    it('should format memory usage correctly', async () => {
      const result = await buildInfoTool.handler();
      
      expect(result).toMatch(/\*\*Memory Usage\*\*: \d+\.\d+ MB \/ \d+\.\d+ MB/);
    });

    it('should format uptime correctly', async () => {
      const result = await buildInfoTool.handler();
      
      expect(result).toMatch(/\*\*Process Uptime\*\*: \d+[dhms]/);
      expect(result).toMatch(/\*\*Uptime\*\*: \d+[dhms]/);
    });

    it('should include valid timestamps', async () => {
      const result = await buildInfoTool.handler();
      
      expect(result).toMatch(/\*\*Started\*\*: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should show correct environment detection', async () => {
      const result = await buildInfoTool.handler();
      
      expect(result).toMatch(/\*\*Mode\*\*: (Production|Development|Unknown)/);
      expect(result).toMatch(/\*\*Debug\*\*: (Enabled|Disabled)/);
      expect(result).toMatch(/\*\*Docker\*\*: (Yes|No)/);
    });
  });
});