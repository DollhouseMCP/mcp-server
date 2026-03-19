/**
 * Unit tests for UnifiedEndpoint
 *
 * Tests the single unified MCP-AQL endpoint that routes operations
 * to appropriate CRUD handlers based on operation name.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { UnifiedEndpoint, getOperationHelp } from '../../../../src/handlers/mcp-aql/UnifiedEndpoint.js';
import { MCPAQLHandler, HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { Gatekeeper } from '../../../../src/handlers/mcp-aql/Gatekeeper.js';
import { PermissionLevel } from '../../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import type { OperationInput, ResponseMeta } from '../../../../src/handlers/mcp-aql/types.js';

describe('UnifiedEndpoint', () => {
  let unifiedEndpoint: UnifiedEndpoint;
  let mcpAqlHandler: MCPAQLHandler;
  let mockRegistry: HandlerRegistry;

  beforeEach(() => {
    // Create mock handlers registry (same as MCPAQLHandler.test.ts)
    mockRegistry = {
      elementCRUD: {
        createElement: jest.fn().mockResolvedValue({ name: 'test-element' }),
        listElements: jest.fn().mockResolvedValue([]),
        getElements: jest.fn().mockResolvedValue([
          { metadata: { name: 'test-persona', description: 'A test persona' }, content: 'Test content' },
        ]),
        getElementDetails: jest.fn().mockResolvedValue({ name: 'test', type: 'persona' }),
        editElement: jest.fn().mockResolvedValue({ updated: true }),
        validateElement: jest.fn().mockResolvedValue({ valid: true }),
        deleteElement: jest.fn().mockResolvedValue({ deleted: true }),
        activateElement: jest.fn().mockResolvedValue({ activated: true }),
        deactivateElement: jest.fn().mockResolvedValue({ deactivated: true }),
        getActiveElements: jest.fn().mockResolvedValue([]),
        getActiveElementsForPolicy: jest.fn().mockResolvedValue([]),
      },
      memoryManager: {
        find: jest.fn().mockResolvedValue({
          metadata: { name: 'test-memory' },
          addEntry: jest.fn().mockResolvedValue({ entryId: 'entry-1' }),
          clearAll: jest.fn().mockResolvedValue({ cleared: true }),
        }),
        save: jest.fn().mockResolvedValue(undefined),
      },
      agentManager: {
        executeAgent: jest.fn().mockResolvedValue({ result: 'executed' }),
      },
      templateRenderer: {
        render: jest.fn().mockResolvedValue('rendered output'),
      },
      elementQueryService: {
        search: jest.fn().mockResolvedValue([]),
        query: jest.fn().mockResolvedValue({ results: [], total: 0 }),
      },
    } as unknown as HandlerRegistry;

    // Issue #452: Create permissive gatekeeper for non-enforcement tests
    const gatekeeper = new Gatekeeper(undefined, { enableAuditLogging: false });
    gatekeeper.enforce = () => ({
      allowed: true,
      permissionLevel: PermissionLevel.AUTO_APPROVE,
      reason: 'Auto-approved by test mock',
    });
    (mockRegistry as any).gatekeeper = gatekeeper;

    mcpAqlHandler = new MCPAQLHandler(mockRegistry);
    unifiedEndpoint = new UnifiedEndpoint(mcpAqlHandler);
  });

  describe('Operation routing', () => {
    describe('CREATE operations', () => {
      it('should route create_element to CREATE handler', async () => {
        const input: OperationInput = {
          operation: 'create_element',
          params: {
            element_name: 'Test Element',
            element_type: 'persona',
            description: 'Test description',
          },
        };

        const result = await unifiedEndpoint.handle(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.elementCRUD.createElement).toHaveBeenCalled();
      });

      it('should route addEntry to CREATE handler', async () => {
        const input: OperationInput = {
          operation: 'addEntry',
          params: {
            element_name: 'test-memory',
            content: 'Test entry content',
          },
        };

        const result = await unifiedEndpoint.handle(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.memoryManager.find).toHaveBeenCalled();
      });
    });

    describe('READ operations', () => {
      it('should route list_elements to READ handler', async () => {
        const input: OperationInput = {
          operation: 'list_elements',
          params: { element_type: 'persona' },
        };

        const result = await unifiedEndpoint.handle(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.elementCRUD.listElements).toHaveBeenCalled();
      });

      it('should route get_element to READ handler', async () => {
        const input: OperationInput = {
          operation: 'get_element',
          params: { element_name: 'test-persona', element_type: 'persona' },
        };

        const result = await unifiedEndpoint.handle(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.elementCRUD.getElementDetails).toHaveBeenCalled();
      });

      it('should route validate_element to READ handler', async () => {
        const input: OperationInput = {
          operation: 'validate_element',
          params: { element_name: 'test-persona', element_type: 'persona' },
        };

        const result = await unifiedEndpoint.handle(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.elementCRUD.validateElement).toHaveBeenCalled();
      });

      it('should route render to READ handler', async () => {
        const input: OperationInput = {
          operation: 'render',
          params: { element_name: 'test-template', variables: { key: 'value' } },
        };

        const result = await unifiedEndpoint.handle(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.templateRenderer.render).toHaveBeenCalled();
      });

      it('should route activate_element to READ handler (Issue #535)', async () => {
        const input: OperationInput = {
          operation: 'activate_element',
          params: {
            element_name: 'test-persona',
            element_type: 'persona',
          },
        };

        const result = await unifiedEndpoint.handle(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.elementCRUD.activateElement).toHaveBeenCalled();
      });

      it('should route deactivate_element to READ handler', async () => {
        const input: OperationInput = {
          operation: 'deactivate_element',
          params: { element_name: 'test-persona', element_type: 'persona' },
        };

        const result = await unifiedEndpoint.handle(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.elementCRUD.deactivateElement).toHaveBeenCalled();
      });
    });

    describe('UPDATE operations', () => {
      it('should route edit_element to UPDATE handler', async () => {
        const input: OperationInput = {
          operation: 'edit_element',
          params: {
            element_name: 'test-persona',
            element_type: 'persona',
            input: { description: 'Updated description' },
          },
        };

        const result = await unifiedEndpoint.handle(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.elementCRUD.editElement).toHaveBeenCalled();
      });
    });

    describe('DELETE operations', () => {
      it('should route delete_element to DELETE handler', async () => {
        const input: OperationInput = {
          operation: 'delete_element',
          params: {
            element_name: 'test-persona',
            element_type: 'persona',
          },
        };

        const result = await unifiedEndpoint.handle(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.elementCRUD.deleteElement).toHaveBeenCalled();
      });

      it('should route execute_agent to DELETE handler', async () => {
        const input: OperationInput = {
          operation: 'execute_agent',
          params: {
            element_name: 'test-agent',  // Issue #323: Use element_name
            parameters: { goal: 'test goal' },
          },
        };

        const result = await unifiedEndpoint.handle(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.agentManager.executeAgent).toHaveBeenCalled();
      });

      it('should route clear to DELETE handler', async () => {
        const input: OperationInput = {
          operation: 'clear',
          params: { element_name: 'test-memory' },
        };

        const result = await unifiedEndpoint.handle(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.memoryManager.find).toHaveBeenCalled();
      });
    });
  });

  describe('Input validation', () => {
    it('should reject invalid input types', async () => {
      const invalidInputs = [
        null,
        undefined,
        'string',
        123,
        [],
        true,
      ];

      for (const invalid of invalidInputs) {
        const result = await unifiedEndpoint.handle(invalid);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Invalid input');
        }
      }
    });

    it('should reject input missing operation field', async () => {
      const input = { params: { test: 'value' } };
      const result = await unifiedEndpoint.handle(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid input');
      }
    });

    it('should reject unknown operations', async () => {
      const input: OperationInput = {
        operation: 'nonexistent_operation',
        params: {},
      };

      const result = await unifiedEndpoint.handle(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown operation');
        expect(result.error).toContain('nonexistent_operation');
      }
    });
  });

  describe('Error handling', () => {
    it('should catch and return handler errors', async () => {
      (mockRegistry.elementCRUD.createElement as jest.Mock).mockRejectedValue(
        new Error('Database connection failed')
      );

      const input: OperationInput = {
        operation: 'create_element',
        params: { element_name: 'test', element_type: 'persona', description: 'test' },
      };

      const result = await unifiedEndpoint.handle(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Database connection failed');
      }
    });

    it('should handle non-Error thrown values', async () => {
      (mockRegistry.elementCRUD.listElements as jest.Mock).mockRejectedValue(
        'String error message'
      );

      const input: OperationInput = {
        operation: 'list_elements',
        params: { element_type: 'persona' },
      };

      const result = await unifiedEndpoint.handle(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('String error message');
      }
    });
  });

  describe('Security enforcement', () => {
    it('should enforce permissions through internal routing', async () => {
      // Test that CREATE operations work through unified endpoint
      const createInput: OperationInput = {
        operation: 'create_element',
        params: { element_name: 'test', element_type: 'persona', description: 'test' },
      };

      const createResult = await unifiedEndpoint.handle(createInput);
      expect(createResult.success).toBe(true);

      // Test that READ operations work through unified endpoint
      const readInput: OperationInput = {
        operation: 'list_elements',
        params: { element_type: 'persona' },
      };

      const readResult = await unifiedEndpoint.handle(readInput);
      expect(readResult.success).toBe(true);

      // Test that UPDATE operations work through unified endpoint
      const updateInput: OperationInput = {
        operation: 'edit_element',
        params: { element_name: 'test', element_type: 'persona', input: { description: 'new' } },
      };

      const updateResult = await unifiedEndpoint.handle(updateInput);
      expect(updateResult.success).toBe(true);

      // Test that DELETE operations work through unified endpoint
      const deleteInput: OperationInput = {
        operation: 'delete_element',
        params: { element_name: 'test', element_type: 'persona' },
      };

      const deleteResult = await unifiedEndpoint.handle(deleteInput);
      expect(deleteResult.success).toBe(true);
    });
  });

  describe('Result format', () => {
    it('should return OperationSuccess with data on success', async () => {
      const input: OperationInput = {
        operation: 'list_elements',
        params: { element_type: 'persona' },
      };

      const result = await unifiedEndpoint.handle(input);

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('_meta');
      expect(result).not.toHaveProperty('error');
    });

    it('should return OperationFailure with error on failure', async () => {
      const input: OperationInput = {
        operation: 'unknown_op',
        params: {},
      };

      const result = await unifiedEndpoint.handle(input);

      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('_meta');
      expect(result).not.toHaveProperty('data');
    });
  });

  // Issue #301: Response metadata via UnifiedEndpoint's own buildMeta path
  describe('Response metadata (_meta)', () => {
    it('should include _meta with timing on successful operations', async () => {
      const input: OperationInput = {
        operation: 'list_elements',
        params: { element_type: 'persona' },
      };

      const result = await unifiedEndpoint.handle(input);

      expect(result.success).toBe(true);
      const meta = (result as { _meta: ResponseMeta })._meta;
      expect(meta).toBeDefined();
      expect(meta.requestId).toBe('unknown'); // no ContextTracker injected
      expect(typeof meta.durationMs).toBe('number');
      expect(meta.durationMs).toBeGreaterThanOrEqual(0);
      expect(meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should include _meta on invalid input failures', async () => {
      const result = await unifiedEndpoint.handle(null);

      expect(result.success).toBe(false);
      const meta = (result as { _meta: ResponseMeta })._meta;
      expect(meta).toBeDefined();
      expect(meta.requestId).toBe('unknown');
      expect(typeof meta.durationMs).toBe('number');
    });

    it('should include _meta on unknown operation failures', async () => {
      const input: OperationInput = {
        operation: 'nonexistent_operation',
        params: {},
      };

      const result = await unifiedEndpoint.handle(input);

      expect(result.success).toBe(false);
      const meta = (result as { _meta: ResponseMeta })._meta;
      expect(meta).toBeDefined();
      expect(meta.requestId).toBe('unknown');
      expect(typeof meta.durationMs).toBe('number');
      expect(meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should include _meta on handler exception failures', async () => {
      (mockRegistry.elementCRUD.createElement as jest.Mock).mockRejectedValue(
        new Error('Intentional test error')
      );

      const input: OperationInput = {
        operation: 'create_element',
        params: { element_name: 'test', element_type: 'persona', description: 'test' },
      };

      const result = await unifiedEndpoint.handle(input);

      expect(result.success).toBe(false);
      const meta = (result as { _meta: ResponseMeta })._meta;
      expect(meta).toBeDefined();
      expect(meta.requestId).toBe('unknown');
      expect(typeof meta.durationMs).toBe('number');
    });

    it('should include _meta with requestId from ContextTracker', async () => {
      const mockTracker = { getCorrelationId: () => 'unified-req-001' };
      const handlerWithTracker = new MCPAQLHandler(mockRegistry, mockTracker);
      const endpointWithTracker = new UnifiedEndpoint(handlerWithTracker);

      const input: OperationInput = {
        operation: 'list_elements',
        params: { element_type: 'persona' },
      };

      const result = await endpointWithTracker.handle(input);

      expect(result.success).toBe(true);
      const meta = (result as { _meta: ResponseMeta })._meta;
      expect(meta.requestId).toBe('unified-req-001');
    });
  });
});

describe('getOperationHelp()', () => {
  it('should return help text with all operation categories', () => {
    const help = getOperationHelp();

    // Check for CREATE operations
    expect(help).toContain('CREATE Operations');
    expect(help).toContain('create_element');
    expect(help).toContain('import_element');
    expect(help).toContain('addEntry');

    // Check for READ operations
    expect(help).toContain('READ Operations');
    expect(help).toContain('list_elements');
    expect(help).toContain('get_element');
    expect(help).toContain('search_elements');
    expect(help).toContain('validate_element');
    expect(help).toContain('render');
    expect(help).toContain('activate_element');

    // Check for UPDATE operations
    expect(help).toContain('UPDATE Operations');
    expect(help).toContain('edit_element');

    // Check for DELETE operations
    expect(help).toContain('DELETE Operations');
    expect(help).toContain('delete_element');
    expect(help).toContain('execute_agent');
    expect(help).toContain('clear');
  });

  it('should return non-empty string', () => {
    const help = getOperationHelp();

    expect(typeof help).toBe('string');
    expect(help.length).toBeGreaterThan(100);
  });
});
