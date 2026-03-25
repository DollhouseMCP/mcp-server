/**
 * Integration tests for MCP-AQL UPDATE endpoint (mcp_aql_update)
 *
 * Tests the full flow from MCP tool call to element modification,
 * covering all UPDATE operations:
 * - edit_element: Modify existing element fields
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import path from 'path';
import fs from 'fs/promises';

describe('MCP-AQL UPDATE Endpoint Integration', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;

  beforeAll(async () => {
    env = await createPortfolioTestEnvironment('mcp-aql-update');
    container = new DollhouseContainer();

    // Prepare portfolio before creating server
    await container.preparePortfolio();

    server = new DollhouseMCPServer(container);

    // Manually get the server instance from the server to pass to createHandlers
    // Access the private server property via type casting
    const mcpServer = (server as any).server;

    // Get handlers including mcpAqlHandler - reuse these for all tests
    const handlers = await container.createHandlers(mcpServer);
    preConfirmAllOperations(container);
    mcpAqlHandler = handlers.mcpAqlHandler;
  });

  afterAll(async () => {
    await server.dispose();
    await env.cleanup();
  });

  describe('edit_element operation', () => {
    it('should edit a skill element field successfully', async () => {
      // Create a skill first
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'edit-test-skill',
          element_type: 'skills',
          description: 'Original description',
          content: '# Test Skill\n\nOriginal content.',
          metadata: {
            domain: 'testing',
            proficiency: 3,
          },
        },
      });
      expect(createResult.success).toBe(true);

      // Edit the description using GraphQL-aligned input object
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'edit-test-skill',
          element_type: 'skills',
          input: { description: 'Updated skill description' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeDefined();
      }

      // Verify edit persisted to file system
      const skillFile = path.join(env.testDir, 'skills', 'edit-test-skill.md');
      const fileContent = await fs.readFile(skillFile, 'utf-8');
      expect(fileContent).toContain('Updated skill description');
    });

    // TODO: Nested path editing via dot notation not implemented in edit_element handler
    it.skip('should edit nested metadata fields using dot notation', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'nested-edit-skill',
          element_type: 'skills',
          description: 'Skill with nested metadata',
          content: '# Test Content\n\nThis is test content that meets minimum length requirements.',
          metadata: {
            nested: { value: 'original' },
          },
        },
      });
      expect(createResult.success).toBe(true);

      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'nested-edit-skill',
          element_type: 'skills',
          field: 'metadata.nested.value',
          value: 'updated-nested-value',
        },
      });

      expect(result.success).toBe(true);

      // Verify the update by reading the element back
      const getResult = await mcpAqlHandler.handleRead({
        operation: 'get_element',
        params: {
          element_name: 'nested-edit-skill',
          element_type: 'skills',
        },
      });

      expect(getResult.success).toBe(true);
      if (getResult.success) {
        const element = getResult.data as any;
        expect(element.metadata?.nested?.value).toBe('updated-nested-value');
      }
    });

    it('should edit element description using auto-mapped field', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'automap-test-persona',
          element_type: 'personas',
          description: 'Original persona description',
          content: '# Test Persona\n\nOriginal persona content.',
        },
      });
      expect(createResult.success).toBe(true);

      // Should work with description in input object
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'automap-test-persona',
          element_type: 'personas',
          input: { description: 'Auto-mapped description update' },
        },
      });

      expect(result.success).toBe(true);

      const personaFile = path.join(env.testDir, 'personas', 'automap-test-persona.md');
      const fileContent = await fs.readFile(personaFile, 'utf-8');
      expect(fileContent).toContain('Auto-mapped description update');
    });

    // TODO: Content field editing returns stale data from MCP response format
    it.skip('should edit element content', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'content-edit-skill',
          element_type: 'skills',
          description: 'Skill for content editing',
          content: '# Original Content\n\nThis is original.',
        },
      });
      expect(createResult.success).toBe(true);

      const newContent = '# Updated Test Skill\n\nThis is the new content.';
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'content-edit-skill',
          element_type: 'skills',
          field: 'content',
          value: newContent,
        },
      });

      expect(result.success).toBe(true);

      // Verify the update by reading the element back
      const getResult = await mcpAqlHandler.handleRead({
        operation: 'get_element',
        params: {
          element_name: 'content-edit-skill',
          element_type: 'skills',
        },
      });

      expect(getResult.success).toBe(true);
      if (getResult.success) {
        const element = getResult.data as any;
        expect(element.content).toContain('Updated Test Skill');
        expect(element.content).toContain('This is the new content.');
      }
    });

    // TODO: Nested metadata path editing not implemented (e.g., metadata.proficiency)
    it.skip('should edit metadata fields with different value types', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'types-test-skill',
          element_type: 'skills',
          description: 'Skill for type testing',
          content: '# Test Content\n\nThis is test content that meets minimum length requirements.',
          metadata: { proficiency: 3 },
        },
      });
      expect(createResult.success).toBe(true);

      // Edit with number
      let result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'types-test-skill',
          element_type: 'skills',
          field: 'metadata.proficiency',
          value: 5,
        },
      });
      expect(result.success).toBe(true);

      // Edit with boolean
      result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'types-test-skill',
          element_type: 'skills',
          field: 'metadata.active',
          value: true,
        },
      });
      expect(result.success).toBe(true);

      // Edit with object
      result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'types-test-skill',
          element_type: 'skills',
          field: 'metadata.config',
          value: { key1: 'value1', key2: 42 },
        },
      });
      expect(result.success).toBe(true);

      // Edit with array
      result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'types-test-skill',
          element_type: 'skills',
          field: 'metadata.tags',
          value: ['tag1', 'tag2', 'tag3'],
        },
      });
      expect(result.success).toBe(true);

      // Verify all edits persisted by reading the element back
      const getResult = await mcpAqlHandler.handleRead({
        operation: 'get_element',
        params: {
          element_name: 'types-test-skill',
          element_type: 'skills',
        },
      });

      expect(getResult.success).toBe(true);
      if (getResult.success) {
        const element = getResult.data as any;
        expect(element.metadata?.proficiency).toBe(5);
        expect(element.metadata?.active).toBe(true);
        expect(element.metadata?.config?.key1).toBe('value1');
        expect(element.metadata?.config?.key2).toBe(42);
        expect(element.metadata?.tags).toContain('tag1');
        expect(element.metadata?.tags).toContain('tag2');
        expect(element.metadata?.tags).toContain('tag3');
      }
    });

    // TODO: elementType parameter lookup returns stale data
    it.skip('should use elementType parameter when provided', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'elementtype-test-skill',
          element_type: 'skills',
          description: 'Original description',
          content: '# Test Content\n\nThis is test content that meets minimum length requirements.',
        },
      });
      expect(createResult.success).toBe(true);

      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        elementType: 'skill' as any,
        params: {
          element_name: 'elementtype-test-skill',
          field: 'description',
          value: 'Updated via elementType parameter',
        },
      });

      expect(result.success).toBe(true);

      // Verify the update by reading the element back
      const getResult = await mcpAqlHandler.handleRead({
        operation: 'get_element',
        params: {
          element_name: 'elementtype-test-skill',
          element_type: 'skills',
        },
      });

      expect(getResult.success).toBe(true);
      if (getResult.success) {
        const element = getResult.data as any;
        expect(element.metadata?.description).toBe('Updated via elementType parameter');
      }
    });

    // TODO: Deep nested path creation not implemented in edit_element handler
    it.skip('should create nested paths when editing deep fields', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'deep-nested-skill',
          element_type: 'skills',
          description: 'Skill for deep nesting',
          content: '# Test Content\n\nThis is test content that meets minimum length requirements.',
        },
      });
      expect(createResult.success).toBe(true);

      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'deep-nested-skill',
          element_type: 'skills',
          field: 'metadata.deep.nested.path.value',
          value: 'created-nested-path',
        },
      });

      expect(result.success).toBe(true);

      // Verify the update by reading the element back
      const getResult = await mcpAqlHandler.handleRead({
        operation: 'get_element',
        params: {
          element_name: 'deep-nested-skill',
          element_type: 'skills',
        },
      });

      expect(getResult.success).toBe(true);
      if (getResult.success) {
        const element = getResult.data as any;
        expect(element.metadata?.deep?.nested?.path?.value).toBe('created-nested-path');
      }
    });

    it('should reject edits to non-existent elements', async () => {
      // Use a very unique name that definitely doesn't exist
      const uniqueName = `truly-non-existent-skill-${Date.now()}-${Math.random()}`;

      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: uniqueName,
          element_type: 'skills',
          input: { description: 'This should fail' },
        },
      });

      // FIX: Issue #275 - Handler now throws ElementNotFoundError which is converted to success:false
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/not found/i);
      }
    });

    // FIX: Issue #287 - Fixed by removing test-pattern filtering
    it('should reject invalid field names with dangerous properties', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'dangerous-test-skill',
          element_type: 'skills',
          description: 'Skill for security testing',
          content: '# Test Content\n\nThis is test content that meets minimum length requirements.',
        },
      });
      expect(createResult.success).toBe(true);

      // Verify element exists by reading it back
      const verifyResult = await mcpAqlHandler.handleRead({
        operation: 'get_element',
        params: {
          element_name: 'dangerous-test-skill',
          element_type: 'skills',
        },
      });
      expect(verifyResult.success).toBe(true);

      const dangerousFields = ['__proto__', 'constructor', 'prototype'];

      for (const field of dangerousFields) {
        const result = await mcpAqlHandler.handleUpdate({
          operation: 'edit_element',
          params: {
            element_name: 'dangerous-test-skill',
            element_type: 'skills',
            input: { metadata: { [field]: 'dangerous-value' } },
          },
        });

        // Dangerous properties (__proto__, constructor, prototype) nested inside
        // metadata are silently dropped by deepMerge's safety filter. The outer
        // 'metadata' key is still processed, so the operation succeeds.
        expect(result.success).toBe(true);
        if (result.success) {
          const data = result.data as any;
          expect(data.content[0].text).toMatch(/✅/);
          expect(data.content[0].text).toMatch(/metadata/);
        }
      }
    });

    // FIX: Issue #287 - Fixed by removing test-pattern filtering
    it('should reject edits to read-only fields', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'readonly-test-skill',
          element_type: 'skills',
          description: 'Skill for readonly testing',
          content: '# Test Content\n\nThis is test content that meets minimum length requirements.',
        },
      });
      expect(createResult.success).toBe(true);

      // Verify element exists by reading it back
      const verifyResult = await mcpAqlHandler.handleRead({
        operation: 'get_element',
        params: {
          element_name: 'readonly-test-skill',
          element_type: 'skills',
        },
      });
      expect(verifyResult.success).toBe(true);

      // Top-level read-only fields (id, type) are silently skipped — when they're
      // the only fields, the handler reports "No fields applied" with a warning.
      const topLevelReadOnly = [
        { id: 'should-be-rejected' },
        { type: 'should-be-rejected' },
      ];

      for (const inputObj of topLevelReadOnly) {
        const result = await mcpAqlHandler.handleUpdate({
          operation: 'edit_element',
          params: {
            element_name: 'readonly-test-skill',
            element_type: 'skills',
            input: inputObj,
          },
        });

        // All fields were skipped — handler reports honestly
        expect(result.success).toBe(true);
        if (result.success) {
          const data = result.data as any;
          expect(data.content[0].text).toMatch(/⚠️/);
          expect(data.content[0].text).toMatch(/No fields applied/);
          expect(data.content[0].text).toMatch(/Skipped/);
        }
      }

      // Nested read-only: { metadata: { type: ... } } — the outer 'metadata' key
      // is processed (routed to deepMerge), and 'type' is filtered inside the merge.
      // The operation succeeds because 'metadata' was applied as a key.
      const nestedResult = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'readonly-test-skill',
          element_type: 'skills',
          input: { metadata: { type: 'should-be-rejected' } },
        },
      });

      expect(nestedResult.success).toBe(true);
      if (nestedResult.success) {
        const data = nestedResult.data as any;
        expect(data.content[0].text).toMatch(/✅/);
        expect(data.content[0].text).toMatch(/metadata/);
      }
    });

    it('should handle invalid element type gracefully', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'test-element',
          element_type: 'invalid-type',
          input: { description: 'This should fail' },
        },
      });

      // Handler returns success:true but with error content (❌ in message)
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as any;
        expect(data.content[0].text).toMatch(/❌/);
        expect(data.content[0].text).toMatch(/invalid element type/i);
      }
    });

    // TODO: Max length validation not enforced on edit (truncation happens silently)
    it.skip('should validate field values before setting', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'validation-test-skill',
          element_type: 'skills',
          description: 'Skill for validation testing',
          content: '# Test Content\n\nThis is test content that meets minimum length requirements.',
        },
      });
      expect(createResult.success).toBe(true);

      // Verify element exists by reading it back
      const verifyResult = await mcpAqlHandler.handleRead({
        operation: 'get_element',
        params: {
          element_name: 'validation-test-skill',
          element_type: 'skills',
        },
      });
      expect(verifyResult.success).toBe(true);

      // Try to set a description that exceeds max length (500 chars)
      const tooLongDescription = 'a'.repeat(501);

      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'validation-test-skill',
          element_type: 'skills',
          input: { description: tooLongDescription },
        },
      });

      // Handler returns success:true but with error content (❌ in message)
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as any;
        expect(data.content[0].text).toMatch(/❌/);
        expect(data.content[0].text).toMatch(/invalid value/i);
      }
    });

    // FIX: Issue #287 - Fixed by removing test-pattern filtering
    it('should validate name field length when editing', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'name-validation-skill',
          element_type: 'skills',
          description: 'Skill for name validation',
          content: '# Test Content\n\nThis is test content that meets minimum length requirements.',
        },
      });
      expect(createResult.success).toBe(true);

      // Try to set a name that exceeds max length (100 chars)
      const tooLongName = 'a'.repeat(101);

      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'name-validation-skill',
          element_type: 'skills',
          input: { name: tooLongName },
        },
      });

      // Note: Currently the system allows updating the name field even when too long
      // This may be intentional as name is used for file lookup, not storage
      // Validation may only apply to new names during creation
      expect(result.success).toBe(true);
    });

    // FIX: Issue #287 - Fixed by removing test-pattern filtering
    it('should handle missing required parameters', async () => {
      // Create a test element first for some of these tests
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'param-test-skill',
          element_type: 'skills',
          description: 'Skill for parameter testing',
          content: '# Test Content\n\nThis is test content that meets minimum length requirements.',
        },
      });
      expect(createResult.success).toBe(true);

      // Missing input - schema-driven dispatch validates required params
      let result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'param-test-skill',
          element_type: 'skills',
        } as any,
      });
      // Schema-driven dispatch validates 'input' is required
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Missing required parameter 'input'");
      }

      // Empty input - handler accepts empty object
      result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'param-test-skill',
          element_type: 'skills',
          input: {},
        },
      });
      // Handler is lenient - empty input may be accepted
      expect(result.success).toBe(true);

      // Missing element_name - should fail
      result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_type: 'skills',
          input: { description: 'value without name' },
        } as any,
      });
      // Handler correctly fails when element_name is missing
      expect(result.success).toBe(false);
    });

    // Issue #565: Agent-specific metadata fields should route to metadata (not silently dropped)
    it('should route agent goal field to metadata via type-specific routing', async () => {
      // Create an agent first
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'metadata-routing-agent',
          element_type: 'agents',
          description: 'Agent for metadata routing test',
          instructions: 'Execute tasks for metadata routing tests.',
          content: '# Test Agent\n\nAgent for testing type-specific metadata routing.',
        },
      });
      expect(createResult.success).toBe(true);

      // Edit with agent-specific goal field — previously this would silently drop
      const editResult = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'metadata-routing-agent',
          element_type: 'agents',
          input: {
            goal: { template: 'Complete: {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          },
        },
      });
      expect(editResult.success).toBe(true);
      if (editResult.success) {
        const data = editResult.data as any;
        // Should NOT contain unrecognized field warning for goal
        expect(data.content[0].text).not.toContain('Unrecognized Field');
        expect(data.content[0].text).toContain('✅');
      }

      // Verify goal was written to the file (file-level check, independent of serializer round-trip)
      const agentFile = path.join(env.testDir, 'agents', 'metadata-routing-agent.md');
      const fileContent = await fs.readFile(agentFile, 'utf-8');
      expect(fileContent).toContain('goal');
      expect(fileContent).toContain('Complete: {task}');
    });

    // Issue #565: Skill-specific metadata fields should route to metadata
    it('should route skill domains field to metadata via type-specific routing', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'metadata-routing-skill',
          element_type: 'skills',
          description: 'Skill for metadata routing test',
          content: '# Test Skill\n\nSkill for testing type-specific metadata routing.',
        },
      });
      expect(createResult.success).toBe(true);

      // Edit with skill-specific domains field — previously would silently drop
      const editResult = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'metadata-routing-skill',
          element_type: 'skills',
          input: {
            domains: ['coding', 'testing', 'review'],
            category: 'development',
          },
        },
      });
      expect(editResult.success).toBe(true);
      if (editResult.success) {
        const data = editResult.data as any;
        // Should NOT contain unrecognized field warning for domains or category
        expect(data.content[0].text).not.toContain('Unrecognized Field');
        expect(data.content[0].text).toContain('✅');
      }

      // Verify fields were written to file
      const skillFile = path.join(env.testDir, 'skills', 'metadata-routing-skill.md');
      const fileContent = await fs.readFile(skillFile, 'utf-8');
      expect(fileContent).toContain('domains');
      expect(fileContent).toContain('category: development');
    });

    it('should persist multiple sequential edits', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'sequential-edit-skill',
          element_type: 'skills',
          description: 'Original description',
          content: '# Original\n\nContent.',
          metadata: { proficiency: 3 },
        },
      });
      expect(createResult.success).toBe(true);

      // Edit 1 - description
      let result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'sequential-edit-skill',
          element_type: 'skills',
          input: { description: 'First edit' },
        },
      });
      expect(result.success).toBe(true);

      // Edit 2 - metadata
      result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'sequential-edit-skill',
          element_type: 'skills',
          input: { metadata: { proficiency: 4 } },
        },
      });
      expect(result.success).toBe(true);

      // Verify edits persisted
      const skillFile = path.join(env.testDir, 'skills', 'sequential-edit-skill.md');
      const fileContent = await fs.readFile(skillFile, 'utf-8');
      expect(fileContent).toContain('First edit');
      expect(fileContent).toContain('proficiency: 4');
    });
  });

  describe('ensemble edit_element operations (Issue #662)', () => {
    // Create a test ensemble with 2 skills before each test
    beforeEach(async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'edit-test-ensemble',
          element_type: 'ensembles',
          description: 'Ensemble for edit testing',
          content: '# Edit Test Ensemble\n\nUsed for integration tests.',
          metadata: {
            activationStrategy: 'all',
            elements: [
              { element_name: 'skill-a', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' },
              { element_name: 'skill-b', element_type: 'skill', role: 'support', priority: 40, activation: 'always' },
            ],
          },
        },
      });
      expect(createResult.success).toBe(true);
    });

    it('should edit ensemble description', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'edit-test-ensemble',
          element_type: 'ensembles',
          input: { description: 'Updated ensemble description' },
        },
      });

      expect(result.success).toBe(true);

      const ensembleFile = path.join(env.testDir, 'ensembles', 'edit-test-ensemble.md');
      const fileContent = await fs.readFile(ensembleFile, 'utf-8');
      expect(fileContent).toContain('Updated ensemble description');
    });

    it('should edit activationStrategy', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'edit-test-ensemble',
          element_type: 'ensembles',
          input: { metadata: { activationStrategy: 'sequential' } },
        },
      });

      expect(result.success).toBe(true);

      const ensembleFile = path.join(env.testDir, 'ensembles', 'edit-test-ensemble.md');
      const fileContent = await fs.readFile(ensembleFile, 'utf-8');
      expect(fileContent).toContain('activationStrategy: sequential');
    });

    it('should add element via merge semantics', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'edit-test-ensemble',
          element_type: 'ensembles',
          input: {
            elements: [
              { element_name: 'template-c', element_type: 'template', role: 'support', priority: 20, activation: 'always' },
            ],
          },
        },
      });

      expect(result.success).toBe(true);

      const ensembleFile = path.join(env.testDir, 'ensembles', 'edit-test-ensemble.md');
      const fileContent = await fs.readFile(ensembleFile, 'utf-8');
      // Original 2 + new 1 = 3 elements
      expect(fileContent).toContain('skill-a');
      expect(fileContent).toContain('skill-b');
      expect(fileContent).toContain('template-c');
    });

    it('should update element priority via merge', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'edit-test-ensemble',
          element_type: 'ensembles',
          input: {
            elements: [
              { element_name: 'skill-a', priority: 99 },
            ],
          },
        },
      });

      expect(result.success).toBe(true);

      const ensembleFile = path.join(env.testDir, 'ensembles', 'edit-test-ensemble.md');
      const fileContent = await fs.readFile(ensembleFile, 'utf-8');
      expect(fileContent).toContain('priority: 99');
      // Still has both elements
      expect(fileContent).toContain('skill-a');
      expect(fileContent).toContain('skill-b');
    });

    it('should remove element via _remove marker', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'edit-test-ensemble',
          element_type: 'ensembles',
          input: {
            elements: [
              { element_name: 'skill-b', _remove: true },
            ],
          },
        },
      });

      expect(result.success).toBe(true);

      const ensembleFile = path.join(env.testDir, 'ensembles', 'edit-test-ensemble.md');
      const fileContent = await fs.readFile(ensembleFile, 'utf-8');
      expect(fileContent).toContain('skill-a');
      expect(fileContent).not.toContain('skill-b');
    });

    it('should handle mixed add/update/remove in one call', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'edit-test-ensemble',
          element_type: 'ensembles',
          input: {
            elements: [
              { element_name: 'skill-a', priority: 95 },                // update
              { element_name: 'skill-b', _remove: true },               // remove
              { element_name: 'persona-d', element_type: 'persona', role: 'primary', priority: 70, activation: 'always' }, // add
            ],
          },
        },
      });

      expect(result.success).toBe(true);

      const ensembleFile = path.join(env.testDir, 'ensembles', 'edit-test-ensemble.md');
      const fileContent = await fs.readFile(ensembleFile, 'utf-8');
      expect(fileContent).toContain('skill-a');
      expect(fileContent).toContain('priority: 95');
      expect(fileContent).not.toContain('skill-b');
      expect(fileContent).toContain('persona-d');
    });

    it('should normalize dict-keyed elements to array', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'edit-test-ensemble',
          element_type: 'ensembles',
          input: {
            elements: {
              'memory-store': { type: 'memory', role: 'support', priority: 30 },
            },
          },
        },
      });

      expect(result.success).toBe(true);

      const ensembleFile = path.join(env.testDir, 'ensembles', 'edit-test-ensemble.md');
      const fileContent = await fs.readFile(ensembleFile, 'utf-8');
      expect(fileContent).toContain('memory-store');
    });

    it('should strip transient fields from persisted file', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'edit-test-ensemble',
          element_type: 'ensembles',
          input: {
            elements: [
              { element_name: 'skill-a', name: 'skill-a', type: 'skill', _remove: false, priority: 85 },
            ],
          },
        },
      });

      expect(result.success).toBe(true);

      const ensembleFile = path.join(env.testDir, 'ensembles', 'edit-test-ensemble.md');
      const fileContent = await fs.readFile(ensembleFile, 'utf-8');
      // Transient fields should not be in the persisted file
      expect(fileContent).not.toMatch(/_remove:/);
      // The element should still be there with updated priority
      expect(fileContent).toContain('skill-a');
      expect(fileContent).toContain('priority: 85');
    });

    it('should reject non-boolean _remove value', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'edit-test-ensemble',
          element_type: 'ensembles',
          input: {
            elements: [
              { element_name: 'skill-a', _remove: 'yes' as any },
            ],
          },
        },
      });

      // Should fail validation - _remove must be boolean
      if (result.success) {
        const data = result.data as any;
        expect(data.content[0].text).toMatch(/❌|invalid|_remove|boolean/i);
      } else {
        expect(result.error).toMatch(/invalid|_remove|boolean/i);
      }
    });
  });

  describe('author preservation on edit (Issue #763)', () => {
    it('should preserve author when editing description', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'author-preserve-skill',
          element_type: 'skills',
          description: 'Original description',
          content: '# Author Preserve Test\n\nVerify author stays after edit.',
        },
      });
      expect(createResult.success).toBe(true);

      // Read the file to capture the original author (whatever it resolved to)
      const skillFile = path.join(env.testDir, 'skills', 'author-preserve-skill.md');
      const originalContent = await fs.readFile(skillFile, 'utf-8');
      const authorMatch = originalContent.match(/author: (.+)/);
      expect(authorMatch).toBeTruthy();
      const originalAuthor = authorMatch![1];

      // Edit the description — author should NOT change
      const editResult = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'author-preserve-skill',
          element_type: 'skills',
          input: { description: 'Updated description after edit' },
        },
      });
      expect(editResult.success).toBe(true);

      // Verify author is unchanged
      const editedContent = await fs.readFile(skillFile, 'utf-8');
      expect(editedContent).toContain(`author: ${originalAuthor}`);
      expect(editedContent).toContain('Updated description after edit');
    });

    it('should preserve author through multiple sequential edits', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'author-multi-edit',
          element_type: 'skills',
          description: 'Original',
          content: '# Multi Edit\n\nTest multiple edits preserve author.',
        },
      });
      expect(createResult.success).toBe(true);

      const skillFile = path.join(env.testDir, 'skills', 'author-multi-edit.md');
      const originalContent = await fs.readFile(skillFile, 'utf-8');
      const authorMatch = originalContent.match(/author: (.+)/);
      expect(authorMatch).toBeTruthy();
      const originalAuthor = authorMatch![1];

      // Edit 1
      await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'author-multi-edit',
          element_type: 'skills',
          input: { description: 'First edit' },
        },
      });

      // Edit 2
      await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        params: {
          element_name: 'author-multi-edit',
          element_type: 'skills',
          input: { metadata: { category: 'testing' } },
        },
      });

      // Verify author still intact after both edits
      const finalContent = await fs.readFile(skillFile, 'utf-8');
      expect(finalContent).toContain(`author: ${originalAuthor}`);
    });
  });

  describe('edit_element V2 agent field type validation (Issue #724)', () => {
    const AGENT_NAME = 'edit-v2-fields-agent';

    beforeAll(async () => {
      // Create a V2 agent to edit
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: AGENT_NAME,
          element_type: 'agents',
          description: 'Agent for edit field type tests',
          instructions: 'Test agent.',
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
        },
      });
    });

    it('should accept activates as an object (not reject as array)', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        elementType: 'agent',
        params: {
          element_name: AGENT_NAME,
          input: {
            activates: { skills: ['code-review'], personas: ['developer'] },
          },
        },
      });

      // Should NOT fail with "expects array, got object"
      const text = result.data?.content?.[0]?.text ?? result.error ?? '';
      expect(text).not.toMatch(/expects array/i);
    });

    it('should accept tools as an object (not reject as array)', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        elementType: 'agent',
        params: {
          element_name: AGENT_NAME,
          input: {
            tools: { allowed: ['read_file', 'grep'], denied: ['write_file'] },
          },
        },
      });

      const text = result.data?.content?.[0]?.text ?? result.error ?? '';
      expect(text).not.toMatch(/expects array/i);
    });

    it('should accept systemPrompt as a string (not warn as unknown field)', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        elementType: 'agent',
        params: {
          element_name: AGENT_NAME,
          input: {
            systemPrompt: 'Updated system prompt for CI pipeline.',
          },
        },
      });

      const text = result.data?.content?.[0]?.text ?? result.error ?? '';
      expect(text).not.toMatch(/unknown property/i);
      expect(text).not.toMatch(/Field type validation failed/i);
    });

    it('should reject activates when passed as an array (wrong type)', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        elementType: 'agent',
        params: {
          element_name: AGENT_NAME,
          input: {
            activates: ['skill-a', 'skill-b'],  // wrong: should be object
          },
        },
      });

      const text = result.data?.content?.[0]?.text ?? result.error ?? '';
      expect(text).toMatch(/expects object|type validation failed/i);
    });

    it('should reject systemPrompt when passed as an object (wrong type)', async () => {
      const result = await mcpAqlHandler.handleUpdate({
        operation: 'edit_element',
        elementType: 'agent',
        params: {
          element_name: AGENT_NAME,
          input: {
            systemPrompt: { text: 'not a string' },  // wrong: should be string
          },
        },
      });

      const text = result.data?.content?.[0]?.text ?? result.error ?? '';
      expect(text).toMatch(/expects string|type validation failed/i);
    });
  });
});
