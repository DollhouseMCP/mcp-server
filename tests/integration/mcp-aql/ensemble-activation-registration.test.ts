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

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
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
});
