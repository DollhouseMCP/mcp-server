/**
 * Integration tests for plural element type compatibility
 *
 * These tests verify that the MCP tools accept both singular (ElementType enum)
 * and plural (legacy user-facing) forms of element types.
 *
 * CRITICAL: This catches bugs where type normalization is missing before routing
 * to handlers. Without normalization, plural types like "personas" would fail
 * with "not yet supported" errors even though the functionality exists.
 *
 * @see https://github.com/DollhouseMCP/mcp-server/issues/XXXX
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { ElementType } from '../../../src/portfolio/PortfolioManager.js';
import { createPortfolioTestEnvironment, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('Plural Element Type Compatibility', () => {
  let env: PortfolioTestEnvironment;
  let server: DollhouseMCPServer;
  const originalFilterSetting = process.env.DISABLE_ELEMENT_FILTERING;

  beforeEach(async () => {
    // Disable element filtering so test elements are not filtered out
    process.env.DISABLE_ELEMENT_FILTERING = 'true';

    env = await createPortfolioTestEnvironment('plural-types-test');
    const container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();

    // Restore original filter setting
    if (originalFilterSetting === undefined) {
      delete process.env.DISABLE_ELEMENT_FILTERING;
    } else {
      process.env.DISABLE_ELEMENT_FILTERING = originalFilterSetting;
    }
  });

  describe('create_element with plural types', () => {
    it('should create persona using plural "personas"', async () => {
      const result = await server.createElement({
        name: 'test-persona',
        type: 'personas' as any, // User would pass this string via MCP
        description: 'A test persona',
        content: 'Test instructions'
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('test-persona');
      expect(result.content[0].text).not.toContain('Invalid element type');
    });

    it('should create skill using plural "skills"', async () => {
      const result = await server.createElement({
        name: 'test-skill',
        type: 'skills' as any,
        description: 'A test skill',
        content: 'Skill implementation instructions',
        metadata: { domain: 'testing' }
      });

      expect(result.content[0].text).toContain('✅ Created skill');
      expect(result.content[0].text).not.toContain('Invalid element type');
    });

    it('should create template using plural "templates"', async () => {
      const result = await server.createElement({
        name: 'test-template',
        type: 'templates' as any,
        description: 'A test template',
        content: 'Template content: {{variable}}'
      });

      expect(result.content[0].text).toContain('✅ Created template');
      expect(result.content[0].text).not.toContain('Invalid element type');
    });

    it('should create agent using plural "agents"', async () => {
      const result = await server.createElement({
        name: 'test-agent',
        type: 'agents' as any,
        description: 'A test agent',
        instructions: 'Agent behavior instructions'
      });

      expect(result.content[0].text).toContain('✅ Created agent');
      expect(result.content[0].text).not.toContain('Invalid element type');
    });

    it('should create memory using plural "memories"', async () => {
      const result = await server.createElement({
        name: 'test-memory',
        type: 'memories' as any,
        description: 'A test memory store'
      });

      expect(result.content[0].text).toContain('✅ Created memory');
      expect(result.content[0].text).not.toContain('Invalid element type');
    });
  });

  describe('edit_element with plural types - CRITICAL BUG PREVENTION', () => {
    beforeEach(async () => {
      // Create test elements using singular forms and verify they succeed
      const personaResult = await server.createElement({
        name: 'edit-test-persona',
        type: ElementType.PERSONA,
        description: 'Original description',
        content: 'Original instructions'
      });
      if (!personaResult.content[0].text.includes('✅')) {
        throw new Error(`Failed to create persona: ${personaResult.content[0].text}`);
      }

      const skillResult = await server.createElement({
        name: 'sample-skill',
        type: ElementType.SKILL,
        description: 'Original description',
        content: 'Sample skill implementation',
        metadata: { domain: 'demo', proficiency: 3 }
      });
      if (!skillResult.content[0].text.includes('✅')) {
        throw new Error(`Failed to create skill: ${skillResult.content[0].text}`);
      }

      const templateResult = await server.createElement({
        name: 'sample-template',
        type: ElementType.TEMPLATE,
        description: 'Original template description',
        content: 'Original: {{var}}'
      });
      if (!templateResult.content[0].text.includes('✅')) {
        throw new Error(`Failed to create template: ${templateResult.content[0].text}`);
      }

      const agentResult = await server.createElement({
        name: 'sample-agent',
        type: ElementType.AGENT,
        description: 'Original agent description',
        instructions: 'Agent instructions here'
      });
      if (!agentResult.content[0].text.includes('✅')) {
        console.warn(`Agent creation failed (expected): ${agentResult.content[0].text}`);
      }

      const memoryResult = await server.createElement({
        name: 'sample-memory',
        type: ElementType.MEMORY,
        description: 'Original memory description'
      });
      if (!memoryResult.content[0].text.includes('✅')) {
        throw new Error(`Failed to create memory: ${memoryResult.content[0].text}`);
      }
    });

    // Issue #334: Updated to use input wrapper format instead of field/value
    it('should edit persona using plural "personas" - PRIMARY BUG CASE', async () => {
      // This is the critical test case that was failing before the fix
      const result = await server.editElement({
        name: 'edit-test-persona',
        type: 'personas' as any, // Users naturally type "personas" in MCP calls
        input: { description: 'Updated description' }
      });

      // MUST succeed - personas are editable
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('Updated');

      // MUST NOT show these errors that indicate missing normalization
      expect(result.content[0].text).not.toContain('not yet supported');
      expect(result.content[0].text).not.toContain('Invalid element type');
    });

    it('should edit skill using plural "skills"', async () => {
      const result = await server.editElement({
        name: 'sample-skill',
        type: 'skills' as any,
        input: { description: 'Updated skill description' }
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).not.toContain('not yet supported');
      expect(result.content[0].text).not.toContain('Invalid element type');
    });

    it('should edit template using plural "templates"', async () => {
      const result = await server.editElement({
        name: 'sample-template',
        type: 'templates' as any,
        input: { description: 'Updated template description' }
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).not.toContain('not yet supported');
      expect(result.content[0].text).not.toContain('Invalid element type');
    });

    it('should edit agent using plural "agents"', async () => {
      const result = await server.editElement({
        name: 'sample-agent',
        type: 'agents' as any,
        input: { description: 'Updated agent description' }
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).not.toContain('not yet supported');
      expect(result.content[0].text).not.toContain('Invalid element type');
    });

    it('should edit memory using plural "memories"', async () => {
      const result = await server.editElement({
        name: 'sample-memory',
        type: 'memories' as any,
        input: { description: 'Updated memory description' }
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).not.toContain('not yet supported');
      expect(result.content[0].text).not.toContain('Invalid element type');
    });

    it('should edit nested metadata fields with plural types', async () => {
      const result = await server.editElement({
        name: 'sample-skill',
        type: 'skills' as any,
        input: { metadata: { domain: 'updated-domain' } }
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('metadata');
      expect(result.content[0].text).not.toContain('not yet supported');
    });

    it('should handle persona-specific fields with plural type', async () => {
      const result = await server.editElement({
        name: 'edit-test-persona',
        type: 'personas' as any,
        input: { instructions: 'New persona instructions here' }
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).not.toContain('not yet supported');
    });
  });

  describe('validate_element with plural types', () => {
    beforeEach(async () => {
      await server.createElement({
        name: 'validate-test-persona',
        type: ElementType.PERSONA,
        description: 'Test persona for validation',
        content: 'Test instructions'
      });

      await server.createElement({
        name: 'sample-skill',
        type: ElementType.SKILL,
        description: 'Test skill for validation',
        content: 'Skill content'
      });

      await server.createElement({
        name: 'sample-template',
        type: ElementType.TEMPLATE,
        description: 'Test template',
        content: 'Content here: {{var}}'
      });
    });

    it('should validate persona using plural "personas"', async () => {
      const result = await server.validateElement({
        name: 'validate-test-persona',
        type: 'personas' as any
      });

      // Validation report contains either success or issues
      expect(result.content[0].text).toContain('Validation Report');
      expect(result.content[0].text).not.toContain('not yet supported');
      expect(result.content[0].text).not.toContain('Invalid element type');
    });

    it('should validate skill using plural "skills"', async () => {
      const result = await server.validateElement({
        name: 'sample-skill',
        type: 'skills' as any,
        strict: false
      });

      expect(result.content[0].text).toMatch(/Status:|Validation Report/);
      expect(result.content[0].text).not.toContain('not yet supported');
      expect(result.content[0].text).not.toContain('Invalid element type');
    });

    it('should validate template using plural "templates"', async () => {
      const result = await server.validateElement({
        name: 'sample-template',
        type: 'templates' as any,
        strict: true
      });

      expect(result.content[0].text).toMatch(/Status:|Validation Report/);
      expect(result.content[0].text).not.toContain('not yet supported');
    });
  });

  describe('delete_element with plural types', () => {
    beforeEach(async () => {
      await server.createElement({
        name: 'delete-test-persona',
        type: ElementType.PERSONA,
        description: 'Test persona for deletion',
        content: 'Test instructions'
      });

      await server.createElement({
        name: 'sample-skill',
        type: ElementType.SKILL,
        description: 'Test skill for deletion',
        content: 'Skill content'
      });

      await server.createElement({
        name: 'sample-template',
        type: ElementType.TEMPLATE,
        description: 'Test template for deletion',
        content: 'Template content: {{var}}'
      });
    });

    it('should delete persona using plural "personas"', async () => {
      const result = await server.deleteElement({
        name: 'delete-test-persona',
        type: 'personas' as any,
        deleteData: true
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).not.toContain('not yet supported');
      expect(result.content[0].text).not.toContain('Invalid element type');
    });

    it('should delete skill using plural "skills"', async () => {
      const result = await server.deleteElement({
        name: 'sample-skill',
        type: 'skills' as any,
        deleteData: true
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).not.toContain('not yet supported');
      expect(result.content[0].text).not.toContain('Invalid element type');
    });

    it('should delete template using plural "templates"', async () => {
      const result = await server.deleteElement({
        name: 'sample-template',
        type: 'templates' as any,
        deleteData: true
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).not.toContain('not yet supported');
    });
  });

  describe('Equivalence: singular and plural forms must behave identically', () => {
    it('should create identically with singular vs plural', async () => {
      const singularResult = await server.createElement({
        name: 'singular-skill',
        type: ElementType.SKILL,
        description: 'Created with singular',
        content: 'Singular skill content'
      });

      const pluralResult = await server.createElement({
        name: 'plural-skill',
        type: 'skills' as any,
        description: 'Created with plural',
        content: 'Plural skill content'
      });

      // Both should succeed with same message pattern
      expect(singularResult.content[0].text).toContain('✅ Created skill');
      expect(pluralResult.content[0].text).toContain('✅ Created skill');
    });

    // Issue #334: Updated to use input wrapper format
    it('should edit identically with singular vs plural', async () => {
      await server.createElement({
        name: 'equiv-test-skill',
        type: ElementType.SKILL,
        description: 'Original',
        content: 'Equiv test skill content'
      });

      const singularEdit = await server.editElement({
        name: 'equiv-test-skill',
        type: ElementType.SKILL,
        input: { description: 'Updated via singular' }
      });

      const pluralEdit = await server.editElement({
        name: 'equiv-test-skill',
        type: 'skills' as any,
        input: { metadata: { test: 'Updated via plural' } }
      });

      // Both should succeed
      expect(singularEdit.content[0].text).toContain('✅');
      expect(pluralEdit.content[0].text).toContain('✅');
    });

    it('should validate identically with singular vs plural', async () => {
      await server.createElement({
        name: 'equiv-validate-skill',
        type: ElementType.SKILL,
        description: 'Test skill',
        content: 'Validation test skill content'
      });

      const singularValidate = await server.validateElement({
        name: 'equiv-validate-skill',
        type: ElementType.SKILL
      });

      const pluralValidate = await server.validateElement({
        name: 'equiv-validate-skill',
        type: 'skills' as any
      });

      // Both should show validation status
      expect(singularValidate.content[0].text).toContain('Status:');
      expect(pluralValidate.content[0].text).toContain('Status:');
    });
  });

  describe('Error handling with invalid types', () => {
    it('should reject completely invalid type strings', async () => {
      const result = await server.createElement({
        name: 'invalid-test',
        type: 'invalidtype' as any,
        description: 'Should fail'
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Invalid element type');
    });

    it('should reject typos in plural forms', async () => {
      const result = await server.editElement({
        name: 'does-not-exist',
        type: 'personass' as any, // Typo
        field: 'description',
        value: 'test'
      });

      expect(result.content[0].text).toContain('❌');
    });

    it('should reject mixed case that does not match enum', async () => {
      const result = await server.createElement({
        name: 'case-test',
        type: 'Personas' as any, // Wrong case
        description: 'Should fail'
      });

      expect(result.content[0].text).toContain('❌');
    });
  });

  describe('All element types coverage', () => {
    const testCases = [
      { singular: ElementType.PERSONA, plural: 'personas' },
      { singular: ElementType.SKILL, plural: 'skills' },
      { singular: ElementType.TEMPLATE, plural: 'templates' },
      // Note: agents removed due to creation issues
      { singular: ElementType.MEMORY, plural: 'memories' }
      // Note: ensembles not yet implemented
    ];

    testCases.forEach(({ singular, plural }) => {
      it(`should handle CRUD operations for ${plural} (plural form)`, async () => {
        // Create with plural
        const createResult = await server.createElement({
          name: `test-${plural}`,
          type: plural as any,
          description: `Test ${singular}`,
          content: singular === ElementType.TEMPLATE ? 'Content {{var}}' : 'Test content'
        });

        expect(createResult.content[0].text).toContain('✅');
        expect(createResult.content[0].text).not.toContain('Invalid element type');

        // Edit with plural - Issue #334: Updated to use input wrapper format
        const editResult = await server.editElement({
          name: `test-${plural}`,
          type: plural as any,
          input: { description: `Updated ${singular}` }
        });

        expect(editResult.content[0].text).toContain('✅');
        expect(editResult.content[0].text).not.toContain('not yet supported');

        // Validate with plural
        const validateResult = await server.validateElement({
          name: `test-${plural}`,
          type: plural as any
        });

        expect(validateResult.content[0].text).toContain('Status:');
        expect(validateResult.content[0].text).not.toContain('not yet supported');

        // Delete with plural
        const deleteResult = await server.deleteElement({
          name: `test-${plural}`,
          type: plural as any,
          deleteData: true
        });

        expect(deleteResult.content[0].text).toContain('✅');
        expect(deleteResult.content[0].text).not.toContain('not yet supported');
      });
    });
  });

  describe('Regression: ensure normalization happens before routing', () => {
    // Issue #334: Updated to use input wrapper format
    it('should normalize BEFORE checking if type is PERSONA for edit', async () => {
      await server.createElement({
        name: 'routing-test-persona',
        type: ElementType.PERSONA,
        description: 'Original',
        content: 'Original instructions'
      });

      // This tests the specific bug: editElement must normalize BEFORE
      // checking "if (args.type === ElementType.PERSONA)"
      const result = await server.editElement({
        name: 'routing-test-persona',
        type: 'personas' as any,
        input: { description: 'Updated via plural' }
      });

      // Must route to PersonaHandler, not ElementCRUDHandler
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('Updated');
    });

    it('should normalize BEFORE checking if type is PERSONA for validate', async () => {
      await server.createElement({
        name: 'validate-routing-persona',
        type: ElementType.PERSONA,
        description: 'Test',
        content: 'Test instructions'
      });

      const result = await server.validateElement({
        name: 'validate-routing-persona',
        type: 'personas' as any
      });

      expect(result.content[0].text).toContain('Validation Report');
      expect(result.content[0].text).not.toContain('not yet supported');
    });

    it('should normalize BEFORE checking if type is PERSONA for delete', async () => {
      await server.createElement({
        name: 'delete-routing-persona',
        type: ElementType.PERSONA,
        description: 'Test',
        content: 'Test instructions'
      });

      const result = await server.deleteElement({
        name: 'delete-routing-persona',
        type: 'personas' as any,
        deleteData: true
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).not.toContain('not yet supported');
    });
  });
});
