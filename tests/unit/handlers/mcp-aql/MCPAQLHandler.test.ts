/**
 * Unit tests for MCPAQLHandler
 *
 * Tests the unified MCP-AQL handler that routes operations to
 * appropriate backend handlers based on CRUD endpoints.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { MCPAQLHandler, HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { Gatekeeper } from '../../../../src/handlers/mcp-aql/Gatekeeper.js';
import { PermissionLevel } from '../../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import type { OperationInput, ResponseMeta } from '../../../../src/handlers/mcp-aql/types.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { logger } from '../../../../src/utils/logger.js';

/**
 * Create a mock Gatekeeper that validates routes but auto-approves all policies.
 * Used for existing tests that don't focus on policy enforcement.
 *
 * Wraps a real Gatekeeper's enforce() to still check Layer 1 (route validation)
 * but bypass Layers 2-4 (policies/confirmations). This ensures endpoint mismatch
 * tests still pass while operation-level tests aren't blocked by confirmations.
 */
function createPermissiveGatekeeper(): Gatekeeper {
  const gk = new Gatekeeper(undefined, { enableAuditLogging: false });
  const originalEnforce = gk.enforce.bind(gk);
  gk.enforce = (input) => {
    // Still do Layer 1 route validation (catches endpoint mismatches)
    const result = originalEnforce(input);
    if (result.errorCode === 'ENDPOINT_MISMATCH' || result.errorCode === 'UNKNOWN_OPERATION') {
      return result;
    }
    // Auto-approve everything else
    return {
      allowed: true,
      permissionLevel: PermissionLevel.AUTO_APPROVE,
      reason: 'Auto-approved by test mock',
    };
  };
  return gk;
}

