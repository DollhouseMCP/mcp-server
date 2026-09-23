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

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import type { IActivationStateStore } from '../../../src/state/IActivationStateStore.js';
import type { EnsembleManager } from '../../../src/elements/ensembles/EnsembleManager.js';
import type { SkillManager } from '../../../src/elements/skills/SkillManager.js';
import type { PolicyExportService } from '../../../src/services/PolicyExportService.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('Ensemble Activation Registration (Issue #1769)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;

  beforeEach(async () => {
    process.env.DOLLHOUSE_SESSION_ID = 'ensemble-reg-test';
    env = await createPortfolioTestEnvironment('ensemble-registration');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas();
    preConfirmAllOperations(container);
    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await server.dispose();
    await env.cleanup();
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

  it('should activate a stored persona after its manager cache is cleared (Issue #2800)', async () => {
    await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      element_type: 'persona',
      params: {
        element_name: 'uncached-ensemble-persona',
        description: 'Stored persona for cold-cache ensemble activation',
        instructions: 'You are a test persona.',
      },
    });

    await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      element_type: 'ensemble',
      params: {
        element_name: 'uncached-persona-ensemble',
        description: 'Ensemble whose primary persona is not cached',
        metadata: {
          elements: [
            { element_name: 'uncached-ensemble-persona', element_type: 'persona', role: 'primary' },
          ],
        },
      },
    });

    const personaManager = container.resolve<PersonaManager>('PersonaManager');
    expect(personaManager.findPersona('uncached-ensemble-persona')).toBeDefined();
    personaManager.clearCache();
    expect(personaManager.findPersona('uncached-ensemble-persona')).toBeUndefined();

    const activateResult = await mcpAqlHandler.handleRead({
      operation: 'activate_element',
      element_type: 'ensemble',
      params: { element_name: 'uncached-persona-ensemble', element_type: 'ensemble' },
    });
    const activateText = JSON.stringify(activateResult);
    expect(activateText).toContain('**Failed**: 0 elements');
    expect(activateText).toContain('**Activated**: 1 elements');

    const activePersonas = await mcpAqlHandler.handleRead({
      operation: 'get_active_elements',
      params: { element_type: 'persona' },
    });
    expect(JSON.stringify(activePersonas)).toContain('uncached-ensemble-persona');
  });

  async function createDeactivationEnsemble(): Promise<void> {
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

  }

  it('completes handler deactivation when a persona member is missing from storage', async () => {
    await createDeactivationEnsemble();
    const handler = container.resolve<ElementCRUDHandler>('ElementCRUDHandler');
    const personaManager = container.resolve<PersonaManager>('PersonaManager');
    await handler.activateElement('deactivation-ensemble', 'ensembles');
    expect(personaManager.getActivePersonaIds()).toContain('ensemble-deactivate-persona.md');

    // Observe the real lifecycle collaborators without replacing their behavior.
    const lifecycle = handler as unknown as {
      getSessionActivationStore(): IActivationStateStore;
      invalidateActivePolicySnapshot(): void;
    };
    const recordDeactivation = jest.spyOn(lifecycle.getSessionActivationStore(), 'recordDeactivation');
    const invalidatePolicy = jest.spyOn(lifecycle, 'invalidateActivePolicySnapshot');
    const exportPolicies = jest.spyOn(container.resolve<PolicyExportService>('PolicyExportService'), 'exportPolicies');

    personaManager.clearCache();
    expect(personaManager.findPersona('ensemble-deactivate-persona')).toBeUndefined();
    // Model external removal at the storage-lookup boundary, preserving the real sync deactivator.
    jest.spyOn(personaManager, 'findPersonaAsync').mockResolvedValue(undefined);
    const response = await handler.deactivateElement('deactivation-ensemble', 'ensembles');

    expect(response.content[0].text).toContain("✅ Ensemble 'deactivation-ensemble' deactivated");
    expect(await container.resolve<EnsembleManager>('EnsembleManager').getActiveEnsembles()).toHaveLength(0);
    expect(await container.resolve<SkillManager>('SkillManager').getActiveSkills()).toHaveLength(0);
    expect(recordDeactivation).toHaveBeenCalledWith('ensembles', 'deactivation-ensemble', undefined, undefined);
    expect(invalidatePolicy).toHaveBeenCalledTimes(1);
    expect(exportPolicies).toHaveBeenCalled();
  });

  it.each(['MCP-AQL', 'direct handler'])('should remove ensemble-activated members after %s deactivation with a cold persona cache', async (route) => {
    await createDeactivationEnsemble();

    const personaManager = container.resolve<PersonaManager>('PersonaManager');
    const handler = container.resolve<ElementCRUDHandler>('ElementCRUDHandler');
    if (route === 'direct handler') {
      await handler.activateElement('deactivation-ensemble', 'ensembles');
      expect(personaManager.getActivePersonaIds()).toContain('ensemble-deactivate-persona.md');
    } else {
      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        element_type: 'ensemble',
        params: { element_name: 'deactivation-ensemble', element_type: 'ensemble' },
      });
      const activeBefore = await mcpAqlHandler.handleRead({
        operation: 'get_active_elements',
        params: { element_type: 'persona' },
      });
      expect(JSON.stringify(activeBefore)).toContain('ensemble-deactivate-persona');
    }
    personaManager.clearCache();
    expect(personaManager.findPersona('ensemble-deactivate-persona')).toBeUndefined();

    if (route === 'direct handler') {
      await handler.deactivateElement('deactivation-ensemble', 'ensembles');
    } else {
      await mcpAqlHandler.handleRead({
        operation: 'deactivate_element',
        element_type: 'ensemble',
        params: { element_name: 'deactivation-ensemble', element_type: 'ensemble' },
      });
    }

    // Inspect the active IDs directly so an empty cache cannot hide a retained activation.
    expect(personaManager.getActivePersonaIds()).not.toContain('ensemble-deactivate-persona.md');

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
