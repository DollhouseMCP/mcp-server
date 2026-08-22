import { describe, expect, it, jest } from '@jest/globals';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import type { ElementWriteMetadata, WriteContentOptions } from '../../../src/storage/IStorageLayer.js';

let selectRows: () => Promise<readonly Record<string, unknown>[]>;
let selectCalls = 0;

jest.unstable_mockModule('../../../src/database/rls.js', () => ({
  withUserRead: async (
    _db: unknown,
    _userId: string,
    operation: (tx: unknown) => Promise<unknown>,
  ) => operation({
    select: () => {
      selectCalls += 1;
      const chain = {
        from: () => chain,
        where: () => selectRows(),
      };
      return chain;
    },
  }),
}));

const { AbstractDatabaseStorageLayer, canonicalNameKey } = await import(
  '../../../src/storage/AbstractDatabaseStorageLayer.js'
);

class TestDatabaseStorageLayer extends AbstractDatabaseStorageLayer {
  constructor(getUserId: () => string, maxUsers = 256) {
    super({} as DatabaseInstance, getUserId, 'skills', maxUsers);
  }

  publish(name: string, id: string): void {
    this.markDurableMutation();
    this.setIndex(name, id);
  }

  unpublish(name: string): void {
    this.markDurableMutation();
    this.removeIndex(name);
  }

  async writeContent(
    _elementType: string,
    _name: string,
    _content: string,
    _metadata: ElementWriteMetadata,
    _options?: WriteContentOptions,
  ): Promise<string> {
    return 'unused';
  }

  async deleteContent(): Promise<void> {}
}

function deferredRows() {
  let resolve!: (rows: readonly Record<string, unknown>[]) => void;
  const promise = new Promise<readonly Record<string, unknown>[]>(done => { resolve = done; });
  return { promise, resolve };
}

