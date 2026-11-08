import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { disposeListingSuite } from '../../helpers/listDecorationCases.js';
import type { IElementManager } from '../../../src/types/elements/IElementManager.js';
import type { IElement } from '../../../src/types/elements/IElement.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { DatabaseStorageLayerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import { cleanupAllTestData, closeTestDb, ensureTestUser, fixedUserId, getTestDb } from './test-db-helpers.js';

afterAll(closeTestDb);
afterEach(() => { jest.restoreAllMocks(); });

describe('database deletion audit labels', () => {
  it.each(['templates', 'ensembles'] as const)('retains the name and row identity when deleting %s', async type => {
    const root = await mkdtemp(path.join(tmpdir(), 'database-delete-audit-'));
    const user = fixedUserId(await ensureTestUser());
    const suite = createRealManagerSuite(root, { storageLayerFactory: new DatabaseStorageLayerFactory(getTestDb(), user) });
    const manager = type === 'templates' ? suite.templateManager : suite.ensembleManager;
    const deletionManager: IElementManager<IElement> = manager;
    const name = 'named-audit-target';
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    try {
      await manager.create({ name, description: 'Deletion audit fixture', content: 'Template content',
        instructions: 'Follow the fixture instructions.' });
      const target = await manager.resolveDeletionTarget(name);
      expect(target.storageIdentity).toMatch(/^[0-9a-f-]{36}$/u);
      await deletionManager.deleteResolved(target);
      const eventType = type === 'templates' ? 'TEMPLATE_DELETED' : 'ENSEMBLE_DELETED';
      const events = audit.mock.calls.map(([event]) => event).filter(event => event.type === eventType);
      expect(events).toHaveLength(1);
      expect(events[0].details).toContain(name);
      expect(events[0].details).toContain(target.storageIdentity);
    } finally {
      await disposeListingSuite(suite);
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });
});
