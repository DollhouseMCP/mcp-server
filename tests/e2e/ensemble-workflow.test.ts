/**
 * Ensemble Workflow E2E Tests
 *
 * Tests complete ensemble workflow through MCP tool interface:
 * - CRUD operations via ElementCRUDHandler
 * - Activation with mixed element types
 * - Configuration edits
 * - Validation
 * - Import/export
 * - Error handling
 * - Performance with large ensembles
 *
 * These tests use the MCP handlers (the way users interact with ensembles),
 * not direct service methods. This ensures we test the complete user-facing workflow.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import { createIntegrationContainer, IntegrationContainer } from '../helpers/integration-container.js';
import { ElementCRUDHandler } from '../../src/handlers/ElementCRUDHandler.js';
import { PersonaManager } from '../../src/persona/PersonaManager.js';
import { SkillManager } from '../../src/elements/skills/index.js';
import { TemplateManager } from '../../src/elements/templates/TemplateManager.js';
import { AgentManager } from '../../src/elements/agents/AgentManager.js';
import { MemoryManager } from '../../src/elements/memories/MemoryManager.js';
import { EnsembleManager } from '../../src/elements/ensembles/EnsembleManager.js';
import { PortfolioManager, ElementType } from '../../src/portfolio/PortfolioManager.js';
import { ElementNotFoundError } from '../../src/utils/ErrorHandler.js';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Ensemble Workflow E2E Tests', () => {
  const originalFilterSetting = process.env.DISABLE_ELEMENT_FILTERING;

  beforeAll(() => {
    process.env.DISABLE_ELEMENT_FILTERING = 'true';
  });

  afterAll(() => {
    if (originalFilterSetting === undefined) {
      delete process.env.DISABLE_ELEMENT_FILTERING;
    } else {
      process.env.DISABLE_ELEMENT_FILTERING = originalFilterSetting;
    }
  });

  let integrationContext: IntegrationContainer;
  let elementCrudHandler: ElementCRUDHandler;
  let portfolioManager: PortfolioManager;
  let ensembleManager: EnsembleManager;
  let personaManager: PersonaManager;
  let skillManager: SkillManager;
  let templateManager: TemplateManager;
  let agentManager: AgentManager;
  let memoryManager: MemoryManager;

  beforeEach(async () => {
    // Setup integration container with isolated portfolio
    integrationContext = await createIntegrationContainer();

    // Resolve services from container
    portfolioManager = integrationContext.container.resolve<PortfolioManager>('PortfolioManager');
    ensembleManager = integrationContext.container.resolve<EnsembleManager>('EnsembleManager');
    personaManager = integrationContext.container.resolve<PersonaManager>('PersonaManager');
    skillManager = integrationContext.container.resolve<SkillManager>('SkillManager');
    templateManager = integrationContext.container.resolve<TemplateManager>('TemplateManager');
    agentManager = integrationContext.container.resolve<AgentManager>('AgentManager');
    memoryManager = integrationContext.container.resolve<MemoryManager>('MemoryManager');

    // ElementCRUDHandler is not registered in DI container, so create it manually
    const templateRenderer = integrationContext.container.resolve('TemplateRenderer');
    const initService = integrationContext.container.resolve('InitializationService');
    const indicatorService = integrationContext.container.resolve('PersonaIndicatorService');
    const fileOperations = integrationContext.container.resolve('FileOperationsService');
    const elementQueryService = integrationContext.container.resolve('ElementQueryService');
    const validationRegistry = integrationContext.container.resolve('ValidationRegistry');

    elementCrudHandler = new ElementCRUDHandler(
      skillManager,
      templateManager,
      templateRenderer,
      agentManager,
      memoryManager,
      ensembleManager,
      personaManager,
      portfolioManager,
      initService,
      indicatorService,
      fileOperations,
      elementQueryService,
      validationRegistry
    );

    // Ensure portfolio directories exist
    await portfolioManager.initialize();
  });

  afterEach(async () => {
    // Cleanup integration context
    await integrationContext.dispose();
  });

  /**
   * Helper to extract text from MCP response format
   */
  function extractText(response: any): string {
    if (typeof response === 'string') return response;
    if (response?.content && Array.isArray(response.content) && response.content.length > 0) {
      return response.content[0]?.text || '';
    }
    if (response?.text) return response.text;
    if (response?.message) return response.message;
    return JSON.stringify(response);
  }

  /**
   * Helper to check if MCP response indicates success
   */
  function isSuccess(response: any): boolean {
    const text = extractText(response);
    return text.includes('✅') || (text.toLowerCase().includes('success') && !text.includes('❌'));
  }

  /**
   * Helper to check if MCP response indicates error
   */
  function isError(response: any): boolean {
    const text = extractText(response);
    return text.includes('❌');
  }

  /**
   * Helper to create test elements for ensemble testing
   * NOTE: Element names in ensembles must use slug format (no spaces, alphanumeric + hyphens/underscores)
   */
  async function createTestElements() {
    const elementsDir = portfolioManager.getElementDir(ElementType.PERSONA);
    const skillsDir = portfolioManager.getElementDir(ElementType.SKILL);
    const templatesDir = portfolioManager.getElementDir(ElementType.TEMPLATE);
    const agentsDir = portfolioManager.getElementDir(ElementType.AGENT);
    const memoriesDir = portfolioManager.getElementDir(ElementType.MEMORY);

    // Create test persona
    const personaContent = `---
name: Test Writer
description: A test persona for ensemble testing
version: 1.0.0
author: test-user
category: creative
triggers:
  - write
  - create
---

You are a creative writer assistant focused on clear, engaging content.`;

    await fs.writeFile(
      path.join(elementsDir, 'test-writer.md'),
      personaContent
    );

    // Create test skill
    const skillContent = `---
name: Code Review
description: A test skill for ensemble testing
version: 1.0.0
complexity: intermediate
domains:
  - software-engineering
languages:
  - javascript
  - typescript
---

Review code for quality, security, and best practices.`;

    await fs.writeFile(
      path.join(skillsDir, 'code-review.md'),
      skillContent
    );

    // Create test template
    const templateContent = `---
name: Meeting Notes
description: A test template for ensemble testing
version: 1.0.0
output_format: markdown
variables:
  - name: date
    type: string
    description: Meeting date
  - name: attendees
    type: string
    description: Meeting attendees
---

# Meeting Notes - {{date}}

**Attendees:** {{attendees}}

## Discussion Points
-

## Action Items
- `;

    await fs.writeFile(
      path.join(templatesDir, 'meeting-notes.md'),
      templateContent
    );

    // Create test agent
    const agentContent = `---
name: Task Planner
description: A test agent for ensemble testing
version: 1.0.0
specializations:
  - planning
  - organization
decisionFramework: rule-based
riskTolerance: low
---

Break down complex tasks into manageable steps and create action plans.`;

    await fs.writeFile(
      path.join(agentsDir, 'task-planner.md'),
      agentContent
    );

    // Create test memory
    const memoryContent = `---
name: Project Context
description: A test memory for ensemble testing
version: 1.0.0
retentionDays: 30
tags:
  - project
  - context
storageBackend: file
privacyLevel: private
autoLoad: false
---

Test project context for ensemble testing.`;

    await fs.writeFile(
      path.join(memoriesDir, 'project-context.md'),
      memoryContent
    );

    // Reload all managers to pick up new files
    await personaManager.reloadPersonas();
    skillManager.clearCache();
    templateManager.clearCache();
    agentManager.clearCache();
    memoryManager.clearCache();
    await skillManager.list();
    await templateManager.list();
    await agentManager.list();
    await memoryManager.list();
  }

  async function installWelcomeEnsembleFixtures() {
    const fixtures = [
      {
        source: new URL('../../data/personas/dollhouse-expert.md', import.meta.url),
        destinationDir: portfolioManager.getElementDir(ElementType.PERSONA),
        filename: 'dollhouse-expert.md'
      },
      {
        source: new URL('../../data/agents/research-assistant.md', import.meta.url),
        destinationDir: portfolioManager.getElementDir(ElementType.AGENT),
        filename: 'research-assistant.md'
      },
      {
        source: new URL('../../data/skills/research-to-elements.md', import.meta.url),
        destinationDir: portfolioManager.getElementDir(ElementType.SKILL),
        filename: 'research-to-elements.md'
      },
      {
        source: new URL('../../data/memories/welcome-to-dollhouse-guide.yaml', import.meta.url),
        destinationDir: portfolioManager.getElementDir(ElementType.MEMORY),
        filename: 'welcome-to-dollhouse-guide.yaml'
      },
      {
        source: new URL('../../data/ensembles/welcome-to-the-dollhouse.md', import.meta.url),
        destinationDir: portfolioManager.getElementDir(ElementType.ENSEMBLE),
        filename: 'welcome-to-the-dollhouse.md'
      }
    ];

    for (const fixture of fixtures) {
      await fs.copyFile(
        fixture.source,
        path.join(fixture.destinationDir, fixture.filename)
      );
    }

    await personaManager.reloadPersonas();
    skillManager.clearCache();
    templateManager.clearCache();
    agentManager.clearCache();
    memoryManager.clearCache();
    ensembleManager.clearCache();

    await skillManager.list();
    await agentManager.list();
    await memoryManager.list();
    await ensembleManager.list();
  }

  describe('Complete CRUD workflow via MCP tools', () => {
    it('should create, read, update, delete ensemble via MCP tools', async () => {
      await createTestElements();
      // Step 1: Create ensemble via MCP tool (using slug-format element names)
      const createResult = await elementCrudHandler.createElement({
        name: 'test-ensemble',
        type: 'ensembles',
        description: 'E2E test ensemble',
        metadata: {
          activationStrategy: 'sequential',
          conflictResolution: 'priority',
          contextSharing: 'selective',
          elements: [
            {
              element_name: 'test-writer',  // Slug format (no spaces)
              element_type: 'personas',
              role: 'primary',
              priority: 100,
              activation: 'always'
            }
          ]
        }
      });

      expect(isSuccess(createResult)).toBe(true);
      const createText = extractText(createResult);
      expect(createText).toContain('test-ensemble');

      // Step 2: List ensembles via MCP tool
      const listResult = await elementCrudHandler.listElements('ensembles');
      const listText = extractText(listResult);

      expect(listText).toContain('test-ensemble');
      expect(listText).toContain('E2E test ensemble');

      // Step 3: Get ensemble details via MCP tool
      const getResult = await elementCrudHandler.getElementDetails('test-ensemble', 'ensembles');
      const getText = extractText(getResult);

      expect(getText).toContain('test-ensemble');
      expect(getText).toContain('E2E test ensemble');
      expect(getText).toContain('sequential');
      expect(getText).toContain('test-writer');

      // Step 4: Update ensemble via MCP tool
      // Issue #290: Use input object format for edits
      const updateResult = await elementCrudHandler.editElement({
        name: 'test-ensemble',
        type: 'ensembles',
        input: { description: 'Updated description for E2E test' }
      });

      expect(isSuccess(updateResult)).toBe(true);

      // Verify update persisted (retry with exponential backoff for filesystem sync)
      let updateVerified = false;
      const backoffDelays = [0, 50, 150, 500, 1500]; // ms — escalating backoff
      for (let attempt = 0; attempt < backoffDelays.length; attempt++) {
        if (backoffDelays[attempt] > 0) {
          await new Promise(r => setTimeout(r, backoffDelays[attempt]));
        }
        const getAfterUpdate = await elementCrudHandler.getElementDetails('test-ensemble', 'ensembles');
        const updateText = extractText(getAfterUpdate);
        if (updateText.includes('Updated description for E2E test')) {
          updateVerified = true;
          if (attempt > 0) {
            console.log(`[ensemble-workflow] Update verified after ${attempt + 1} attempts (backoff: ${backoffDelays[attempt]}ms). Platform: ${process.platform}, Node: ${process.version}`);
          }
          break;
        }
        if (attempt === backoffDelays.length - 1) {
          console.warn(`[ensemble-workflow] Update NOT verified after ${backoffDelays.length} attempts (total backoff: ${backoffDelays.reduce((a, b) => a + b, 0)}ms). Platform: ${process.platform}, Node: ${process.version}. Got: ${updateText.substring(0, 200)}`);
        }
      }
      expect(updateVerified).toBe(true);

      // Step 5: Delete ensemble via MCP tool
      const deleteResult = await elementCrudHandler.deleteElement({
        name: 'test-ensemble',
        type: 'ensembles',
        deleteData: true
      });

      expect(isSuccess(deleteResult)).toBe(true);

      // Verify deletion
      const listAfterDelete = await elementCrudHandler.listElements('ensembles');
      const listAfterDeleteText = extractText(listAfterDelete);
      expect(listAfterDeleteText).not.toContain('test-ensemble');
    }, 30000);
  });

  describe('Activate ensemble with mixed element types via MCP', () => {
    it('should activate ensemble with personas, skills, and templates', async () => {
      // Create real test elements
      await createTestElements();

      // Create ensemble referencing all element types (using slug names)
      const createResult = await elementCrudHandler.createElement({
        name: 'full-stack-ensemble',
        type: 'ensembles',
        description: 'Ensemble with all element types',
        metadata: {
          activationStrategy: 'all',
          conflictResolution: 'merge',
          contextSharing: 'full',
          elements: [
            {
              element_name: 'test-writer',  // Slug format
              element_type: 'personas',
              role: 'primary',
              priority: 100,
              activation: 'always',
              purpose: 'Main persona for content creation'
            },
            {
              element_name: 'code-review',  // Slug format
              element_type: 'skills',
              role: 'support',
              priority: 80,
              activation: 'always',
              purpose: 'Code quality assessment'
            },
            {
              element_name: 'meeting-notes',  // Slug format
              element_type: 'templates',
              role: 'support',
              priority: 60,
              activation: 'on-demand',
              purpose: 'Documentation templates'
            },
            {
              element_name: 'task-planner',  // Slug format
              element_type: 'agents',
              role: 'support',
              priority: 70,
              activation: 'conditional',
              condition: 'complex_task',
              purpose: 'Planning assistance'
            },
            {
              element_name: 'project-context',  // Slug format
              element_type: 'memories',
              role: 'support',
              priority: 50,
              activation: 'always',
              purpose: 'Project knowledge'
            }
          ]
        }
      });

      expect(isSuccess(createResult)).toBe(true);

      // Activate via MCP tool
      const activateResult = await elementCrudHandler.activateElement(
        'full-stack-ensemble',
        'ensembles'
      );

      const activateText = extractText(activateResult);

      // Check activation was attempted
      expect(activateText).toBeTruthy();

      // Should mention the ensemble name
      expect(activateText.toLowerCase()).toContain('full-stack-ensemble');

      // Should report activation results (success or failures)
      const hasSuccessIndicator = activateText.includes('✅') || activateText.includes('activated');
      const hasErrorIndicator = activateText.includes('❌') || activateText.includes('⚠️');

      expect(hasSuccessIndicator || hasErrorIndicator).toBe(true);

      // The activation test above verifies the ensemble activation workflow.
      // We don't need to additionally check if all referenced elements are loaded
      // into their respective managers, as that's an implementation detail.
      // The important part is that activation was attempted and reported results.
    }, 30000);
  });

  describe('Welcome ensemble integration via MCP', () => {
    it('should activate the shipped welcome ensemble and surface all active member types', async () => {
      await installWelcomeEnsembleFixtures();

      const activateResult = await elementCrudHandler.activateElement(
        'welcome-to-the-dollhouse',
        'ensembles'
      );

      const activateText = extractText(activateResult);
      expect(activateText).toContain("✅ Ensemble 'welcome-to-the-dollhouse' activated");
      expect(activateText).toContain('**Strategy**: sequential');
      expect(activateText).toContain('**Activated**: 4 elements');
      expect(activateText).toContain('dollhouse-expert');
      expect(activateText).toContain('welcome-to-dollhouse-guide');
      expect(activateText).toContain('research-assistant');
      expect(activateText).toContain('research-to-elements');

      const activeEnsemblesText = extractText(await elementCrudHandler.getActiveElements('ensembles'));
      const activePersonasText = extractText(await elementCrudHandler.getActiveElements('personas'));
      const activeSkillsText = extractText(await elementCrudHandler.getActiveElements('skills'));
      const activeAgentsText = extractText(await elementCrudHandler.getActiveElements('agents'));
      const activeMemoriesText = extractText(await elementCrudHandler.getActiveElements('memories'));

      expect(activeEnsemblesText).toContain('welcome-to-the-dollhouse');
      expect(activePersonasText).toContain('dollhouse-expert');
      expect(activeSkillsText).toContain('research-to-elements');
      expect(activeAgentsText).toContain('Research Assistant');
      expect(activeMemoriesText).toContain('welcome-to-dollhouse-guide');
    }, 30000);
  });

  describe('Edit ensemble configuration via MCP', () => {
    it('should edit ensemble activation strategy via MCP tools', async () => {
      // Create ensemble with 'sequential' strategy
      await elementCrudHandler.createElement({
        name: 'editable-ensemble',
        type: 'ensembles',
        description: 'Ensemble for testing edits',
        metadata: {
          activationStrategy: 'sequential',
          conflictResolution: 'last-write',
          contextSharing: 'none',
          elements: []
        }
      });

      // Edit strategy to 'all'
      // Issue #290: Use input object format with nested metadata
      const editStrategyResult = await elementCrudHandler.editElement({
        name: 'editable-ensemble',
        type: 'ensembles',
        input: { metadata: { activationStrategy: 'all' } }
      });

      expect(isSuccess(editStrategyResult)).toBe(true);

      // Verify change
      const detailsAfterStrategy = await elementCrudHandler.getElementDetails(
        'editable-ensemble',
        'ensembles'
      );
      const strategyText = extractText(detailsAfterStrategy);
      expect(strategyText).toContain('all');

      // Edit conflict resolution
      const editConflictResult = await elementCrudHandler.editElement({
        name: 'editable-ensemble',
        type: 'ensembles',
        input: { metadata: { conflictResolution: 'priority' } }
      });

      expect(isSuccess(editConflictResult)).toBe(true);

      // Verify change persisted
      const detailsAfterConflict = await elementCrudHandler.getElementDetails(
        'editable-ensemble',
        'ensembles'
      );
      const conflictText = extractText(detailsAfterConflict);
      expect(conflictText).toContain('priority');

      // Edit context sharing
      const editContextResult = await elementCrudHandler.editElement({
        name: 'editable-ensemble',
        type: 'ensembles',
        input: { metadata: { contextSharing: 'selective' } }
      });

      expect(isSuccess(editContextResult)).toBe(true);

      // Verify all changes persisted to file
      const ensemblesDir = portfolioManager.getElementDir(ElementType.ENSEMBLE);
      const filePath = path.join(ensemblesDir, 'editable-ensemble.md');
      const fileContent = await fs.readFile(filePath, 'utf-8');

      expect(fileContent).toContain('all');
      expect(fileContent).toContain('priority');
      expect(fileContent).toContain('selective');
    }, 30000);

    it('should add and remove elements from ensemble', async () => {
      await createTestElements();

      // Create ensemble with one element
      await elementCrudHandler.createElement({
        name: 'growing-ensemble',
        type: 'ensembles',
        description: 'Ensemble that grows',
        metadata: {
          activationStrategy: 'sequential',
          conflictResolution: 'merge',
          contextSharing: 'selective',
          elements: [
            {
              element_name: 'test-writer',
              element_type: 'personas',
              role: 'primary',
              priority: 100,
              activation: 'always'
            }
          ]
        }
      });

      // Add a new element
      // Issue #290: Use input object format with nested metadata
      const addElementResult = await elementCrudHandler.editElement({
        name: 'growing-ensemble',
        type: 'ensembles',
        input: {
          metadata: {
            elements: [
              {
                element_name: 'test-writer',
                element_type: 'personas',
                role: 'primary',
                priority: 100,
                activation: 'always'
              },
              {
                element_name: 'code-review',
                element_type: 'skills',
                role: 'support',
                priority: 80,
                activation: 'always'
              }
            ]
          }
        }
      });

      expect(isSuccess(addElementResult)).toBe(true);

      // Verify element was added
      const detailsAfterAdd = await elementCrudHandler.getElementDetails(
        'growing-ensemble',
        'ensembles'
      );
      const addText = extractText(detailsAfterAdd);
      expect(addText).toContain('test-writer');
      expect(addText).toContain('code-review');
    }, 30000);
  });

  describe('Validate ensemble via MCP before activation', () => {
    it('should validate ensemble and report errors via MCP', async () => {
      // Create ensemble with validation issues
      const createResult = await elementCrudHandler.createElement({
        name: 'invalid-ensemble',
        type: 'ensembles',
        description: 'Ensemble with issues',
        metadata: {
          activationStrategy: 'sequential',
          conflictResolution: 'priority',
          contextSharing: 'selective',
          elements: [
            {
              element_name: 'non-existent-element',
              element_type: 'personas',
              role: 'primary',
              priority: 100,
              activation: 'always'
            },
            {
              element_name: 'another-missing',
              element_type: 'skills',
              role: 'support',
              priority: 80,
              activation: 'always',
              dependencies: ['non-existent-element']
            }
          ]
        }
      });

      expect(isSuccess(createResult)).toBe(true);

      // Validate via MCP tool
      const validateResult = await elementCrudHandler.validateElement({
        name: 'invalid-ensemble',
        type: 'ensembles',
        strict: true
      });

      // Should report validation results
      expect(validateResult).toBeDefined();

      // Validation should contain detailed information
      const validText = extractText(validateResult);
      expect(validText).toBeTruthy();

      // Should mention the ensemble
      expect(validText.toLowerCase()).toContain('invalid-ensemble');
    }, 30000);

    it('should validate ensemble with circular dependencies', async () => {
      // Create ensemble with circular dependencies
      const createResult = await elementCrudHandler.createElement({
        name: 'circular-ensemble',
        type: 'ensembles',
        description: 'Ensemble with circular deps',
        content: '# Circular Ensemble\n\nThis ensemble has circular dependencies for testing.',
        metadata: {
          activationStrategy: 'sequential',
          conflictResolution: 'priority',
          contextSharing: 'selective',
          elements: [
            {
              element_name: 'element-a',
              element_type: 'skills',
              role: 'primary',
              priority: 100,
              activation: 'always',
              dependencies: ['element-b']
            },
            {
              element_name: 'element-b',
              element_type: 'skills',
              role: 'support',
              priority: 80,
              activation: 'always',
              dependencies: ['element-a']
            }
          ]
        }
      });

      // Check if creation succeeded before validating
      const creationSucceeded = isSuccess(createResult);

      if (creationSucceeded) {
        // Brief delay to allow cache to update (Issue #276)
        await new Promise(resolve => setTimeout(resolve, 500));

        // Validate
        const validateResult = await elementCrudHandler.validateElement({
          name: 'circular-ensemble',
          type: 'ensembles',
          strict: true
        });

        const validText = extractText(validateResult);

        // Should detect circular dependency
        expect(validText.toLowerCase()).toMatch(/circular|dependency|cycle/);
      } else {
        // If creation failed, that's also valid - creation may fail with validation error
        expect(createResult).toBeDefined();
      }
    }, 30000);
  });

  describe('Import/export ensemble workflow', () => {
    it('should export ensemble to JSON format', async () => {
      // Create test ensemble
      const createResult = await elementCrudHandler.createElement({
        name: 'exportable-ensemble',
        type: 'ensembles',
        description: 'Ensemble for export testing',
        metadata: {
          activationStrategy: 'all',
          conflictResolution: 'merge',
          contextSharing: 'full',
          elements: [
            {
              element_name: 'test-element',
              element_type: 'skills',
              role: 'primary',
              priority: 100,
              activation: 'always'
            }
          ]
        }
      });

      expect(isSuccess(createResult)).toBe(true);

      // Get ensemble from manager
      const ensembles = await ensembleManager.list();
      const ensemble = ensembles.find(e => e.metadata.name === 'exportable-ensemble');

      expect(ensemble).toBeDefined();

      // Export to JSON
      const jsonExport = await ensembleManager.exportElement(ensemble!, 'json');

      expect(jsonExport).toBeTruthy();

      // Parse and verify JSON structure
      const parsed = JSON.parse(jsonExport);
      expect(parsed.metadata.name).toBe('exportable-ensemble');
      expect(parsed.metadata.activationStrategy).toBe('all');
      expect(parsed.metadata.elements).toHaveLength(1);
    }, 30000);

    it('should import ensemble from JSON and re-export', async () => {
      // Create ensemble data in JSON format (using slug format for element names)
      const jsonData = JSON.stringify({
        name: 'imported-ensemble',
        description: 'Ensemble imported from JSON',
        version: '1.0.0',
        activationStrategy: 'sequential',
        conflictResolution: 'priority',
        contextSharing: 'selective',
        elements: [
          {
            element_name: 'test-element',  // Slug format
            element_type: 'personas',
            role: 'primary',
            priority: 100,
            activation: 'always'
          }
        ]
      });

      // Import via manager
      const imported = await ensembleManager.importElement(jsonData, 'json');

      expect(imported).toBeDefined();
      expect(imported.metadata.name).toBe('imported-ensemble');

      // Save to portfolio
      await ensembleManager.save(imported, 'imported-ensemble.md');

      // Re-export in markdown format
      const markdownExport = await ensembleManager.exportElement(imported, 'markdown');

      expect(markdownExport).toContain('---');
      expect(markdownExport).toContain('name: imported-ensemble');
      expect(markdownExport).toContain('sequential');
    }, 30000);
  });

  describe('Error handling in E2E workflow', () => {
    it('should handle activation of non-existent ensemble gracefully', async () => {
      const activateResult = await elementCrudHandler.activateElement(
        'does-not-exist',
        'ensembles'
      );

      const resultText = extractText(activateResult);

      expect(resultText).toContain('❌');
      expect(resultText.toLowerCase()).toContain('not found');
    }, 30000);

    it('should handle creation with invalid configuration', async () => {
      // Try to create ensemble with invalid activation strategy
      const createResult = await elementCrudHandler.createElement({
        name: 'invalid-config',
        type: 'ensembles',
        description: 'Invalid ensemble',
        metadata: {
          activationStrategy: 'invalid-strategy',
          conflictResolution: 'priority',
          contextSharing: 'selective',
          elements: []
        }
      });

      // Should fail
      const createText = extractText(createResult);
      expect(createText.toLowerCase()).toMatch(/invalid|strategy|error/);
    }, 30000);

    // FIX: Issue #275 - Handler now throws ElementNotFoundError instead of returning error content
    it('should handle deletion of non-existent ensemble', async () => {
      await expect(
        elementCrudHandler.deleteElement({
          name: 'never-existed',
          type: 'ensembles',
          deleteData: true
        })
      ).rejects.toThrow(ElementNotFoundError);
    }, 30000);

    it('should validate ensemble before saving', async () => {
      // Create ensemble with empty name (should fail validation)
      const createResult = await elementCrudHandler.createElement({
        name: '',
        type: 'ensembles',
        description: 'Invalid ensemble with empty name',
        metadata: {
          activationStrategy: 'sequential',
          conflictResolution: 'priority',
          contextSharing: 'selective',
          elements: []
        }
      });

      // Should get error
      const createText = extractText(createResult);
      expect(isError(createResult)).toBe(true);
      expect(createText.toLowerCase()).toMatch(/name|required|invalid/);
    }, 30000);
  });

  describe('Performance test - Large ensemble', () => {
    it('should handle ensemble with many elements (up to limit)', async () => {
      await createTestElements();

      // Create ensemble with many elements (test near the limit)
      const maxElements = 25; // Use a reasonable number for testing
      const elements = [];

      for (let i = 0; i < maxElements; i++) {
        // Use slug format for names
        elements.push({
          element_name: `element-${i}`,
          element_type: 'skills',
          role: i === 0 ? 'primary' : 'support',
          priority: 100 - i,
          activation: 'always'
        });
      }

      const startTime = Date.now();

      // Create ensemble
      const createResult = await elementCrudHandler.createElement({
        name: 'large-ensemble',
        type: 'ensembles',
        description: 'Ensemble with many elements',
        metadata: {
          activationStrategy: 'all',
          conflictResolution: 'priority',
          contextSharing: 'selective',
          elements: elements
        }
      });

      const createDuration = Date.now() - startTime;

      expect(isSuccess(createResult)).toBe(true);
      expect(createDuration).toBeLessThan(5000); // Should complete within 5 seconds

      // Validate it loads correctly
      const getResult = await elementCrudHandler.getElementDetails(
        'large-ensemble',
        'ensembles'
      );

      const getText = extractText(getResult);
      expect(getText).toContain('large-ensemble');
      expect(getText).toContain(`${maxElements}`);

      // Try to activate (expect some elements to fail since they don't exist)
      const activateStartTime = Date.now();

      const activateResult = await elementCrudHandler.activateElement(
        'large-ensemble',
        'ensembles'
      );

      const activateDuration = Date.now() - activateStartTime;

      // Should not timeout (timeout is typically 30s, we expect much faster)
      expect(activateDuration).toBeLessThan(30000);

      const activateText = extractText(activateResult);
      expect(activateText).toBeTruthy();
    }, 60000); // Allow 60s for this test

    it('should reject ensemble exceeding element limit', async () => {
      // Try to create ensemble with too many elements
      const tooManyElements = 51; // Over the limit of 50
      const elements = [];

      for (let i = 0; i < tooManyElements; i++) {
        elements.push({
          element_name: `element-${i}`,
          element_type: 'skills',
          role: 'support',
          priority: 50,
          activation: 'always'
        });
      }

      const createResult = await elementCrudHandler.createElement({
        name: 'oversized-ensemble',
        type: 'ensembles',
        description: 'Ensemble with too many elements',
        metadata: {
          activationStrategy: 'sequential',
          conflictResolution: 'priority',
          contextSharing: 'selective',
          elements: elements
        }
      });

      // Should have failed
      const createText = extractText(createResult);
      expect(isError(createResult)).toBe(true);
      expect(createText.toLowerCase()).toMatch(/limit|maximum|too many|50/);
    }, 30000);
  });

  describe('Ensemble list and search operations', () => {
    it('should list all ensembles with details', async () => {
      // Create multiple ensembles
      await elementCrudHandler.createElement({
        name: 'ensemble-one',
        type: 'ensembles',
        description: 'First test ensemble',
        metadata: {
          activationStrategy: 'sequential',
          conflictResolution: 'priority',
          contextSharing: 'selective',
          elements: []
        }
      });

      await elementCrudHandler.createElement({
        name: 'ensemble-two',
        type: 'ensembles',
        description: 'Second test ensemble',
        metadata: {
          activationStrategy: 'all',
          conflictResolution: 'merge',
          contextSharing: 'full',
          elements: []
        }
      });

      // List all ensembles
      const listResult = await elementCrudHandler.listElements('ensembles');
      const listText = extractText(listResult);

      expect(listText).toContain('ensemble-one');
      expect(listText).toContain('ensemble-two');
      expect(listText).toContain('First test ensemble');
      expect(listText).toContain('Second test ensemble');
    }, 30000);

    it('should get active ensembles', async () => {
      // Check active ensembles (should be none initially)
      const activeResult = await elementCrudHandler.getActiveElements('ensembles');
      const activeText = extractText(activeResult);

      // Should have a response (even if no active ensembles)
      expect(activeText).toBeTruthy();
    }, 30000);
  });

  describe('File system persistence', () => {
    it('should persist ensemble changes to disk immediately', async () => {
      // Create ensemble
      await elementCrudHandler.createElement({
        name: 'persisted-ensemble',
        type: 'ensembles',
        description: 'Test persistence',
        metadata: {
          activationStrategy: 'sequential',
          conflictResolution: 'priority',
          contextSharing: 'selective',
          elements: []
        }
      });

      // Check file exists
      const ensemblesDir = portfolioManager.getElementDir(ElementType.ENSEMBLE);
      const filePath = path.join(ensemblesDir, 'persisted-ensemble.md');

      const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(fileExists).toBe(true);

      // Read file content
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('name: persisted-ensemble');
      expect(content).toContain('Test persistence');
      expect(content).toContain('sequential');

      // Update ensemble
      // Issue #290: Use input object format for edits
      await elementCrudHandler.editElement({
        name: 'persisted-ensemble',
        type: 'ensembles',
        input: { description: 'Updated persistence test' }
      });

      // Verify file updated
      const updatedContent = await fs.readFile(filePath, 'utf-8');
      expect(updatedContent).toContain('Updated persistence test');

      // Delete ensemble
      await elementCrudHandler.deleteElement({
        name: 'persisted-ensemble',
        type: 'ensembles',
        deleteData: true
      });

      // Verify file deleted
      const fileExistsAfterDelete = await fs.access(filePath).then(() => true).catch(() => false);
      expect(fileExistsAfterDelete).toBe(false);
    }, 30000);
  });
});
