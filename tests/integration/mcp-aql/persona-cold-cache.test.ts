import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { PersonaActivationStrategy } from '../../../src/handlers/strategies/PersonaActivationStrategy.js';
import { PersonaIndicatorService } from '../../../src/services/PersonaIndicatorService.js';
import { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import { resolveElementTypes } from '../../../src/utils/elementTypeResolver.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('Persona lookup after cache eviction (Issue #2800)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let manager: PersonaManager;
  const name = 'cold-cache-persona';

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('persona-cold-cache');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas();
    preConfirmAllOperations(container);
    await container.resolve<MCPAQLHandler>('mcpAqlHandler').handleCreate({
      operation: 'create_element',
      element_type: 'persona',
      params: { element_name: name, description: 'Cold cache regression persona', instructions: 'You are a test persona.' },
    });
    manager = container.resolve<PersonaManager>('PersonaManager');
    expect(manager.findPersona(name)).toBeDefined();
    manager.clearCache();
    expect(manager.findPersona(name)).toBeUndefined();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await server.dispose();
    await env.cleanup();
  });

  it('resolves an untyped stored persona', async () => {
    const result = await resolveElementTypes([{ element_name: name }], { personaManager: manager });
    expect(result).toEqual({ resolved: [{ element_name: name, element_type: 'persona' }], ambiguous: [], notFound: [] });
  });

  it('validates a stored persona after clearing its cache', async () => {
    const result = await manager.validatePersona(name);
    expect(result.report).toBeDefined();
    expect(result.message).toContain('Status:');
  });

  it('reports ambiguity with a same-named skill instead of silently choosing it', async () => {
    const result = await resolveElementTypes([{ element_name: name }], {
      personaManager: manager,
      skillManager: { findByName: async () => ({ metadata: { name } }) },
    });
    expect(result).toEqual({ resolved: [], ambiguous: [{ element_name: name, found_in: ['skill', 'persona'] }], notFound: [] });
  });

  it('deactivates a stored persona after clearing its cache', async () => {
    await manager.activatePersona(name);
    manager.clearCache();
    expect(manager.findPersona(name)).toBeUndefined();
    const strategy = new PersonaActivationStrategy(manager, container.resolve<PersonaIndicatorService>('PersonaIndicatorService'));
    const result = await strategy.deactivate(name);
    expect(result.content[0].text).toContain('✅');
    expect(result.activationRecord?.filename).toBe('cold-cache-persona.md');
    expect(await manager.resolveActivePersonas()).toEqual([]);
  });

  it('records the stored filename when activation omits its activation record', async () => {
    const handler = container.resolve<ElementCRUDHandler>('ElementCRUDHandler');
    const recordActivation = jest.fn();
    const storeHost = handler as unknown as { getSessionActivationStore(): { recordActivation: typeof recordActivation; getSessionId(): string } };
    jest.spyOn(storeHost, 'getSessionActivationStore').mockReturnValue({ recordActivation, getSessionId: () => 'cold-cache-test' });
    jest.spyOn(PersonaActivationStrategy.prototype, 'activate').mockResolvedValue({ content: [{ type: 'text', text: 'Activated' }] });
    const result = await handler.activateElement(name, 'personas');
    expect(result.content[0].text).toBe('Activated');
    expect(recordActivation).toHaveBeenCalledWith('personas', name, 'cold-cache-persona.md', undefined);
  });
});
