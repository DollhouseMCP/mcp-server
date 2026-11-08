import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { disposeListingSuite } from '../../helpers/listDecorationCases.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { deleteElement } from '../../../src/handlers/element-crud/deleteElement.js';
import type { ElementCrudContext } from '../../../src/handlers/element-crud/types.js';
import { ManagerBackedPortfolioElementStore } from '../../../src/web-console/stores/ManagerBackedPortfolioElementStore.js';

const userId = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
afterEach(() => { jest.restoreAllMocks(); });

describe('per-type audit across deletion entry points', () => {
  it.each((['templates', 'ensembles'] as const).flatMap(type =>
    (['handler', 'console', 'legacy'] as const).map(route => ({ type, route }))))('audits $type once through $route delete', async ({ type, route }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'delete-audit-'));
    const suite = createRealManagerSuite(root);
    const manager = type === 'templates' ? suite.templateManager : suite.ensembleManager;
    const store = new ManagerBackedPortfolioElementStore({ managers: {
      personas: suite.personaManager, skills: suite.skillManager, templates: suite.templateManager,
      agents: suite.agentManager, memories: suite.memoryManager, ensembles: suite.ensembleManager,
    }, getCurrentUserId: () => userId });
    const context = { ...suite, fileOperations: suite.fileOperationsService,
      getManagerForType: () => manager, ensureInitialized: async () => {} } as unknown as ElementCrudContext;
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    const eventType = type === 'templates' ? 'TEMPLATE_DELETED' : 'ENSEMBLE_DELETED';
    const create = async (name: string) => manager.create({ name, description: 'Deletion audit fixture',
      content: 'Template content', instructions: 'Follow the fixture instructions.' });
    const count = () => audit.mock.calls.filter(([event]) => event.type === eventType).length;
    try {
      const name = 'audit-delete';
      await create(name);
      const reference = (await manager.resolveDeletionTarget(name)).storageIdentity;
      if (route === 'handler') {
        expect((await deleteElement(context, { name, type })).content[0].text).not.toContain('❌');
      } else if (route === 'console') {
        const existing = await store.findByName(userId, type, name);
        expect(await store.delete({ userId, type, canonicalName: name,
          expectedVersion: existing!.version, expectedContentHash: existing!.contentHash, now: new Date() })).not.toBeNull();
      } else {
        await manager.delete(reference);
      }
      expect(count()).toBe(1);
      const details = audit.mock.calls.find(([event]) => event.type === eventType)![0].details;
      expect(details).toBe(type === 'templates'
        ? `Template deleted: ${path.basename(reference)}`
        : `Successfully deleted ensemble: ${reference}`);
    } finally { await disposeListingSuite(suite); await rm(root, { recursive: true, force: true }); }
  });
});
