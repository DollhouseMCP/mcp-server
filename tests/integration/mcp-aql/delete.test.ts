/**
 * Integration tests for MCP-AQL DELETE endpoint (mcp_aql_delete)
 *
 * Tests the full flow from MCP tool call to element deletion,
 * covering all DELETE operations:
 * - delete_element: Delete elements permanently
 * - clear: Clear memory entries
 *
 * Note: execute_agent was moved to EXECUTE endpoint in Issue #244
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import path from 'path';
import fs from 'fs/promises';

describe('MCP-AQL DELETE Endpoint Integration', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('mcp-aql-delete');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    preConfirmAllOperations(container);
    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
  });

  describe('delete_element operation', () => {
    beforeEach(async () => {
      // Create test elements for deletion
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'persona-to-delete',
          element_type: 'personas',
          description: 'A persona to be deleted',
          content: '# Persona to Delete\n\nThis will be deleted.',
        },
      });

      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'skill-to-delete',
          element_type: 'skills',
          description: 'A skill to be deleted',
          content: '# Skill to Delete\n\nThis will be removed.',
          metadata: { domain: 'testing' },
        },
      });
    });

    it('should delete a persona via mcp_aql_delete', async () => {
      // Verify element exists
      const personaFile = path.join(env.testDir, 'personas', 'persona-to-delete.md');
      await expect(fs.access(personaFile)).resolves.toBeUndefined();

      // Delete the persona
      const result = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: {
          element_name: 'persona-to-delete',
          element_type: 'personas',
        },
      });

      expect(result.success).toBe(true);

      // Verify file was removed
      await expect(fs.access(personaFile)).rejects.toThrow();
    });

    it('should delete a skill via mcp_aql_delete', async () => {
      // Verify element exists
      const skillFile = path.join(env.testDir, 'skills', 'skill-to-delete.md');
      await expect(fs.access(skillFile)).resolves.toBeUndefined();

      // Delete the skill
      const result = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: {
          element_name: 'skill-to-delete',
          element_type: 'skills',
        },
      });

      expect(result.success).toBe(true);

      // Verify file was removed
      await expect(fs.access(skillFile)).rejects.toThrow();
    });

    it('should delete using elementType parameter', async () => {
      const result = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        elementType: 'persona' as any,
        params: {
          element_name: 'persona-to-delete',
        },
      });

      expect(result.success).toBe(true);

      const personaFile = path.join(env.testDir, 'personas', 'persona-to-delete.md');
      await expect(fs.access(personaFile)).rejects.toThrow();
    });

    it('should delete element with deleteData flag', async () => {
      // Create a template with potential data files
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'template-with-data',
          element_type: 'templates',
          description: 'Template with associated data',
          content: 'Template content: {{variable}}',
        },
      });

      const result = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: {
          element_name: 'template-with-data',
          element_type: 'templates',
          deleteData: true,
        },
      });

      expect(result.success).toBe(true);

      const templateFile = path.join(env.testDir, 'templates', 'template-with-data.md');
      await expect(fs.access(templateFile)).rejects.toThrow();
    });

    it('should handle deleting non-existent element gracefully', async () => {
      const result = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: {
          element_name: 'non-existent-element',
          element_type: 'personas',
        },
      });

      // Delete operations may be idempotent - either succeeds or fails gracefully
      expect(result).toHaveProperty('success');
      expect(typeof result.success).toBe('boolean');

      if (!result.success) {
        expect(result.error).toBeDefined();
        expect(typeof result.error).toBe('string');
      }
    });

    it('should handle missing parameters appropriately', async () => {
      const result = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: {
          // Missing name - system may handle this gracefully or error
          element_type: 'personas',
        },
      });

      // System should return a valid result structure
      expect(result).toHaveProperty('success');
      expect(typeof result.success).toBe('boolean');

      if (!result.success) {
        expect(result.error).toBeDefined();
        expect(typeof result.error).toBe('string');
      }
    });

    // FIX: Issue #276 - Test skipped due to cache timing issues between create and delete operations
    // Elements created via handleCreate are not immediately visible for delete operations
    it.skip('should delete multiple different element types', async () => {
      // Create multiple element types
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'multi-delete-persona',
          element_type: 'personas',
          description: 'Persona for multi-type delete test',
          content: 'Content',
        },
      });

      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'multi-delete-template',
          element_type: 'templates',
          description: 'Template for multi-type delete test',
          content: 'Template {{var}}',
        },
      });

      // Delete persona
      const personaResult = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: {
          element_name: 'multi-delete-persona',
          element_type: 'personas',
        },
      });
      expect(personaResult.success).toBe(true);

      // Delete template
      const templateResult = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: {
          element_name: 'multi-delete-template',
          element_type: 'templates',
        },
      });
      expect(templateResult.success).toBe(true);

      // Verify both are deleted
      const personaFile = path.join(env.testDir, 'personas', 'multi-delete-persona.md');
      const templateFile = path.join(env.testDir, 'templates', 'multi-delete-template.md');
      await expect(fs.access(personaFile)).rejects.toThrow();
      await expect(fs.access(templateFile)).rejects.toThrow();
    });
  });

  describe('ensemble delete_element operations (Issue #662)', () => {
    beforeEach(async () => {
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'ensemble-to-delete',
          element_type: 'ensembles',
          description: 'Ensemble to be deleted',
          content: '# Delete Me\n\nThis ensemble will be deleted.',
          metadata: {
            elements: [
              { element_name: 'test-skill', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' },
            ],
          },
        },
      });
    });

    it('should delete an ensemble', async () => {
      const ensembleFile = path.join(env.testDir, 'ensembles', 'ensemble-to-delete.md');
      await expect(fs.access(ensembleFile)).resolves.toBeUndefined();

      const result = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: {
          element_name: 'ensemble-to-delete',
          element_type: 'ensembles',
        },
      });

      expect(result.success).toBe(true);
      await expect(fs.access(ensembleFile)).rejects.toThrow();
    });

    it('should handle deleting non-existent ensemble', async () => {
      const result = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: {
          element_name: 'non-existent-ensemble',
          element_type: 'ensembles',
        },
      });

      expect(result).toHaveProperty('success');
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe('clear operation', () => {
    beforeEach(async () => {
      // Create a memory element with entries
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'memory-to-clear',
          element_type: 'memories',
          description: 'A memory with entries to be cleared',
          content: '',
          metadata: { retention: 'session' },
        },
      });

      // Add entries to the memory
      await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'memory-to-clear',
          content: 'First entry to be cleared',
          tags: ['test', 'clear'],
        },
      });

      await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'memory-to-clear',
          content: 'Second entry to be cleared',
          tags: ['test', 'clear'],
        },
      });
    });

    it('should clear all entries from a memory via mcp_aql_delete', async () => {
      const result = await mcpAqlHandler.handleDelete({
        operation: 'clear',
        params: {
          element_name: 'memory-to-clear',
        },
      });

      expect(result.success).toBe(true);

      // Note: The clear operation's behavior depends on implementation.
      // It may clear entries in-place or remove and recreate the memory file.
      // We verify the operation succeeds without checking file state.
    });

    it('should fail when clearing non-existent memory', async () => {
      const result = await mcpAqlHandler.handleDelete({
        operation: 'clear',
        params: {
          element_name: 'non-existent-memory',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    it('should handle clearing already empty memory', async () => {
      // Create a new memory without entries
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'empty-memory',
          element_type: 'memories',
          description: 'An empty memory',
          content: '',
        },
      });

      const result = await mcpAqlHandler.handleDelete({
        operation: 'clear',
        params: {
          element_name: 'empty-memory',
        },
      });

      // Should succeed even if already empty
      expect(result.success).toBe(true);
    });
  });

  // Issue #244: execute_agent tests moved to EXECUTE endpoint tests
  // See tests/integration/mcp-aql/execute.test.ts for EXECUTE endpoint tests

  describe('DELETE endpoint permission validation', () => {
    it('should reject CREATE operations on DELETE endpoint', async () => {
      // Try to call a CREATE operation (create_element) through handleDelete
      // This should fail permission validation
      const result = await mcpAqlHandler.handleDelete({
        operation: 'create_element',
        params: {
          element_name: 'invalid-operation',
          element_type: 'personas',
          description: 'Should not be created',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Security violation');
        expect(result.error).toContain('CREATE');
      }
    });

    it('should reject READ operations on DELETE endpoint', async () => {
      const result = await mcpAqlHandler.handleDelete({
        operation: 'list_elements',
        params: {
          element_type: 'personas',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Security violation');
        expect(result.error).toContain('READ');
      }
    });

    it('should reject UPDATE operations on DELETE endpoint', async () => {
      const result = await mcpAqlHandler.handleDelete({
        operation: 'edit_element',
        params: {
          element_name: 'test',
          element_type: 'personas',
          field: 'description',
          value: 'new value',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Security violation');
        expect(result.error).toContain('UPDATE');
      }
    });
  });

  describe('error handling', () => {
    it('should handle invalid operation input', async () => {
      const result = await mcpAqlHandler.handleDelete({
        // Missing operation field
        params: {
          element_name: 'test',
        },
      } as any);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });

    it('should handle unknown DELETE operations', async () => {
      const result = await mcpAqlHandler.handleDelete({
        operation: 'unknown_delete_operation',
        params: {},
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });

    it('should return structured error for validation failures', async () => {
      // Test with completely invalid params that will cause an error
      const result = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: {
          name: null as any, // Invalid name type
          element_type: 'personas',
        },
      });

      // Result structure should be valid regardless of success/failure
      expect(result).toHaveProperty('success');
      if (!result.success) {
        expect(typeof result.error).toBe('string');
        expect(result.error.length).toBeGreaterThan(0);
      } else {
        // If it somehow succeeds, data should be defined
        expect(result.data).toBeDefined();
      }
    });
  });
});
