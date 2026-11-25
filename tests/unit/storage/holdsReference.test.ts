/**
 * IStorageLayer.holdsReference on both layers: true for a record of the exact reference of any
 * status (indexed, failed; a known row id), false once the index is settled and holds no record
 * of it, and undefined while the index is cold or invalidated, when the layer cannot say.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';

const TEST_USER = '11111111-1111-4111-8111-111111111111';
const ROW = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455';

describe('holdsReference', () => {
  it('on files: any record holds, a settled index answers no, a cold or invalidated one cannot say', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'holds-reference-'));
    const suite = createRealManagerSuite(root);
    try {
      const memories = suite.memoryManager;
      const dir = (memories as any)['memoriesDir'];
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'good.yaml'), 'name: good\ndescription: d\nentries: []\n');
      await writeFile(path.join(dir, 'broken.yaml'), 'name: [unclosed\n  : : :\n');
      const layer = (memories as any)['storageLayer'];
      expect(layer.holdsReference('good.yaml')).toBeUndefined();
      await memories.listReport();
      expect([layer.holdsReference('good.yaml'), layer.holdsReference('broken.yaml'), layer.holdsReference('absent.yaml')])
        .toEqual([true, true, false]);
      layer.invalidate();
      expect(layer.holdsReference('absent.yaml')).toBeUndefined();
      expect(layer.holdsReference('good.yaml')).toBe(true);
    } finally {
      await Promise.all([suite.memoryManager.dispose(), suite.skillManager.dispose()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('on the database: a known row id holds, a completed scan answers no, before any scan it cannot say', () => {
    const layer = new DatabaseStorageLayer({ transaction: jest.fn() } as never, () => TEST_USER, 'skills');
    expect(layer.holdsReference(ROW)).toBeUndefined();
    const state = (layer as any).getState();
    state.scanCompleted = true;
    state.lastScanTimestamp = new Date();
    expect(layer.holdsReference(ROW)).toBe(false);
    state.idToNameMap.set(ROW, 'Known Row');
    expect(layer.holdsReference(ROW)).toBe(true);
    state.lastScanTimestamp = null;
    expect(layer.holdsReference('11111111-2222-4333-8444-555555555555')).toBeUndefined();
  });

  it('observes a warm database miss with one incremental scan, returning what it applied; a cold index is left to the caller', async () => {
    const layer = new DatabaseStorageLayer({ transaction: jest.fn() } as never, () => TEST_USER, 'skills');
    const scanRows = jest.spyOn(layer as any, 'scanRows');
    await expect(layer.observeCollectionChange()).resolves.toEqual({ changed: false });
    expect(scanRows).not.toHaveBeenCalled();
    const state = (layer as any).getState();
    state.scanCompleted = true;
    state.lastScanTimestamp = new Date();
    const added = { added: [ROW], modified: [], removed: [], unchanged: [] };
    const modified = { added: [], modified: [ROW], removed: [], unchanged: [] };
    const none = { added: [], modified: [], removed: [], unchanged: [] };
    scanRows.mockResolvedValueOnce(added as never).mockResolvedValueOnce(modified as never).mockResolvedValueOnce(none as never);
    await expect(layer.observeCollectionChange()).resolves.toEqual({ changed: true, diff: added });
    await expect(layer.observeCollectionChange()).resolves.toEqual({ changed: true, diff: modified });
    await expect(layer.observeCollectionChange()).resolves.toEqual({ changed: false, diff: none });
    expect(scanRows.mock.calls).toEqual([[false], [false], [false]]);
  });
});
