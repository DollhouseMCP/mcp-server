import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { DatabaseInstance } from '../../../src/database/connection.js';

let transaction: Record<string, jest.Mock>;

jest.unstable_mockModule('../../../src/database/rls.js', () => ({
  withUserContext: async (
    _db: unknown,
    _userId: string,
    operation: (tx: Record<string, jest.Mock>) => Promise<unknown>,
  ) => operation(transaction),
  withUserRead: async (
    _db: unknown,
    _userId: string,
    operation: (tx: Record<string, jest.Mock>) => Promise<unknown>,
  ) => operation(transaction),
}));

const { DatabaseMemoryStorageLayer } = await import(
  '../../../src/storage/DatabaseMemoryStorageLayer.js'
);
type MemoryStorageRevision = import(
  '../../../src/storage/DatabaseMemoryStorageLayer.js'
).MemoryStorageRevision;

const USER_ID = '00000000-0000-4000-8000-000000000001';
const MEMORY_ID = '00000000-0000-4000-8000-000000000002';

function parentSelect(rows: readonly unknown[] = [{
  id: MEMORY_ID,
  name: 'shared-memory',
  rawContent: 'metadata:\n  name: shared-memory\nentries: []\n',
}]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.for = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function entryInsert() {
  const chain: Record<string, jest.Mock> = {};
  chain.values = jest.fn(() => chain);
  chain.onConflictDoUpdate = jest.fn(() => Promise.resolve());
  return chain;
}

function entryRowsSelect(rows: readonly unknown[] = []) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function rowSelect(rows: readonly unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function elementUpdate(rows: readonly unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.set = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.returning = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function capturingElementUpdate(rows: readonly unknown[] = [{ id: MEMORY_ID }]) {
  const chain = elementUpdate(rows);
  let values: Record<string, unknown> | undefined;
  chain.set.mockImplementation((next: Record<string, unknown>) => {
    values = next;
    return chain;
  });
  return { chain, values: () => values };
}

function groupedMemorySelect(rows: readonly unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.groupBy = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function entryDelete(returningRows?: readonly unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.where = jest.fn(() => chain);
  if (returningRows) {
    chain.returning = jest.fn(() => Promise.resolve(returningRows));
  } else {
    chain.then = (resolve: (value: undefined) => void) => Promise.resolve(undefined).then(resolve);
  }
  return chain;
}

function elementDelete(rows: readonly unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.where = jest.fn(() => chain);
  chain.returning = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function collectSqlParameterValues(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (value === null || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  const record = value as Record<string, unknown>;
  const ownValue = Object.prototype.hasOwnProperty.call(record, 'value') ? [record.value] : [];
  return ownValue.concat(
    Object.values(record).flatMap(child => collectSqlParameterValues(child, seen)),
  );
}

describe('DatabaseMemoryStorageLayer mutation serialization', () => {
  beforeEach(() => {
    transaction = {};
    transaction.update = jest.fn(() => elementUpdate([{ id: MEMORY_ID }]));
  });

  it('claims the parent element row before an entry-level upsert', async () => {
    const select = parentSelect();
    const insert = entryInsert();
    const normalizedEntry = {
      entryId: 'entry-1',
      timestamp: new Date('2026-08-21T12:00:00.000Z'),
      content: 'serialized child write',
      sanitizedContent: null,
      sanitizedPatterns: {},
      tags: [],
      entryMetadata: {},
      privacyLevel: null,
      trustLevel: 'untrusted',
      source: null,
      expiresAt: null,
    };
    const normalizedRows = entryRowsSelect([normalizedEntry]);
    const update = capturingElementUpdate();
    transaction.select = jest.fn()
      .mockReturnValueOnce(select)
      .mockReturnValueOnce(normalizedRows);
    transaction.insert = jest.fn(() => insert);
    transaction.update = jest.fn(() => update.chain);
    const layer = new DatabaseMemoryStorageLayer({} as DatabaseInstance, () => USER_ID);

    await layer.addEntry(MEMORY_ID, {
      entryId: 'entry-1',
      timestamp: new Date('2026-08-21T12:00:00.000Z'),
      content: 'serialized child write',
    });

    expect(select.for).toHaveBeenCalledWith('update');
    expect(normalizedRows.orderBy).toHaveBeenCalledWith(expect.anything(), expect.anything());
    expect(select.for.mock.invocationCallOrder[0]).toBeLessThan(transaction.insert.mock.invocationCallOrder[0]);
    expect(update.values()?.rawContent).toContain('serialized child write');
    expect(update.values()?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(update.values()?.byteSize).toBe(Buffer.byteLength(update.values()?.rawContent as string, 'utf8'));
  });

  it('removes an entry and rewrites the parent revision from remaining normalized rows', async () => {
    const update = capturingElementUpdate();
    transaction.select = jest.fn()
      .mockReturnValueOnce(parentSelect([{
        id: MEMORY_ID,
        name: 'shared-memory',
        rawContent: 'metadata:\n  name: shared-memory\nentries:\n  - id: removed\n    content: old\n',
      }]))
      .mockReturnValueOnce(entryRowsSelect([{
        entryId: 'remaining',
        timestamp: new Date('2026-08-21T12:00:00.000Z'),
        content: 'keep me',
        sanitizedContent: null,
        sanitizedPatterns: {},
        tags: [],
        entryMetadata: {},
        privacyLevel: null,
        trustLevel: 'untrusted',
        source: null,
        expiresAt: null,
      }]));
    transaction.delete = jest.fn(() => entryDelete());
    transaction.update = jest.fn(() => update.chain);
    const layer = new DatabaseMemoryStorageLayer({} as DatabaseInstance, () => USER_ID);

    await layer.removeEntry(MEMORY_ID, 'removed');

    expect(transaction.select.mock.results[0].value.for).toHaveBeenCalledWith('update');
    expect(update.values()?.rawContent).toContain('keep me');
    expect(update.values()?.rawContent).not.toContain('content: old');
  });

  it('locks every affected parent and advances its revision while purging expired entries', async () => {
    const update = capturingElementUpdate();
    transaction.select = jest.fn()
      .mockReturnValueOnce(groupedMemorySelect([{ memoryId: MEMORY_ID }]))
      .mockReturnValueOnce(parentSelect())
      .mockReturnValueOnce(entryRowsSelect([]));
    transaction.delete = jest.fn(() => entryDelete([{ id: 'expired-row' }]));
    transaction.update = jest.fn(() => update.chain);
    const layer = new DatabaseMemoryStorageLayer({} as DatabaseInstance, () => USER_ID);

    await expect(layer.purgeExpiredEntries()).resolves.toBe(1);

    expect(transaction.select.mock.results[0].value.orderBy).toHaveBeenCalledTimes(1);
    expect(transaction.select.mock.results[1].value.for).toHaveBeenCalledWith('update');
    expect(update.values()?.rawContent).toContain('entries: []');
    expect(update.values()?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not create an orphan entry when the parent disappeared', async () => {
    transaction.select = jest.fn(() => parentSelect([]));
    transaction.insert = jest.fn();
    const layer = new DatabaseMemoryStorageLayer({} as DatabaseInstance, () => USER_ID);

    await expect(layer.addEntry(MEMORY_ID, {
      entryId: 'entry-1',
      timestamp: new Date('2026-08-21T12:00:00.000Z'),
      content: 'must not persist',
    })).rejects.toThrow('was not found');
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('rejects a stale full-document save instead of overwriting another replica', async () => {
    const original = 'name: shared-memory\ndescription: original\nentries: []\n';
    const read = rowSelect([{
      rawContent: original,
      contentHash: 'original-hash',
      name: 'shared-memory',
      userId: USER_ID,
    }]);
    const update = elementUpdate([]);
    transaction.select = jest.fn(() => read);
    transaction.update = jest.fn(() => update);
    transaction.insert = jest.fn();
    const layer = new DatabaseMemoryStorageLayer({} as DatabaseInstance, () => USER_ID);

    const loaded = await layer.runWithRevisionTracking(() => layer.readContent(MEMORY_ID));
    expect(loaded.result).toBe(original);
    await expect(layer.runWithRevisionTracking(
      () => layer.writeContent(
        'memories',
        'shared-memory',
        'name: shared-memory\ndescription: stale replacement\nentries: []\n',
        { author: '', version: '1.0.0', description: '', tags: [] },
      ),
      loaded.revision,
    )).rejects.toMatchObject({ code: 'MEMORY_PERSISTENCE_CONFLICT' });

    expect(transaction.update).toHaveBeenCalledTimes(1);
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('rejects a stale delete instead of removing a newer replica save', async () => {
    const original = 'name: shared-memory\ndescription: original\nentries: []\n';
    transaction.select = jest.fn(() => rowSelect([{
      rawContent: original,
      contentHash: 'original-hash',
      name: 'shared-memory',
      userId: USER_ID,
    }]));
    transaction.delete = jest.fn(() => elementDelete([]));
    const layer = new DatabaseMemoryStorageLayer({} as DatabaseInstance, () => USER_ID);

    await expect(layer.runWithRevisionTracking(async () => {
      await layer.readContent(MEMORY_ID);
      await layer.deleteContent('memories', 'shared-memory');
    }))
      .rejects.toMatchObject({ code: 'MEMORY_PERSISTENCE_CONFLICT' });
  });

  it('keeps CAS revisions attached to each loaded instance', async () => {
    const original = 'name: shared-memory\ndescription: original\nentries: []\n';
    const revised = 'name: shared-memory\ndescription: revised\nentries: []\n';
    const readA = rowSelect([{
      rawContent: original,
      contentHash: 'revision-a',
      name: 'shared-memory',
      userId: USER_ID,
    }]);
    const readB = rowSelect([{
      rawContent: revised,
      contentHash: 'revision-b',
      name: 'shared-memory',
      userId: USER_ID,
    }]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(readA)
      .mockReturnValueOnce(readB);
    const layer = new DatabaseMemoryStorageLayer({} as DatabaseInstance, () => USER_ID);

    const loadedA = await layer.runWithRevisionTracking(() => layer.readContent(MEMORY_ID));
    const loadedB = await layer.runWithRevisionTracking(() => layer.readContent(MEMORY_ID));

    expect(loadedA.revision).toMatchObject({ contentHash: 'revision-a', userId: USER_ID });
    expect(loadedB.revision).toMatchObject({ contentHash: 'revision-b', userId: USER_ID });
    expect(loadedA.revision).not.toBe(loadedB.revision);
  });

  it('does not let one loaded instance inherit another instance\'s successful CAS', async () => {
    const original = 'name: shared-memory\ndescription: original\nentries: []\n';
    const readRow = {
      rawContent: original,
      contentHash: 'original-hash',
      name: 'shared-memory',
      userId: USER_ID,
    };
    let currentHash = readRow.contentHash;
    let pendingHash = currentHash;
    let pendingName = readRow.name;

    transaction.select = jest.fn()
      .mockReturnValueOnce(rowSelect([readRow]))
      .mockReturnValueOnce(rowSelect([readRow]))
      .mockReturnValue(parentSelect([{ id: MEMORY_ID }]));
    transaction.update = jest.fn(() => {
      const chain: Record<string, jest.Mock> = {};
      let matchesCurrentRevision = false;
      chain.set = jest.fn((values: Record<string, unknown>) => {
        pendingHash = values.contentHash as string;
        pendingName = values.name as string;
        return chain;
      });
      chain.where = jest.fn((condition: unknown) => {
        matchesCurrentRevision = collectSqlParameterValues(condition).includes(currentHash);
        return chain;
      });
      chain.returning = jest.fn(async () => {
        if (!matchesCurrentRevision) return [];
        currentHash = pendingHash;
        return [{ id: MEMORY_ID }];
      });
      return chain;
    });
    transaction.delete = jest.fn(() => ({ where: jest.fn(async () => undefined) }));
    const layer = new DatabaseMemoryStorageLayer({} as DatabaseInstance, () => USER_ID);

    const loadedA = await layer.runWithRevisionTracking(() => layer.readContent(MEMORY_ID));
    const loadedB = await layer.runWithRevisionTracking(() => layer.readContent(MEMORY_ID));
    await expect(layer.runWithRevisionTracking(
      () => layer.writeContent(
        'memories',
        'renamed-memory',
        'name: renamed-memory\ndescription: writer A\nentries: []\n',
        { author: '', version: '1.0.0', description: '', tags: [] },
      ),
      loadedA.revision,
    )).resolves.toMatchObject({ result: MEMORY_ID });
    expect(pendingName).toBe('renamed-memory');

    await expect(layer.runWithRevisionTracking(
      () => layer.writeContent(
        'memories',
        'shared-memory',
        'name: shared-memory\ndescription: stale writer B\nentries: []\n',
        { author: '', version: '1.0.0', description: '', tags: [] },
      ),
      loadedB.revision,
    )).rejects.toMatchObject({ code: 'MEMORY_PERSISTENCE_CONFLICT' });
  });

  it('rejects a revision token under a different current user', async () => {
    let currentUserId = USER_ID;
    transaction.update = jest.fn();
    const layer = new DatabaseMemoryStorageLayer(
      {} as DatabaseInstance,
      () => currentUserId,
    );
    const aliceRevision: MemoryStorageRevision = {
      userId: USER_ID,
      elementId: MEMORY_ID,
      name: 'shared-memory',
      contentHash: 'alice-hash',
    };
    currentUserId = '00000000-0000-4000-8000-000000000099';

    await expect(layer.runWithRevisionTracking(
      () => layer.writeContent(
        'memories',
        'shared-memory',
        'name: shared-memory\nentries: []\n',
        { author: '', version: '1.0.0', description: '', tags: [] },
      ),
      aliceRevision,
    )).rejects.toMatchObject({ code: 'MEMORY_PERSISTENCE_CONFLICT' });
    expect(transaction.update).not.toHaveBeenCalled();
  });
});
