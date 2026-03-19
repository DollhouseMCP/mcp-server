/**
 * Tests for ElementTools
 * Verifies element tool definitions and handlers
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { getElementTools } from '../../../../src/server/tools/ElementTools.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import type { ElementCRUDHandler } from '../../../../src/handlers/ElementCRUDHandler.js';

describe('ElementTools', () => {
  let mockHandler: jest.Mocked<ElementCRUDHandler>;
  let tools: Array<{ tool: any; handler: any }>;

  beforeEach(() => {
    // Create a mock ElementCRUDHandler with all required methods
    mockHandler = {
      listElements: jest.fn<() => Promise<any>>().mockImplementation(() => Promise.resolve({ elements: [] })),
      activateElement: jest.fn<() => Promise<any>>().mockImplementation(() => Promise.resolve({ success: true })),
      deactivateElement: jest.fn<() => Promise<any>>().mockImplementation(() => Promise.resolve({ success: true })),
      getElementDetails: jest.fn<() => Promise<any>>().mockImplementation(() => Promise.resolve({ details: {} })),
      getActiveElements: jest.fn<() => Promise<any>>().mockImplementation(() => Promise.resolve({ active: [] })),
      reloadElements: jest.fn<() => Promise<any>>().mockImplementation(() => Promise.resolve({ reloaded: true })),
      renderTemplate: jest.fn<() => Promise<any>>().mockImplementation(() => Promise.resolve({ rendered: "content" })),
      executeAgent: jest.fn<() => Promise<any>>().mockImplementation(() => Promise.resolve({ result: "executed" })),
      createElement: jest.fn<() => Promise<any>>(() => Promise.resolve({ success: true })),
      editElement: jest.fn<() => Promise<any>>(() => Promise.resolve({ success: true })),
      validateElement: jest.fn<() => Promise<any>>(() => Promise.resolve({ valid: true })),
      deleteElement: jest.fn<() => Promise<any>>(() => Promise.resolve({ success: true })),
      recordAgentStep: jest.fn<() => Promise<any>>(() => Promise.resolve({ success: true })),
      completeAgentGoal: jest.fn<() => Promise<any>>(() => Promise.resolve({ success: true })),
      getAgentState: jest.fn<() => Promise<any>>(() => Promise.resolve({ success: true })),
      continueAgentExecution: jest.fn<() => Promise<any>>(() => Promise.resolve({ success: true }))
    } as any;

    tools = getElementTools(mockHandler);
  });

  describe('Tool Registration', () => {
    it('should register exactly 16 element tools', () => {
      expect(tools).toHaveLength(16);
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
      expect(toolNames).toContain('create_element');
      expect(toolNames).toContain('edit_element');
      expect(toolNames).toContain('validate_element');
      expect(toolNames).toContain('delete_element');
      expect(toolNames).toContain('record_agent_step');
      expect(toolNames).toContain('complete_agent_goal');
      expect(toolNames).toContain('get_agent_state');
      expect(toolNames).toContain('continue_agent_execution');
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
    it('should call handler.listElements with correct type and default options', async () => {
      const listTool = tools.find(t => t.tool.name === 'list_elements');
      const args = { type: ElementType.SKILL };

      await listTool!.handler(args);

      // Issue #38: Now passes QueryOptions as second argument (all undefined = defaults)
      expect(mockHandler.listElements).toHaveBeenCalledWith(ElementType.SKILL, expect.objectContaining({
        pagination: expect.any(Object),
        sort: expect.any(Object),
        filters: expect.any(Object),
      }));
      expect(mockHandler.listElements).toHaveBeenCalledTimes(1);
    });

    it('should pass query options to handler when provided (Issue #38)', async () => {
      const listTool = tools.find(t => t.tool.name === 'list_elements');
      const args = {
        type: ElementType.MEMORY,
        page: 2,
        pageSize: 10,
        sortBy: 'created',
        sortOrder: 'desc',
        nameContains: 'test',
        tags: ['tag1'],
        status: 'active',
      };

      await listTool!.handler(args);

      expect(mockHandler.listElements).toHaveBeenCalledWith(ElementType.MEMORY, {
        pagination: { page: 2, pageSize: 10 },
        sort: { sortBy: 'created', sortOrder: 'desc' },
        filters: {
          nameContains: 'test',
          tags: ['tag1'],
          tagsAny: undefined,
          author: undefined,
          createdAfter: undefined,
          createdBefore: undefined,
          status: 'active',
        },
      });
    });

    it('should validate element type enum includes only MCP-supported types', () => {
      const listTool = tools.find(t => t.tool.name === 'list_elements');
      const enumValues = listTool!.tool.inputSchema.properties.type.enum;

      // Should include every defined element type (mirrors server enum)
      expect(enumValues).toEqual(Object.values(ElementType));
      expect(enumValues).toContain(ElementType.PERSONA);
      expect(enumValues).toContain(ElementType.SKILL);
      expect(enumValues).toContain(ElementType.TEMPLATE);
      expect(enumValues).toContain(ElementType.AGENT);
      expect(enumValues).toContain(ElementType.MEMORY);
      expect(enumValues).toContain(ElementType.ENSEMBLE);
    });
  });

  describe('activate_element handler', () => {
    it('should call handler.activateElement with name and type', async () => {
      const activateTool = tools.find(t => t.tool.name === 'activate_element');
      const args = { name: 'test-skill', type: ElementType.SKILL };

      await activateTool!.handler(args);

      expect(mockHandler.activateElement).toHaveBeenCalledWith('test-skill', ElementType.SKILL);
      expect(mockHandler.activateElement).toHaveBeenCalledTimes(1);
    });

    it('should require both name and type', () => {
      const activateTool = tools.find(t => t.tool.name === 'activate_element');
      expect(activateTool!.tool.inputSchema.required).toEqual(['name', 'type']);
    });
  });

  describe('deactivate_element handler', () => {
    it('should call handler.deactivateElement with name and type', async () => {
      const deactivateTool = tools.find(t => t.tool.name === 'deactivate_element');
      const args = { name: 'test-skill', type: ElementType.SKILL };

      await deactivateTool!.handler(args);

      expect(mockHandler.deactivateElement).toHaveBeenCalledWith('test-skill', ElementType.SKILL);
      expect(mockHandler.deactivateElement).toHaveBeenCalledTimes(1);
    });
  });

  describe('get_element_details handler', () => {
    it('should call handler.getElementDetails with name and type', async () => {
      const detailsTool = tools.find(t => t.tool.name === 'get_element_details');
      const args = { name: 'test-template', type: ElementType.TEMPLATE };

      await detailsTool!.handler(args);

      expect(mockHandler.getElementDetails).toHaveBeenCalledWith('test-template', ElementType.TEMPLATE);
      expect(mockHandler.getElementDetails).toHaveBeenCalledTimes(1);
    });
  });

  describe('get_active_elements handler', () => {
    it('should call handler.getActiveElements with optional type', async () => {
      const activeTool = tools.find(t => t.tool.name === 'get_active_elements');
      const args = { type: ElementType.PERSONA };

      await activeTool!.handler(args);

      expect(mockHandler.getActiveElements).toHaveBeenCalledWith(ElementType.PERSONA);
      expect(mockHandler.getActiveElements).toHaveBeenCalledTimes(1);
    });

    it('should work without type parameter', async () => {
      const activeTool = tools.find(t => t.tool.name === 'get_active_elements');
      const args = {};

      await activeTool!.handler(args);

      expect(mockHandler.getActiveElements).toHaveBeenCalledWith(undefined as any);
    });

    it('should require type parameter', () => {
      const activeTool = tools.find(t => t.tool.name === 'get_active_elements');
      expect(activeTool!.tool.inputSchema.required).toEqual(['type']);
    });
  });

  describe('reload_elements handler', () => {
    it('should call handler.reloadElements with type', async () => {
      const reloadTool = tools.find(t => t.tool.name === 'reload_elements');
      const args = { type: ElementType.AGENT };

      await reloadTool!.handler(args);

      expect(mockHandler.reloadElements).toHaveBeenCalledWith(ElementType.AGENT);
      expect(mockHandler.reloadElements).toHaveBeenCalledTimes(1);
    });

    it('should require type parameter', () => {
      const reloadTool = tools.find(t => t.tool.name === 'reload_elements');
      expect(reloadTool!.tool.inputSchema.required).toEqual(['type']);
    });
  });

  describe('render_template handler', () => {
    it('should call handler.renderTemplate with name and variables', async () => {
      const renderTool = tools.find(t => t.tool.name === 'render_template');
      const args = {
        name: 'email-template',
        variables: { name: 'John', subject: 'Hello' }
      };

      await renderTool!.handler(args);

      expect(mockHandler.renderTemplate).toHaveBeenCalledWith('email-template', { name: 'John', subject: 'Hello' });
      expect(mockHandler.renderTemplate).toHaveBeenCalledTimes(1);
    });

    it('should require name and variables', () => {
      const renderTool = tools.find(t => t.tool.name === 'render_template');
      expect(renderTool!.tool.inputSchema.required).toEqual(['name', 'variables']);
    });
  });

  describe('execute_agent handler', () => {
    it('should call handler.executeAgent with name and parameters', async () => {
      const executeTool = tools.find(t => t.tool.name === 'execute_agent');
      const args = {
        name: 'task-agent',
        parameters: { directory: 'src' }
      };

      await executeTool!.handler(args);

      expect(mockHandler.executeAgent).toHaveBeenCalledWith('task-agent', { directory: 'src' });
      expect(mockHandler.executeAgent).toHaveBeenCalledTimes(1);
    });

    it('should require name and parameters', () => {
      const executeTool = tools.find(t => t.tool.name === 'execute_agent');
      expect(executeTool!.tool.inputSchema.required).toEqual(['name', 'parameters']);
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
    it('should propagate errors from handler methods', async () => {
      const listTool = tools.find(t => t.tool.name === 'list_elements');
      const error = new Error('Database connection failed');

      mockHandler.listElements.mockRejectedValueOnce(error);

      await expect(listTool!.handler({ type: ElementType.SKILL }))
        .rejects.toThrow('Database connection failed');
    });
  });

  /**
   * Drift Prevention Tests
   *
   * These tests ensure that tool schemas stay in sync with handler implementations.
   * If a parameter is added to AgentManager but not to the tool schema, these tests will fail.
   *
   * Issue: PR #385 review identified that nextActionHint and riskScore were added
   * to AgentManager.recordAgentStep but not documented in the tool schema.
   */
  describe('Drift Prevention - Tool Schema/Handler Sync', () => {
    describe('record_agent_step schema', () => {
      it('should document all parameters accepted by AgentManager.recordAgentStep', () => {
        const recordStepTool = tools.find(t => t.tool.name === 'record_agent_step');
        expect(recordStepTool).toBeDefined();

        const properties = recordStepTool!.tool.inputSchema.properties;
        const propertyNames = Object.keys(properties);

        // Core params
        expect(propertyNames).toContain('agentName');
        expect(propertyNames).toContain('stepDescription');
        expect(propertyNames).toContain('outcome');
        expect(propertyNames).toContain('findings');
        expect(propertyNames).toContain('confidence');

        // Autonomy-related params (added in Phase 2)
        expect(propertyNames).toContain('nextActionHint');
        expect(propertyNames).toContain('riskScore');
      });

      it('should have 7 properties in record_agent_step schema', () => {
        // This test will fail if new params are added to handler but not schema
        const recordStepTool = tools.find(t => t.tool.name === 'record_agent_step');
        const properties = recordStepTool!.tool.inputSchema.properties;

        // agentName, stepDescription, outcome, findings, confidence, nextActionHint, riskScore
        expect(Object.keys(properties)).toHaveLength(7);
      });

      it('should mark findings as optional (not in required array)', () => {
        const recordStepTool = tools.find(t => t.tool.name === 'record_agent_step');
        const required = recordStepTool!.tool.inputSchema.required;

        // findings should NOT be in the required array (it's optional)
        expect(required).not.toContain('findings');
        // But agentName, stepDescription, outcome should be required
        expect(required).toContain('agentName');
        expect(required).toContain('stepDescription');
        expect(required).toContain('outcome');
      });

      it('should have only 3 required properties for record_agent_step', () => {
        const recordStepTool = tools.find(t => t.tool.name === 'record_agent_step');
        const required = recordStepTool!.tool.inputSchema.required;

        // agentName, stepDescription, outcome
        expect(required).toHaveLength(3);
      });

      it('should have correct types for autonomy params', () => {
        const recordStepTool = tools.find(t => t.tool.name === 'record_agent_step');
        const properties = recordStepTool!.tool.inputSchema.properties;

        expect(properties.nextActionHint.type).toBe('string');
        expect(properties.riskScore.type).toBe('number');
        expect(properties.riskScore.minimum).toBe(0);
        expect(properties.riskScore.maximum).toBe(100);
      });
    });

    describe('description mentions autonomy', () => {
      it('should mention autonomy directive in record_agent_step description', () => {
        const recordStepTool = tools.find(t => t.tool.name === 'record_agent_step');
        expect(recordStepTool!.tool.description.toLowerCase()).toContain('autonomy');
      });
    });
  });
});
