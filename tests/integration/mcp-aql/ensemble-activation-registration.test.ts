/**
 * Regression test for Issue #1769: Ensemble activation must register
 * member elements with their type managers.
 *
 * Reproduces the exact bug scenario:
 * 1. Create elements of multiple types
 * 2. Create an ensemble containing them
 * 3. Activate the ensemble
 * 4. Call get_active_elements per type — must show the members
 *
 * Before the fix, step 4 returned empty results because the ensemble
 * only called instance.activate() (status flag) without registering
 * elements in the type manager's active set.
 */

import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import type { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import type { ActivationStore } from '../../../src/services/ActivationStore.js';
import { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('Ensemble Activation Registration (Issue #1769)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let originalHome: string | undefined;

  beforeEach(async () => {
    process.env.DOLLHOUSE_SESSION_ID = 'ensemble-reg-test';
    originalHome = process.env.HOME;
    env = await createPortfolioTestEnvironment('ensemble-registration');
    const home = join(env.testDir, 'home');
    await mkdir(home);
    process.env.HOME = home;
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas();
    preConfirmAllOperations(container);
    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    delete process.env.DOLLHOUSE_SESSION_ID;
  });

  it('should make ensemble-activated skills visible via get_active_elements', async () => {
    // Create a skill
    await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      element_type: 'skill',
      params: {
        element_name: 'ensemble-test-skill',
        description: 'Skill for ensemble activation test',
        content: 'Test skill content.',
      },
    });

    // Create an ensemble containing the skill
    await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      element_type: 'ensemble',
      params: {
        element_name: 'test-ensemble',
        description: 'Test ensemble for activation registration',
        metadata: {
          elements: [
            { element_name: 'ensemble-test-skill', element_type: 'skill', role: 'primary' },
          ],
        },
      },
    });

    // Activate the ensemble
    const activateResult = await mcpAqlHandler.handleRead({
      operation: 'activate_element',
      element_type: 'ensemble',
      params: { element_name: 'test-ensemble', element_type: 'ensemble' },
    });
    const activateText = JSON.stringify(activateResult);
    expect(activateText).toContain('activated');

    // REGRESSION CHECK: get_active_elements for skills must include the ensemble member
    const activeSkills = await mcpAqlHandler.handleRead({
      operation: 'get_active_elements',
      params: { element_type: 'skill' },
    });
    const activeSkillsText = JSON.stringify(activeSkills);
    expect(activeSkillsText).toContain('ensemble-test-skill');
  });

  it('should make ensemble-activated personas visible via get_active_elements', async () => {
    // Create a persona
    await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      element_type: 'persona',
      params: {
        element_name: 'ensemble-test-persona',
        description: 'Persona for ensemble activation test',
        instructions: 'You are a test persona.',
      },
    });

    // Create an ensemble containing the persona
    await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      element_type: 'ensemble',
      params: {
        element_name: 'persona-ensemble',
        description: 'Ensemble with a persona',
        metadata: {
          elements: [
            { element_name: 'ensemble-test-persona', element_type: 'persona', role: 'primary' },
          ],
        },
      },
    });

    // Activate the ensemble
    await mcpAqlHandler.handleRead({
      operation: 'activate_element',
      element_type: 'ensemble',
      params: { element_name: 'persona-ensemble', element_type: 'ensemble' },
    });

    // REGRESSION CHECK
    const activePersonas = await mcpAqlHandler.handleRead({
      operation: 'get_active_elements',
      params: { element_type: 'persona' },
    });
    const activeText = JSON.stringify(activePersonas);
    expect(activeText).toContain('ensemble-test-persona');
  });

  const uncachedPersona = 'uncached-ensemble-persona';
  const uncachedEnsemble = 'uncached-persona-ensemble';

  async function createEnsembleWithUncachedPersona(): Promise<void> {
    await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      element_type: 'persona',
      params: {
        element_name: uncachedPersona,
        description: 'Stored persona for cold-cache ensemble activation',
        instructions: 'You are a test persona.',
      },
    });

    await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      element_type: 'ensemble',
      params: {
        element_name: uncachedEnsemble,
        description: 'Ensemble whose primary persona is uncached',
        metadata: {
          elements: [
            { element_name: uncachedPersona, element_type: 'persona', role: 'primary' },
          ],
        },
      },
    });

    const personaManager = container.resolve<PersonaManager>('PersonaManager');
    expect(personaManager.findPersona(uncachedPersona)).toBeDefined();
    personaManager.clearCache();
    expect(personaManager.findPersona(uncachedPersona)).toBeUndefined();
  }

  it('should activate a stored persona after its manager cache is cleared (#3295)', async () => {
    await createEnsembleWithUncachedPersona();

    const result = await mcpAqlHandler.handleRead({
      operation: 'activate_element',
      element_type: 'ensemble',
      params: { element_name: uncachedEnsemble, element_type: 'ensemble' },
    });
    expect(JSON.stringify(result)).toContain('**Failed**: 0 elements');
    expect(JSON.stringify(result)).toContain('**Activated**: 1 elements');

    const activePersonas = await mcpAqlHandler.handleRead({
      operation: 'get_active_elements',
      params: { element_type: 'persona' },
    });
    expect(JSON.stringify(activePersonas)).toContain(uncachedPersona);
  });

  it('should report a genuinely missing persona when activating its ensemble', async () => {
    await createEnsembleWithUncachedPersona();
    await unlink(join(env.testDir, 'personas', `${uncachedPersona}.md`));

    const result = await mcpAqlHandler.handleRead({
      operation: 'activate_element',
      element_type: 'ensemble',
      params: { element_name: uncachedEnsemble, element_type: 'ensemble' },
    });
    expect(JSON.stringify(result)).toContain('**Failed**: 1 elements');
    expect(JSON.stringify(result)).toContain(`Persona '${uncachedPersona}' not found`);
  });

  it.each(['MCP-AQL', 'direct handler'])('deactivates an evicted persona member through %s', async route => {
    await createEnsembleWithUncachedPersona();
    const manager = container.resolve<PersonaManager>('PersonaManager');
    const handler = container.resolve<ElementCRUDHandler>('ElementCRUDHandler');
    const filename = `${uncachedPersona}.md`;

    await handler.activateElement(uncachedEnsemble, 'ensemble');
    expect(manager.getActivePersonaIds()).toContain(filename);
    manager.clearCache();
    expect(manager.findPersona(uncachedPersona)).toBeUndefined();

    const result = route === 'MCP-AQL'
      ? await mcpAqlHandler.handleRead({
        operation: 'deactivate_element',
        element_type: 'ensemble',
        params: { element_name: uncachedEnsemble, element_type: 'ensemble' },
      })
      : await handler.deactivateElement(uncachedEnsemble, 'ensemble');
    expect(JSON.stringify(result)).toContain(`Ensemble '${uncachedEnsemble}' deactivated`);
    expect(manager.getActivePersonaIds()).not.toContain(filename);
  });

  it('completes ensemble deactivation when a persona member is gone from storage', async () => {
    await createEnsembleWithUncachedPersona();
    const handler = container.resolve<ElementCRUDHandler>('ElementCRUDHandler');
    const store = container.resolve<ActivationStore>('ActivationStore');
    const manager = container.resolve<PersonaManager>('PersonaManager');

    await handler.activateElement(uncachedEnsemble, 'ensemble');
    expect(store.getActivations('ensemble')).toContainEqual(expect.objectContaining({ name: uncachedEnsemble }));
    manager.clearCache();
    await unlink(join(env.testDir, 'personas', `${uncachedPersona}.md`));

    const result = await handler.deactivateElement(uncachedEnsemble, 'ensemble');
    expect(result.content[0].text).toContain(`Ensemble '${uncachedEnsemble}' deactivated`);
    expect(store.getActivations('ensemble')).toEqual([]);
  });

  it('should remove ensemble-activated members from get_active_elements after deactivation', async () => {
    await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      element_type: 'persona',
      params: {
        element_name: 'ensemble-deactivate-persona',
        description: 'Persona for ensemble deactivation test',
        instructions: 'You are a test persona.',
      },
    });

    await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      element_type: 'skill',
      params: {
        element_name: 'ensemble-deactivate-skill',
        description: 'Skill for ensemble deactivation test',
        content: 'Test skill content.',
      },
    });

    await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      element_type: 'ensemble',
      params: {
        element_name: 'deactivation-ensemble',
        description: 'Ensemble for deactivation registration',
        metadata: {
          elements: [
            { element_name: 'ensemble-deactivate-persona', element_type: 'persona', role: 'primary' },
            { element_name: 'ensemble-deactivate-skill', element_type: 'skill', role: 'support' },
          ],
        },
      },
    });

    await mcpAqlHandler.handleRead({
      operation: 'activate_element',
      element_type: 'ensemble',
      params: { element_name: 'deactivation-ensemble', element_type: 'ensemble' },
    });

    await mcpAqlHandler.handleRead({
      operation: 'deactivate_element',
      element_type: 'ensemble',
      params: { element_name: 'deactivation-ensemble', element_type: 'ensemble' },
    });

    const activePersonas = await mcpAqlHandler.handleRead({
      operation: 'get_active_elements',
      params: { element_type: 'persona' },
    });
    expect(JSON.stringify(activePersonas)).not.toContain('ensemble-deactivate-persona');

    const activeSkills = await mcpAqlHandler.handleRead({
      operation: 'get_active_elements',
      params: { element_type: 'skill' },
    });
    expect(JSON.stringify(activeSkills)).not.toContain('ensemble-deactivate-skill');
  });
});
