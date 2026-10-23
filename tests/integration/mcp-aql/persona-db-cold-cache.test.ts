import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AgentManager } from '../../../src/elements/agents/AgentManager.js';
import { ActivationMetricsTracker } from '../../../src/metrics/ActivationMetricsTracker.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import type { IStorageLayerFactory } from '../../../src/storage/IStorageLayerFactory.js';
import { DatabaseActivationStateStore } from '../../../src/state/DatabaseActivationStateStore.js';
import { ElementType } from '../../../src/portfolio/types.js';
import type { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import { MCPAQLHandler, type HandlerRegistry } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { Gatekeeper } from '../../../src/handlers/mcp-aql/Gatekeeper.js';
import { createIntegrationContainer } from '../../helpers/integration-container.js';
import { getTestDb, ensureTestUser, ensureTestUserB, isDatabaseAvailable, cleanupTestElements, cleanupTestSessions, closeTestDb } from '../database/test-db-helpers.js';

const available = await isDatabaseAvailable();
if (!available) {
  await closeTestDb();
  if (process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') {
    throw new Error('Required PostgreSQL unavailable');
  }
}
const databaseSuite = available ? describe : describe.skip;

databaseSuite('Database persona policy recovery after refresh', () => {
  let env: Awaited<ReturnType<typeof createIntegrationContainer>>;
  let manager: PersonaManager;
  let handler: ElementCRUDHandler;
  let aql: MCPAQLHandler;
  let store: DatabaseActivationStateStore;
  let writer: DatabaseStorageLayer;
  let userId: string;
  const sessionId = 'persona-db-policy';
  const policy = { deny: ['delete_element'] };
  let foreignUserId: string | undefined;

  beforeEach(async () => {
    userId = await ensureTestUser();
    await cleanupTestElements(userId);
    env = await createIntegrationContainer();
    const container = env.container;
    const fallback = container.resolve<IStorageLayerFactory>('StorageLayerFactory');
    container.register('UserIdResolver', () => () => userId);
    container.replace<IStorageLayerFactory>('StorageLayerFactory', () => ({
      createForElement: (type, options) => type === ElementType.PERSONA || type === ElementType.AGENT
        ? new DatabaseStorageLayer(getTestDb(), () => userId, type)
        : fallback.createForElement(type, options),
    }));
    writer = new DatabaseStorageLayer(getTestDb(), () => userId, ElementType.PERSONA);
    store = new DatabaseActivationStateStore(getTestDb(), userId, sessionId);
    await store.initialize();
    manager = container.resolve<PersonaManager>('PersonaManager');
    handler = new ElementCRUDHandler(container.resolve('SkillManager'), container.resolve('TemplateManager'),
      container.resolve('TemplateRenderer'), container.resolve('AgentManager'), container.resolve('MemoryManager'),
      container.resolve('EnsembleManager'), manager, env.portfolioManager,
      container.resolve('InitializationService'), container.resolve('PersonaIndicatorService'),
      container.resolve('FileOperationsService'), container.resolve('ElementQueryService'),
      container.resolve('ValidationRegistry'), new ActivationMetricsTracker(() => 'local-user'), {
        activationStore: store
      });
    aql = new MCPAQLHandler({ elementCRUD: handler, memoryManager: container.resolve('MemoryManager'),
      gatekeeper: new Gatekeeper(undefined, { enableAuditLogging: false }) } as HandlerRegistry);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store?.awaitPendingWrites();
    await aql?.dispose();
    await env?.dispose();
    await cleanupTestElements(userId);
    await cleanupTestSessions();
    if (foreignUserId) await cleanupTestElements(foreignUserId);
  });
  afterAll(closeTestDb);

  async function activate(count: number) {
    const names = Array.from({ length: count }, (_, index) => `db-policy-${index}`);
    await Promise.all(names.map(name => writer.writeContent(ElementType.PERSONA, name,
      `---\nname: ${name}\ndescription: Policy fixture\nversion: 1.0.0\ngatekeeper:\n  deny: [delete_element]\n---\nProtect deletion.\n`,
      { author: 'test', version: '1.0.0', tags: [], description: 'Policy fixture' })));
    // Activation mutates the session set and persistence state, so keep it ordered.
    await names.reduce(async (previous, name) => {
      await previous;
      await handler.activateElement(name, 'personas');
      expect((await manager.findPersonaAsync(name))?.filename).toMatch(/^[\da-f-]{36}$/u);
    }, Promise.resolve());
    await store.awaitPendingWrites();
    return names;
  }


  it('deletes an active database agent by its durable UUID', async () => {
    const name = 'delete-database-agent';
    const agentWriter = new DatabaseStorageLayer(getTestDb(), () => userId, ElementType.AGENT);
    const id = await agentWriter.writeContent(ElementType.AGENT, name,
      `---\nname: ${name}\ndescription: Deletion fixture\nversion: 1.0.0\n---\nFollow instructions.\n`,
      { author: 'test', version: '1.0.0', tags: [], description: 'Deletion fixture' });
    expect(id).toMatch(/^[\da-f-]{36}$/u);
    expect((await handler.activateElement(name, 'agent')).content[0].text).not.toContain('❌');
    expect(store.getActivations('agent')[0].identity).toEqual({ kind: 'database', value: id });
    const result = await handler.deleteElement({ name, type: 'agent' });
    expect(result.content[0].text).toContain('✅');
    expect(result.content[0].text).not.toContain('warning');
    expect(store.getActivations('agent')).toEqual([]);
    expect(env.container.resolve<AgentManager>('AgentManager')['getActivationSet']().size).toBe(0);
    await expect(agentWriter.readContent(id)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an unknown persona name without persisting an activation', async () => {
    const result = await aql.handleRead({ operation: 'activate_element',
      params: { element_name: 'unknown-persona', element_type: 'personas' } });
    expect(result.data).toMatchObject({ content: [expect.objectContaining({ text: expect.stringContaining('Persona not found') })] });
    await store.awaitPendingWrites();
    expect(store.getActivations('persona')).toEqual([]);
    expect(manager.getActivePersonas()).toEqual([]);
  });

  it('persists the successful persona activation tuple unchanged', async () => {
    const record = jest.spyOn(store, 'recordActivation');
    const [name] = await activate(1);
    const persona = await manager.findPersonaAsync(name);
    expect(record).toHaveBeenCalledWith(ElementType.PERSONA, name, persona?.filename, undefined);
    expect(store.getActivations('persona')).toEqual([expect.objectContaining({ name, filename: persona?.filename })]);
  });

  async function createSkill(publicForeign: boolean): Promise<string> {
    const owner = publicForeign ? await ensureTestUserB() : userId;
    if (publicForeign) foreignUserId = owner;
    const skillWriter = new DatabaseStorageLayer(getTestDb(), () => owner, ElementType.SKILL);
    const content = '---\nname: cross-type-skill\ndescription: Skill policy fixture\nversion: 1.0.0\ngatekeeper:\n  deny: [delete_element]\n---\nSkill instructions.\n';
    const id = await skillWriter.writeContent(ElementType.SKILL, 'cross-type-skill', content,
      { author: 'test', version: '1.0.0', tags: [], description: 'Skill policy fixture', visibility: publicForeign ? 'public' : 'private' });
    // Prove the app-role caller can read this row through its actual type, including via public RLS.
    const skillReader = new DatabaseStorageLayer(getTestDb(), () => userId, ElementType.SKILL);
    await expect(skillReader.readContent(id)).resolves.toBe(content);
    return id;
  }

  describe.each([false, true])('cross-type skill UUID (foreign public: %s)', publicForeign => {
    it('refuses storage reads through the persona layer with ENOENT', async () => {
      const id = await createSkill(publicForeign);
      await expect(writer.readContent(id)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses persona identity lookup without caching the skill', async () => {
      const id = await createSkill(publicForeign);
      await expect(manager.findByStorageIdentity(id)).resolves.toBeUndefined();
      // Private access deliberately verifies no cross-type cache publication.
      expect(manager['getCachedElementByStorageIdentity'](id)).toBeUndefined();
    });

    it('refuses direct activation without changing active personas', async () => {
      await activate(1);
      const before = manager.getActivePersonas();
      const id = await createSkill(publicForeign);
      await expect(manager.activatePersona(id)).resolves.toMatchObject({ success: false });
      expect(manager.getActivePersonas()).toEqual(before);
    });

    it('refuses MCPAQL activation without changing persisted session policies', async () => {
      await activate(1);
      const before = store.getActivations('persona');
      const activeBefore = manager.getActivePersonas().map(persona => persona.filename);
      const id = await createSkill(publicForeign);
      const result = await aql.handleRead({ operation: 'activate_element',
        params: { element_name: id, element_type: 'personas' } });
      // The AQL envelope reports dispatch success; refusal is in the activation response.
      expect(result.data).toMatchObject({ content: [expect.objectContaining({ text: expect.stringContaining('Persona not found') })] });
      await store.awaitPendingWrites();
      expect(store.getActivations('persona')).toEqual(before);
      expect(manager.getActivePersonas().map(persona => persona.filename)).toEqual(activeBefore);
      expect(await aql['getActiveElements'](sessionId)).toHaveLength(1);
    });
  });

  it.each([1, 10])('retains %i directly active persona policies after a refresh', async count => {
    await activate(count);
    const collected = await handler.getActiveElementsForPolicy({ allowCoalescing: false });
    expect(await manager.resolveActivePersonas()).toHaveLength(count);
    expect(collected).toHaveLength(count);
    for (const element of collected) expect(element.metadata.gatekeeper).toEqual(policy);
  });

  it.each([1, 10])('recovers %i persisted session policies through MCPAQL', async count => {
    await activate(count);
    // Exercise the actual session-id branch and real PostgreSQL activation store.
    const collected = await aql['getActiveElements'](sessionId);
    expect(collected).toHaveLength(count);
    for (const element of collected) expect(element.metadata.gatekeeper).toEqual(policy);
  });

  it('restores a persisted UUID activation in a fresh container without pruning it', async () => {
    const [name] = await activate(1);
    const restarted = await createIntegrationContainer();
    try {
      const fallback = restarted.container.resolve<IStorageLayerFactory>('StorageLayerFactory');
      restarted.container.register('UserIdResolver', () => () => userId);
      restarted.container.replace<IStorageLayerFactory>('StorageLayerFactory', () => ({
        createForElement: (type, options) => type === ElementType.PERSONA
          ? new DatabaseStorageLayer(getTestDb(), () => userId, type)
          : fallback.createForElement(type, options),
      }));
      const freshManager = restarted.container.resolve<PersonaManager>('PersonaManager');
      const restoredStore = new DatabaseActivationStateStore(getTestDb(), userId, sessionId);
      await restoredStore.initialize();
      const prune = jest.spyOn(restoredStore, 'removeStaleActivation');
      expect(freshManager.findPersona(name)).toBeUndefined();
      await restarted.container['restoreActivations'](restoredStore);
      await restoredStore.awaitPendingWrites();
      expect({ pruned: prune.mock.calls.length, active: freshManager.getActivePersonas().length })
        .toEqual({ pruned: 0, active: 1 });
      expect(restoredStore.getActivations('persona')).toHaveLength(1);
    } finally { await restarted.dispose(); }
  });
});
