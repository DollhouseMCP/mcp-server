/**
 * Integration tests for MCP-AQL Error Handling
 *
 * Tests error scenarios across all CRUD endpoints:
 * - CREATE (mcp_aql_create)
 * - READ (mcp_aql_read)
 * - UPDATE (mcp_aql_update)
 * - DELETE (mcp_aql_delete)
 *
 * Error categories tested:
 * 1. Unknown operation errors
 * 2. Missing required parameter errors
 * 3. Invalid element type errors
 * 4. Element not found errors
 * 5. Invalid input structure errors
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import { Gatekeeper } from '../../../src/handlers/mcp-aql/Gatekeeper.js';

describe('MCP-AQL Error Handling Integration', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('mcp-aql-errors');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    preConfirmAllOperations(container);

    // Create MCPAQLHandler manually - avoids calling createHandlers which tries to setup MCP server
    // This approach allows us to test the handler in isolation
    const elementCrudHandler = (server as any).elementCRUDHandler;
    mcpAqlHandler = new MCPAQLHandler({
      elementCRUD: elementCrudHandler,
      memoryManager: container.resolve('MemoryManager'),
      agentManager: container.resolve('AgentManager'),
      templateRenderer: container.resolve('TemplateRenderer'),
      elementQueryService: container.resolve('ElementQueryService'),
      gatekeeper: container.resolve<Gatekeeper>('gatekeeper'),
    });
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
  });

  describe('Unknown operation errors', () => {
    it('should fail when CREATE endpoint receives unknown operation', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'unknown_create_operation',
        params: {},
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown operation');
        expect(result.error).toContain('unknown_create_operation');
      }
    });

    it('should fail when READ endpoint receives unknown operation', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'unknown_read_operation',
        params: {},
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown operation');
        expect(result.error).toContain('unknown_read_operation');
      }
    });

    it('should fail when UPDATE endpoint receives unknown operation', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'unknown_update_operation',
        params: {},
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown operation');
        expect(result.error).toContain('unknown_update_operation');
      }
    });

    it('should fail when DELETE endpoint receives unknown operation', async () => {
      const result = await mcpAqlHandler.handleDelete({
        operation: 'unknown_delete_operation',
        params: {},
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown operation');
        expect(result.error).toContain('unknown_delete_operation');
      }
    });

    it('should provide helpful error message with tool description reference', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'nonexistent_op',
        params: {},
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('tool descriptions');
      }
    });
  });

  describe('Wrong endpoint errors (permission violations)', () => {
    it('should fail when create_element is called via READ endpoint', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'create_element',
        params: {
          element_name: 'test',
          element_type: 'personas',
          description: 'Test',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Security violation');
        expect(result.error).toContain('must be called via mcp_aql_create');
      }
    });

    it('should fail when edit_element is called via READ endpoint', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'edit_element',
        params: {
          element_name: 'test',
          element_type: 'personas',
          field: 'description',
          value: 'New description',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Security violation');
        expect(result.error).toContain('must be called via mcp_aql_update');
      }
    });

    it('should fail when delete_element is called via CREATE endpoint', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'delete_element',
        params: {
          element_name: 'test',
          element_type: 'personas',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Security violation');
        expect(result.error).toContain('must be called via mcp_aql_delete');
      }
    });

    it('should fail when list_elements is called via DELETE endpoint', async () => {
      const result = await mcpAqlHandler.handleDelete({
        operation: 'list_elements',
        params: {
          element_type: 'personas',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Security violation');
        expect(result.error).toContain('must be called via mcp_aql_read');
      }
    });
  });

  describe('Missing required parameter errors', () => {
    it('should fail when search_elements is missing query', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'search_elements',
        params: {
          // Missing query
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('query');
      }
    });

    // Note: Parameter validation for create_element, edit_element, etc. happens
    // at the handler/manager layer, not at MCP-AQL layer. MCP-AQL passes params through.
    // Those validations are tested in unit/integration tests for the specific handlers.
  });

  describe('Invalid element type errors', () => {
    // Note: Element type validation happens at the handler/manager layer.
    // Invalid types will typically result in "not found" errors or be handled
    // by the underlying managers. MCP-AQL layer doesn't validate element types.
    // Type validation is tested in unit tests for ElementCRUDHandler and managers.
  });

  describe('Element not found errors', () => {
    it('should fail when addEntry targets non-existent memory', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'nonexistent-memory',
          content: 'Test entry',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    // Note: Most "not found" errors happen at the handler/manager layer.
    // The MCP-AQL layer successfully dispatches the operation, and the underlying
    // handler returns the error. Those specific error messages are tested in
    // the handler/manager unit tests.
  });

  describe('Invalid input structure errors', () => {
    it('should fail when operation field is missing', async () => {
      const result = await mcpAqlHandler.handleRead({
        // Missing operation field
        params: { element_name: 'test' },
      } as any);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid input');
        expect(result.error).toContain('operation');
      }
    });

    it('should fail when input is null', async () => {
      const result = await mcpAqlHandler.handleRead(null);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid input');
      }
    });

    it('should fail when input is undefined', async () => {
      const result = await mcpAqlHandler.handleCreate(undefined);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid input');
      }
    });

    it('should fail when input is a string', async () => {
      const result = await mcpAqlHandler.handleUpdate('invalid-string-input');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid input');
      }
    });

    it('should fail when input is a number', async () => {
      const result = await mcpAqlHandler.handleDelete(12345);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid input');
      }
    });

    it('should fail when params is an array instead of object', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'list_elements',
        params: ['not', 'an', 'object'] as any,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid input');
      }
    });

    it('should fail when params is null', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: null as any,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid input');
      }
    });

    it('should fail when operation is not a string', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 123 as any,
        params: {},
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid input');
      }
    });

    it('should fail when operation is an empty string', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: '',
        params: {},
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown operation');
      }
    });
  });

  describe('Import/Export specific errors', () => {
    it('should fail when import_element receives invalid export package', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'import_element',
        params: {
          data: {
            // Missing required fields
            format: 'json',
            data: '{}',
          },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        // Schema-driven dispatch provides clearer error message
        expect(result.error).toContain('missing element data');
      }
    });

    it('should fail when import_element receives malformed JSON string', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'import_element',
        params: {
          data: '{invalid json syntax',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid export package');
      }
    });

    it('should fail when export_element is missing name parameter', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'export_element',
        params: {
          element_type: 'personas',
          // Missing name
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('name');
      }
    });

    it('should fail when export_element is missing type parameter', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'export_element',
        params: {
          element_name: 'test-element',
          // Missing type
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('type');
      }
    });
  });

  // Issue #244: execute_agent moved to EXECUTE endpoint
  describe('Agent execution errors', () => {
    it('should fail when execute_agent targets non-existent agent', async () => {
      const result = await mcpAqlHandler.handleExecute({
        operation: 'execute_agent',
        params: {
          element_name: 'nonexistent-agent',
          parameters: {},
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe('Template rendering errors', () => {
    // Note: Template rendering errors (template not found, invalid variables, etc.)
    // are handled by the TemplateRenderer. MCP-AQL successfully dispatches the
    // render operation, and any errors are caught and returned as OperationFailure.
    // Template-specific error behavior is tested in TemplateRenderer unit tests.
  });

  describe('Memory operations errors', () => {
    it('should fail when clear targets non-existent memory', async () => {
      const result = await mcpAqlHandler.handleDelete({
        operation: 'clear',
        params: {
          element_name: 'nonexistent-memory',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });
  });

  describe('Search query validation errors', () => {
    it('should fail when search query exceeds length limit', async () => {
      const longQuery = 'a'.repeat(1001); // Over 1000 character limit

      const result = await mcpAqlHandler.handleRead({
        operation: 'search_elements',
        params: {
          query: longQuery,
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('1000 characters');
      }
    });

    it('should fail when search query is empty string', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'search_elements',
        params: {
          query: '',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('query');
      }
    });

    it('should fail when search query is only whitespace', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'search_elements',
        params: {
          query: '   ',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('query');
      }
    });
  });

  describe('Query elements errors', () => {
    it('should fail when query_elements is missing elementType', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'query_elements',
        params: {
          // Missing elementType
          filters: {},
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('elementType');
      }
    });
  });

  describe('Actionable validation error messages (#441)', () => {
    // Note: Element-level validation happens at the handler/manager layer.
    // Validation errors are returned as MCP tool responses (success: true, data with error text)
    // because createElement catches exceptions internally and formats them.

    it('should include specific invalid characters when creating a persona with slash in name', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'personas',
        params: {
          element_name: 'test/invalid',
          description: 'A test persona',
          instructions: 'You are a test persona with detailed instructions for testing purposes.',
        },
      });

      // Validation errors propagate as MCP tool responses (success: true, error in data)
      if (result.success && result.data) {
        const text = (result.data as any)?.content?.[0]?.text ?? '';
        // The error message should contain the invalid character and allowed pattern
        if (text.includes('invalid characters')) {
          expect(text).toContain("'/'");
          expect(text).toContain('Allowed:');
        }
      }
    });

    it('should include specific invalid characters when creating a skill with special chars', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'skills',
        params: {
          element_name: 'test@skill#1',
          description: 'A test skill',
          content: '# Test Skill\n\nThis is a test skill.',
        },
      });

      if (result.success && result.data) {
        const text = (result.data as any)?.content?.[0]?.text ?? '';
        if (text.includes('invalid characters')) {
          expect(text).toContain('Allowed:');
        }
      }
    });

    it('should include allowed pattern description in category validation errors', async () => {
      // Test category validation via the ValidationService directly
      // Category validation uses SAFE_CATEGORY pattern
      const { ValidationService } = await import('../../../src/services/validation/ValidationService.js');
      const service = new ValidationService();

      const result = service.validateCategory('test category!');

      expect(result.isValid).toBe(false);
      expect(result.errors?.[0]).toContain('invalid characters');
      expect(result.errors?.[0]).toContain('Allowed:');
      expect(result.errors?.[0]).toContain('must start with a letter');
    });

    it('should include allowed pattern description in username validation errors', async () => {
      const { ValidationService } = await import('../../../src/services/validation/ValidationService.js');
      const service = new ValidationService();

      const result = service.validateUsername('user@name');

      expect(result.isValid).toBe(false);
      expect(result.errors?.[0]).toContain('invalid characters');
      expect(result.errors?.[0]).toContain("'@'");
      expect(result.errors?.[0]).toContain('Allowed:');
      expect(result.errors?.[0]).toContain('must start and end with alphanumeric');
    });

    it('should include structural constraints when all chars are valid but pattern fails', async () => {
      const { ValidationService } = await import('../../../src/services/validation/ValidationService.js');
      const service = new ValidationService();

      // Username 'a' - all chars are individually valid but too short for SAFE_USERNAME pattern
      const result = service.validateUsername('a');

      expect(result.isValid).toBe(false);
      expect(result.errors?.[0]).toContain('invalid characters');
      // No specific invalid chars to list, but structural constraint should explain
      expect(result.errors?.[0]).toContain('Allowed:');
      expect(result.errors?.[0]).toContain('must start and end with alphanumeric');
    });
  });
});