describe('AbstractDatabaseStorageLayer index publication', () => {
  it('normalizes database uniqueness aliases to one canonical key', () => {
    expect([
      'Meeting Notes',
      ' meeting_notes ',
      'MEETING---NOTES',
      '-meeting-notes-',
    ].map(canonicalNameKey)).toEqual(Array(4).fill('meeting-notes'));
  });

  it('fails a canonical alias lookup when legacy rows make it ambiguous', () => {
    const layer = new TestDatabaseStorageLayer(() => 'user-a');
    layer.publish('Meeting Notes', 'first-id');
    layer.publish('meeting_notes', 'second-id');

    expect(layer.getPathByName('Meeting Notes')).toBe('first-id');
    expect(layer.getPathByName('meeting_notes')).toBe('second-id');
    expect(layer.getPathByName('meeting-notes')).toBeUndefined();
  });

  it('does not use a lowercase shortcut to bypass a legacy canonical collision', () => {
    const layer = new TestDatabaseStorageLayer(() => 'user-a');
    layer.publish('meeting-notes', 'first-id');
    layer.publish('Meeting Notes', 'second-id');

    expect(layer.getPathByName('MEETING-NOTES')).toBeUndefined();
  });

  it('reports a same-layer deletion exactly once on the next scan', async () => {
    selectRows = () => Promise.resolve([{
      id: 'deleted-id',
      name: 'Deleted Element',
      contentHash: 'hash-a',
      updatedAt: new Date('2026-08-22T00:00:00.000Z'),
    }]);
    const layer = new TestDatabaseStorageLayer(() => 'user-a');
    await layer.scan();
    layer.unpublish('Deleted Element');
    selectRows = () => Promise.resolve([]);

    await expect(layer.scan()).resolves.toMatchObject({ removed: ['deleted-id'] });
    await expect(layer.scan()).resolves.toMatchObject({ removed: [] });
  });

  it('coalesces concurrent scans for one user', async () => {
    selectCalls = 0;
    const pending = deferredRows();
    selectRows = () => pending.promise;
    const layer = new TestDatabaseStorageLayer(() => 'user-a');

    const first = layer.scan();
    const second = layer.scan();
    expect(selectCalls).toBe(1);
    pending.resolve([{
      id: 'element-a',
      name: 'Element A',
      contentHash: 'hash-a',
      updatedAt: new Date('2026-08-22T00:00:00.000Z'),
    }]);

    await expect(first).resolves.toEqual(await second);
    expect(layer.getPathByName('element-a')).toBe('element-a');
  });

  it('retries an older scan generation without overwriting a newer mutation', async () => {
    selectCalls = 0;
    const stale = deferredRows();
    const current = deferredRows();
    selectRows = () => selectCalls === 1 ? stale.promise : current.promise;
    const layer = new TestDatabaseStorageLayer(() => 'user-a');

    const staleScan = layer.scan();
    layer.publish('newer-element', 'newer-id');
    stale.resolve([]);
    await new Promise(resolve => setImmediate(resolve));
    expect(selectCalls).toBe(2);
    current.resolve([
      {
        id: 'older-id',
        name: 'Older Element',
        contentHash: 'hash-a',
        updatedAt: new Date('2026-08-22T00:00:00.000Z'),
      },
      {
        id: 'newer-id',
        name: 'Newer Element',
        contentHash: 'hash-b',
        updatedAt: new Date('2026-08-22T00:00:01.000Z'),
      },
    ]);
    await expect(staleScan).resolves.toMatchObject({ added: ['older-id', 'newer-id'] });

    expect(layer.getPathByName('newer-element')).toBe('newer-id');
    expect(layer.getPathByName('older-element')).toBe('older-id');
    expect(layer.hasCompletedScan()).toBe(true);
  });

  it('bounds per-user index state with least-recently-used eviction', () => {
    let userId = 'user-0';
    const layer = new TestDatabaseStorageLayer(() => userId, 3);
    for (let index = 0; index < 20; index += 1) {
      userId = `user-${index}`;
      layer.getPathByName('missing');
    }

    expect(layer.indexStateCountForTesting()).toBeLessThanOrEqual(3);
  });

  it('keeps the per-user index bounded while every evicted state is still scanning', async () => {
    const pending = deferredRows();
    selectRows = () => pending.promise;
    let userId = 'user-0';
    const layer = new TestDatabaseStorageLayer(() => userId, 3);
    const scans: Promise<unknown>[] = [];

    for (let index = 0; index < 20; index += 1) {
      userId = `user-${index}`;
      scans.push(layer.scan());
      expect(layer.indexStateCountForTesting()).toBeLessThanOrEqual(3);
    }

    pending.resolve([]);
    await Promise.all(scans);
    expect(layer.indexStateCountForTesting()).toBeLessThanOrEqual(3);
  });

  it('returns and retains an active scan result after another user evicts its cached state', async () => {
    selectCalls = 0;
    const userAPending = deferredRows();
    selectRows = () => selectCalls === 1 ? userAPending.promise : Promise.resolve([]);
    let userId = 'user-a';
    const layer = new TestDatabaseStorageLayer(() => userId, 1);

    const userAPaths = layer.getIndexedPaths();
    userId = 'user-b';
    await layer.scan();
    expect(layer.indexStateCountForTesting()).toBe(1);

    userId = 'user-a';
    const coalescedScan = layer.scan();
    expect(selectCalls).toBe(2);
    userAPending.resolve([{
      id: 'element-a',
      name: 'Element A',
      contentHash: 'hash-a',
      updatedAt: new Date('2026-08-22T00:00:00.000Z'),
    }]);

    await expect(userAPaths).resolves.toEqual(['element-a']);
    await expect(coalescedScan).resolves.toMatchObject({ added: ['element-a'] });
    expect(layer.getPathByName('element-a')).toBe('element-a');
    expect(layer.indexStateCountForTesting()).toBe(1);
  });

  it('fails a continuously invalidated manifest scan after bounded retries', async () => {
    selectCalls = 0;
    const layer = new TestDatabaseStorageLayer(() => 'user-a');
    selectRows = async () => {
      layer.publish(`mutation-${selectCalls}`, `mutation-${selectCalls}`);
      return [];
    };

    await expect(layer.scan()).rejects.toThrow('4 consecutive scan attempts');
    expect(selectCalls).toBe(4);
    expect(layer.hasCompletedScan()).toBe(false);
  });

  it('does not let an in-flight scan republish state after clear', async () => {
    selectCalls = 0;
    const pending = deferredRows();
    selectRows = () => pending.promise;
    const layer = new TestDatabaseStorageLayer(() => 'user-a');

    const scan = layer.scan();
    layer.clear();
    pending.resolve([{
      id: 'stale-id',
      name: 'Stale Element',
      contentHash: 'stale-hash',
      updatedAt: new Date('2026-08-22T00:00:00.000Z'),
    }]);

    await expect(scan).resolves.toEqual({ added: [], modified: [], removed: [], unchanged: [] });
    expect(layer.getPathByName('stale-element')).toBeUndefined();
    expect(layer.hasCompletedScan()).toBe(false);
  });
});
