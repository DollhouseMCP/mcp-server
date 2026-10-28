import { describe, expect, it, jest } from '@jest/globals';

import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';

describe('DatabaseStorageLayer identity delete retries', () => {
  it('keeps legacy deleteContent a no-op when the row is missing or hidden by RLS', async () => {
    const layer = new DatabaseStorageLayer(
      {} as never,
      () => '11111111-1111-4111-8111-111111111111',
      'skills',
    );
    const notFound = Object.assign(new Error('Element not found'), { code: 'ENOENT' });
    jest.spyOn(layer, 'deleteContentByIdentity').mockRejectedValue(notFound);

    await expect(layer.deleteContent('skills', 'protected-skill')).resolves.toBeUndefined();
  });

  it('does not hide failures other than a missing or RLS-hidden row', async () => {
    const layer = new DatabaseStorageLayer(
      {} as never,
      () => '11111111-1111-4111-8111-111111111111',
      'skills',
    );
    const stale = Object.assign(new Error('Identity changed'), { code: 'ESTALE' });
    jest.spyOn(layer, 'deleteContentByIdentity').mockRejectedValue(stale);

    await expect(layer.deleteContent('skills', 'protected-skill'))
      .rejects.toMatchObject({ code: 'ESTALE' });
  });

  it('bounds serialization retries and returns a typed retryable error', async () => {
    const serializationFailure = Object.assign(new Error('could not serialize access'), {
      code: '40001',
    });
    const transaction = jest.fn<() => Promise<never>>()
      .mockRejectedValue(serializationFailure);
    const layer = new DatabaseStorageLayer(
      { transaction } as never,
      () => '11111111-1111-4111-8111-111111111111',
      'skills',
    );

    await expect(layer.deleteContentByIdentity('skills', 'retry-me'))
      .rejects.toMatchObject({ code: 'EAGAIN', retryable: true });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('retries PostgreSQL deadlocks and returns the same typed retryable error', async () => {
    const deadlockFailure = Object.assign(new Error('deadlock detected'), {
      code: '40P01',
    });
    const transaction = jest.fn<() => Promise<never>>()
      .mockRejectedValue(deadlockFailure);
    const layer = new DatabaseStorageLayer(
      { transaction } as never,
      () => '11111111-1111-4111-8111-111111111111',
      'skills',
    );

    await expect(layer.deleteContentByIdentity('skills', 'retry-me'))
      .rejects.toMatchObject({ code: 'EAGAIN', retryable: true });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('recognizes retryable SQLSTATE codes wrapped by Drizzle query errors', async () => {
    const wrappedFailure = new Error('Failed query', {
      cause: Object.assign(new Error('could not serialize access'), { code: '40001' }),
    });
    const transaction = jest.fn<() => Promise<never>>()
      .mockRejectedValue(wrappedFailure);
    const layer = new DatabaseStorageLayer(
      { transaction } as never,
      () => '11111111-1111-4111-8111-111111111111',
      'skills',
    );

    await expect(layer.deleteContentByIdentity('skills', 'retry-me'))
      .rejects.toMatchObject({ code: 'EAGAIN', retryable: true });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('continues through wrappers whose code is not a SQLSTATE string', async () => {
    const wrappedFailure = Object.assign(new Error('Failed query', {
      cause: Object.assign(new Error('could not serialize access'), { code: '40001' }),
    }), { code: undefined });
    const transaction = jest.fn<() => Promise<never>>()
      .mockRejectedValue(wrappedFailure);
    const layer = new DatabaseStorageLayer(
      { transaction } as never,
      () => '11111111-1111-4111-8111-111111111111',
      'skills',
    );

    await expect(layer.deleteContentByIdentity('skills', 'retry-me'))
      .rejects.toMatchObject({ code: 'EAGAIN', retryable: true });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('bounds and evicts whole per-user index states by least-recent use', () => {
    let currentUser = '00000000-0000-4000-8000-000000000000';
    const layer = new DatabaseStorageLayer(
      {} as never,
      () => currentUser,
      'skills',
    );
    const indexStates = (layer as unknown as {
      indexStates: Map<string, {
        nameToIdMap: Map<string, string>;
        idToNameMap: Map<string, string>;
        lastScanTimestamp: Date | null;
        scanCompleted: boolean;
      }>;
    }).indexStates;

    layer.getPathByName('seed');
    const firstState = indexStates.get(currentUser);
    expect(firstState).toBeDefined();
    firstState?.nameToIdMap.set('seed', 'seed-id');
    firstState?.idToNameMap.set('seed-id', 'seed');
    if (firstState) {
      firstState.lastScanTimestamp = new Date('2026-09-03T00:00:00.000Z');
      firstState.scanCompleted = true;
    }

    for (let index = 1; index <= 256; index += 1) {
      currentUser = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      layer.getPathByName('missing');
    }

    expect(indexStates.size).toBe(256);
    expect(indexStates.has('00000000-0000-4000-8000-000000000000')).toBe(false);
    expect([...indexStates.values()]).not.toContain(firstState);
    expect([...indexStates.values()].some(state =>
      state.nameToIdMap.has('seed')
      || state.idToNameMap.has('seed-id')
      || state.lastScanTimestamp?.toISOString() === '2026-09-03T00:00:00.000Z'
      || state.scanCompleted
    )).toBe(false);
  });

  it('does not evict an index state while an operation holds its lease', () => {
    let currentUser = '00000000-0000-4000-8000-000000000000';
    const layer = new DatabaseStorageLayer({} as never, () => currentUser, 'skills');
    const internals = layer as unknown as {
      acquireState(userId: string): { activeOperations: number };
      releaseState(state: { activeOperations: number }): void;
      indexStates: Map<string, { activeOperations: number }>;
    };
    const leasedState = internals.acquireState(currentUser);

    for (let index = 1; index <= 256; index += 1) {
      currentUser = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      layer.getPathByName('missing');
    }

    expect(internals.indexStates.get('00000000-0000-4000-8000-000000000000'))
      .toBe(leasedState);
    internals.releaseState(leasedState);
    currentUser = '00000000-0000-4000-8000-000000000257';
    layer.getPathByName('missing');
    expect(internals.indexStates.has('00000000-0000-4000-8000-000000000000')).toBe(false);
  });
});

describe('DatabaseStorageLayer indexed reads', () => {
  function fixture() {
    const rows = [
      { id: 'exact-id', name: 'Agent_Name', updatedAt: new Date() },
      { id: 'sibling-id', name: 'agent-name', updatedAt: new Date() },
      { id: 'canonical-id', name: 'Meeting Notes', updatedAt: new Date() },
    ];
    const where = jest.fn<() => Promise<typeof rows>>().mockResolvedValue(rows);
    const select = jest.fn(() => ({ from: jest.fn(() => ({ where })) }));
    const execute = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const tx = { select, execute };
    const transaction = jest.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx));
    const layer = new DatabaseStorageLayer({ transaction } as never,
      () => '11111111-1111-4111-8111-111111111111', 'skills');
    return { layer, transaction, select, execute };
  }

  it.each(['readIndexedPath', 'findIndexedPath'] as const)('%s respects preferred names and stops at the first hit', async method => {
    const { layer } = fixture();
    await layer.scan();
    // A getter on an unused candidate detects traversal after a successful lookup.
    const names = ['missing', 'Meeting Notes'];
    Object.defineProperty(names, 2, { get: () => { throw new Error('Unexpected fallback lookup'); } });
    const result = await layer[method](names);
    expect(typeof result === 'object' ? result.path : result).toBe('canonical-id');
    const reversed = await layer[method](['agent-name', 'Meeting Notes']);
    expect(typeof reversed === 'object' ? reversed.path : reversed).toBe('sibling-id');
  });

  it.each([
    ['Agent_Name', 'exact-id'], ['agent-name', 'sibling-id'],
    ['AGENT NAME', undefined], ['meeting_notes', 'canonical-id'], ['missing', undefined],
  ] as const)('preserves exact and canonical matching for %s', async (name, expected) => {
    const { layer } = fixture();
    await layer.scan();
    expect(layer.getPathByName(name)).toBe(expected);
    expect(await layer.findIndexedPath([name])).toBe(expected);
    expect((await layer.readIndexedPath([name])).path).toBe(expected);
  });

  it('rejects a query failure without advancing the last successful scan timestamp', async () => {
    const { layer, transaction } = fixture();
    await layer.scan();
    const previous = layer['getState']().lastScanTimestamp;
    const failure = new Error('query unavailable');
    transaction.mockRejectedValueOnce(failure);
    await expect(layer.scan()).rejects.toBe(failure);
    expect(layer['getState']().lastScanTimestamp).toBe(previous);
    expect((await layer.readIndexedPath(['Meeting Notes'])).path).toBe('canonical-id');
  });

  it('reports scan completion without scanning or querying during indexed reads', async () => {
    const { layer, transaction, select, execute } = fixture();
    const scan = jest.spyOn(layer, 'scan');
    expect(await layer.readIndexedPath(['Meeting Notes'])).toEqual({
      path: undefined, indexComplete: false, authoritative: false, unindexed: [],
    });
    expect(await layer.findIndexedPath(['Meeting Notes'])).toBeUndefined();
    expect(scan).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    await layer.scan();
    scan.mockClear();
    transaction.mockClear();
    select.mockClear();
    execute.mockClear();
    expect(await layer.readIndexedPath(['Meeting Notes'])).toEqual({
      path: 'canonical-id', indexComplete: true, authoritative: true, unindexed: [],
    });
    expect(await layer.findIndexedPath(['Meeting Notes'])).toBe('canonical-id');
    expect(await layer.findIndexedPath(['missing'])).toBeUndefined();
    expect(scan).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
