/**
 * Tests for MCP-AQL batch operations
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { MCPAQLHandler, HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { Gatekeeper } from '../../../../src/handlers/mcp-aql/Gatekeeper.js';
import { PermissionLevel } from '../../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import { BatchRequest, BatchResult, isBatchRequest } from '../../../../src/handlers/mcp-aql/types.js';

// Mock dependencies
const mockElementCRUD = {
  createElement: jest.fn(),
  getElements: jest.fn(),
  getElement: jest.fn(),
  editElement: jest.fn(),
  deleteElement: jest.fn(),
  activateElement: jest.fn(),
  deactivateElement: jest.fn(),
  getActiveElements: jest.fn(),
  validateElement: jest.fn(),
};

const mockMemoryManager = {
  addEntry: jest.fn(),
  getEntries: jest.fn(),
  clearEntries: jest.fn(),
};

const mockAgentManager = {
  executeAgent: jest.fn(),
};

const mockTemplateRenderer = {
  render: jest.fn(),
};

const mockElementQueryService = {
  query: jest.fn(),
};

describe('MCP-AQL Batch Operations', () => {
  let handler: MCPAQLHandler;

  beforeEach(() => {
    jest.clearAllMocks();

    // Issue #452: Create permissive gatekeeper for non-enforcement tests
    const gatekeeper = new Gatekeeper(undefined, { enableAuditLogging: false });
    gatekeeper.enforce = () => ({
      allowed: true,
      permissionLevel: PermissionLevel.AUTO_APPROVE,
      reason: 'Auto-approved by test mock',
    });

    const handlers: HandlerRegistry = {
      elementCRUD: mockElementCRUD as unknown as HandlerRegistry['elementCRUD'],
      memoryManager: mockMemoryManager as unknown as HandlerRegistry['memoryManager'],
      agentManager: mockAgentManager as unknown as HandlerRegistry['agentManager'],
      templateRenderer: mockTemplateRenderer as unknown as HandlerRegistry['templateRenderer'],
      elementQueryService: mockElementQueryService as unknown as HandlerRegistry['elementQueryService'],
      gatekeeper,
    };

    handler = new MCPAQLHandler(handlers);
  });

  describe('isBatchRequest type guard', () => {
    it('should return true for valid batch request', () => {
      const input: BatchRequest = {
        operations: [
          { operation: 'create_element', params: { element_name: 'test', element_type: 'persona' } },
        ],
      };
      expect(isBatchRequest(input)).toBe(true);
    });

    it('should return false for single operation input', () => {
      const input = { operation: 'create_element', params: { element_name: 'test' } };
      expect(isBatchRequest(input)).toBe(false);
    });

    it('should return false for null', () => {
      expect(isBatchRequest(null)).toBe(false);
    });

    it('should return false for non-object', () => {
      expect(isBatchRequest('string')).toBe(false);
      expect(isBatchRequest(123)).toBe(false);
    });

    it('should return false if operations is not an array', () => {
      expect(isBatchRequest({ operations: 'not-array' })).toBe(false);
    });

    it('should return false if operation items are invalid', () => {
      expect(isBatchRequest({ operations: [{ notOperation: 'test' }] })).toBe(false);
    });
  });

  describe('handleCreate with batch', () => {
    it('should execute multiple create operations', async () => {
      mockElementCRUD.createElement
        .mockResolvedValueOnce({ name: 'a', element_type: 'persona' })
        .mockResolvedValueOnce({ name: 'b', element_type: 'skill' });

      const batch: BatchRequest = {
        operations: [
          { operation: 'create_element', elementType: 'persona', params: { element_name: 'a', description: 'Test A' } },
          { operation: 'create_element', elementType: 'skill', params: { element_name: 'b', description: 'Test B' } },
        ],
      };

      const result = await handler.handleCreate(batch) as BatchResult;

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.summary.total).toBe(2);
      expect(result.summary.succeeded).toBe(2);
      expect(result.summary.failed).toBe(0);
    });

    it('should handle partial failures in batch', async () => {
      mockElementCRUD.createElement
        .mockResolvedValueOnce({ name: 'a' })
        .mockRejectedValueOnce(new Error('Creation failed'));

      const batch: BatchRequest = {
        operations: [
          { operation: 'create_element', elementType: 'persona', params: { element_name: 'a', description: 'Test A' } },
          { operation: 'create_element', elementType: 'skill', params: { element_name: 'b', description: 'Test B' } },
        ],
      };

      const result = await handler.handleCreate(batch) as BatchResult;

      expect(result.success).toBe(true); // Batch itself succeeds
      expect(result.results[0].result.success).toBe(true);
      expect(result.results[1].result.success).toBe(false);
      expect(result.summary.succeeded).toBe(1);
      expect(result.summary.failed).toBe(1);
    });

    it('should return results in order', async () => {
      mockElementCRUD.createElement
        .mockResolvedValueOnce({ name: 'first' })
        .mockResolvedValueOnce({ name: 'second' })
        .mockResolvedValueOnce({ name: 'third' });

      const batch: BatchRequest = {
        operations: [
          { operation: 'create_element', elementType: 'persona', params: { element_name: 'first', description: 'First' } },
          { operation: 'create_element', elementType: 'skill', params: { element_name: 'second', description: 'Second' } },
          { operation: 'create_element', elementType: 'template', params: { element_name: 'third', description: 'Third' } },
        ],
      };

      const result = await handler.handleCreate(batch) as BatchResult;

      expect(result.results[0].index).toBe(0);
      expect(result.results[1].index).toBe(1);
      expect(result.results[2].index).toBe(2);
    });
  });

  describe('handleRead with batch', () => {
    it('should detect batch request and return batch result structure', async () => {
      // Simple test to verify batch detection works for READ
      const batch: BatchRequest = {
        operations: [],
      };

      const result = await handler.handleRead(batch) as BatchResult;

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('summary');
    });
  });

  describe('handleUpdate with batch', () => {
    it('should execute multiple update operations', async () => {
      mockElementCRUD.editElement
        .mockResolvedValueOnce({ name: 'a', updated: true })
        .mockResolvedValueOnce({ name: 'b', updated: true });

      const batch: BatchRequest = {
        operations: [
          { operation: 'edit_element', elementType: 'persona', params: { element_name: 'a', input: { description: 'new' } } },
          { operation: 'edit_element', elementType: 'skill', params: { element_name: 'b', input: { description: 'new' } } },
        ],
      };

      const result = await handler.handleUpdate(batch) as BatchResult;

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
    });
  });

  describe('handleDelete with batch', () => {
    it('should execute multiple delete operations', async () => {
      mockElementCRUD.deleteElement
        .mockResolvedValueOnce({ deleted: true })
        .mockResolvedValueOnce({ deleted: true });

      const batch: BatchRequest = {
        operations: [
          { operation: 'delete_element', elementType: 'persona', params: { element_name: 'a' } },
          { operation: 'delete_element', elementType: 'skill', params: { element_name: 'b' } },
        ],
      };

      const result = await handler.handleDelete(batch) as BatchResult;

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
    });
  });

  describe('single operation fallback', () => {
    it('should handle single operation when not batch', async () => {
      mockElementCRUD.createElement.mockResolvedValue({ name: 'test' });

      const result = await handler.handleCreate({
        operation: 'create_element',
        elementType: 'persona',
        params: { element_name: 'test' },
      });

      // Should return OperationResult, not BatchResult
      expect(result).toHaveProperty('success');
      expect(result).not.toHaveProperty('results');
    });
  });

  describe('batch size limit (Issue #221/#543)', () => {
    it('should reject batches exceeding MAX_BATCH_OPERATIONS', async () => {
      // Create a batch with 51 operations (limit is 50)
      const operations = Array.from({ length: 51 }, (_, i) => ({
        operation: 'create_element' as const,
        elementType: 'persona' as const,
        params: { element_name: `test-${i}`, description: `Test ${i}` },
      }));

      const batch: BatchRequest = { operations };
      const result = await handler.handleCreate(batch) as BatchResult;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/exceeds maximum of 50/);
      expect(result.results).toHaveLength(0);
      expect(result.summary.total).toBe(51);
      expect(result.summary.succeeded).toBe(0);
      // No operations should have been executed
      expect(mockElementCRUD.createElement).not.toHaveBeenCalled();
    });

    it('should allow batches at exactly the limit', async () => {
      mockElementCRUD.createElement.mockResolvedValue({ name: 'test' });

      const operations = Array.from({ length: 50 }, (_, i) => ({
        operation: 'create_element' as const,
        elementType: 'persona' as const,
        params: { element_name: `test-${i}`, description: `Test ${i}` },
      }));

      const batch: BatchRequest = { operations };
      const result = await handler.handleCreate(batch) as BatchResult;

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(50);
      expect(result.summary.succeeded).toBe(50);
    });
  });

  describe('empty batch', () => {
    it('should handle empty batch gracefully', async () => {
      const batch: BatchRequest = {
        operations: [],
      };

      const result = await handler.handleCreate(batch) as BatchResult;

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(0);
      expect(result.summary.total).toBe(0);
      expect(result.summary.succeeded).toBe(0);
      expect(result.summary.failed).toBe(0);
    });
  });
});
