/**
 * Tests for BuildInfoTools
 * Verifies build info tool definitions and handlers
 */

import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import { getBuildInfoTools } from '../../../../../src/server/tools/BuildInfoTools.js';
import { IToolHandler } from '../../../../../src/server/types.js';

// Mock the generated version module
jest.mock('../../../../../src/generated/version.js', () => ({
  PACKAGE_VERSION: '1.5.2',
  BUILD_TIMESTAMP: '2025-08-17T10:30:00.000Z',
  BUILD_TYPE: 'git',
  PACKAGE_NAME: '@dollhousemcp/mcp-server'
}));

// Mock the git utilities
jest.mock('../../../../../src/utils/git.js', () => ({
  getCurrentGitCommit: jest.fn()
}));

// Mock fs promises
const mockReadFile = jest.fn();
jest.mock('fs/promises', () => ({
  readFile: mockReadFile
}));

describe('BuildInfoTools', () => {
  let mockServer: jest.Mocked<IToolHandler>;
  let tools: Array<{ tool: any; handler: any }>;
  let originalPlatform: string;
  let originalArch: string;
  let originalVersion: string;

  beforeEach(() => {
    // Store original process values
    originalPlatform = process.platform;
    originalArch = process.arch;
    originalVersion = process.version;

    // Create a mock server with getBuildInfo method
    mockServer = {
      getBuildInfo: jest.fn()
    } as any;

    tools = getBuildInfoTools(mockServer);
  });

  afterEach(() => {
    // Restore original process values
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
    Object.defineProperty(process, 'version', { value: originalVersion });
    jest.clearAllMocks();
  });

  describe('Tool Registration', () => {
    it('should register exactly 1 build info tool', () => {
      expect(tools).toHaveLength(1);
    });

    it('should register get_build_info tool', () => {
      const toolNames = tools.map(t => t.tool.name);
      expect(toolNames).toContain('get_build_info');
    });

    it('should have proper tool definition structure', () => {
      const buildInfoTool = tools.find(t => t.tool.name === 'get_build_info');
      expect(buildInfoTool).toBeDefined();
      expect(buildInfoTool!.tool.name).toBe('get_build_info');
      expect(buildInfoTool!.tool.description).toBe('Get comprehensive build and runtime information about the DollhouseMCP server');
      expect(buildInfoTool!.tool.inputSchema).toEqual({
        type: "object",
        properties: {},
      });
    });

    it('should have handler that calls server.getBuildInfo', () => {
      const buildInfoTool = tools.find(t => t.tool.name === 'get_build_info');
      expect(buildInfoTool!.handler).toBeDefined();
      
      buildInfoTool!.handler();
      expect(mockServer.getBuildInfo).toHaveBeenCalledWith();
    });
  });

  describe('Tool Input Schema Validation', () => {
    it('should have empty input schema for get_build_info', () => {
      const tool = tools.find(t => t.tool.name === 'get_build_info')!.tool;
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toEqual({});
    });
  });

  describe('Handler Function', () => {
    it('should return a function that calls server.getBuildInfo', () => {
      const buildInfoTool = tools.find(t => t.tool.name === 'get_build_info');
      expect(typeof buildInfoTool!.handler).toBe('function');
      
      const result = buildInfoTool!.handler();
      expect(mockServer.getBuildInfo).toHaveBeenCalledTimes(1);
      expect(mockServer.getBuildInfo).toHaveBeenCalledWith();
    });
  });

  describe('Tool Integration Test', () => {
    it('should successfully call getBuildInfo method through tool handler', async () => {
      // Create a mock implementation that returns expected structure
      const mockBuildInfo = {
        content: [{
          type: "text",
          text: "🏗️ DollhouseMCP Build Information:\n\n📦 **Package**: @dollhousemcp/mcp-server v1.5.2"
        }]
      };

      mockServer.getBuildInfo = jest.fn().mockResolvedValue(mockBuildInfo);
      
      const buildInfoTool = tools.find(t => t.tool.name === 'get_build_info');
      const result = await buildInfoTool!.handler();

      expect(mockServer.getBuildInfo).toHaveBeenCalledWith();
      expect(result).toEqual(mockBuildInfo);
    });
  });
});