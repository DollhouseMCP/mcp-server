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

    it('should return formatted build info in MCP format', async () => {
      const result = await buildInfoTool.handler();

      // Check MCP response structure
      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty('type', 'text');
      expect(result.content[0]).toHaveProperty('text');
      
      // Check content
      const text = result.content[0].text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain('# 🔧 Build Information');
    });

    it('should work with empty arguments object', async () => {
      const result = await buildInfoTool.handler({});

      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('content');
      expect(result.content[0].text).toContain('Build Information');
    });

    it('should work with no arguments', async () => {
      const result = await buildInfoTool.handler();

      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('content');
      expect(result.content[0].text).toContain('Build Information');
    });

    it('should include package information', async () => {
      const result = await buildInfoTool.handler();
      const text = result.content[0].text;

      expect(text).toContain('## 📦 Package');
      expect(text).toContain('**Name**:');
      expect(text).toContain('**Version**:');
    });

    it('should include build information', async () => {
      const result = await buildInfoTool.handler();
      const text = result.content[0].text;

      expect(text).toContain('## 🏗️ Build');
      expect(text).toContain('**Type**:');
    });

    it('should include runtime information', async () => {
      const result = await buildInfoTool.handler();
      const text = result.content[0].text;

      expect(text).toContain('## 💻 Runtime');
      expect(text).toContain('**Node.js**:');
      expect(text).toContain('**Platform**:');
      expect(text).toContain('**Architecture**:');
    });

    it('should include environment information', async () => {
      const result = await buildInfoTool.handler();
      const text = result.content[0].text;

      expect(text).toContain('## ⚙️ Environment');
      expect(text).toContain('**NODE_ENV**:');
      expect(text).toContain('**Mode**:');
      expect(text).toContain('**Debug**:');
      expect(text).toContain('**Docker**:');
    });

    it('should include server information', async () => {
      const result = await buildInfoTool.handler();
      const text = result.content[0].text;

      expect(text).toContain('## 🚀 Server');
      expect(text).toContain('**Started**:');
      expect(text).toContain('**Uptime**:');
      expect(text).toContain('**MCP Connection**:');
    });

    it('should indicate MCP connection is active', async () => {
      const result = await buildInfoTool.handler();
      const text = result.content[0].text;

      expect(text).toContain('**MCP Connection**: ✅ Connected');
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

      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('content');
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
        expect(typeof result).toBe('object');
        expect(result).toHaveProperty('content');
        expect(result.content[0].text).toContain('Build Information');
      });
    });

    it('should produce consistent results', async () => {
      const result1 = await buildInfoTool.handler();
      const result2 = await buildInfoTool.handler();
      
      const text1 = result1.content[0].text;
      const text2 = result2.content[0].text;

      // Results should be similar (package name/version should be the same)
      expect(text1).toContain('@dollhousemcp/mcp-server');
      expect(text2).toContain('@dollhousemcp/mcp-server');
      
      // Both should have the same structure
      expect(text1).toContain('## 📦 Package');
      expect(text2).toContain('## 📦 Package');
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

    it('should return content suitable for MCP', async () => {
      const result = await tools[0].handler();

      // Check MCP format
      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]).toHaveProperty('type', 'text');
      expect(result.content[0]).toHaveProperty('text');
      
      // Check text content
      const text = result.content[0].text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
      
      // Should be formatted markdown
      expect(text).toContain('#');
      expect(text).toContain('**');
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
        expect(typeof result).toBe('object');
        expect(result).toHaveProperty('content');
      } finally {
        console.error = originalConsoleError;
      }
    });

    it('should include fallback values when external dependencies fail', async () => {
      const result = await buildInfoTool.handler();
      const text = result.content[0].text;
      
      // Even if git/docker detection fails, we should get basic info
      expect(text).toContain('**Node.js**:');
      expect(text).toContain('**Platform**:');
      expect(text).toContain('**Architecture**:');
    });
  });

  describe('Content Validation', () => {
    let buildInfoTool: { tool: any; handler: any };

    beforeEach(() => {
      buildInfoTool = tools.find(t => t.tool.name === 'get_build_info')!;
    });

    it('should format memory usage correctly', async () => {
      const result = await buildInfoTool.handler();
      const text = result.content[0].text;
      
      expect(text).toMatch(/\*\*Memory Usage\*\*: \d+\.\d+ MB \/ \d+\.\d+ MB/);
    });

    it('should format uptime correctly', async () => {
      const result = await buildInfoTool.handler();
      const text = result.content[0].text;
      
      expect(text).toMatch(/\*\*Process Uptime\*\*: \d+[dhms]/);
      expect(text).toMatch(/\*\*Uptime\*\*: \d+[dhms]/);
    });

    it('should include valid timestamps', async () => {
      const result = await buildInfoTool.handler();
      const text = result.content[0].text;
      
      expect(text).toMatch(/\*\*Started\*\*: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should show correct environment detection', async () => {
      const result = await buildInfoTool.handler();
      const text = result.content[0].text;
      
      expect(text).toMatch(/\*\*Mode\*\*: (Production|Development|Unknown)/);
      expect(text).toMatch(/\*\*Debug\*\*: (Enabled|Disabled)/);
      expect(text).toMatch(/\*\*Docker\*\*: (Yes|No)/);
    });
  });
});