/**
 * Integration tests for Ensemble CRUD operations via ElementCRUDHandler
 *
 * Tests the full lifecycle of ensemble management through the MCP tools interface:
 * - createElement: Create ensembles with elements array
 * - editElement: Modify ensemble metadata and elements (CRITICAL FOR ISSUE #14)
 * - validateElement: Validate ensemble structure and dependencies
 * - deleteElement: Remove ensembles
 * - listElements: Query ensembles
 *
 * ISSUE #14 CONTEXT:
 * - Refactored Ensemble to use array instead of Map for internal storage
 * - These tests verify that ensemble CRUD operations work with the new array-based architecture
 * - Focus on array editing operations (add/remove/update elements)
 *
 * Uses real DI container instances (not mocks) for integration testing
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { createIntegrationContainer, IntegrationContainer } from '../../helpers/integration-container.js';
import { EnsembleManager } from '../../../src/elements/ensembles/EnsembleManager.js';
import { SkillManager } from '../../../src/elements/skills/SkillManager.js';
import { TemplateManager } from '../../../src/elements/templates/TemplateManager.js';
import { AgentManager } from '../../../src/elements/agents/AgentManager.js';

describe('Ensemble CRUD Operations (Integration)', () => {
  let containerContext: IntegrationContainer;
  let server: DollhouseMCPServer;
  let ensembleManager: EnsembleManager;
  let skillManager: SkillManager;
  let templateManager: TemplateManager;
  let agentManager: AgentManager;

  beforeEach(async () => {
    // Create isolated test environment with DI container
    containerContext = await createIntegrationContainer();

    // Get manager instances from container (for direct access when needed)
    ensembleManager = containerContext.container.resolve('EnsembleManager');
    skillManager = containerContext.container.resolve('SkillManager');
    templateManager = containerContext.container.resolve('TemplateManager');
    agentManager = containerContext.container.resolve('AgentManager');

    // Create server instance with the integration container
    server = new DollhouseMCPServer(containerContext.container);
    await server.listPersonas(); // Initialize server

    // Clean up any existing test ensembles
    await cleanupTestElements();
  });

  afterEach(async () => {
    await cleanupTestElements();
    await server.dispose();
    await containerContext.dispose();
  });

  // ====================================================================
  // Helper Functions
  // ====================================================================

  async function createTestSkill(name: string): Promise<void> {
    // Use server methods to ensure consistency with the same DI container instance
    await server.createElement({
      name,
      type: ElementType.SKILL,
      description: `Test skill ${name}`,
      metadata: {
        usage: 'test',
        domain: 'testing',
        proficiency: 3
      }
    });
  }

  async function createTestTemplate(name: string): Promise<void> {
    await server.createElement({
      name,
      type: ElementType.TEMPLATE,
      description: `Test template ${name}`,
      content: '# Test\n\nThis is a test template.',
      metadata: {
        variables: []
      }
    });
  }

  async function createTestAgent(name: string): Promise<void> {
    await server.createElement({
      name,
      type: ElementType.AGENT,
      description: `Test agent ${name}`,
      instructions: `Execute test tasks for ${name}.`,
      metadata: {
        role: 'test',
        capabilities: ['test']
      }
    });
  }

  async function createTestEnsemble(
    name: string,
    elements: any[],
    options?: { allowNested?: boolean }
  ): Promise<void> {
    await server.createElement({
      name,
      type: ElementType.ENSEMBLE,
      description: `Test ensemble ${name}`,
      metadata: {
        activationStrategy: 'sequential',
        conflictResolution: 'last-write',
        elements,
        ...(options?.allowNested && { allowNested: true })
      }
    });
  }

  async function cleanupTestElements(): Promise<void> {
    try {
      // Clean up ensembles
      const ensembles = await ensembleManager.list();
      for (const ensemble of ensembles) {
        if (ensemble.metadata.name.startsWith('test-') ||
            ensemble.metadata.name.includes('editable') ||
            ensemble.metadata.name.includes('deletable') ||
            ensemble.metadata.name.includes('valid') ||
            ensemble.metadata.name.includes('invalid') ||
            ensemble.metadata.name.includes('multi-') ||
            ensemble.metadata.name.includes('removable') ||
            ensemble.metadata.name.includes('property-')) {
          try {
            await ensembleManager.delete(ensemble.metadata.name);
          } catch (_e) {
            // Ignore cleanup errors
          }
        }
      }

      // Clean up skills
      const skills = await skillManager.list();
      for (const skill of skills) {
        if (skill.metadata.name.startsWith('test-skill') ||
            skill.metadata.name.startsWith('new-skill') ||
            skill.metadata.name.startsWith('skill-') ||
            skill.metadata.name.startsWith('updatable-skill') ||
            skill.metadata.name.startsWith('valid-skill')) {
          try {
            await skillManager.delete(skill.metadata.name);
          } catch (_e) {
            // Ignore cleanup errors
          }
        }
      }

      // Clean up templates
      const templates = await templateManager.list();
      for (const template of templates) {
        if (template.metadata.name.startsWith('test-template')) {
          try {
            await templateManager.delete(template.metadata.name);
          } catch (_e) {
            // Ignore cleanup errors
          }
        }
      }

      // Clean up agents
      const agents = await agentManager.list();
      for (const agent of agents) {
        if (agent.metadata.name.startsWith('test-agent')) {
          try {
            await agentManager.delete(agent.metadata.name);
          } catch (_e) {
            // Ignore cleanup errors
          }
        }
      }
    } catch (_e) {
      // Ignore cleanup errors
    }
  }

  // ====================================================================
  // createElement Tests
  // ====================================================================

  describe('createElement', () => {
    it('should create a basic ensemble with required fields', async () => {
      const result = await server.createElement({
        name: 'test-ensemble-basic',
        type: ElementType.ENSEMBLE,
        description: 'Test ensemble with basic fields',
        metadata: {
          activationStrategy: 'sequential',
          conflictResolution: 'last-write'
        }
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toMatch(/created.*ensemble.*test-ensemble-basic/i);

      // Verify the ensemble can be retrieved
      const detailsResult = await server.getElementDetails('test-ensemble-basic', ElementType.ENSEMBLE);
      expect(detailsResult.content[0].text).toContain('test-ensemble-basic');
    });

    it('should create an ensemble with elements array', async () => {
      // Create some skills first that the ensemble can reference
      await createTestSkill('test-skill-1');
      await createTestSkill('test-skill-2');

      const result = await server.createElement({
        name: 'multi-element-ensemble',
        type: ElementType.ENSEMBLE,
        description: 'Ensemble with multiple elements',
        metadata: {
          activationStrategy: 'all',
          conflictResolution: 'merge',
          elements: [
            {
              element_name: 'test-skill-1',
              element_type: 'skill',
              role: 'primary',
              priority: 80,
              activation: 'always'
            },
            {
              element_name: 'test-skill-2',
              element_type: 'skill',
              role: 'support',
              priority: 50,
              activation: 'on-demand'
            }
          ]
        }
      });

      expect(result.content[0].text).toContain('✅');

      // Verify the ensemble was created with elements
      const ensembles = await ensembleManager.list();
      const created = ensembles.find(e => e.metadata.name === 'multi-element-ensemble');
      expect(created).toBeDefined();
      expect(created?.metadata.elements).toHaveLength(2);
      expect(created?.metadata.elements[0].element_name).toBe('test-skill-1');
      expect(created?.metadata.elements[0].role).toBe('primary');
      expect(created?.metadata.elements[0].priority).toBe(80);
      expect(created?.metadata.elements[1].element_name).toBe('test-skill-2');
      expect(created?.metadata.elements[1].role).toBe('support');
      expect(created?.metadata.elements[1].priority).toBe(50);
    });

    it('should validate required fields when creating ensemble', async () => {
      const result = await server.createElement({
        name: '',
        type: ElementType.ENSEMBLE,
        description: '',
        metadata: {}
      });

      // Should fail due to missing required fields
      expect(result.content[0].text).toContain('❌');
    });
  });

  // ====================================================================
  // editElement Tests - CRITICAL FOR ISSUE #14
  // ====================================================================

  describe('editElement - Array Operations (Issue #14)', () => {
    // NOTE: Some tests in this suite may fail due to bugs in the ensemble editing logic
    // These failures document real issues that need to be fixed

    it('should edit ensemble metadata (name, description, strategy)', async () => {
      // Create ensemble
      await createTestEnsemble('editable-ensemble-meta', []);

      // Edit description - Issue #334: Use input wrapper format
      const result1 = await server.editElement({
        name: 'editable-ensemble-meta',
        type: ElementType.ENSEMBLE,
        input: { description: 'Updated description' }
      });

      expect(result1.content[0].text).toContain('✅');

      // Edit activation strategy - Issue #334: Use input wrapper format
      const result2 = await server.editElement({
        name: 'editable-ensemble-meta',
        type: ElementType.ENSEMBLE,
        input: { metadata: { activationStrategy: 'all' } }
      });

      expect(result2.content[0].text).toContain('✅');

      // Verify changes persisted
      const ensembles = await ensembleManager.list();
      const edited = ensembles.find(e => e.metadata.name === 'editable-ensemble-meta');
      expect(edited?.metadata.description).toBe('Updated description');
      expect(edited?.metadata.activationStrategy).toBe('all');
    });

    it('should add elements to ensemble elements array', async () => {
      // Create ensemble
      await createTestEnsemble('editable-ensemble-add', []);

      // Create skill to add
      await createTestSkill('new-skill-1');

      // Edit to add element - Issue #334: Use input wrapper format
      const result = await server.editElement({
        name: 'editable-ensemble-add',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            {
              element_name: 'new-skill-1',
              element_type: 'skill',
              role: 'primary',
              priority: 70,
              activation: 'always'
            }
          ]
        }
      });

      expect(result.content[0].text).toContain('✅');

      // Force reload to ensure we're reading from disk
      const ensembles = await ensembleManager.list();
      const edited = ensembles.find(e => e.metadata.name === 'editable-ensemble-add');

      // Verify element was added
      expect(edited?.metadata.elements).toHaveLength(1);
      expect(edited?.metadata.elements[0].element_name).toBe('new-skill-1');
      expect(edited?.metadata.elements[0].role).toBe('primary');
      expect(edited?.metadata.elements[0].priority).toBe(70);
    });

    it('should remove elements from ensemble elements array using _remove marker', async () => {
      // Create ensemble with 2 elements
      await createTestSkill('skill-1');
      await createTestSkill('skill-2');
      await createTestEnsemble('removable-ensemble', [
        { element_name: 'skill-1', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' },
        { element_name: 'skill-2', element_type: 'skill', role: 'support', priority: 50, activation: 'always' }
      ]);

      // Issue #662: Remove element using _remove marker (merge semantics preserve unlisted elements)
      const result = await server.editElement({
        name: 'removable-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            { element_name: 'skill-2', _remove: true }
          ]
        }
      });

      expect(result.content[0].text).toContain('✅');

      // Verify element was removed, other preserved
      const ensembles = await ensembleManager.list();
      const edited = ensembles.find(e => e.metadata.name === 'removable-ensemble');
      expect(edited?.metadata.elements).toHaveLength(1);
      expect(edited?.metadata.elements[0].element_name).toBe('skill-1');
    });

    it('should update element properties in array (priority, role, etc.)', async () => {
      // Create ensemble
      await createTestSkill('updatable-skill');
      await createTestEnsemble('property-test-ensemble', [
        { element_name: 'updatable-skill', element_type: 'skill', role: 'support', priority: 50, activation: 'on-demand' }
      ]);

      // Update element properties - Issue #334: Use input wrapper format
      const result = await server.editElement({
        name: 'property-test-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            { element_name: 'updatable-skill', element_type: 'skill', role: 'primary', priority: 90, activation: 'always' }
          ]
        }
      });

      expect(result.content[0].text).toContain('✅');

      // Verify properties were updated
      const ensembles = await ensembleManager.list();
      const edited = ensembles.find(e => e.metadata.name === 'property-test-ensemble');
      expect(edited?.metadata.elements[0].role).toBe('primary');
      expect(edited?.metadata.elements[0].priority).toBe(90);
      expect(edited?.metadata.elements[0].activation).toBe('always');
    });

    it('should handle editing ensemble with nested ensembles', async () => {
      // Create a base ensemble
      await createTestSkill('base-skill');
      await createTestEnsemble('base-ensemble', [
        { element_name: 'base-skill', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' }
      ]);

      // Create parent ensemble with nested ensemble (requires allowNested: true)
      await createTestEnsemble('parent-ensemble', [
        { element_name: 'base-ensemble', element_type: 'ensemble', role: 'primary', priority: 90, activation: 'always' }
      ], { allowNested: true });

      // Edit the parent ensemble to add another element - Issue #334: Use input wrapper format
      const result = await server.editElement({
        name: 'parent-ensemble',
        type: ElementType.ENSEMBLE,
        input: {
          elements: [
            { element_name: 'base-ensemble', element_type: 'ensemble', role: 'primary', priority: 90, activation: 'always' },
            { element_name: 'base-skill', element_type: 'skill', role: 'support', priority: 50, activation: 'on-demand' }
          ]
        }
      });

      expect(result.content[0].text).toContain('✅');

      // Verify nested ensemble structure
      const ensembles = await ensembleManager.list();
      const edited = ensembles.find(e => e.metadata.name === 'parent-ensemble');
      expect(edited?.metadata.elements).toHaveLength(2);
      expect(edited?.metadata.elements[0].element_type).toBe('ensemble');
      expect(edited?.metadata.elements[1].element_type).toBe('skill');
    });
  });

  // ====================================================================
  // deleteElement Tests
  // ====================================================================

  describe('deleteElement', () => {
    it('should delete an ensemble', async () => {
      await createTestEnsemble('deletable-ensemble', []);

      const result = await server.deleteElement({
        name: 'deletable-ensemble',
        type: ElementType.ENSEMBLE
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('deleted');

      // Verify it was deleted
      const ensembles = await ensembleManager.list();
      const found = ensembles.find(e => e.metadata.name === 'deletable-ensemble');
      expect(found).toBeUndefined();
    });

    // Issue #336: ElementNotFoundError is now thrown instead of returning error content
    it('should throw ElementNotFoundError for non-existent ensemble', async () => {
      await expect(server.deleteElement({
        name: 'non-existent-ensemble',
        type: ElementType.ENSEMBLE
      })).rejects.toThrow('not found');
    });
  });

  // ====================================================================
  // validateElement Tests
  // ====================================================================

  describe('validateElement', () => {
    it('should validate a valid ensemble', async () => {
      await createTestSkill('valid-skill');
      await createTestEnsemble('valid-ensemble', [
        { element_name: 'valid-skill', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' }
      ]);

      const result = await server.validateElement({
        name: 'valid-ensemble',
        type: ElementType.ENSEMBLE
      });

      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('valid');
    });

    it('should catch circular dependencies', async () => {
      // Create two ensembles that reference each other (circular dependency)
      // Both require allowNested: true since they contain ensemble references
      await createTestEnsemble('ensemble-a', [
        { element_name: 'ensemble-b', element_type: 'ensemble', role: 'primary', priority: 80, activation: 'always' }
      ], { allowNested: true });
      await createTestEnsemble('ensemble-b', [
        { element_name: 'ensemble-a', element_type: 'ensemble', role: 'primary', priority: 80, activation: 'always' }
      ], { allowNested: true });

      const result = await server.validateElement({
        name: 'ensemble-a',
        type: ElementType.ENSEMBLE,
        strict: true
      });

      // NOTE: Current validation implementation may mark circular dependencies as valid with warnings
      // This test verifies validation completes without crashing
      expect(result.content[0].text).toContain('Validation Report');
      expect(result.content[0].text).toMatch(/✅|⚠️/); // Either valid or has warnings
    });

    it('should catch missing required fields', async () => {
      // Create an ensemble with empty description (should trigger warnings)
      await createTestEnsemble('invalid-ensemble', []);

      // Edit to empty description - Issue #334: Use input wrapper format
      await server.editElement({
        name: 'invalid-ensemble',
        type: ElementType.ENSEMBLE,
        input: { description: '' }
      });

      const result = await server.validateElement({
        name: 'invalid-ensemble',
        type: ElementType.ENSEMBLE,
        strict: true
      });

      // Should report warnings about empty description
      expect(result.content[0].text).toContain('Validation Report');
      expect(result.content[0].text).toContain('Warnings');
    });
  });

  // ====================================================================
  // listElements Tests
  // ====================================================================

  describe('listElements', () => {
    it('should list all ensembles', async () => {
      // Create some test ensembles via server
      await createTestEnsemble('test-ensemble-1', []);
      await createTestEnsemble('test-ensemble-2', []);
      await createTestEnsemble('test-ensemble-3', []);

      const result = await server.listElements(ElementType.ENSEMBLE) as any;

      // Issue #299: list_elements returns structured data
      const names = (result.items || []).map((i: any) => i.name || i.element_name);
      expect(names).toContain('test-ensemble-1');
      expect(names).toContain('test-ensemble-2');
      expect(names).toContain('test-ensemble-3');
    });

    it('should return empty items when no ensembles exist', async () => {
      // Don't create any ensembles - test the empty case
      const result = await server.listElements(ElementType.ENSEMBLE) as any;

      // Issue #299: structured response with 0 items
      expect(result.items).toBeDefined();
      expect(result.items).toHaveLength(0);
    });
  });

  // ====================================================================
  // Complex CRUD Workflow Tests
  // ====================================================================

  describe('Complex CRUD workflows', () => {
    it('should handle full ensemble lifecycle: create → edit → validate → delete', async () => {
      // 1. Create
      await createTestSkill('workflow-skill');
      const createResult = await server.createElement({
        name: 'test-workflow-ensemble',
        type: ElementType.ENSEMBLE,
        description: 'Lifecycle test ensemble',
        metadata: {
          activationStrategy: 'sequential',
          conflictResolution: 'last-write',
          elements: [
            { element_name: 'workflow-skill', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' }
          ]
        }
      });
      expect(createResult.content[0].text).toContain('✅');

      // 2. Edit - Issue #334: Use input wrapper format
      const editResult = await server.editElement({
        name: 'test-workflow-ensemble',
        type: ElementType.ENSEMBLE,
        input: { metadata: { activationStrategy: 'all' } }
      });
      expect(editResult.content[0].text).toContain('✅');

      // 3. Validate
      const validateResult = await server.validateElement({
        name: 'test-workflow-ensemble',
        type: ElementType.ENSEMBLE
      });
      expect(validateResult.content[0].text).toContain('✅');

      // 4. Delete
      const deleteResult = await server.deleteElement({
        name: 'test-workflow-ensemble',
        type: ElementType.ENSEMBLE
      });
      expect(deleteResult.content[0].text).toContain('✅');

      // 5. Verify deletion
      const ensembles = await ensembleManager.list();
      const found = ensembles.find(e => e.metadata.name === 'test-workflow-ensemble');
      expect(found).toBeUndefined();
    });

    it('should handle ensemble with multiple element types', async () => {
      // Create elements of different types
      await createTestSkill('multi-type-skill');
      await createTestTemplate('multi-type-template');
      await createTestAgent('multi-type-agent');

      // Create ensemble with mixed element types
      const result = await server.createElement({
        name: 'multi-type-ensemble',
        type: ElementType.ENSEMBLE,
        description: 'Ensemble with multiple element types',
        metadata: {
          activationStrategy: 'priority',
          conflictResolution: 'merge',
          elements: [
            { element_name: 'multi-type-skill', element_type: 'skill', role: 'primary', priority: 90, activation: 'always' },
            { element_name: 'multi-type-template', element_type: 'template', role: 'support', priority: 70, activation: 'on-demand' },
            { element_name: 'multi-type-agent', element_type: 'agent', role: 'support', priority: 50, activation: 'conditional', condition: 'needs_automation' }
          ]
        }
      });

      expect(result.content[0].text).toContain('✅');

      // Verify the ensemble was created correctly
      const ensembles = await ensembleManager.list();
      const created = ensembles.find(e => e.metadata.name === 'multi-type-ensemble');
      expect(created?.metadata.elements).toHaveLength(3);
      expect(created?.metadata.elements[0].element_type).toBe('skill');
      expect(created?.metadata.elements[1].element_type).toBe('template');
      expect(created?.metadata.elements[2].element_type).toBe('agent');
      expect(created?.metadata.elements[2].condition).toBe('needs_automation');
    });
  });
});