describe('MCPAQLHandler', () => {
  let handler: MCPAQLHandler;
  let mockRegistry: HandlerRegistry;

  beforeEach(() => {
    // Create mock handlers registry
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
        releaseDeadlock: jest.fn().mockResolvedValue({
          sessionId: 'test-session',
          deactivated: [],
          failed: [],
          persistedStateCleared: true,
        }),
        getActiveElements: jest.fn().mockResolvedValue([]),
        getActiveElementsForPolicy: jest.fn().mockResolvedValue([]),
        getPolicyElementsForReport: jest.fn().mockResolvedValue([]),
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
        getAgentState: jest.fn().mockResolvedValue({ status: 'idle', steps: [] }),
        recordAgentStep: jest.fn().mockResolvedValue({ recorded: true }),
        completeAgentGoal: jest.fn().mockResolvedValue({ completed: true }),
        continueAgentExecution: jest.fn().mockResolvedValue({ continued: true }),
      },
      templateRenderer: {
        render: jest.fn().mockResolvedValue('rendered output'),
      },
      elementQueryService: {
        search: jest.fn().mockResolvedValue([]),
        query: jest.fn().mockReturnValue({
          items: [],
          pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false },
          sorting: { sortBy: 'name', sortOrder: 'asc' },
          filters: { applied: { count: 0 } },
        }),
        queryItems: jest.fn().mockReturnValue([]),
      },
      // Issue #452: Permissive Gatekeeper so existing tests pass
      // without needing to confirm every operation
      gatekeeper: createPermissiveGatekeeper(),
    } as unknown as HandlerRegistry;

    handler = new MCPAQLHandler(mockRegistry);
  });

  describe('handleCreate()', () => {
    describe('create_element operation', () => {
      it('should successfully create an element', async () => {
        const input: OperationInput = {
          operation: 'create_element',
          elementType: undefined,
          params: {
            element_name: 'Test Element',
            element_type: 'persona',
            description: 'Test description',
            content: 'Test content',
          },
        };

        const result = await handler.handleCreate(input);

        expect(result.success).toBe(true);
        if (result.success) {
          // Issue #202: Response transforms name → element_name for LLM consistency
          expect(result.data).toEqual({ element_name: 'test-element' });
          // Issue #290: mapTo converts name->elementName, type->elementType
          expect(mockRegistry.elementCRUD.createElement).toHaveBeenCalledWith(
            expect.objectContaining({
              elementName: 'Test Element',
              elementType: 'persona',
              description: 'Test description',
              content: 'Test content',
            })
          );
        }
      });

      it('should use elementType from input when provided', async () => {
        const input: OperationInput = {
          operation: 'create_element',
          elementType: 'skill' as any,
          params: {
            element_name: 'Test Skill',
            description: 'Test description',
          },
        };

        await handler.handleCreate(input);

        // Issue #290: mapTo converts type->elementType
        expect(mockRegistry.elementCRUD.createElement).toHaveBeenCalledWith(
          expect.objectContaining({
            elementType: 'skill',
          })
        );
      });
    });

    describe('activate_element operation', () => {
      it('should successfully activate an element', async () => {
        const input: OperationInput = {
          operation: 'activate_element',
          params: {
            element_name: 'test-persona',
            element_type: 'persona',
          },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual({ activated: true });
          expect(mockRegistry.elementCRUD.activateElement).toHaveBeenCalledWith(
            'test-persona',
            'persona',
            undefined
          );
        }
      });

      it('should pass context when provided', async () => {
        const input: OperationInput = {
          operation: 'activate_element',
          params: {
            element_name: 'test-persona',
            element_type: 'persona',
            context: { key: 'value' },
          },
        };

        await handler.handleRead(input);

        expect(mockRegistry.elementCRUD.activateElement).toHaveBeenCalledWith(
          'test-persona',
          'persona',
          { key: 'value' }
        );
      });
    });

    describe('addEntry operation', () => {
      it('should add entry to memory element', async () => {
        const input: OperationInput = {
          operation: 'addEntry',
          params: {
            element_name: 'test-memory',
            content: 'Test entry content',
            tags: ['tag1', 'tag2'],
            metadata: { key: 'value' },
          },
        };

        const result = await handler.handleCreate(input);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual({ entryId: 'entry-1' });
        }
        expect(mockRegistry.memoryManager.find).toHaveBeenCalled();
      });

      it('should fail when memory not found', async () => {
        (mockRegistry.memoryManager.find as jest.Mock).mockResolvedValue(null);

        const input: OperationInput = {
          operation: 'addEntry',
          params: {
            element_name: 'nonexistent-memory',
            content: 'Test content',
          },
        };

        const result = await handler.handleCreate(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("Memory 'nonexistent-memory' not found");
        }
      });
    });

    describe('import_element operation', () => {
      it('should validate export package format', async () => {
        // Missing required 'data' parameter
        const input: OperationInput = {
          operation: 'import_element',
          params: { source: 'test.json' },
        };

        const result = await handler.handleCreate(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          // Schema-driven dispatch validates required params first
          expect(result.error).toContain("Missing required parameter 'data'");
        }
      });

      it('should import valid export package', async () => {
        const exportPackage = {
          exportVersion: '1.0',
          exportedAt: new Date().toISOString(),
          elementType: 'personas',
          elementName: 'test-persona',
          format: 'json',
          data: JSON.stringify({
            name: 'Test Persona',
            description: 'A test persona for import',
            content: 'Test content',
          }),
        };

        const input: OperationInput = {
          operation: 'import_element',
          elementType: 'persona' as any,
          params: { data: JSON.stringify(exportPackage), overwrite: true },
        };

        const result = await handler.handleCreate(input);

        // Should succeed with mocked createElement (overwrite allows replacing)
        expect(result.success).toBe(true);
        expect(mockRegistry.elementCRUD.createElement).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Test Persona',
            description: 'A test persona for import',
            type: 'personas',
          })
        );
      });
    });

    describe('Permission violations', () => {
      it('should reject READ operations via CREATE endpoint', async () => {
        const input: OperationInput = {
          operation: 'list_elements',
          params: { element_type: 'persona' },
        };

        const result = await handler.handleCreate(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('list_elements');
          expect(result.error).toContain('mcp_aql_read');
          expect(result.error).toContain('not mcp_aql_create');
        }
      });

      it('should reject UPDATE operations via CREATE endpoint', async () => {
        const input: OperationInput = {
          operation: 'edit_element',
          params: { element_name: 'test', element_type: 'persona', input: { description: 'new' } },
        };

        const result = await handler.handleCreate(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_update');
        }
      });

      it('should reject DELETE operations via CREATE endpoint', async () => {
        const input: OperationInput = {
          operation: 'delete_element',
          params: { element_name: 'test', element_type: 'persona' },
        };

        const result = await handler.handleCreate(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_delete');
        }
      });
    });
  });

  describe('get_effective_cli_policies', () => {
    it('includes operation rules and external patterns in the combined dashboard view', async () => {
      (mockRegistry.elementCRUD.getActiveElementsForPolicy as jest.Mock).mockResolvedValue([
        {
          type: 'persona',
          name: 'careful-persona',
          metadata: {
            name: 'careful-persona',
            gatekeeper: {
              allow: ['read_*'],
              confirm: ['edit_*'],
              deny: ['delete_*'],
              externalRestrictions: {
                allowPatterns: ['Bash:git status*'],
                confirmPatterns: ['Bash:git push*'],
                denyPatterns: ['Bash:rm*'],
                description: 'Safer shell access',
              },
            },
          },
        },
      ]);

      const result = await handler.handleRead({
        operation: 'get_effective_cli_policies',
        params: {},
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.combinedAllowOperations).toEqual(['read_*']);
        expect(data.combinedConfirmOperations).toEqual(['edit_*']);
        expect(data.combinedDenyOperations).toEqual(['delete_*']);
        expect(data.combinedConfirmPatterns).toEqual(['Bash:git push*']);
        expect(data.elements).toEqual([
          expect.objectContaining({
            allowOperations: ['read_*'],
            confirmOperations: ['edit_*'],
            denyOperations: ['delete_*'],
            confirmPatterns: ['Bash:git push*'],
          }),
        ]);
      }
    });

    it('uses reportable policy elements for dashboard session views', async () => {
      (mockRegistry.elementCRUD.getPolicyElementsForReport as jest.Mock).mockResolvedValue([
        {
          type: 'skill',
          name: 'audit-trace-demo',
          metadata: {
            name: 'audit-trace-demo',
            gatekeeper: {
              externalRestrictions: {
                denyPatterns: ['Bash:curl*'],
                confirmPatterns: ['Bash:git push*'],
              },
            },
          },
          sessionIds: ['session-demo-1'],
        },
      ]);

      const result = await handler.handleRead({
        operation: 'get_effective_cli_policies',
        params: {
          reporting_scope: 'dashboard',
          session_id: 'session-demo-1',
        },
      });

      expect(result.success).toBe(true);
      expect(mockRegistry.elementCRUD.getPolicyElementsForReport).toHaveBeenCalledWith('session-demo-1');
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.combinedDenyPatterns).toEqual(['Bash:curl*']);
        expect(data.combinedConfirmPatterns).toEqual(['Bash:git push*']);
      }
    });
  });

  describe('evaluate_permission', () => {
    it('uses session-scoped reportable policy elements when session_id is provided', async () => {
      (mockRegistry.elementCRUD.getPolicyElementsForReport as jest.Mock).mockResolvedValue([
        {
          type: 'skill',
          name: 'audit-trace-demo',
          metadata: {
            name: 'audit-trace-demo',
            gatekeeper: {
              externalRestrictions: {
                denyPatterns: ['Bash:rm*'],
              },
            },
          },
          sessionIds: ['session-follower-1'],
        },
      ]);

      const result = await handler.handleRead({
        operation: 'evaluate_permission',
        params: {
          tool_name: 'ToolX',
          input: { action: 'demo' },
          platform: 'claude_code',
          session_id: 'session-follower-1',
        },
      });

      expect(result.success).toBe(true);
      expect(mockRegistry.elementCRUD.getPolicyElementsForReport).toHaveBeenCalledWith('session-follower-1');
    });
  });

  describe('handleRead()', () => {
    describe('list_elements operation', () => {
      it('should successfully list elements', async () => {
        const input: OperationInput = {
          operation: 'list_elements',
          elementType: 'persona' as any,
          params: { page: 1, pageSize: 10 },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.elementCRUD.listElements).toHaveBeenCalledWith(
          'persona',
          { page: 1, pageSize: 10 }
        );
      });

      it('should use element_type from params when elementType not provided', async () => {
        const input: OperationInput = {
          operation: 'list_elements',
          params: { element_type: 'skill' },
        };

        await handler.handleRead(input);

        expect(mockRegistry.elementCRUD.listElements).toHaveBeenCalledWith(
          'skill',
          { element_type: 'skill' }
        );
      });
    });

    describe('get_element and get_element_details operations', () => {
      it('should get element by name via get_element', async () => {
        const input: OperationInput = {
          operation: 'get_element',
          params: { element_name: 'test-persona', element_type: 'persona' },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.elementCRUD.getElementDetails).toHaveBeenCalledWith(
          'test-persona',
          'persona'
        );
      });

      it('should get element details via get_element_details', async () => {
        const input: OperationInput = {
          operation: 'get_element_details',
          params: { element_name: 'test-persona', element_type: 'persona' },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.elementCRUD.getElementDetails).toHaveBeenCalledWith(
          'test-persona',
          'persona'
        );
      });
    });

    describe('validate_element operation', () => {
      it('should validate an element', async () => {
        const input: OperationInput = {
          operation: 'validate_element',
          params: { element_name: 'test-persona', element_type: 'persona', strict: true },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
        // Issue #290: mapTo converts element_name->elementName, element_type->elementType
        expect(mockRegistry.elementCRUD.validateElement).toHaveBeenCalledWith(
          expect.objectContaining({
            elementName: 'test-persona',
            elementType: 'persona',
            strict: true,
          })
        );
      });

      it('should handle validation without strict flag', async () => {
        const input: OperationInput = {
          operation: 'validate_element',
          params: { element_name: 'test-persona', element_type: 'persona' },
        };

        await handler.handleRead(input);

        // Issue #290: mapTo converts element_name->elementName, element_type->elementType
        expect(mockRegistry.elementCRUD.validateElement).toHaveBeenCalledWith(
          expect.objectContaining({
            elementName: 'test-persona',
            elementType: 'persona',
          })
        );
      });
    });

    describe('get_active_elements operation', () => {
      it('should get active elements by type', async () => {
        const input: OperationInput = {
          operation: 'get_active_elements',
          params: { element_type: 'persona' },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.elementCRUD.getActiveElements).toHaveBeenCalledWith('persona');
      });
    });

    describe('deactivate_element operation', () => {
      it('should deactivate an element', async () => {
        const input: OperationInput = {
          operation: 'deactivate_element',
          params: { element_name: 'test-persona', element_type: 'persona' },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.elementCRUD.deactivateElement).toHaveBeenCalledWith(
          'test-persona',
          'persona'
        );
      });
    });

    describe('render operation', () => {
      it('should render a template', async () => {
        const input: OperationInput = {
          operation: 'render',
          params: { element_name: 'test-template', variables: { key: 'value' } },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe('rendered output');
        }
        expect(mockRegistry.templateRenderer.render).toHaveBeenCalledWith(
          'test-template',
          { key: 'value' },
          undefined,
          undefined
        );
      });
    });

    describe('export_element operation', () => {
      it('should require name parameter', async () => {
        const input: OperationInput = {
          operation: 'export_element',
          elementType: 'persona' as any,
          params: { format: 'json' },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          // Schema-driven dispatch validates required params
          // Issue #290: element_name is the new canonical param name
          expect(result.error).toContain("Missing required parameter 'element_name'");
        }
      });

      it('should export an element successfully', async () => {
        const input: OperationInput = {
          operation: 'export_element',
          elementType: 'persona' as any,
          params: { element_name: 'test-persona', format: 'json' },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
        if (result.success) {
          const data = result.data as { exportVersion: string; format: string };
          expect(data.exportVersion).toBe('1.0');
          expect(data.format).toBe('json');
        }
      });
    });

    describe('search_elements operation', () => {
      it('should require query parameter', async () => {
        const input: OperationInput = {
          operation: 'search_elements',
          params: {},
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Search query is required');
        }
      });

      it('should reject overly long query', async () => {
        const input: OperationInput = {
          operation: 'search_elements',
          params: { query: 'x'.repeat(1001) }, // Over 1000 char limit
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('under 1000 characters');
        }
      });

      it('should search elements successfully', async () => {
        const input: OperationInput = {
          operation: 'search_elements',
          params: { query: 'test' },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
        if (result.success) {
          const data = result.data as { items: unknown[]; query: string; pagination: unknown; sorting: unknown };
          expect(data.query).toBe('test');
          expect(Array.isArray(data.items)).toBe(true);
          expect(data.pagination).toBeDefined();
          expect(data.sorting).toBeDefined();
        }
      });

      it('should support multi-word search matching individual words', async () => {
        (mockRegistry.elementCRUD.getElements as jest.Mock).mockResolvedValue([
          { metadata: { name: 'Code Review Expert', description: 'Reviews code for quality' }, content: '' },
          { metadata: { name: 'API Helper', description: 'Helps with API calls' }, content: '' },
        ]);

        const input: OperationInput = {
          operation: 'search_elements',
          elementType: 'persona' as any, // Scope to single type to avoid duplicates
          params: { query: 'code review' },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
        if (result.success) {
          // Field selection transforms 'name' → 'element_name'
          const data = result.data as { items: Array<{ element_name: string }> };
          expect(data.items.length).toBeGreaterThanOrEqual(1);
          expect(data.items[0].element_name).toBe('Code Review Expert');
        }
      });

      it('should support pagination params', async () => {
        (mockRegistry.elementCRUD.getElements as jest.Mock).mockResolvedValue(
          Array.from({ length: 30 }, (_, i) => ({
            metadata: { name: `Element ${i}`, description: `Description ${i}` },
            content: `test content ${i}`,
          }))
        );

        const input: OperationInput = {
          operation: 'search_elements',
          elementType: 'persona' as any, // Scope to single type to get exactly 30 results
          params: { query: 'Element', pagination: { page: 2, pageSize: 5 } },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
        if (result.success) {
          const data = result.data as { items: unknown[]; pagination: { page: number; pageSize: number; totalItems: number } };
          expect(data.items).toHaveLength(5);
          expect(data.pagination.page).toBe(2);
          expect(data.pagination.pageSize).toBe(5);
          expect(data.pagination.totalItems).toBe(30);
        }
      });

      it('should support sort params', async () => {
        (mockRegistry.elementCRUD.getElements as jest.Mock).mockResolvedValue([
          { metadata: { name: 'Zebra', description: 'test' }, content: '' },
          { metadata: { name: 'Apple', description: 'test' }, content: '' },
        ]);

        const input: OperationInput = {
          operation: 'search_elements',
          elementType: 'persona' as any, // Scope to single type to avoid duplicates
          params: { query: 'test', sort: { sortBy: 'name', sortOrder: 'desc' } },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
        if (result.success) {
          // Field selection transforms 'name' → 'element_name'
          const data = result.data as { items: Array<{ element_name: string }>; sorting: { sortBy: string; sortOrder: string } };
          expect(data.sorting.sortBy).toBe('name');
          expect(data.sorting.sortOrder).toBe('desc');
          expect(data.items[0].element_name).toBe('Zebra');
          expect(data.items[1].element_name).toBe('Apple');
        }
      });
    });

    describe('query_elements operation', () => {
      it('should require elementType parameter', async () => {
        const input: OperationInput = {
          operation: 'query_elements',
          params: { page: 1 },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('elementType is required');
        }
      });

      it('should query elements successfully', async () => {
        const input: OperationInput = {
          operation: 'query_elements',
          elementType: 'persona' as any,
          params: { pagination: { page: 1, pageSize: 10 } },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.elementCRUD.getElements).toHaveBeenCalledWith('persona');
        expect(mockRegistry.elementQueryService.query).toHaveBeenCalled();
      });
    });

    // Issue #243: Unified search operation tests
    describe('search operation (unified search)', () => {
      beforeEach(() => {
        // Add portfolioHandler mock for unified search
        (mockRegistry as any).portfolioHandler = {
          searchAll: jest.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'Search results' }],
          }),
        };
      });

      describe('scope normalization', () => {
        it('should default to all sources when scope is undefined', async () => {
          const input: OperationInput = {
            operation: 'search',
            params: { query: 'test' },
          };

          await handler.handleRead(input);

          expect((mockRegistry as any).portfolioHandler.searchAll).toHaveBeenCalledWith(
            expect.objectContaining({
              sources: ['local', 'github', 'collection'],
            })
          );
        });

        it('should default to all sources when scope is "all"', async () => {
          const input: OperationInput = {
            operation: 'search',
            params: { query: 'test', scope: 'all' },
          };

          await handler.handleRead(input);

          expect((mockRegistry as any).portfolioHandler.searchAll).toHaveBeenCalledWith(
            expect.objectContaining({
              sources: ['local', 'github', 'collection'],
            })
          );
        });

        it('should handle single scope as string', async () => {
          const input: OperationInput = {
            operation: 'search',
            params: { query: 'test', scope: 'local' },
          };

          await handler.handleRead(input);

          expect((mockRegistry as any).portfolioHandler.searchAll).toHaveBeenCalledWith(
            expect.objectContaining({
              sources: ['local'],
            })
          );
        });

        it('should handle multiple scopes as array', async () => {
          const input: OperationInput = {
            operation: 'search',
            params: { query: 'test', scope: ['local', 'collection'] },
          };

          await handler.handleRead(input);

          expect((mockRegistry as any).portfolioHandler.searchAll).toHaveBeenCalledWith(
            expect.objectContaining({
              sources: ['local', 'collection'],
            })
          );
        });
      });

      describe('scope validation', () => {
        it('should reject invalid scope string', async () => {
          const input: OperationInput = {
            operation: 'search',
            params: { query: 'test', scope: 'invalid' },
          };

          const result = await handler.handleRead(input);

          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error).toContain('Invalid scope value');
            expect(result.error).toContain('invalid');
            expect(result.error).toContain('local, github, collection');
          }
        });

        it('should reject array with invalid scope values', async () => {
          const input: OperationInput = {
            operation: 'search',
            params: { query: 'test', scope: ['local', 'invalid', 'collection'] },
          };

          const result = await handler.handleRead(input);

          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error).toContain('Invalid scope value');
            expect(result.error).toContain('invalid');
          }
        });

        it('should reject non-string values in scope array', async () => {
          const input: OperationInput = {
            operation: 'search',
            params: { query: 'test', scope: ['local', 123, 'collection'] },
          };

          const result = await handler.handleRead(input);

          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error).toContain('Invalid scope value');
          }
        });

        it('should reject invalid scope type', async () => {
          const input: OperationInput = {
            operation: 'search',
            params: { query: 'test', scope: { invalid: true } },
          };

          const result = await handler.handleRead(input);

          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error).toContain('Invalid scope parameter');
          }
        });
      });

      describe('pagination extraction', () => {
        it('should convert offset-based pagination to page number', async () => {
          const input: OperationInput = {
            operation: 'search',
            params: {
              query: 'test',
              pagination: { offset: 20, limit: 10 },
            },
          };

          await handler.handleRead(input);

          expect((mockRegistry as any).portfolioHandler.searchAll).toHaveBeenCalledWith(
            expect.objectContaining({
              page: 3, // offset 20 / limit 10 + 1 = 3
              pageSize: 10,
            })
          );
        });

        it('should use top-level limit when pagination object not provided', async () => {
          const input: OperationInput = {
            operation: 'search',
            params: { query: 'test', limit: 25 },
          };

          await handler.handleRead(input);

          expect((mockRegistry as any).portfolioHandler.searchAll).toHaveBeenCalledWith(
            expect.objectContaining({
              pageSize: 25,
            })
          );
        });

        it('should pass page directly when offset not provided', async () => {
          const input: OperationInput = {
            operation: 'search',
            params: { query: 'test', page: 5 },
          };

          await handler.handleRead(input);

          expect((mockRegistry as any).portfolioHandler.searchAll).toHaveBeenCalledWith(
            expect.objectContaining({
              page: 5,
            })
          );
        });

        it('should default limit to 20 when calculating page from offset', async () => {
          const input: OperationInput = {
            operation: 'search',
            params: {
              query: 'test',
              pagination: { offset: 40 }, // no limit specified
            },
          };

          await handler.handleRead(input);

          expect((mockRegistry as any).portfolioHandler.searchAll).toHaveBeenCalledWith(
            expect.objectContaining({
              page: 3, // offset 40 / default limit 20 + 1 = 3
              pageSize: 20,
            })
          );
        });
      });

      describe('parameter mapping', () => {
        it('should map type to elementType', async () => {
          const input: OperationInput = {
            operation: 'search',
            params: { query: 'test', type: 'personas' },
          };

          await handler.handleRead(input);

          expect((mockRegistry as any).portfolioHandler.searchAll).toHaveBeenCalledWith(
            expect.objectContaining({
              elementType: 'personas',
            })
          );
        });

        it('should pass sortBy parameter', async () => {
          const input: OperationInput = {
            operation: 'search',
            params: { query: 'test', sortBy: 'name' },
          };

          await handler.handleRead(input);

          expect((mockRegistry as any).portfolioHandler.searchAll).toHaveBeenCalledWith(
            expect.objectContaining({
              sortBy: 'name',
            })
          );
        });
      });

      describe('error handling', () => {
        it('should fail when portfolioHandler is not configured', async () => {
          // Remove portfolioHandler from registry
          (mockRegistry as any).portfolioHandler = undefined;

          const input: OperationInput = {
            operation: 'search',
            params: { query: 'test' },
          };

          const result = await handler.handleRead(input);

          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error).toContain('not configured');
          }
        });
      });
    });

    describe('Permission violations', () => {
      it('should reject CREATE operations via READ endpoint', async () => {
        const input: OperationInput = {
          operation: 'create_element',
          params: { element_name: 'test', element_type: 'persona', description: 'test' },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_create');
        }
      });

      it('should reject UPDATE operations via READ endpoint', async () => {
        const input: OperationInput = {
          operation: 'edit_element',
          params: { element_name: 'test', element_type: 'persona', input: { description: 'new' } },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
        }
      });

      it('should reject DELETE operations via READ endpoint', async () => {
        const input: OperationInput = {
          operation: 'delete_element',
          params: { element_name: 'test', element_type: 'persona' },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
        }
      });
    });
  });

  describe('handleUpdate()', () => {
    describe('edit_element operation', () => {
      it('should successfully edit an element', async () => {
        const input: OperationInput = {
          operation: 'edit_element',
          params: {
            element_name: 'test-persona',
            element_type: 'persona',
            input: { description: 'Updated description' },
          },
        };

        const result = await handler.handleUpdate(input);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual({ updated: true });
        }
        // Issue #290: mapTo converts element_name->elementName, element_type->elementType
        expect(mockRegistry.elementCRUD.editElement).toHaveBeenCalledWith(
          expect.objectContaining({
            elementName: 'test-persona',
            elementType: 'persona',
            input: { description: 'Updated description' },
          })
        );
      });

      it('should handle different value types', async () => {
        const input: OperationInput = {
          operation: 'edit_element',
          params: {
            element_name: 'test-persona',
            element_type: 'persona',
            input: { metadata: { priority: 5 } },
          },
        };

        await handler.handleUpdate(input);

        expect(mockRegistry.elementCRUD.editElement).toHaveBeenCalledWith(
          expect.objectContaining({
            input: { metadata: { priority: 5 } },
          })
        );
      });
    });

    describe('Permission violations', () => {
      it('should reject CREATE operations via UPDATE endpoint', async () => {
        const input: OperationInput = {
          operation: 'create_element',
          params: { element_name: 'test', element_type: 'persona', description: 'test' },
        };

        const result = await handler.handleUpdate(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_create');
        }
      });

      it('should reject READ operations via UPDATE endpoint', async () => {
        const input: OperationInput = {
          operation: 'list_elements',
          params: { element_type: 'persona' },
        };

        const result = await handler.handleUpdate(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
        }
      });

      it('should reject DELETE operations via UPDATE endpoint', async () => {
        const input: OperationInput = {
          operation: 'delete_element',
          params: { element_name: 'test', element_type: 'persona' },
        };

        const result = await handler.handleUpdate(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
        }
      });
    });
  });

  describe('handleDelete()', () => {
    describe('delete_element operation', () => {
      it('should successfully delete an element', async () => {
        const input: OperationInput = {
          operation: 'delete_element',
          params: {
            element_name: 'test-persona',
            element_type: 'persona',
            deleteData: true,
          },
        };

        const result = await handler.handleDelete(input);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual({ deleted: true });
        }
        // Issue #290: mapTo converts element_name->elementName, element_type->elementType
        expect(mockRegistry.elementCRUD.deleteElement).toHaveBeenCalledWith(
          expect.objectContaining({
            elementName: 'test-persona',
            elementType: 'persona',
            deleteData: true,
          })
        );
      });

      it('should handle delete without deleteData flag', async () => {
        const input: OperationInput = {
          operation: 'delete_element',
          params: { element_name: 'test-persona', element_type: 'persona' },
        };

        await handler.handleDelete(input);

        // Issue #290: mapTo converts element_name->elementName, element_type->elementType
        expect(mockRegistry.elementCRUD.deleteElement).toHaveBeenCalledWith(
          expect.objectContaining({
            elementName: 'test-persona',
            elementType: 'persona',
          })
        );
      });
    });

    // execute_agent moved to EXECUTE endpoint in Issue #244

    describe('clear operation', () => {
      it('should clear memory entries', async () => {
        const input: OperationInput = {
          operation: 'clear',
          params: { element_name: 'test-memory' },
        };

        const result = await handler.handleDelete(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.memoryManager.find).toHaveBeenCalled();
      });

      it('should fail when memory not found', async () => {
        (mockRegistry.memoryManager.find as jest.Mock).mockResolvedValue(null);

        const input: OperationInput = {
          operation: 'clear',
          params: { element_name: 'nonexistent-memory' },
        };

        const result = await handler.handleDelete(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("Memory 'nonexistent-memory' not found");
        }
      });
    });

    describe('Permission violations', () => {
      it('should reject CREATE operations via DELETE endpoint', async () => {
        const input: OperationInput = {
          operation: 'create_element',
          params: { element_name: 'test', element_type: 'persona', description: 'test' },
        };

        const result = await handler.handleDelete(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_create');
        }
      });

      it('should reject READ operations via DELETE endpoint', async () => {
        const input: OperationInput = {
          operation: 'list_elements',
          params: { element_type: 'persona' },
        };

        const result = await handler.handleDelete(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
        }
      });

      it('should reject UPDATE operations via DELETE endpoint', async () => {
        const input: OperationInput = {
          operation: 'edit_element',
          params: { element_name: 'test', element_type: 'persona', input: { description: 'new' } },
        };

        const result = await handler.handleDelete(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
        }
      });
    });
  });

  // Issue #244: EXECUTE endpoint tests
  describe('handleExecute()', () => {
    describe('execute_agent operation', () => {
      it('should execute an agent', async () => {
        const input: OperationInput = {
          operation: 'execute_agent',
          params: {
            element_name: 'test-agent',  // Issue #323: Use element_name
            parameters: { goal: 'test goal' },
          },
        };

        const result = await handler.handleExecute(input);

        expect(result.success).toBe(true);
        if (result.success) {
          // Issue #125: Structured JSON with _type discriminator
          expect(result.data).toEqual({ _type: 'ExecuteAgentResult', result: 'executed' });
        }
        expect(mockRegistry.agentManager.executeAgent).toHaveBeenCalledWith(
          'test-agent',
          { goal: 'test goal' }
        );
      });
    });

    describe('get_execution_state operation', () => {
      it('should get agent execution state', async () => {
        const input: OperationInput = {
          operation: 'get_execution_state',
          params: {
            element_name: 'test-agent',  // Issue #323: Use element_name
            includeDecisionHistory: true,
          },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
        expect(mockRegistry.agentManager.getAgentState).toHaveBeenCalledWith({
          agentName: 'test-agent',
          includeDecisionHistory: true,
          includeContext: undefined,
        });
      });

      it('should explain how to recover when element_name is missing', async () => {
        const input: OperationInput = {
          operation: 'get_execution_state',
          params: {},
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("Missing required parameter 'element_name'");
          expect(result.error).toContain('Use the same element_name you passed to execute_agent');
          expect(result.error).toContain('{ operation: "get_execution_state", params: { element_name: "code-reviewer", includeDecisionHistory: true } }');
          expect(result.error).toContain('list active agents first');
        }
      });
    });

    describe('Permission violations', () => {
      it('should reject CREATE operations via EXECUTE endpoint', async () => {
        const input: OperationInput = {
          operation: 'create_element',
          params: { element_name: 'test', element_type: 'persona', description: 'test' },
        };

        const result = await handler.handleExecute(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
        }
      });

      it('should reject READ operations via EXECUTE endpoint', async () => {
        const input: OperationInput = {
          operation: 'list_elements',
          params: { element_type: 'persona' },
        };

        const result = await handler.handleExecute(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
        }
      });
    });
  });

  describe('Input validation', () => {
    describe('isOperationInput guard', () => {
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
          const result = await handler.handleRead(invalid);
          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error).toContain('Invalid input');
          }
        }
      });

      it('should reject input missing operation field', async () => {
        const input = { params: { test: 'value' } };
        const result = await handler.handleRead(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Invalid input');
        }
      });

      it('should accept input with only operation field', async () => {
        const input: OperationInput = {
          operation: 'list_elements',
          params: { element_type: 'persona' },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
      });

      it('should accept input with all fields', async () => {
        const input: OperationInput = {
          operation: 'list_elements',
          elementType: 'persona' as any,
          params: { page: 1 },
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(true);
      });
    });

    describe('Unknown operations', () => {
      it('should return failure for unknown operation', async () => {
        const input: OperationInput = {
          operation: 'nonexistent_operation',
          params: {},
        };

        const result = await handler.handleRead(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Unknown operation');
          expect(result.error).toContain('tool descriptions');
        }
      });
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

      const result = await handler.handleCreate(input);

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

      const result = await handler.handleRead(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('String error message');
      }
    });

    it('should handle missing params gracefully', async () => {
      const input: OperationInput = {
        operation: 'list_elements',
        // params is undefined - but 'element_type' is required
      };

      const result = await handler.handleRead(input);

      // Schema-driven dispatch validates required 'element_type' param
      // Issue #290: element_type is the new canonical param name
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Missing required parameter 'element_type'");
      }
    });
  });

  describe('Dispatcher routing', () => {
    it('should route to correct ElementCRUD methods', async () => {
      const operations = [
        { op: 'create_element', endpoint: 'handleCreate', method: 'createElement', params: { element_name: 'test', element_type: 'persona', description: 'test' } },
        { op: 'list_elements', endpoint: 'handleRead', method: 'listElements', params: { element_type: 'persona' } },
        { op: 'edit_element', endpoint: 'handleUpdate', method: 'editElement', params: { element_name: 'test', element_type: 'persona', input: { description: 'new' } } },
        { op: 'delete_element', endpoint: 'handleDelete', method: 'deleteElement', params: { element_name: 'test', element_type: 'persona' } },
      ];

      for (const { op, endpoint, method, params } of operations) {
        const input: OperationInput = {
          operation: op,
          params,
        };

        await (handler as any)[endpoint](input);
        expect((mockRegistry.elementCRUD as any)[method]).toHaveBeenCalled();
      }
    });

    // Note: Tests for unknown module/method error handling are covered by
    // the OperationRouter's static configuration and PermissionGuard validation.
    // In practice, invalid handler references cannot reach the dispatcher since:
    // 1. All operations must pass PermissionGuard.validate()
    // 2. All operations are defined in OPERATION_ROUTES with valid handler refs
    // Module mocking for these edge cases is not compatible with ESM.
  });

  describe('Result format', () => {
    it('should return OperationSuccess with data on success', async () => {
      const input: OperationInput = {
        operation: 'list_elements',
        params: { element_type: 'persona' },
      };

      const result = await handler.handleRead(input);

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('_meta');
      expect(result).not.toHaveProperty('error');
    });

    it('should return OperationFailure with error on failure', async () => {
      const input: OperationInput = {
        operation: 'create_element',
        params: {},
      };

      (mockRegistry.elementCRUD.createElement as jest.Mock).mockRejectedValue(
        new Error('Validation failed')
      );

      const result = await handler.handleCreate(input);

      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('_meta');
      expect(result).not.toHaveProperty('data');
    });
  });

  // ==========================================================================
  // Issue #452: Gatekeeper Enforcement Tests
  // ==========================================================================
  describe('Gatekeeper enforcement (Issue #452)', () => {
    let enforcingHandler: MCPAQLHandler;
    let enforcingRegistry: HandlerRegistry;

    beforeEach(() => {
      // Create a handler with a REAL Gatekeeper (not pre-approved)
      // so we can test enforcement behavior
      enforcingRegistry = {
        elementCRUD: {
          createElement: jest.fn().mockResolvedValue({ name: 'test-element' }),
          listElements: jest.fn().mockResolvedValue([]),
          getElements: jest.fn().mockResolvedValue([]),
          getElementDetails: jest.fn().mockResolvedValue({}),
          editElement: jest.fn().mockResolvedValue({ updated: true }),
          validateElement: jest.fn().mockResolvedValue({ valid: true }),
          deleteElement: jest.fn().mockResolvedValue({ deleted: true }),
          activateElement: jest.fn().mockResolvedValue({ activated: true }),
          deactivateElement: jest.fn().mockResolvedValue({ deactivated: true }),
          getActiveElements: jest.fn().mockResolvedValue([]),
          getActiveElementsForPolicy: jest.fn().mockResolvedValue([]),
          getPolicyElementsForReport: jest.fn().mockResolvedValue([]),
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
          getAgentState: jest.fn().mockResolvedValue({ status: 'idle', steps: [] }),
          recordAgentStep: jest.fn().mockResolvedValue({ recorded: true }),
          completeAgentGoal: jest.fn().mockResolvedValue({ completed: true }),
          continueAgentExecution: jest.fn().mockResolvedValue({ continued: true }),
        },
        templateRenderer: {
          render: jest.fn().mockResolvedValue('rendered output'),
        },
        elementQueryService: {
          search: jest.fn().mockResolvedValue([]),
          query: jest.fn().mockReturnValue({
            items: [],
            pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false },
            sorting: { sortBy: 'name', sortOrder: 'asc' },
            filters: { applied: { count: 0 } },
          }),
          queryItems: jest.fn().mockReturnValue([]),
        },
        // Real Gatekeeper — no pre-approved confirmations
        gatekeeper: new Gatekeeper(undefined, { enableAuditLogging: false }),
      } as unknown as HandlerRegistry;

      enforcingHandler = new MCPAQLHandler(enforcingRegistry);
    });

    it('should auto-approve READ operations (list_elements)', async () => {
      const input: OperationInput = {
        operation: 'list_elements',
        params: { element_type: 'persona' },
      };

      const result = await enforcingHandler.handleRead(input);
      expect(result.success).toBe(true);
    });

    it('should auto-confirm CREATE operations without explicit confirm_operation (#1653)', async () => {
      const input: OperationInput = {
        operation: 'create_element',
        params: {
          element_name: 'Test',
          element_type: 'persona',
          description: 'Test',
          content: 'Test',
        },
      };

      // #1653: Auto-confirm — no confirm_operation round-trip needed
      const result = await enforcingHandler.handleCreate(input);
      expect(result.success).toBe(true);
    });

    it('confirm_operation still works for explicit pre-approval (#1653)', async () => {
      // confirm_operation is still available for explicit pre-approval scenarios
      const confirmInput: OperationInput = {
        operation: 'confirm_operation',
        params: { operation: 'create_element' },
      };

      const confirmResult = await enforcingHandler.handleExecute(confirmInput);
      expect(confirmResult.success).toBe(true);
      if (confirmResult.success) {
        expect(confirmResult.data).toHaveProperty('confirmed', true);
      }

      // Create after explicit confirmation
      const createInput: OperationInput = {
        operation: 'create_element',
        params: {
          element_name: 'Test',
          element_type: 'persona',
          description: 'Test',
          content: 'Test',
        },
      };
      const createResult = await enforcingHandler.handleCreate(createInput);
      expect(createResult.success).toBe(true);
    });

    it('should pass active elements to Gatekeeper enforce()', async () => {
      // Mock active elements with a gatekeeper policy that denies list_elements
      const mockElements = [{
        type: 'persona',
        name: 'Strict Persona',
        metadata: {
          name: 'Strict Persona',
          gatekeeper: {
            deny: ['list_elements'],
          },
        },
      }];
      (enforcingRegistry.elementCRUD as any).getActiveElementsForPolicy
        .mockResolvedValue(mockElements);

      const input: OperationInput = {
        operation: 'list_elements',
        params: { element_type: 'persona' },
      };

      const result = await enforcingHandler.handleRead(input);
      // list_elements should be denied by the active persona's policy
      expect(result.success).toBe(false);
    });

    it('confirm_operation should be auto-approved (no infinite loop)', async () => {
      const input: OperationInput = {
        operation: 'confirm_operation',
        params: { operation: 'create_element' },
      };

      // confirm_operation routes through EXECUTE (non-idempotent, human-in-the-loop)
      // but should go through enforcement without requiring confirmation itself
      const result = await enforcingHandler.handleExecute(input);
      expect(result.success).toBe(true);
    });

    it('should throw when Gatekeeper is not injected', () => {
      const registryWithoutGk = { ...enforcingRegistry } as any;
      delete registryWithoutGk.gatekeeper;

      // Should throw — Gatekeeper is required via DI container
      expect(() => new MCPAQLHandler(registryWithoutGk as HandlerRegistry))
        .toThrow('Gatekeeper instance is required');
    });

    it('should handle getActiveElements failure gracefully', async () => {
      // Make getActiveElementsForPolicy throw
      (enforcingRegistry.elementCRUD as any).getActiveElementsForPolicy
        .mockRejectedValue(new Error('Manager unavailable'));

      // Pre-confirm so we can reach dispatch
      (enforcingRegistry as any).gatekeeper.recordConfirmation(
        'list_elements', PermissionLevel.CONFIRM_SESSION
      );

      const input: OperationInput = {
        operation: 'list_elements',
        params: { element_type: 'persona' },
      };

      // Should still work — fails open with empty active elements
      const result = await enforcingHandler.handleRead(input);
      expect(result.success).toBe(true);
    });
  });

  // Issue #301: Request correlation metadata tests
  describe('Response metadata (_meta)', () => {
    it('should include _meta with requestId from ContextTracker', async () => {
      const mockTracker = { getCorrelationId: () => 'test-req-123' };
      const handlerWithTracker = new MCPAQLHandler(mockRegistry, mockTracker);

      const input: OperationInput = {
        operation: 'list_elements',
        params: { element_type: 'persona' },
      };

      const result = await handlerWithTracker.handleRead(input);

      expect(result.success).toBe(true);
      const meta = (result as { _meta: ResponseMeta })._meta;
      expect(meta).toBeDefined();
      expect(meta.requestId).toBe('test-req-123');
      expect(typeof meta.durationMs).toBe('number');
      expect(meta.durationMs).toBeGreaterThanOrEqual(0);
      expect(meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should include _meta on failure responses', async () => {
      const mockTracker = { getCorrelationId: () => 'fail-req-456' };
      const handlerWithTracker = new MCPAQLHandler(mockRegistry, mockTracker);

      const input: OperationInput = {
        operation: 'create_element',
        params: { element_name: 'test', element_type: 'persona', description: 'test' },
      };

      // Force an error in the handler
      (mockRegistry.elementCRUD.createElement as jest.Mock).mockRejectedValue(
        new Error('Intentional test error')
      );

      const result = await handlerWithTracker.handleCreate(input);

      expect(result.success).toBe(false);
      const meta = (result as { _meta: ResponseMeta })._meta;
      expect(meta).toBeDefined();
      expect(meta.requestId).toBe('fail-req-456');
      expect(typeof meta.durationMs).toBe('number');
      expect(meta.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should include _meta with "unknown" requestId when no ContextTracker', async () => {
      // handler (from beforeEach) has no ContextTracker
      const input: OperationInput = {
        operation: 'list_elements',
        params: { element_type: 'persona' },
      };

      const result = await handler.handleRead(input);

      expect(result.success).toBe(true);
      const meta = (result as { _meta: ResponseMeta })._meta;
      expect(meta).toBeDefined();
      expect(meta.requestId).toBe('unknown');
      expect(typeof meta.durationMs).toBe('number');
    });

    it('should include _meta on batch results', async () => {
      const mockTracker = { getCorrelationId: () => 'batch-req-789' };
      const handlerWithTracker = new MCPAQLHandler(mockRegistry, mockTracker);

      const input = {
        operations: [
          { operation: 'list_elements', params: { element_type: 'persona' } },
          { operation: 'list_elements', params: { element_type: 'skill' } },
        ],
      };

      const result = await handlerWithTracker.handleRead(input);

      expect(result.success).toBe(true);
      expect('results' in result).toBe(true); // BatchResult
      const meta = (result as { _meta: ResponseMeta })._meta;
      expect(meta).toBeDefined();
      expect(meta.requestId).toBe('batch-req-789');
      expect(typeof meta.durationMs).toBe('number');
      expect(meta.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should include _meta on early validation failures', async () => {
      // Invalid input triggers early return in executeOperation
      const result = await handler.handleRead(null);

      expect(result.success).toBe(false);
      const meta = (result as { _meta: ResponseMeta })._meta;
      expect(meta).toBeDefined();
      expect(meta.requestId).toBe('unknown');
      expect(typeof meta.durationMs).toBe('number');
    });
  });

  // =========================================================================
  // Issue #142: verify_challenge operation tests
  // PR #478 review: granular events, UUID validation, rate limiting, metrics
  // =========================================================================
  describe('verify_challenge operation (Issue #142)', () => {
    // Valid UUID v4 for tests (challenge IDs are generated by crypto.randomUUID)
    const VALID_CHALLENGE_ID = '550e8400-e29b-41d4-a716-446655440000';
    const VALID_CHALLENGE_ID_2 = '6ba7b810-9dad-41d8-80b4-00c04fd430c8';

    let verifyHandler: MCPAQLHandler;
    let mockVerificationStore: {
      verify: jest.Mock;
      set: jest.Mock;
      get: jest.Mock;
      size: jest.Mock;
      cleanup: jest.Mock;
      clear: jest.Mock;
      destroy: jest.Mock;
    };
    let mockDangerZoneEnforcer: {
      check: jest.Mock;
      block: jest.Mock;
      unblock: jest.Mock;
      getBlockedAgents: jest.Mock;
      hasBlockedAgents: jest.Mock;
      clearAll: jest.Mock;
      getMetrics: jest.Mock;
    };

    beforeEach(() => {
      mockVerificationStore = {
        verify: jest.fn(),
        set: jest.fn(),
        get: jest.fn(),
        size: jest.fn().mockReturnValue(0),
        cleanup: jest.fn(),
        clear: jest.fn(),
        destroy: jest.fn(),
      };

      mockDangerZoneEnforcer = {
        check: jest.fn().mockReturnValue({ blocked: false }),
        block: jest.fn(),
        unblock: jest.fn().mockReturnValue(true),
        getBlockedAgents: jest.fn().mockReturnValue([]),
        hasBlockedAgents: jest.fn().mockReturnValue(false),
        clearAll: jest.fn().mockReturnValue(true),
        getMetrics: jest.fn().mockReturnValue({}),
      };

      const registry = {
        ...mockRegistry,
        verificationStore: mockVerificationStore,
        dangerZoneEnforcer: mockDangerZoneEnforcer,
      } as unknown as HandlerRegistry;

      verifyHandler = new MCPAQLHandler(registry);
    });

    // --- Core verification flow ---

    it('should succeed with valid code and unblock agent', async () => {
      const storedChallenge = { code: 'XYZ789', expiresAt: Date.now() + 300000, reason: 'test' };
      mockVerificationStore.get.mockReturnValue(storedChallenge);
      mockVerificationStore.verify.mockReturnValue(true);
      mockDangerZoneEnforcer.getBlockedAgents.mockReturnValue(['code-reviewer']);
      mockDangerZoneEnforcer.check.mockReturnValue({
        blocked: true,
        verificationId: VALID_CHALLENGE_ID,
      });

      const result = await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'XYZ789' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(expect.objectContaining({
          verified: true,
          unblockedAgent: 'code-reviewer',
        }));
      }
      expect(mockVerificationStore.verify).toHaveBeenCalledWith(VALID_CHALLENGE_ID, 'XYZ789');
      expect(mockDangerZoneEnforcer.unblock).toHaveBeenCalledWith('code-reviewer', VALID_CHALLENGE_ID);
    });

    it('should fail with incorrect code', async () => {
      const storedChallenge = { code: 'CORRECT', expiresAt: Date.now() + 300000, reason: 'test' };
      mockVerificationStore.get.mockReturnValue(storedChallenge);
      mockVerificationStore.verify.mockReturnValue(false);

      const result = await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'WRONG' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Verification failed');
        expect(result.error).toContain('incorrect code');
      }
    });

    it('should fail with expired challenge (not found in store)', async () => {
      // get() returns undefined for expired/missing challenges
      mockVerificationStore.get.mockReturnValue(undefined);

      const result = await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'ABC123' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('challenge not found');
        expect(result.error).toContain('expired');
      }
    });

    it('should fail when challenge_id is missing', async () => {
      const result = await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { code: 'ABC123' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('challenge_id');
      }
    });

    it('should fail when code is missing', async () => {
      const result = await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('code');
      }
    });

    it('should succeed even when no blocked agent matches the challengeId', async () => {
      const storedChallenge = { code: 'ABC123', expiresAt: Date.now() + 300000, reason: 'test' };
      mockVerificationStore.get.mockReturnValue(storedChallenge);
      mockVerificationStore.verify.mockReturnValue(true);
      mockDangerZoneEnforcer.getBlockedAgents.mockReturnValue([]);

      const result = await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'ABC123' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(expect.objectContaining({
          verified: true,
          message: expect.stringContaining('retry'),
        }));
      }
    });

    it('should fail when verificationStore is not available', async () => {
      const registryNoStore = {
        ...mockRegistry,
        dangerZoneEnforcer: mockDangerZoneEnforcer,
        // No verificationStore
      } as unknown as HandlerRegistry;
      const handlerNoStore = new MCPAQLHandler(registryNoStore);

      const result = await handlerNoStore.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'ABC123' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Verification system not available');
      }
    });

    it('should reject deadlock relief challenges via verify_challenge', async () => {
      mockVerificationStore.get.mockReturnValue({
        code: 'RELIEF1',
        expiresAt: Date.now() + 300000,
        reason: 'Deadlock relief requested',
      });

      const result = await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'RELIEF1' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('reserved for deadlock relief');
      }
      expect(mockVerificationStore.verify).not.toHaveBeenCalled();
    });

    // --- UUID v4 format validation ---

    it('should reject challenge_id with invalid UUID format', async () => {
      const result = await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: 'not-a-uuid', code: 'ABC123' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid challenge_id format');
        expect(result.error).toContain('UUID');
      }
      // Should never hit the store
      expect(mockVerificationStore.get).not.toHaveBeenCalled();
      expect(mockVerificationStore.verify).not.toHaveBeenCalled();
    });

    it('should reject challenge_id with wrong UUID version', async () => {
      // UUID v1 format (version digit is 1, not 4)
      const uuidV1 = '550e8400-e29b-11d4-a716-446655440000';

      const result = await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: uuidV1, code: 'ABC123' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid challenge_id format');
      }
    });

    it('should accept valid UUID v4 challenge_id', async () => {
      const storedChallenge = { code: 'ABC123', expiresAt: Date.now() + 300000, reason: 'test' };
      mockVerificationStore.get.mockReturnValue(storedChallenge);
      mockVerificationStore.verify.mockReturnValue(true);

      const result = await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'ABC123' },
      });

      expect(result.success).toBe(true);
      expect(mockVerificationStore.get).toHaveBeenCalledWith(VALID_CHALLENGE_ID);
    });

    // --- Rate limiting ---

    it('should reject when rate limit is exceeded', async () => {
      // Trigger failures to exceed the rate limit (default: 10 per 60s)
      for (let i = 0; i < 11; i++) {
        const storedChallenge = { code: 'CORRECT', expiresAt: Date.now() + 300000, reason: 'test' };
        mockVerificationStore.get.mockReturnValue(storedChallenge);
        mockVerificationStore.verify.mockReturnValue(false);
        await verifyHandler.handleCreate({
          operation: 'verify_challenge',
          params: { challenge_id: VALID_CHALLENGE_ID, code: 'WRONG' },
        });
      }

      // Next attempt should be rate-limited
      const result = await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID_2, code: 'ABC123' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Too many failed verification attempts');
      }
    });

    // --- Verification metrics ---

    it('should track verification metrics', async () => {
      // Initial metrics should be zero
      const initialMetrics = verifyHandler.getVerificationMetrics();
      expect(initialMetrics.totalAttempts).toBe(0);
      expect(initialMetrics.totalSuccesses).toBe(0);
      expect(initialMetrics.totalFailures).toBe(0);

      // Successful verification
      const storedChallenge = { code: 'ABC123', expiresAt: Date.now() + 300000, reason: 'test' };
      mockVerificationStore.get.mockReturnValue(storedChallenge);
      mockVerificationStore.verify.mockReturnValue(true);
      await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'ABC123' },
      });

      const afterSuccess = verifyHandler.getVerificationMetrics();
      expect(afterSuccess.totalAttempts).toBe(1);
      expect(afterSuccess.totalSuccesses).toBe(1);

      // Failed verification (wrong code)
      mockVerificationStore.get.mockReturnValue(storedChallenge);
      mockVerificationStore.verify.mockReturnValue(false);
      await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'WRONG' },
      });

      const afterFailure = verifyHandler.getVerificationMetrics();
      expect(afterFailure.totalAttempts).toBe(2);
      expect(afterFailure.totalFailures).toBe(1);

      // Expired challenge
      mockVerificationStore.get.mockReturnValue(undefined);
      await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID_2, code: 'ABC123' },
      });

      const afterExpired = verifyHandler.getVerificationMetrics();
      expect(afterExpired.totalAttempts).toBe(3);
      expect(afterExpired.totalExpired).toBe(1);

      // Invalid format
      await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: 'not-valid', code: 'ABC123' },
      });

      const afterInvalid = verifyHandler.getVerificationMetrics();
      expect(afterInvalid.totalAttempts).toBe(4);
      expect(afterInvalid.totalInvalidFormat).toBe(1);
    });

    // --- Granular security events ---

    it('should log VERIFICATION_ATTEMPTED for every attempt', async () => {
      const logSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
      const storedChallenge = { code: 'ABC123', expiresAt: Date.now() + 300000, reason: 'test' };
      mockVerificationStore.get.mockReturnValue(storedChallenge);
      mockVerificationStore.verify.mockReturnValue(true);

      await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'ABC123' },
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'VERIFICATION_ATTEMPTED',
          severity: 'MEDIUM',
        })
      );
      logSpy.mockRestore();
    });

    it('should log VERIFICATION_SUCCEEDED on successful verification', async () => {
      const logSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
      const storedChallenge = { code: 'ABC123', expiresAt: Date.now() + 300000, reason: 'test' };
      mockVerificationStore.get.mockReturnValue(storedChallenge);
      mockVerificationStore.verify.mockReturnValue(true);

      await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'ABC123' },
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'VERIFICATION_SUCCEEDED',
        })
      );
      logSpy.mockRestore();
    });

    it('should log VERIFICATION_FAILED on incorrect code', async () => {
      const logSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
      const storedChallenge = { code: 'CORRECT', expiresAt: Date.now() + 300000, reason: 'test' };
      mockVerificationStore.get.mockReturnValue(storedChallenge);
      mockVerificationStore.verify.mockReturnValue(false);

      await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'WRONG' },
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'VERIFICATION_FAILED',
          severity: 'HIGH',
          additionalData: expect.objectContaining({ reason: 'wrong_code' }),
        })
      );
      logSpy.mockRestore();
    });

    it('should log VERIFICATION_EXPIRED when challenge is not found', async () => {
      const logSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
      mockVerificationStore.get.mockReturnValue(undefined);

      await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'ABC123' },
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'VERIFICATION_EXPIRED',
          severity: 'HIGH',
          additionalData: expect.objectContaining({ reason: 'expired_or_not_found' }),
        })
      );
      logSpy.mockRestore();
    });

    it('should log VERIFICATION_FAILED for invalid UUID format', async () => {
      const logSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent');

      await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: 'bad-format', code: 'ABC123' },
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'VERIFICATION_FAILED',
          additionalData: expect.objectContaining({ reason: 'invalid_format' }),
        })
      );
      logSpy.mockRestore();
    });

    // --- Error message consistency (GatekeeperErrorCode) ---

    it('should use GatekeeperErrorCode-aligned error messages', async () => {
      // Expired challenge should reference VERIFICATION_TIMEOUT semantics
      mockVerificationStore.get.mockReturnValue(undefined);

      const result = await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'ABC123' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        // Should give actionable guidance
        expect(result.error).toContain('Retry the blocked operation');
      }
    });

    it('should give actionable guidance on wrong code failure', async () => {
      const storedChallenge = { code: 'CORRECT', expiresAt: Date.now() + 300000, reason: 'test' };
      mockVerificationStore.get.mockReturnValue(storedChallenge);
      mockVerificationStore.verify.mockReturnValue(false);

      const result = await verifyHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'WRONG' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('one-time use');
        expect(result.error).toContain('Retry the blocked operation');
      }
    });
  });

  describe('release_deadlock operation', () => {
    const VALID_CHALLENGE_ID = '550e8400-e29b-41d4-a716-446655440000';

    it('should issue a challenge on the first call', async () => {
      const verificationStore = {
        set: jest.fn(),
        get: jest.fn(),
        verify: jest.fn(),
        clear: jest.fn(),
        size: jest.fn().mockReturnValue(0),
        cleanup: jest.fn(),
        destroy: jest.fn(),
      };
      const verificationNotifier = {
        showCode: jest.fn(),
        isAvailable: jest.fn().mockReturnValue(true),
      };

      const releaseHandler = new MCPAQLHandler({
        ...mockRegistry,
        verificationStore,
        verificationNotifier,
      } as unknown as HandlerRegistry);

      const result = await releaseHandler.handleCreate({
        operation: 'release_deadlock',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(expect.objectContaining({
          pending: true,
          challenge_id: expect.any(String),
        }));
      }
      expect(verificationStore.set).toHaveBeenCalled();
      expect(verificationNotifier.showCode).toHaveBeenCalled();
    });

    it('should complete deadlock relief after successful verification', async () => {
      const verificationStore = {
        set: jest.fn(),
        get: jest.fn().mockReturnValue({
          code: 'RELIEF1',
          expiresAt: Date.now() + 300000,
          reason: 'Deadlock relief requested',
        }),
        verify: jest.fn().mockReturnValue(true),
        clear: jest.fn(),
        size: jest.fn().mockReturnValue(1),
        cleanup: jest.fn(),
        destroy: jest.fn(),
      };
      const elementCRUD = {
        ...mockRegistry.elementCRUD,
        releaseDeadlock: jest.fn().mockResolvedValue({
          sessionId: 'test-session',
          activeBeforeReset: [{ type: 'persona', name: 'locked-persona' }],
          deactivated: [{ type: 'persona', name: 'locked-persona' }],
          failed: [],
          likelyDeadlockCause: {
            sandboxingElement: { type: 'persona', name: 'locked-persona' },
            advisoryElements: [],
          },
          persistedStateCleared: true,
          snapshotFile: '/opt/dollhouse/test-data/deadlock-relief-test.json',
        }),
      };

      const releaseHandler = new MCPAQLHandler({
        ...mockRegistry,
        elementCRUD,
        verificationStore,
      } as unknown as HandlerRegistry);

      const result = await releaseHandler.handleCreate({
        operation: 'release_deadlock',
        params: { challenge_id: VALID_CHALLENGE_ID, code: 'RELIEF1' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(expect.objectContaining({
          released: true,
          persistedStateCleared: true,
          activeBeforeReset: [{ type: 'persona', element_name: 'locked-persona' }],
          deactivated: [{ type: 'persona', element_name: 'locked-persona' }],
          likelyDeadlockCause: {
            sandboxingElement: { type: 'persona', element_name: 'locked-persona' },
            advisoryElements: [],
          },
          snapshotFile: '/opt/dollhouse/test-data/deadlock-relief-test.json',
        }));
      }
      expect(verificationStore.verify).toHaveBeenCalledWith(VALID_CHALLENGE_ID, 'RELIEF1');
      expect(elementCRUD.releaseDeadlock).toHaveBeenCalled();
    });

    it('should remain available even when confirm_operation is sandboxed by an active element', async () => {
      const verificationStore = {
        set: jest.fn(),
        get: jest.fn(),
        verify: jest.fn(),
        clear: jest.fn(),
        size: jest.fn().mockReturnValue(0),
        cleanup: jest.fn(),
        destroy: jest.fn(),
      };
      const verificationNotifier = {
        showCode: jest.fn(),
        isAvailable: jest.fn().mockReturnValue(true),
      };
      const restrictiveRegistry = {
        ...mockRegistry,
        gatekeeper: new Gatekeeper(undefined, { enableAuditLogging: false }),
        verificationStore,
        verificationNotifier,
        elementCRUD: {
          ...mockRegistry.elementCRUD,
          getActiveElementsForPolicy: jest.fn().mockResolvedValue([
            {
              type: 'persona',
              name: 'sandbox-persona',
              metadata: {
                gatekeeper: {
                  deny: ['confirm_operation'],
                },
              },
            },
          ]),
        },
      } as unknown as HandlerRegistry;

      const restrictiveHandler = new MCPAQLHandler(restrictiveRegistry);

      const confirmResult = await restrictiveHandler.handleExecute({
        operation: 'confirm_operation',
        params: { operation: 'edit_element' },
      });
      expect(confirmResult.success).toBe(false);

      const releaseResult = await restrictiveHandler.handleCreate({
        operation: 'release_deadlock',
      });

      expect(releaseResult.success).toBe(true);
      if (releaseResult.success) {
        expect(releaseResult.data).toEqual(expect.objectContaining({
          pending: true,
          challenge_id: expect.any(String),
        }));
      }
      expect(verificationStore.set).toHaveBeenCalled();
    });

    it('should require challenge_id and code together on completion', async () => {
      const releaseHandler = new MCPAQLHandler({
        ...mockRegistry,
        verificationStore: {
          set: jest.fn(),
          get: jest.fn(),
          verify: jest.fn(),
          clear: jest.fn(),
          size: jest.fn(),
          cleanup: jest.fn(),
          destroy: jest.fn(),
        },
      } as unknown as HandlerRegistry);

      const result = await releaseHandler.handleCreate({
        operation: 'release_deadlock',
        params: { challenge_id: VALID_CHALLENGE_ID },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('requires both challenge_id and code together');
      }
    });
  });

  // Issue #657: Save frequency monitoring
  describe('trackSaveFrequency()', () => {
    let trackHandler: MCPAQLHandler;

    beforeEach(() => {
      trackHandler = new MCPAQLHandler(mockRegistry);
    });

    it('should track calls without warning when below threshold', () => {
      const tracker = trackHandler as any;
      const loggerWarnSpy = jest.spyOn(logger, 'warn');

      tracker.trackSaveFrequency('test-memory');

      expect(tracker.saveFrequencyCounters.has('test-memory')).toBe(true);
      expect(tracker.saveFrequencyCounters.get('test-memory').timestamps.length).toBe(1);
      // Should not warn for a single call
      expect(loggerWarnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Save frequency warn threshold'),
        expect.anything()
      );

      loggerWarnSpy.mockRestore();
    });

    it('should normalize memory names to lowercase', () => {
      const tracker = trackHandler as any;

      tracker.trackSaveFrequency('MyMemory');
      tracker.trackSaveFrequency('MYMEMORY');
      tracker.trackSaveFrequency('mymemory');

      // All three should have been tracked under the same key
      expect(tracker.saveFrequencyCounters.size).toBe(1);
      expect(tracker.saveFrequencyCounters.has('mymemory')).toBe(true);
      expect(tracker.saveFrequencyCounters.get('mymemory').timestamps.length).toBe(3);
    });

    it('should set warned flag when warn threshold is reached', () => {
      const tracker = trackHandler as any;
      const loggerWarnSpy = jest.spyOn(logger, 'warn');
      const loggerErrorSpy = jest.spyOn(logger, 'error');

      // Default warn threshold is 50 — call enough times to trigger
      const warnThreshold = 50;
      for (let i = 0; i < warnThreshold; i++) {
        tracker.trackSaveFrequency('heavy-memory');
      }

      const counter = tracker.saveFrequencyCounters.get('heavy-memory');
      expect(counter.warned).toBe(true);
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        '[MCPAQLHandler] Save frequency warn threshold exceeded',
        expect.objectContaining({
          memoryName: 'heavy-memory',
          count: warnThreshold,
          threshold: warnThreshold,
        })
      );

      loggerWarnSpy.mockRestore();
      loggerErrorSpy.mockRestore();
    });

    it('should set critical flag when critical threshold is reached', () => {
      const tracker = trackHandler as any;
      const loggerErrorSpy = jest.spyOn(logger, 'error');
      const securitySpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent');

      // Default critical threshold is 200
      const criticalThreshold = 200;
      for (let i = 0; i < criticalThreshold; i++) {
        tracker.trackSaveFrequency('runaway-memory');
      }

      const counter = tracker.saveFrequencyCounters.get('runaway-memory');
      expect(counter.critical).toBe(true);
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        '[MCPAQLHandler] Save frequency critical threshold exceeded',
        expect.objectContaining({
          memoryName: 'runaway-memory',
          threshold: criticalThreshold,
        })
      );
      expect(securitySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'RATE_LIMIT_EXCEEDED',
          severity: 'HIGH',
          source: 'MCPAQLHandler.trackSaveFrequency',
        })
      );

      loggerErrorSpy.mockRestore();
      securitySpy.mockRestore();
    });

    it('should reset warning flags when frequency drops below threshold', () => {
      const tracker = trackHandler as any;

      // Manually set up a counter with stale timestamps that will be pruned
      const oldTimestamp = Date.now() - 120000; // 2 minutes ago (outside default 60s window)
      tracker.saveFrequencyCounters.set('recovery-memory', {
        timestamps: Array(60).fill(oldTimestamp),
        warned: true,
        critical: true,
      });

      // One new call — stale timestamps get pruned, count drops to 1
      tracker.trackSaveFrequency('recovery-memory');

      const counter = tracker.saveFrequencyCounters.get('recovery-memory');
      expect(counter.timestamps.length).toBe(1);
      expect(counter.warned).toBe(false);
      expect(counter.critical).toBe(false);
    });

    it('should evict oldest entry when map exceeds 500 entries', () => {
      const tracker = trackHandler as any;

      // Fill with 500 entries
      for (let i = 0; i < 500; i++) {
        tracker.saveFrequencyCounters.set(`memory-${i}`, {
          timestamps: [Date.now()],
          warned: false,
          critical: false,
        });
      }
      expect(tracker.saveFrequencyCounters.size).toBe(500);

      // Adding a new one should evict the oldest (memory-0)
      tracker.trackSaveFrequency('memory-overflow');

      expect(tracker.saveFrequencyCounters.size).toBe(500);
      expect(tracker.saveFrequencyCounters.has('memory-0')).toBe(false);
      expect(tracker.saveFrequencyCounters.has('memory-overflow')).toBe(true);
    });

    it('should not warn again after warned flag is already set', () => {
      const tracker = trackHandler as any;
      const loggerWarnSpy = jest.spyOn(logger, 'warn');

      // Trigger warn threshold
      for (let i = 0; i < 50; i++) {
        tracker.trackSaveFrequency('repeat-memory');
      }

      const warnCallCount = loggerWarnSpy.mock.calls.filter(
        call => String(call[0]).includes('Save frequency warn threshold')
      ).length;

      // Call more times — should not log warn again
      for (let i = 0; i < 10; i++) {
        tracker.trackSaveFrequency('repeat-memory');
      }

      const newWarnCallCount = loggerWarnSpy.mock.calls.filter(
        call => String(call[0]).includes('Save frequency warn threshold')
      ).length;

      expect(newWarnCallCount).toBe(warnCallCount);

      loggerWarnSpy.mockRestore();
    });
  });
});
