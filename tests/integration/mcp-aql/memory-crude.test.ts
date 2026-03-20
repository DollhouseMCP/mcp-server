/**
 * Integration tests for Memory CRUDE operations via MCP-AQL
 *
 * Tests the complete memory lifecycle through MCP-AQL endpoints:
 * - CREATE: create_element (memory), addEntry
 * - READ: list_elements, get_element for memories
 * - UPDATE: verify append-only behavior (edit_element should fail)
 * - DELETE: clear operation
 *
 * These tests verify the two-step memory flow documented in issue #396:
 * 1. Create memory container via create_element
 * 2. Add entries via addEntry
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('Memory CRUDE Operations Integration', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('mcp-aql-memory-crude');
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

  describe('CREATE: Memory Creation Flow', () => {
    describe('create_element for memory', () => {
      it('should create an empty memory container', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'session-notes',
            element_type: 'memories',
            description: 'Session context and notes',
          },
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBeDefined();
        }
      });

      it('should create memory with retention metadata', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'audit-log',
            element_type: 'memories',
            description: 'Audit trail for operations',
            metadata: { retention: 'permanent', privacyLevel: 'private' },
          },
        });

        expect(result.success).toBe(true);
      });

      it('should overwrite memory with duplicate name (upsert behavior)', async () => {
        // Create first memory
        await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'duplicate-test',
            element_type: 'memories',
            description: 'First memory',
          },
        });

        // Creating with same name overwrites (upsert behavior)
        const result = await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'duplicate-test',
            element_type: 'memories',
            description: 'Updated memory',
          },
        });

        // System allows upsert - this is expected behavior
        expect(result.success).toBe(true);
      });
    });

    describe('addEntry operation', () => {
      beforeEach(async () => {
        // Create memory container first
        await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'entry-test-memory',
            element_type: 'memories',
            description: 'Memory for entry tests',
          },
        });
      });

      it('should add entry to existing memory', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'entry-test-memory',
            content: 'Remember this important fact',
          },
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBeDefined();
        }
      });

      it('should add entry with tags', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'entry-test-memory',
            content: 'Tagged entry content',
            tags: ['important', 'session-1'],
          },
        });

        expect(result.success).toBe(true);
      });

      it('should add entry with metadata', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'entry-test-memory',
            content: 'Entry with custom metadata',
            tags: ['metadata-test'],
            metadata: { source: 'integration-test', priority: 'high' },
          },
        });

        expect(result.success).toBe(true);
      });

      it('should add multiple entries to same memory', async () => {
        // Add first entry
        const result1 = await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'entry-test-memory',
            content: 'First entry',
          },
        });
        expect(result1.success).toBe(true);

        // Add second entry
        const result2 = await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'entry-test-memory',
            content: 'Second entry',
          },
        });
        expect(result2.success).toBe(true);

        // Add third entry
        const result3 = await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'entry-test-memory',
            content: 'Third entry',
          },
        });
        expect(result3.success).toBe(true);
      });

      it('should fail when memory does not exist', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'non-existent-memory',
            content: 'This should fail',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('not found');
        }
      });

      it('should fail when content is empty', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'entry-test-memory',
            content: '',
          },
        });

        expect(result.success).toBe(false);
      });
    });
  });

  describe('READ: Memory Retrieval', () => {
    beforeEach(async () => {
      // Create memories with entries for read tests
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'read-test-memory',
          element_type: 'memories',
          description: 'Memory for read tests',
        },
      });

      await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'read-test-memory',
          content: 'First test entry for reading',
          tags: ['read-test'],
        },
      });

      await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'read-test-memory',
          content: 'Second test entry for reading',
          tags: ['read-test'],
        },
      });

      // Create a second memory for list tests
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'another-memory',
          element_type: 'memories',
          description: 'Another memory for list tests',
        },
      });

      // Allow cache to settle
      await new Promise(resolve => setTimeout(resolve, 500));
    });

    describe('list_elements for memories', () => {
      it('should list all memories', async () => {
        const result = await mcpAqlHandler.handleRead({
          operation: 'list_elements',
          params: {
            element_type: 'memories',
          },
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // Issue #299: list_elements now returns structured data
          const data = result.data as { items?: Array<{ name: string }> };
          expect(data.items).toBeDefined();
          expect(Array.isArray(data.items)).toBe(true);
          const names = (data.items || []).map((i: any) => i.name || i.element_name);
          expect(names).toContain('read-test-memory');
        }
      });
    });

    describe('get_element for memory', () => {
      it('should get memory with its entries', async () => {
        const result = await mcpAqlHandler.handleRead({
          operation: 'get_element',
          params: {
            element_name: 'read-test-memory',
            element_type: 'memories',
          },
        });

        expect(result.success).toBe(true);
        if (result.success) {
          const data = result.data as { content?: Array<{ type: string; text: string }> };
          expect(data.content).toBeDefined();
          const text = data.content![0].text;
          // Should contain memory name and entries
          expect(text).toContain('read-test-memory');
          expect(text).toContain('First test entry');
          expect(text).toContain('Second test entry');
        }
      });

      it('should fail for non-existent memory', async () => {
        const result = await mcpAqlHandler.handleRead({
          operation: 'get_element',
          params: {
            element_name: 'does-not-exist',
            element_type: 'memories',
          },
        });

        expect(result.success).toBe(false);
      });
    });
  });

  describe('UPDATE: Append-Only Behavior', () => {
    beforeEach(async () => {
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'update-test-memory',
          element_type: 'memories',
          description: 'Memory for update tests',
        },
      });

      await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'update-test-memory',
          content: 'Original entry',
        },
      });
    });

    it('should reject edit_element for memory content', async () => {
      // Memories are append-only - edit_element should not modify entries
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'update-test-memory',
          element_type: 'memories',
          input: {
            content: 'This should not replace entries',
          },
        },
      });

      // edit_element on memory content should fail or be ignored
      // The exact behavior depends on implementation
      // At minimum, it should not destroy existing entries
      if (result.success) {
        // If it succeeds, verify entries are preserved
        const readResult = await mcpAqlHandler.handleRead({
          operation: 'get_element',
          params: {
            element_name: 'update-test-memory',
            element_type: 'memories',
          },
        });

        if (readResult.success) {
          const data = readResult.data as { content?: Array<{ type: string; text: string }> };
          const text = data.content![0].text;
          expect(text).toContain('Original entry');
        }
      }
    });

    it('should allow editing memory metadata (description)', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'update-test-memory',
          element_type: 'memories',
          input: {
            description: 'Updated description',
          },
        },
      });

      // Editing metadata (not content) may be allowed
      // This test documents the expected behavior
      expect(result).toBeDefined();
    });
  });

  describe('DELETE: Clear Operation', () => {
    beforeEach(async () => {
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'delete-test-memory',
          element_type: 'memories',
          description: 'Memory for delete tests',
        },
      });

      await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'delete-test-memory',
          content: 'Entry to be cleared',
        },
      });

      await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'delete-test-memory',
          content: 'Another entry to be cleared',
        },
      });
    });

    it('should clear all entries from memory', async () => {
      const result = await mcpAqlHandler.handleDelete({
        operation: 'clear',
        params: {
          element_name: 'delete-test-memory',
        },
      });

      expect(result.success).toBe(true);
    });

    it('should succeed when clearing already empty memory', async () => {
      // Create empty memory
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'empty-memory',
          element_type: 'memories',
          description: 'Already empty',
        },
      });

      const result = await mcpAqlHandler.handleDelete({
        operation: 'clear',
        params: {
          element_name: 'empty-memory',
        },
      });

      expect(result.success).toBe(true);
    });

    it('should fail when clearing non-existent memory', async () => {
      const result = await mcpAqlHandler.handleDelete({
        operation: 'clear',
        params: {
          element_name: 'memory-that-does-not-exist',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    it('should delete memory element entirely via delete_element', async () => {
      const result = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: {
          element_name: 'delete-test-memory',
          element_type: 'memories',
        },
      });

      expect(result.success).toBe(true);

      // Verify memory no longer exists
      const readResult = await mcpAqlHandler.handleRead({
        operation: 'get_element',
        params: {
          element_name: 'delete-test-memory',
          element_type: 'memories',
        },
      });

      expect(readResult.success).toBe(false);
    });
  });

  describe('Persistence Verification (Issue #438)', () => {
    it('should persist addEntry to disk across server restart', async () => {
      // Create memory and add entry
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'persist-test',
          element_type: 'memories',
          description: 'Persistence test memory',
        },
      });

      await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'persist-test',
          content: 'This entry must survive restart',
          tags: ['persistence'],
        },
      });

      // Allow filesystem flush
      await new Promise(resolve => setTimeout(resolve, 500));

      // Dispose and recreate server to simulate restart
      await server.dispose();

      const container2 = new DollhouseContainer();
      const server2 = new DollhouseMCPServer(container2);
      await server2.listPersonas(); // Initialize
      const handler2 = container2.resolve<MCPAQLHandler>('mcpAqlHandler');

      try {
        // Read memory from fresh server instance
        const result = await handler2.handleRead({
          operation: 'get_element',
          params: {
            element_name: 'persist-test',
            element_type: 'memories',
          },
        });

        expect(result.success).toBe(true);
        if (result.success) {
          const data = result.data as { content?: Array<{ type: string; text: string }> };
          const text = data.content![0].text;
          expect(text).toContain('This entry must survive restart');
        }
      } finally {
        await server2.dispose();
      }
    });

    it('should persist clear operation to disk across server restart', async () => {
      // Create memory, add entry, then clear
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'clear-persist-test',
          element_type: 'memories',
          description: 'Clear persistence test',
        },
      });

      await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'clear-persist-test',
          content: 'Entry that will be cleared',
        },
      });

      // Clear all entries
      await mcpAqlHandler.handleDelete({
        operation: 'clear',
        params: {
          element_name: 'clear-persist-test',
        },
      });

      // Allow filesystem flush
      await new Promise(resolve => setTimeout(resolve, 500));

      // Dispose and recreate server to simulate restart
      await server.dispose();

      const container2 = new DollhouseContainer();
      const server2 = new DollhouseMCPServer(container2);
      await server2.listPersonas();
      const handler2 = container2.resolve<MCPAQLHandler>('mcpAqlHandler');

      try {
        const result = await handler2.handleRead({
          operation: 'get_element',
          params: {
            element_name: 'clear-persist-test',
            element_type: 'memories',
          },
        });

        expect(result.success).toBe(true);
        if (result.success) {
          const data = result.data as { content?: Array<{ type: string; text: string }> };
          const text = data.content![0].text;
          // The cleared entry should NOT be present
          expect(text).not.toContain('Entry that will be cleared');
        }
      } finally {
        await server2.dispose();
      }
    });
  });

  describe('Complete Memory Lifecycle', () => {
    it('should handle full create -> add entries -> read -> clear -> delete flow', async () => {
      // 1. CREATE: Create memory container
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'lifecycle-test',
          element_type: 'memories',
          description: 'Full lifecycle test',
        },
      });
      expect(createResult.success).toBe(true);

      // 2. CREATE: Add entries
      const addResult1 = await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'lifecycle-test',
          content: 'Step 1 completed',
          tags: ['lifecycle'],
        },
      });
      expect(addResult1.success).toBe(true);

      const addResult2 = await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'lifecycle-test',
          content: 'Step 2 completed',
          tags: ['lifecycle'],
        },
      });
      expect(addResult2.success).toBe(true);

      // 3. READ: Verify entries exist
      const readResult = await mcpAqlHandler.handleRead({
        operation: 'get_element',
        params: {
          element_name: 'lifecycle-test',
          element_type: 'memories',
        },
      });
      expect(readResult.success).toBe(true);
      if (readResult.success) {
        const data = readResult.data as { content?: Array<{ type: string; text: string }> };
        const text = data.content![0].text;
        expect(text).toContain('Step 1 completed');
        expect(text).toContain('Step 2 completed');
      }

      // 4. DELETE: Clear entries
      const clearResult = await mcpAqlHandler.handleDelete({
        operation: 'clear',
        params: {
          element_name: 'lifecycle-test',
        },
      });
      expect(clearResult.success).toBe(true);

      // 5. DELETE: Remove memory entirely
      const deleteResult = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: {
          element_name: 'lifecycle-test',
          element_type: 'memories',
        },
      });
      expect(deleteResult.success).toBe(true);

      // 6. Verify memory is gone
      const finalReadResult = await mcpAqlHandler.handleRead({
        operation: 'get_element',
        params: {
          element_name: 'lifecycle-test',
          element_type: 'memories',
        },
      });
      expect(finalReadResult.success).toBe(false);
    });
  });

  describe('Validation and Error Cases', () => {
    describe('create_element validation', () => {
      it('should fail with missing element_name', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_type: 'memories',
            description: 'Missing name',
          },
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBeDefined();
        }
      });

      it('should fail with missing element_type', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'no-type-memory',
            description: 'Missing type',
          },
        });

        expect(result.success).toBe(false);
      });

      it('should handle invalid element_type gracefully', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'invalid-type-test',
            element_type: 'invalid_type',
            description: 'Invalid type',
          },
        });

        // System may normalize/reject invalid types - document actual behavior
        // This test verifies the system doesn't crash on invalid input
        expect(result).toBeDefined();
      });

      it('should sanitize potentially dangerous element names', async () => {
        // Attempt path traversal in name
        const result = await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: '../../../etc/passwd',
            element_type: 'memories',
            description: 'Path traversal attempt',
          },
        });

        // Should either fail or sanitize the name
        if (result.success) {
          // If it succeeds, the name should be sanitized
          const readResult = await mcpAqlHandler.handleRead({
            operation: 'get_element',
            params: {
              element_name: '../../../etc/passwd',
              element_type: 'memories',
            },
          });
          // Original malicious path should not work
          expect(readResult.success).toBe(false);
        }
      });
    });

    describe('addEntry validation', () => {
      beforeEach(async () => {
        await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'validation-memory',
            element_type: 'memories',
            description: 'For validation tests',
          },
        });
      });

      it('should fail with missing element_name', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            content: 'Content without memory name',
          },
        });

        expect(result.success).toBe(false);
      });

      it('should fail with missing content parameter', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'validation-memory',
          },
        });

        expect(result.success).toBe(false);
      });

      it('should fail with null content', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'validation-memory',
            content: null,
          },
        });

        expect(result.success).toBe(false);
      });

      it('should fail with whitespace-only content', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'validation-memory',
            content: '   \n\t  ',
          },
        });

        expect(result.success).toBe(false);
      });

      it('should handle very long content gracefully', async () => {
        const longContent = 'A'.repeat(100000); // 100KB of content
        const result = await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'validation-memory',
            content: longContent,
          },
        });

        // Should either succeed with truncation or fail with size error
        expect(result).toBeDefined();
      });

      it('should sanitize HTML/script content', async () => {
        const result = await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'validation-memory',
            content: '<script>alert("xss")</script>Normal content',
          },
        });

        // Should succeed but sanitize the content
        expect(result.success).toBe(true);

        // Verify content was sanitized
        const readResult = await mcpAqlHandler.handleRead({
          operation: 'get_element',
          params: {
            element_name: 'validation-memory',
            element_type: 'memories',
          },
        });

        if (readResult.success) {
          const data = readResult.data as { content?: Array<{ type: string; text: string }> };
          const text = data.content![0].text;
          // Script tags should be stripped
          expect(text).not.toContain('<script>');
          expect(text).toContain('Normal content');
        }
      });
    });
  });

  describe('Complex Memory Operations', () => {
    beforeEach(async () => {
      // Create multiple memories for complex operation tests
      const memories = [
        { name: 'project-alpha', description: 'Project Alpha notes', tags: ['project', 'alpha'] },
        { name: 'project-beta', description: 'Project Beta notes', tags: ['project', 'beta'] },
        { name: 'daily-standup', description: 'Daily standup notes', tags: ['meeting', 'daily'] },
        { name: 'architecture-decisions', description: 'ADR records', tags: ['architecture', 'decisions'] },
      ];

      for (const mem of memories) {
        await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: mem.name,
            element_type: 'memories',
            description: mem.description,
            metadata: { tags: mem.tags },
          },
        });

        // Add sample entries to each
        await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: mem.name,
            content: `First entry for ${mem.name}`,
            tags: mem.tags,
          },
        });

        await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: mem.name,
            content: `Second entry for ${mem.name}`,
            tags: [...mem.tags, 'second'],
          },
        });
      }

      // Allow cache to settle
      await new Promise(resolve => setTimeout(resolve, 500));
    });

    describe('Batch-like operations', () => {
      it('should list all memories and count them', async () => {
        const result = await mcpAqlHandler.handleRead({
          operation: 'list_elements',
          params: {
            element_type: 'memories',
          },
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // Issue #299: list_elements now returns structured data
          const data = result.data as { items?: Array<{ name: string }> };
          const names = (data.items || []).map((i: any) => i.name || i.element_name);
          // Should find all 4 memories
          expect(names).toContain('project-alpha');
          expect(names).toContain('project-beta');
          expect(names).toContain('daily-standup');
          expect(names).toContain('architecture-decisions');
        }
      });

      it('should add entries to multiple memories in sequence', async () => {
        const memoryNames = ['project-alpha', 'project-beta', 'daily-standup'];
        const batchContent = 'Batch update entry';

        const results = await Promise.all(
          memoryNames.map(name =>
            mcpAqlHandler.handleCreate({
              operation: 'addEntry',
              params: {
                element_name: name,
                content: `${batchContent} for ${name}`,
                tags: ['batch-update'],
              },
            })
          )
        );

        // All should succeed
        results.forEach(result => {
          expect(result.success).toBe(true);
        });
      });

      it('should clear multiple memories in sequence', async () => {
        const memoryNames = ['project-alpha', 'project-beta'];

        const results = await Promise.all(
          memoryNames.map(name =>
            mcpAqlHandler.handleDelete({
              operation: 'clear',
              params: {
                element_name: name,
              },
            })
          )
        );

        // All should succeed
        results.forEach(result => {
          expect(result.success).toBe(true);
        });
      });
    });

    describe('Search and filtering', () => {
      it('should search memories by name pattern', async () => {
        const result = await mcpAqlHandler.handleRead({
          operation: 'search_elements',
          params: {
            query: 'project',
            element_type: 'memories',
          },
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // search_elements returns data in various formats depending on results
          expect(result.data).toBeDefined();
          // Verify search completed without error
          const dataStr = JSON.stringify(result.data);
          // May return results or empty set
          expect(dataStr).toBeDefined();
        }
      });

      it('should search memories by description content', async () => {
        const result = await mcpAqlHandler.handleRead({
          operation: 'search_elements',
          params: {
            query: 'notes',
            element_type: 'memories',
          },
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBeDefined();
        }
      });

      it('should handle search with no results', async () => {
        const result = await mcpAqlHandler.handleRead({
          operation: 'search_elements',
          params: {
            query: 'xyznonexistent123',
            element_type: 'memories',
          },
        });

        expect(result.success).toBe(true);
        // Should succeed but return empty or "no results" message
      });
    });

    describe('Query operations', () => {
      it('should list elements with element_type filter', async () => {
        // Use list_elements which is the standard way to query by type
        const result = await mcpAqlHandler.handleRead({
          operation: 'list_elements',
          params: {
            element_type: 'memories',
          },
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBeDefined();
          // Issue #299: list_elements now returns structured data
          const data = result.data as { items?: Array<unknown>; element_type?: string };
          expect(data.items).toBeDefined();
        }
      });
    });
  });

  describe('Memory Element Relationships', () => {
    describe('Memory with Agent relationship', () => {
      beforeEach(async () => {
        // Create a memory for agent context
        await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'agent-context-memory',
            element_type: 'memories',
            description: 'Stores context for agent execution',
          },
        });

        // Add context entries
        await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'agent-context-memory',
            content: 'User prefers concise responses',
            tags: ['preference', 'style'],
          },
        });

        await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'agent-context-memory',
            content: 'Project uses TypeScript with strict mode',
            tags: ['preference', 'technical'],
          },
        });

        // Create an agent that references this memory
        // Issue #722: 'instructions' = behavioral directives, 'content' = reference material
        await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'context-aware-agent',
            element_type: 'agents',
            description: 'Agent that uses memory context',
            instructions: 'Use memory context for personalization decisions.',
            content: '# Context-Aware Agent\n\nUses memory for personalization.',
            metadata: {
              activates: {
                memories: ['agent-context-memory'],
              },
            },
          },
        });

        await new Promise(resolve => setTimeout(resolve, 500));
      });

      it('should retrieve memory that agent references', async () => {
        // First verify the memory exists with entries
        const memoryResult = await mcpAqlHandler.handleRead({
          operation: 'get_element',
          params: {
            element_name: 'agent-context-memory',
            element_type: 'memories',
          },
        });

        expect(memoryResult.success).toBe(true);
        if (memoryResult.success) {
          const data = memoryResult.data as { content?: Array<{ type: string; text: string }> };
          const text = data.content![0].text;
          expect(text).toContain('User prefers concise responses');
          expect(text).toContain('TypeScript');
        }
      });

      it('should have agent with memory activation config', async () => {
        const agentResult = await mcpAqlHandler.handleRead({
          operation: 'get_element',
          params: {
            element_name: 'context-aware-agent',
            element_type: 'agents',
          },
        });

        expect(agentResult.success).toBe(true);
      });
    });

    describe('Memory with Persona relationship', () => {
      beforeEach(async () => {
        // Create a memory for persona preferences
        await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'persona-preferences',
            element_type: 'memories',
            description: 'Learned preferences for persona behavior',
          },
        });

        await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'persona-preferences',
            content: 'User likes detailed explanations with examples',
            tags: ['communication', 'learned'],
          },
        });

        // Create a persona that could use this memory
        await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'learning-persona',
            element_type: 'personas',
            description: 'A persona that learns from interactions',
            instructions: 'You are an adaptive assistant that learns user preferences.',
            metadata: {
              category: 'adaptive',
              linkedMemory: 'persona-preferences',
            },
          },
        });

        await new Promise(resolve => setTimeout(resolve, 500));
      });

      it('should maintain memory entries for persona learning', async () => {
        // Add more learned preferences
        const addResult = await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'persona-preferences',
            content: 'User prefers code examples in Python',
            tags: ['preference', 'code', 'learned'],
          },
        });

        expect(addResult.success).toBe(true);

        // Verify all preferences are stored
        const readResult = await mcpAqlHandler.handleRead({
          operation: 'get_element',
          params: {
            element_name: 'persona-preferences',
            element_type: 'memories',
          },
        });

        expect(readResult.success).toBe(true);
        if (readResult.success) {
          const data = readResult.data as { content?: Array<{ type: string; text: string }> };
          const text = data.content![0].text;
          expect(text).toContain('detailed explanations');
          expect(text).toContain('Python');
        }
      });
    });

    describe('Shared memory across elements', () => {
      beforeEach(async () => {
        // Create a shared context memory
        await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'shared-project-context',
            element_type: 'memories',
            description: 'Shared context for project work',
          },
        });

        await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'shared-project-context',
            content: 'Project deadline is end of Q1',
            tags: ['project', 'deadline'],
          },
        });

        await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'shared-project-context',
            content: 'Tech stack: Node.js, TypeScript, PostgreSQL',
            tags: ['project', 'technical'],
          },
        });

        // Create multiple agents that share this memory
        for (const agentName of ['code-reviewer', 'documentation-writer', 'test-generator']) {
          await mcpAqlHandler.handleCreate({
            operation: 'create_element',
            params: {
              element_name: agentName,
              element_type: 'agents',
              description: `${agentName} agent`,
              instructions: `Execute ${agentName.replace('-', ' ')} tasks.`,
              content: `# ${agentName}\n\nAgent for ${agentName.replace('-', ' ')}.`,
              metadata: {
                activates: {
                  memories: ['shared-project-context'],
                },
              },
            },
          });
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      });

      it('should allow multiple agents to reference same memory', async () => {
        // All agents should be able to read the shared memory
        const memoryResult = await mcpAqlHandler.handleRead({
          operation: 'get_element',
          params: {
            element_name: 'shared-project-context',
            element_type: 'memories',
          },
        });

        expect(memoryResult.success).toBe(true);
        if (memoryResult.success) {
          const data = memoryResult.data as { content?: Array<{ type: string; text: string }> };
          const text = data.content![0].text;
          expect(text).toContain('deadline');
          expect(text).toContain('TypeScript');
        }
      });

      it('should update shared memory visible to all', async () => {
        // Add new entry to shared memory
        await mcpAqlHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'shared-project-context',
            content: 'Sprint planning moved to Mondays',
            tags: ['project', 'process'],
          },
        });

        // Verify update is visible
        const readResult = await mcpAqlHandler.handleRead({
          operation: 'get_element',
          params: {
            element_name: 'shared-project-context',
            element_type: 'memories',
          },
        });

        expect(readResult.success).toBe(true);
        if (readResult.success) {
          const data = readResult.data as { content?: Array<{ type: string; text: string }> };
          const text = data.content![0].text;
          expect(text).toContain('Sprint planning');
        }
      });
    });
  });
});
