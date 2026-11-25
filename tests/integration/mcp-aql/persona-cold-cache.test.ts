import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DollhouseContainer, type HandlerBundle } from '../../../src/di/Container.js';
import { PersonaActivationStrategy } from '../../../src/handlers/strategies/PersonaActivationStrategy.js';
import type { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { ElementType } from '../../../src/portfolio/types.js';
import type { ActivationStore } from '../../../src/services/ActivationStore.js';
import { resolveElementTypes } from '../../../src/utils/elementTypeResolver.js';
import { createIntegrationContainer, type IntegrationContainer } from '../../helpers/integration-container.js';
import { preConfirmAllOperations } from '../../helpers/portfolioTestHelper.js';

describe('Persona lookup after cache eviction (#3295)', () => {
  const name = 'cold-cache-persona';
  let env: IntegrationContainer;
  let handlers: HandlerBundle;
  let manager: PersonaManager;

  beforeEach(async () => {
    env = await createIntegrationContainer();
    await env.container.preparePortfolio();
    handlers = await env.container.bootstrapHandlers();
    preConfirmAllOperations(env.container);
    const result = await handlers.mcpAqlHandler.handleCreate({
      operation: 'create_element',
      element_type: 'persona',
      params: {
        element_name: name,
        description: 'Cold cache regression persona',
        instructions: 'You are a test persona.',
      },
    });
    expect(result.success).toBe(true);
    manager = env.container.resolve<PersonaManager>('PersonaManager');
    expect(manager.findPersona(name)).toBeDefined();
    manager.clearCache();
    expect(manager.findPersona(name)).toBeUndefined();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await env.dispose();
  });

  it('resolves an untyped stored persona', async () => {
    const result = await resolveElementTypes([{ element_name: name }], { personaManager: manager });
    expect(result).toEqual({
      resolved: [{ element_name: name, element_type: 'persona' }],
      ambiguous: [],
      notFound: [],
    });
  });

  it('reports ambiguity with a same-named skill', async () => {
    const result = await resolveElementTypes([{ element_name: name }], {
      personaManager: manager,
      skillManager: { findByName: () => Promise.resolve({ metadata: { name } }) },
    });
    expect(result).toEqual({
      resolved: [],
      ambiguous: [{ element_name: name, found_in: ['skill', 'persona'] }],
      notFound: [],
    });
  });

  it('validates a stored persona through the legacy handler', async () => {
    const result = await handlers.personaHandler.validatePersona(name);
    expect(result.content[0].text).toContain(`Validation Report: ${name}`);
    expect(result.content[0].text).toContain('Status: Valid');
  });

  it('returns details for a stored persona', async () => {
    const result = await handlers.elementCrudHandler.getElementDetails(name, 'persona');
    expect(result.content[0].text).toContain(`**${name}** Details`);
  });

  it('deactivates a stored persona after clearing its cache', async () => {
    const activation = await manager.activatePersona(name);
    expect(activation.success).toBe(true);
    manager.clearCache();
    expect(manager.findPersona(name)).toBeUndefined();

    const result = await handlers.elementCrudHandler.deactivateElement(name, 'persona');
    expect(result.content[0].text).toContain(`Deactivated persona: ${name}`);
    expect(manager.getActivePersonaIds()).toEqual([]);
  });

  it('persists the stored filename when the strategy leaves the cache cold', async () => {
    const store = env.container.resolve<ActivationStore>('ActivationStore');
    const recordActivation = jest.spyOn(store, 'recordActivation');
    jest.spyOn(PersonaActivationStrategy.prototype, 'activate')
      .mockResolvedValue({ content: [{ type: 'text', text: 'Activated' }] });

    const result = await handlers.elementCrudHandler.activateElement(name, 'persona');
    expect(result.content[0].text).toBe('Activated');
    expect(recordActivation).toHaveBeenCalledWith(ElementType.PERSONA, name, `${name}.md`);
  });

  async function writePersona(filename: string, displayName: string): Promise<void> {
    const file = join(env.portfolioManager.getElementDir(ElementType.PERSONA), filename);
    await writeFile(file, [
      '---',
      `name: ${displayName}`,
      'description: File persona fixture',
      'gatekeeper:',
      '  deny: [delete_element]',
      '---',
      'Test persona instructions.',
    ].join('\n'));
    await manager.refreshIndex({ freshAfterInFlight: true });
  }

  it('resolves a dotted display name after eviction', async () => {
    const displayName = 'Finance v2.0';
    await writePersona('finance-v2-0.md', displayName);
    expect(manager.findPersona(displayName)).toBeUndefined();
    expect((await manager.findPersonaAsync(displayName))?.metadata.name).toBe(displayName);
  });

  it('collects the active policy and lists the persona by its stored filename after eviction', async () => {
    const displayName = 'Renamed persona';
    const filename = 'original-persona.md';
    await writePersona(filename, displayName);
    expect(manager.findPersona(filename)).toBeUndefined();

    const activation = await manager.activatePersona(filename);
    expect(activation.success).toBe(true);
    expect(manager.getActivePersonaIds()).toEqual([filename]);

    manager.clearCache();
    expect(manager.findPersona(filename)).toBeUndefined();
    const policies = await handlers.elementCrudHandler.getActiveElementsForPolicy();
    expect(policies).toContainEqual(expect.objectContaining({
      type: 'persona',
      name: displayName,
      metadata: expect.objectContaining({ gatekeeper: { deny: ['delete_element'] } }),
    }));

    manager.clearCache();
    const active = await handlers.elementCrudHandler.getActiveElements('persona');
    expect(active.content[0].text).toContain(displayName);
  });

  it('restores a persisted filename with a different display name in a fresh container', async () => {
    const filename = 'original-persona.md';
    await writePersona(filename, 'Renamed persona');

    const restarted = new DollhouseContainer();
    try {
      await restarted.preparePortfolio();
      const store = restarted.resolve<ActivationStore>('ActivationStore');
      store.recordActivation(ElementType.PERSONA, 'Old display name', filename);
      const freshManager = restarted.resolve<PersonaManager>('PersonaManager');
      expect(freshManager.findPersona(filename)).toBeUndefined();

      await restarted['restoreActivations'](store);
      expect(freshManager.getActivePersonaIds()).toEqual([filename]);
      expect(store.getActivations('persona')).toContainEqual(expect.objectContaining({ filename }));
    } finally {
      await restarted.dispose();
    }
  });
});
