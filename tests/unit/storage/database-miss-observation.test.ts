/**
 * The database miss observation (observeCollectionChange) is the incremental scan a listing makes.
 * The rows it applies are evicted through the one eviction rule, so a cached copy never outlives an
 * edit it observed: list, external edit, a warm miss, then list serves the edited row.
 */
import { describe, expect, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { FAKE_DATABASE_USER, fakeDatabase, skillBody, type FakeRow } from '../../helpers/fakeDatabase.js';

const ID1 = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455';
const ID2 = '6f1c2d3e-4a5b-4c6d-8e7f-001122334466';
const pause = () => new Promise(resolve => setTimeout(resolve, 10));

describe('database miss observation', () => {
  it.each([false, true])('a later list serves another process\'s edit (warm miss in between: %s)', async missFirst => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'database-miss-observation-'));
    const rows: FakeRow[] = [
      { id: ID1, name: 'Alpha', description: 'v1', rawContent: skillBody('Alpha', 'v1'), updatedAt: new Date(Date.now() - 60_000) },
      { id: ID2, name: 'Beta', description: 'b', rawContent: skillBody('Beta', 'b'), updatedAt: new Date(Date.now() - 60_000) },
    ];
    const log: string[] = [];
    const db = fakeDatabase(rows, log);
    const factory = { createForElement: (type: string) => new DatabaseStorageLayer(db as never, () => FAKE_DATABASE_USER, type) };
    const suite = createRealManagerSuite(root, { storageLayerFactory: factory as never });
    const skills = suite.skillManager;
    const describeAll = async () => (await skills.list()).map(skill => `${skill.metadata.name}:${skill.metadata.description}`).sort();
    try {
      expect(await describeAll()).toEqual(['Alpha:v1', 'Beta:b']);
      rows[0].rawContent = skillBody('Alpha', 'v2-edited');
      rows[0].description = 'v2-edited';
      await pause();
      rows[0].updatedAt = new Date();
      await pause();
      if (missFirst) await expect(skills.findByName('Nonexistent')).resolves.toBeUndefined();
      expect(await describeAll()).toEqual(['Alpha:v2-edited', 'Beta:b']);
      expect((await skills.findByName('Alpha'))?.metadata.description).toBe('v2-edited');
    } finally {
      await Promise.all([skills.dispose(), suite.memoryManager.dispose()]);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
