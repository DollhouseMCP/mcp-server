/**
 * Tests for ElementTools
 * Verifies element tool definitions and handlers
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { getElementTools } from '../../../../../src/server/tools/ElementTools.js';
import { IToolHandler } from '../../../../../src/server/types.js';
import { ElementType } from '../../../../../src/portfolio/types.js';

describe('ElementTools', () => {
  let mockServer: jest.Mocked<IToolHandler>;
  let tools: Array<{ tool: any; handler: any }>;

  beforeEach(() => {
    // Create a mock server with all required methods
    mockServer = {
      listElements: jest.fn().mockResolvedValue({ elements: [] }),
      activateElement: jest.fn().mockResolvedValue({ success: true }),
      deactivateElement: jest.fn().mockResolvedValue({ success: true }),
      getElementDetails: jest.fn().mockResolvedValue({ details: {} }),
      getActiveElements: jest.fn().mockResolvedValue({ active: [] }),
      reloadElements: jest.fn().mockResolvedValue({ reloaded: true }),
      renderTemplate: jest.fn().mockResolvedValue({ rendered: 'content' }),
      executeAgent: jest.fn().mockResolvedValue({ result: 'executed' })
    } as any;

    tools = getElementTools(mockServer);
  });

  describe('Tool Registration', () => {
    it('should register exactly 8 element tools', () => {
      expect(tools).toHaveLength(8);
    });

    it('should have all expected tool names registered', () => {
      const toolNames = tools.map(t => t.tool.name);
      expect(toolNames).toContain('list_elements');
      expect(toolNames).toContain('activate_element');
      expect(toolNames).toContain('deactivate_element');
      expect(toolNames).toContain('get_element_details');
      expect(toolNames).toContain('get_active_elements');
      expect(toolNames).toContain('reload_elements');
      expect(toolNames).toContain('render_template');
      expect(toolNames).toContain('execute_agent');
    });

    it('should have proper descriptions for all tools', () => {
      tools.forEach(tool => {
        expect(tool.tool.description).toBeTruthy();
        expect(typeof tool.tool.description).toBe('string');
        expect(tool.tool.description.length).toBeGreaterThan(10);
      });
    });

    it('should have valid input schemas for all tools', () => {
      tools.forEach(tool => {
        expect(tool.tool.inputSchema).toBeDefined();
        expect(tool.tool.inputSchema.type).toBe('object');
        expect(tool.tool.inputSchema.properties).toBeDefined();
      });
    });
  });

  describe('list_elements handler', () => {
    it('should call server.listElements with correct type', async () => {
      const listTool = tools.find(t => t.tool.name === 'list_elements');
      const args = { type: ElementType.SKILL };

      await listTool!.handler(args);

      expect(mockServer.listElements).toHaveBeenCalledWith(ElementType.SKILL);
      expect(mockServer.listElements).toHaveBeenCalledTimes(1);
    });

    it('should validate element type enum', () => {
      const listTool = tools.find(t => t.tool.name === 'list_elements');
      const enumValues = listTool!.tool.inputSchema.properties.type.enum;

      expect(enumValues).toEqual(Object.values(ElementType));
    });
  });

  describe('activate_element handler', () => {
    it('should call server.activateElement with name and type', async () => {
      const activateTool = tools.find(t => t.tool.name === 'activate_element');
      const args = { name: 'test-skill', type: ElementType.SKILL };

      await activateTool!.handler(args);

      expect(mockServer.activateElement).toHaveBeenCalledWith('test-skill', ElementType.SKILL);
      expect(mockServer.activateElement).toHaveBeenCalledTimes(1);
    });

    it('should require both name and type', () => {
      const activateTool = tools.find(t => t.tool.name === 'activate_element');
      expect(activateTool!.tool.inputSchema.required).toEqual(['name', 'type']);
    });
  });

  describe('deactivate_element handler', () => {
    it('should call server.deactivateElement with name and type', async () => {
      const deactivateTool = tools.find(t => t.tool.name === 'deactivate_element');
      const args = { name: 'test-skill', type: ElementType.SKILL };

      await deactivateTool!.handler(args);

      expect(mockServer.deactivateElement).toHaveBeenCalledWith('test-skill', ElementType.SKILL);
      expect(mockServer.deactivateElement).toHaveBeenCalledTimes(1);
    });
  });

  describe('get_element_details handler', () => {
    it('should call server.getElementDetails with name and type', async () => {
      const detailsTool = tools.find(t => t.tool.name === 'get_element_details');
      const args = { name: 'test-template', type: ElementType.TEMPLATE };

      await detailsTool!.handler(args);

      expect(mockServer.getElementDetails).toHaveBeenCalledWith('test-template', ElementType.TEMPLATE);
      expect(mockServer.getElementDetails).toHaveBeenCalledTimes(1);
    });
  });

  describe('get_active_elements handler', () => {
    it('should call server.getActiveElements with optional type', async () => {
      const activeTool = tools.find(t => t.tool.name === 'get_active_elements');
      const args = { type: ElementType.PERSONA };

      await activeTool!.handler(args);

      expect(mockServer.getActiveElements).toHaveBeenCalledWith(ElementType.PERSONA);
      expect(mockServer.getActiveElements).toHaveBeenCalledTimes(1);
    });

    it('should work without type parameter', async () => {
      const activeTool = tools.find(t => t.tool.name === 'get_active_elements');
      const args = {};

      await activeTool!.handler(args);

      expect(mockServer.getActiveElements).toHaveBeenCalledWith(undefined);
    });

    it('should require type parameter', () => {
      const activeTool = tools.find(t => t.tool.name === 'get_active_elements');
      expect(activeTool!.tool.inputSchema.required).toEqual(['type']);
    });
  });

  describe('reload_elements handler', () => {
    it('should call server.reloadElements with type', async () => {
      const reloadTool = tools.find(t => t.tool.name === 'reload_elements');
      const args = { type: ElementType.AGENT };

      await reloadTool!.handler(args);

      expect(mockServer.reloadElements).toHaveBeenCalledWith(ElementType.AGENT);
      expect(mockServer.reloadElements).toHaveBeenCalledTimes(1);
    });

    it('should require type parameter', () => {
      const reloadTool = tools.find(t => t.tool.name === 'reload_elements');
      expect(reloadTool!.tool.inputSchema.required).toEqual(['type']);
    });
  });

  describe('render_template handler', () => {
    it('should call server.renderTemplate with name and variables', async () => {
      const renderTool = tools.find(t => t.tool.name === 'render_template');
      const args = { 
        name: 'email-template',
        variables: { name: 'John', subject: 'Hello' }
      };

      await renderTool!.handler(args);

      expect(mockServer.renderTemplate).toHaveBeenCalledWith('email-template', { name: 'John', subject: 'Hello' });
      expect(mockServer.renderTemplate).toHaveBeenCalledTimes(1);
    });

    it('should require name and variables', () => {
      const renderTool = tools.find(t => t.tool.name === 'render_template');
      expect(renderTool!.tool.inputSchema.required).toEqual(['name', 'variables']);
    });
  });

  describe('execute_agent handler', () => {
    it('should call server.executeAgent with name and goal', async () => {
      const executeTool = tools.find(t => t.tool.name === 'execute_agent');
      const args = { 
        name: 'task-agent',
        goal: 'Complete the report'
      };

      await executeTool!.handler(args);

      expect(mockServer.executeAgent).toHaveBeenCalledWith('task-agent', 'Complete the report');
      expect(mockServer.executeAgent).toHaveBeenCalledTimes(1);
    });

    it('should require name and goal', () => {
      const executeTool = tools.find(t => t.tool.name === 'execute_agent');
      expect(executeTool!.tool.inputSchema.required).toEqual(['name', 'goal']);
    });
  });

  describe('Type Safety', () => {
    it('should use typed handlers for all tools', () => {
      tools.forEach(tool => {
        // Handler should be a function
        expect(typeof tool.handler).toBe('function');
        
        // Handler should not use 'any' type (check by looking at function string)
        const handlerStr = tool.handler.toString();
        expect(handlerStr).not.toContain('(args: any)');
      });
    });
  });

  describe('Error Handling', () => {
    it('should propagate errors from server methods', async () => {
      const listTool = tools.find(t => t.tool.name === 'list_elements');
      const error = new Error('Database connection failed');
      
      mockServer.listElements.mockRejectedValueOnce(error);

      await expect(listTool!.handler({ type: ElementType.SKILL }))
        .rejects.toThrow('Database connection failed');
    });
  });
});