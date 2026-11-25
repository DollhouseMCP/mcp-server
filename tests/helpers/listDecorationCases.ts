import { expect } from '@jest/globals';
import { createRealManagerSuite } from './di-mocks.js';
import { listElements } from '../../src/handlers/element-crud/listElements.js';
import type { ElementCrudContext } from '../../src/handlers/element-crud/types.js';
import { createElementQueryService } from '../../src/services/query/ElementQueryService.js';
import { ElementStatus } from '../../src/types/elements/index.js';

export const decoratedTypes = ['agents', 'skills', 'ensembles'] as const;

export async function verifyActiveListing(suite: ReturnType<typeof createRealManagerSuite>, type: typeof decoratedTypes[number]) {
  const manager = { agents: suite.agentManager, skills: suite.skillManager, ensembles: suite.ensembleManager }[type];
  const name = 'listing-active';
  const metadata = { name, description: 'Active listing fixture', instructions: 'Follow these detailed fixture instructions.' };
  if (type === 'agents') {
    expect((await suite.agentManager.create(name, metadata.description, metadata.instructions, {})).success).toBe(true);
  } else if (type === 'skills') {
    await suite.skillManager.create(metadata);
  } else {
    await suite.ensembleManager.create(metadata);
  }
  const activate = {
    agents: () => suite.agentManager.activateAgent(name),
    skills: () => suite.skillManager.activateSkill(name),
    ensembles: () => suite.ensembleManager.activateEnsemble(name),
  };
  const activated = await activate[type]();
  expect(activated.success).toBe(true);
  const original = await manager.findByName(name);
  manager.clearCache();
  // Legacy list() still decorates a newly hydrated instance.
  const legacy = await manager.list();
  expect(legacy).toHaveLength(1);
  expect(legacy[0]).not.toBe(original);
  expect(legacy[0].getStatus()).toBe(ElementStatus.ACTIVE);
  manager.clearCache();
  const context = { ...suite, ensureInitialized: async () => {},
    elementQueryService: createElementQueryService() } as unknown as ElementCrudContext;
  const result = await listElements(context, type, { filters: { status: 'active' } });
  expect(result).toMatchObject({ items: [{ name }], pagination: { totalItems: 1 }, complete: true });
  const report = await manager.listReport();
  expect(report.items).toHaveLength(1);
  expect(report.items[0]).not.toBe(legacy[0]);
  expect(report.items[0].getStatus()).toBe(ElementStatus.ACTIVE);
}

export async function disposeListingSuite(suite: ReturnType<typeof createRealManagerSuite>) {
  await Promise.all([suite.skillManager, suite.agentManager, suite.ensembleManager,
    suite.memoryManager, suite.personaManager, suite.templateManager].map(manager => manager.dispose()));
}
