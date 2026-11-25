import { afterAll, describe, expect, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { decoratedTypes, disposeListingSuite, verifyActiveListing } from '../../helpers/listDecorationCases.js';
import { DatabaseStorageLayerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import { cleanupAllTestData, closeTestDb, ensureTestUser, fixedUserId, getTestDb } from './test-db-helpers.js';

import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../../src/elements/memories/Memory.js';
import { MemoryUpgradeLifecycle } from '../../../src/lifecycle/MemoryUpgradeLifecycle.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';

afterAll(closeTestDb);

describe('list report decoration on database rows', () => {
  it('uses database caller names for a fenced fresh memory mutation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fresh-memory-database-'));
    const user = fixedUserId(await ensureTestUser());
    const storageLayerFactory = new DatabaseStorageLayerFactory(getTestDb(), user);
    const suite = createRealManagerSuite(root, { storageLayerFactory });
    const manager = new MemoryManager({ ...suite, storageLayerFactory, getCurrentUserId: user,
      eventDispatcher: new ElementEventDispatcher(), memoryUpgradeLifecycle: new MemoryUpgradeLifecycle() });
    try {
      await manager.save(new Memory({ name: 'readme', description: 'Database caller aliases' }, suite.metadataService), 'readme.yaml');
      await expect(manager.runFreshMemoryMutation('readme.yaml', async memory => memory.metadata.name)).resolves.toBe('readme');
    } finally {
      await manager.dispose();
      await disposeListingSuite(suite);
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });

  it.each(decoratedTypes)('keeps active %s in list_elements after eviction', async type => {
    const root = await mkdtemp(path.join(tmpdir(), 'listed-database-'));
    const user = fixedUserId(await ensureTestUser());
    const suite = createRealManagerSuite(root, { storageLayerFactory: new DatabaseStorageLayerFactory(getTestDb(), user) });
    try { await verifyActiveListing(suite, type); }
    finally {
      await disposeListingSuite(suite);
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });
});
