/**
 * Integration tests for MCP-AQL Permission Guard enforcement
 *
 * Tests that operations must be called via correct CRUD endpoints.
 * This verifies Layer 3 (actual security enforcement) in the defense-in-depth model.
 *
 * Test strategy:
 * - Verify operations fail when called via wrong endpoints
 * - Verify error messages contain "Security violation"
 * - Verify error messages explain correct endpoint to use
 * - Cover all CRUD endpoints (CREATE, READ, UPDATE, DELETE)
 * - Test representative operations from each endpoint category
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { createPortfolioTestEnvironment, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('MCP-AQL Permission Guard Integration', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('mcp-aql-permissions');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
  });

  describe('CREATE operation violations', () => {
    describe('create_element via wrong endpoints', () => {
      it('should fail when called via READ endpoint', async () => {
        const result = await mcpAqlHandler.handleRead({
          operation: 'create_element',
          params: {
            element_name: 'test-persona',
            element_type: 'personas',
            description: 'Should fail',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('create_element');
          expect(result.error).toContain('mcp_aql_create');
          expect(result.error).toContain('not mcp_aql_read');
        }
      });

      it('should fail when called via UPDATE endpoint', async () => {
        const result = await mcpAqlHandler.handleUpdate({
          operation: 'create_element',
          params: {
            element_name: 'test-persona',
            element_type: 'personas',
            description: 'Should fail',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('create_element');
          expect(result.error).toContain('mcp_aql_create');
          expect(result.error).toContain('not mcp_aql_update');
        }
      });

      it('should fail when called via DELETE endpoint', async () => {
        const result = await mcpAqlHandler.handleDelete({
          operation: 'create_element',
          params: {
            element_name: 'test-persona',
            element_type: 'personas',
            description: 'Should fail',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('create_element');
          expect(result.error).toContain('mcp_aql_create');
          expect(result.error).toContain('not mcp_aql_delete');
        }
      });
    });

    describe('activate_element via wrong endpoints (Issue #535: now READ)', () => {
      it('should fail when called via CREATE endpoint', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'activate_element',
          params: {
            element_name: 'some-persona',
            element_type: 'personas',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('activate_element');
          expect(result.error).toContain('mcp_aql_read');
        }
      });

      it('should fail when called via UPDATE endpoint', async () => {
        const result = await mcpAqlHandler.handleUpdate({
          operation: 'activate_element',
          params: {
            element_name: 'some-persona',
            element_type: 'personas',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_read');
          expect(result.error).toContain('not mcp_aql_update');
        }
      });

      it('should fail when called via DELETE endpoint', async () => {
        const result = await mcpAqlHandler.handleDelete({
          operation: 'activate_element',
          params: {
            element_name: 'some-persona',
            element_type: 'personas',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_read');
          expect(result.error).toContain('not mcp_aql_delete');
        }
      });
    });
  });

  describe('READ operation violations', () => {
    describe('list_elements via wrong endpoints', () => {
      it('should fail when called via CREATE endpoint', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'list_elements',
          params: {
            element_type: 'personas',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('list_elements');
          expect(result.error).toContain('mcp_aql_read');
          expect(result.error).toContain('not mcp_aql_create');
        }
      });

      it('should fail when called via UPDATE endpoint', async () => {
        const result = await mcpAqlHandler.handleUpdate({
          operation: 'list_elements',
          params: {
            element_type: 'personas',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_read');
          expect(result.error).toContain('not mcp_aql_update');
        }
      });

      it('should fail when called via DELETE endpoint', async () => {
        const result = await mcpAqlHandler.handleDelete({
          operation: 'list_elements',
          params: {
            element_type: 'personas',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_read');
          expect(result.error).toContain('not mcp_aql_delete');
        }
      });
    });

    describe('get_element via wrong endpoints', () => {
      it('should fail when called via CREATE endpoint', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'get_element',
          params: {
            element_name: 'some-persona',
            element_type: 'personas',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('get_element');
          expect(result.error).toContain('mcp_aql_read');
        }
      });

      it('should fail when called via DELETE endpoint', async () => {
        const result = await mcpAqlHandler.handleDelete({
          operation: 'get_element',
          params: {
            element_name: 'some-persona',
            element_type: 'personas',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_read');
          expect(result.error).toContain('not mcp_aql_delete');
        }
      });
    });

    describe('search_elements via wrong endpoints', () => {
      it('should fail when called via CREATE endpoint', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'search_elements',
          params: {
            query: 'test',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('search_elements');
          expect(result.error).toContain('mcp_aql_read');
        }
      });

      it('should fail when called via UPDATE endpoint', async () => {
        const result = await mcpAqlHandler.handleUpdate({
          operation: 'search_elements',
          params: {
            query: 'test',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_read');
        }
      });
    });

    describe('validate_element via wrong endpoints', () => {
      it('should fail when called via CREATE endpoint', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'validate_element',
          params: {
            element_name: 'some-persona',
            element_type: 'personas',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('validate_element');
          expect(result.error).toContain('mcp_aql_read');
        }
      });

      it('should fail when called via DELETE endpoint', async () => {
        const result = await mcpAqlHandler.handleDelete({
          operation: 'validate_element',
          params: {
            element_name: 'some-persona',
            element_type: 'personas',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_read');
        }
      });
    });
  });

  describe('UPDATE operation violations', () => {
    describe('edit_element via wrong endpoints', () => {
      it('should fail when called via CREATE endpoint', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'edit_element',
          params: {
            element_name: 'some-persona',
            element_type: 'personas',
            field: 'description',
            value: 'New description',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('edit_element');
          expect(result.error).toContain('mcp_aql_update');
          expect(result.error).toContain('not mcp_aql_create');
        }
      });

      it('should fail when called via READ endpoint', async () => {
        const result = await mcpAqlHandler.handleRead({
          operation: 'edit_element',
          params: {
            element_name: 'some-persona',
            element_type: 'personas',
            field: 'description',
            value: 'New description',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('edit_element');
          expect(result.error).toContain('mcp_aql_update');
          expect(result.error).toContain('not mcp_aql_read');
        }
      });

      it('should fail when called via DELETE endpoint', async () => {
        const result = await mcpAqlHandler.handleDelete({
          operation: 'edit_element',
          params: {
            element_name: 'some-persona',
            element_type: 'personas',
            field: 'description',
            value: 'New description',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('edit_element');
          expect(result.error).toContain('mcp_aql_update');
          expect(result.error).toContain('not mcp_aql_delete');
        }
      });
    });
  });

  describe('DELETE operation violations', () => {
    describe('delete_element via wrong endpoints', () => {
      it('should fail when called via CREATE endpoint', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'delete_element',
          params: {
            element_name: 'some-persona',
            element_type: 'personas',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('delete_element');
          expect(result.error).toContain('mcp_aql_delete');
          expect(result.error).toContain('not mcp_aql_create');
        }
      });

      it('should fail when called via READ endpoint', async () => {
        const result = await mcpAqlHandler.handleRead({
          operation: 'delete_element',
          params: {
            element_name: 'some-persona',
            element_type: 'personas',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('delete_element');
          expect(result.error).toContain('mcp_aql_delete');
          expect(result.error).toContain('not mcp_aql_read');
        }
      });

      it('should fail when called via UPDATE endpoint', async () => {
        const result = await mcpAqlHandler.handleUpdate({
          operation: 'delete_element',
          params: {
            element_name: 'some-persona',
            element_type: 'personas',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('delete_element');
          expect(result.error).toContain('mcp_aql_delete');
          expect(result.error).toContain('not mcp_aql_update');
        }
      });
    });

    // Issue #244: execute_agent moved to EXECUTE endpoint
    describe('execute_agent via wrong endpoints', () => {
      it('should fail when called via CREATE endpoint', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'execute_agent',
          params: {
            element_name: 'some-agent',
            parameters: {},
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('execute_agent');
          expect(result.error).toContain('mcp_aql_execute');
        }
      });

      it('should fail when called via READ endpoint', async () => {
        const result = await mcpAqlHandler.handleRead({
          operation: 'execute_agent',
          params: {
            element_name: 'some-agent',
            parameters: {},
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_execute');
          expect(result.error).toContain('not mcp_aql_read');
        }
      });

      it('should fail when called via UPDATE endpoint', async () => {
        const result = await mcpAqlHandler.handleUpdate({
          operation: 'execute_agent',
          params: {
            element_name: 'some-agent',
            parameters: {},
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_execute');
          expect(result.error).toContain('not mcp_aql_update');
        }
      });

      it('should fail when called via DELETE endpoint', async () => {
        const result = await mcpAqlHandler.handleDelete({
          operation: 'execute_agent',
          params: {
            element_name: 'some-agent',
            parameters: {},
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_execute');
          expect(result.error).toContain('not mcp_aql_delete');
        }
      });
    });

    describe('clear (memory) via wrong endpoints', () => {
      it('should fail when called via CREATE endpoint', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'clear',
          params: {
            element_name: 'some-memory',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('clear');
          expect(result.error).toContain('mcp_aql_delete');
        }
      });

      it('should fail when called via READ endpoint', async () => {
        const result = await mcpAqlHandler.handleRead({
          operation: 'clear',
          params: {
            element_name: 'some-memory',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_delete');
          expect(result.error).toContain('not mcp_aql_read');
        }
      });

      it('should fail when called via UPDATE endpoint', async () => {
        const result = await mcpAqlHandler.handleUpdate({
          operation: 'clear',
          params: {
            element_name: 'some-memory',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_delete');
          expect(result.error).toContain('not mcp_aql_update');
        }
      });
    });
  });

  describe('Permission reason messages', () => {
    it('should include "additive, non-destructive nature" for CREATE violations', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'create_element',
        params: {
          element_name: 'test',
          element_type: 'personas',
          description: 'test',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('additive, non-destructive nature');
      }
    });

    it('should include "read-only, safe nature" for READ violations', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'list_elements',
        params: {
          element_type: 'personas',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('read-only, safe nature');
      }
    });

    it('should include "data modification capabilities" for UPDATE violations', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'edit_element',
        params: {
          element_name: 'test',
          element_type: 'personas',
          field: 'description',
          value: 'new',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('data modification capabilities');
      }
    });

    it('should include "destructive potential" for DELETE violations', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'delete_element',
        params: {
          element_name: 'test',
          element_type: 'personas',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('destructive potential');
      }
    });
  });

  describe('Unknown operation handling', () => {
    it('should fail with clear message for unknown operation', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'nonexistent_operation',
        params: {},
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown operation');
        expect(result.error).toContain('nonexistent_operation');
        expect(result.error).toContain('tool descriptions');
      }
    });
  });

  describe('Cross-endpoint validation completeness', () => {
    it('should block all CREATE operations from non-CREATE endpoints', async () => {
      const createOps = ['create_element', 'import_element', 'addEntry'];
      const wrongEndpoints = [
        { element_name: 'READ', handler: mcpAqlHandler.handleRead.bind(mcpAqlHandler) },
        { element_name: 'UPDATE', handler: mcpAqlHandler.handleUpdate.bind(mcpAqlHandler) },
        { element_name: 'DELETE', handler: mcpAqlHandler.handleDelete.bind(mcpAqlHandler) },
      ];

      for (const op of createOps) {
        for (const endpoint of wrongEndpoints) {
          const result = await endpoint.handler({
            operation: op,
            params: { element_name: 'test', element_type: 'personas' },
          });

          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error).toContain('Security violation');
            expect(result.error).toContain('mcp_aql_create');
          }
        }
      }
    });

    it('should block all READ operations from non-READ endpoints', async () => {
      const readOps = [
        'list_elements',
        'get_element',
        'search_elements',
        'validate_element',
        'get_active_elements',
        'activate_element',
      ];
      const wrongEndpoints = [
        { element_name: 'CREATE', handler: mcpAqlHandler.handleCreate.bind(mcpAqlHandler) },
        { element_name: 'UPDATE', handler: mcpAqlHandler.handleUpdate.bind(mcpAqlHandler) },
        { element_name: 'DELETE', handler: mcpAqlHandler.handleDelete.bind(mcpAqlHandler) },
      ];

      for (const op of readOps) {
        for (const endpoint of wrongEndpoints) {
          const result = await endpoint.handler({
            operation: op,
            params: { element_name: 'test', element_type: 'personas' },
          });

          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error).toContain('Security violation');
            expect(result.error).toContain('mcp_aql_read');
          }
        }
      }
    });

    it('should block UPDATE operation from all non-UPDATE endpoints', async () => {
      const wrongEndpoints = [
        { element_name: 'CREATE', handler: mcpAqlHandler.handleCreate.bind(mcpAqlHandler) },
        { element_name: 'READ', handler: mcpAqlHandler.handleRead.bind(mcpAqlHandler) },
        { element_name: 'DELETE', handler: mcpAqlHandler.handleDelete.bind(mcpAqlHandler) },
      ];

      for (const endpoint of wrongEndpoints) {
        const result = await endpoint.handler({
          operation: 'edit_element',
          params: { element_name: 'test', element_type: 'personas', input: { description: 'new' } },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Security violation');
          expect(result.error).toContain('mcp_aql_update');
        }
      }
    });

    it('should block all DELETE operations from non-DELETE endpoints', async () => {
      // execute_agent moved to EXECUTE endpoint in Issue #244
      const deleteOps = ['delete_element', 'clear'];
      const wrongEndpoints = [
        { element_name: 'CREATE', handler: mcpAqlHandler.handleCreate.bind(mcpAqlHandler) },
        { element_name: 'READ', handler: mcpAqlHandler.handleRead.bind(mcpAqlHandler) },
        { element_name: 'UPDATE', handler: mcpAqlHandler.handleUpdate.bind(mcpAqlHandler) },
      ];

      for (const op of deleteOps) {
        for (const endpoint of wrongEndpoints) {
          const result = await endpoint.handler({
            operation: op,
            params: { element_name: 'test' },
          });

          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error).toContain('Security violation');
            expect(result.error).toContain('mcp_aql_delete');
          }
        }
      }
    });

    // Issue #244: EXECUTE endpoint tests
    it('should block all EXECUTE operations from non-EXECUTE endpoints', async () => {
      const executeOps = ['execute_agent'];
      const wrongEndpoints = [
        { element_name: 'CREATE', handler: mcpAqlHandler.handleCreate.bind(mcpAqlHandler) },
        { element_name: 'READ', handler: mcpAqlHandler.handleRead.bind(mcpAqlHandler) },
        { element_name: 'UPDATE', handler: mcpAqlHandler.handleUpdate.bind(mcpAqlHandler) },
        { element_name: 'DELETE', handler: mcpAqlHandler.handleDelete.bind(mcpAqlHandler) },
      ];

      for (const op of executeOps) {
        for (const endpoint of wrongEndpoints) {
          const result = await endpoint.handler({
            operation: op,
            params: { element_name: 'test', parameters: {} },
          });

          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error).toContain('Security violation');
            expect(result.error).toContain('mcp_aql_execute');
          }
        }
      }
    });
  });
});
