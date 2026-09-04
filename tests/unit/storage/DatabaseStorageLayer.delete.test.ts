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
