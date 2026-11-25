import { nameTakenBy } from '../../../src/elements/base/ElementNameEvidence.js';
import { describe, expect, it, jest } from '@jest/globals';

import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';

const TEST_USER = '11111111-1111-4111-8111-111111111111';

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

  it('readIndexedPath respects preferred names and stops at the first hit', async () => {
    const { layer } = fixture();
    await layer.scan();
    // A getter on an unused candidate detects traversal after a successful lookup.
    const names = ['missing', 'Meeting Notes'];
    Object.defineProperty(names, 2, { get: () => { throw new Error('Unexpected fallback lookup'); } });
    expect((await layer.readIndexedPath(names)).path).toBe('canonical-id');
    expect((await layer.readIndexedPath(['agent-name', 'Meeting Notes'])).path).toBe('sibling-id');
  });

  it.each([
    ['Agent_Name', 'exact-id'], ['agent-name', 'sibling-id'],
    ['AGENT NAME', undefined], ['meeting_notes', 'canonical-id'], ['missing', undefined],
  ] as const)('preserves exact and canonical matching for %s', async (name, expected) => {
    const { layer } = fixture();
    await layer.scan();
    expect(layer.getPathByName(name)).toBe(expected);
    expect((await layer.readIndexedPath([name])).path).toBe(expected);
  });

  it('offers every row a name could select as a candidate and leaves ambiguity to the selector', async () => {
    const { layer } = fixture();
    await layer.scan();
    const named = (reference: string, name: string) => ({ reference, name });
    expect(await layer.readIndexedPath(['AGENT NAME'])).toMatchObject({ path: undefined,
      candidates: [named('exact-id', 'Agent_Name'), named('sibling-id', 'agent-name')] });
    expect((await layer.readIndexedPath(['meeting_notes'])).candidates).toEqual([named('canonical-id', 'Meeting Notes')]);
    expect((await layer.readIndexedPath(['missing', 'Meeting Notes'])).candidates).toEqual([named('canonical-id', 'Meeting Notes')]);
    expect((await layer.readIndexedPath(['missing'])).candidates).toEqual([]);
  });

  it('unindexes a renamed row\'s previous name, so the freed name can be created and the new one is found', async () => {
    // probe5: another process renames row X from 'Alpha' to 'Beta', keeping its id.
    const id = '11111111-1111-4111-8111-aaaaaaaaaaaa';
    let rows = [{ id, name: 'Alpha', updatedAt: new Date() }];
    const where = jest.fn(async () => rows);
    const select = jest.fn(() => ({ from: jest.fn(() => ({ where })) }));
    const tx = { select, execute: jest.fn(async () => undefined) };
    const layer = new DatabaseStorageLayer({ transaction: async (work: (value: typeof tx) => Promise<unknown>) => work(tx) } as never,
      () => '11111111-1111-4111-8111-111111111111', 'skills');
    await layer.scan();
    rows = [{ id, name: 'Beta', updatedAt: new Date(Date.now() + 1_000) }];
    const diff = await layer.refreshCollection();
    expect(diff).toMatchObject({ added: [], modified: [id], removed: [] });
    expect((await layer.readIndexedPath(['Alpha'])).candidates).toEqual([]);
    await expect(nameTakenBy(layer, 'Alpha')).resolves.toBeUndefined();
    expect((await layer.readIndexedPath(['Beta'])).candidates).toEqual([{ reference: id, name: 'Beta' }]);
    // The same through the write path (writeContent indexes the new name for the kept id).
    (layer as unknown as { setIndex(name: string, id: string): void }).setIndex('Gamma', id);
    expect((await layer.readIndexedPath(['Beta'])).candidates).toEqual([]);
    expect((await layer.readIndexedPath(['Gamma'])).candidates).toEqual([{ reference: id, name: 'Gamma' }]);
  });

  it('reports every known row modified on refresh, whatever its updated_at says (no clock decides a row is unchanged)', async () => {
    // probe7: an edit whose transaction began before the last scan, and a database clock behind the app clock.
    const { layer, select } = fixture();
    await layer.scan();
    const beforeScan = new Date(Date.now() - 60_000);
    const rows = [{ id: 'exact-id', name: 'Agent_Name', updatedAt: beforeScan }, { id: 'sibling-id', name: 'agent-name', updatedAt: new Date(Date.now() - 2_000) },
      { id: 'canonical-id', name: 'Meeting Notes', updatedAt: new Date(0) }];
    select.mockImplementation(() => ({ from: jest.fn(() => ({ where: jest.fn<() => Promise<typeof rows>>().mockResolvedValue(rows) })) }) as never);
    expect(await layer.refreshCollection()).toEqual({ added: [], modified: ['exact-id', 'sibling-id', 'canonical-id'], removed: [], unchanged: [] });
    expect(await layer.refreshCollection()).toEqual({ added: [], modified: ['exact-id', 'sibling-id', 'canonical-id'], removed: [], unchanged: [] });
  });

  it('reports both rows of a name swap by another process modified, never added', async () => {
    const x = '11111111-1111-4111-8111-aaaaaaaaaaaa';
    const y = '11111111-1111-4111-8111-bbbbbbbbbbbb';
    let rows = [{ id: x, name: 'x', updatedAt: new Date() }, { id: y, name: 'y', updatedAt: new Date() }];
    const select = jest.fn(() => ({ from: jest.fn(() => ({ where: jest.fn(async () => rows) })) }));
    const tx = { select, execute: jest.fn(async () => undefined) };
    const layer = new DatabaseStorageLayer({ transaction: async (work: (value: typeof tx) => Promise<unknown>) => work(tx) } as never,
      () => '11111111-1111-4111-8111-111111111111', 'skills');
    await layer.scan();
    rows = [{ id: x, name: 'y', updatedAt: new Date() }, { id: y, name: 'x', updatedAt: new Date() }];
    expect(await layer.refreshCollection()).toMatchObject({ added: [], modified: [x, y], removed: [] });
    expect((await layer.readIndexedPath(['x'])).candidates).toEqual([{ reference: y, name: 'x' }]);
    expect((await layer.readIndexedPath(['y'])).candidates).toEqual([{ reference: x, name: 'y' }]);
  });

  it('refreshes with the full id scan, so a row another process deleted is reported removed', async () => {
    const { layer, select } = fixture();
    await layer.scan();
    const remaining = [{ id: 'exact-id', name: 'Agent_Name', updatedAt: new Date() }, { id: 'sibling-id', name: 'agent-name', updatedAt: new Date() }];
    select.mockImplementation(() => ({ from: jest.fn(() => ({ where: jest.fn<() => Promise<typeof remaining>>().mockResolvedValue(remaining) })) }) as never);
    const diff = await layer.refreshCollection();
    expect(diff.removed).toEqual(['canonical-id']);
    expect((await layer.readIndexedPath(['Meeting Notes'])).candidates).toEqual([]);
  });

  it('keeps the precomputed name keys in step with the index through writes, renames and removals', async () => {
    const { layer } = fixture();
    await layer.scan();
    const candidates = async (name: string) => (await layer.readIndexedPath([name])).candidates.map(candidate => candidate.reference);
    expect(await candidates('meeting_notes')).toEqual(['canonical-id']);
    layer['setIndex']('Weekly Notes', 'weekly-id');
    expect(await candidates('weekly notes')).toEqual(['weekly-id']);
    layer['removeIndexById']('weekly-id');
    expect(await candidates('weekly notes')).toEqual([]);
    layer['removeIndex']('Meeting Notes');
    expect(await candidates('meeting_notes')).toEqual([]);
    expect(layer.getPathByName('meeting-notes')).toBeUndefined();
    // An exact-reference read asks for no name candidates.
    expect((await layer.readIndexedPath(['exact-id'], { candidates: false })).candidates).toEqual([]);
    expect(await candidates('AGENT NAME')).toEqual(['exact-id', 'sibling-id']);
  });

  it('resolves a mutation identity with the shared name rule inside the transaction', async () => {
    const { layer } = fixture();
    await expect(layer.resolveContentIdentity('skills', 'Agent_Name')).resolves.toEqual({ id: 'exact-id', name: 'Agent_Name' });
    await expect(layer.resolveContentIdentity('skills', 'agent-name')).resolves.toEqual({ id: 'sibling-id', name: 'agent-name' });
    await expect(layer.resolveContentIdentity('skills', 'meeting_notes')).resolves.toEqual({ id: 'canonical-id', name: 'Meeting Notes' });
    await expect(layer.resolveContentIdentity('skills', 'AGENT NAME')).rejects.toMatchObject({ code: 'EAMBIGUOUS', competitors: ['exact-id', 'sibling-id'] });
    // A row id is the exact reference (tier 0) under the same rule, never a separate step.
    await expect(layer.resolveContentIdentity('skills', 'exact-id')).resolves.toEqual({ id: 'exact-id', name: 'Agent_Name' });
    await expect(layer.resolveContentIdentity('skills', 'missing')).resolves.toBeUndefined();
  });

  it('resolves camel-case, dotted and Unicode-variant names identically for reads and mutations', async () => {
    const rows = [
      { id: 'camel', name: 'MySkill', updatedAt: new Date() },
      { id: 'dotted', name: 'foo.bar', updatedAt: new Date() },
      { id: 'accent', name: 'Caf\u00e9 Notes', updatedAt: new Date() },
    ];
    const where = jest.fn<() => Promise<typeof rows>>().mockResolvedValue(rows);
    const select = jest.fn(() => ({ from: jest.fn(() => ({ where })) }));
    const execute = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const tx = { select, execute };
    const transaction = jest.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx));
    const layer = new DatabaseStorageLayer({ transaction } as never, () => '11111111-1111-4111-8111-111111111111', 'skills');
    await layer.scan();
    for (const [identifier, id] of [['my-skill', 'camel'], ['foo-bar', 'dotted'], ['Cafe\u0301 notes', 'accent']] as const) {
      expect((await layer.resolveContentIdentity('skills', identifier))?.id).toBe(id);
      expect((await layer.readIndexedPath([identifier])).candidates.map(candidate => candidate.reference)).toEqual([id]);
    }
  });

  it('rejects a query failure and revokes index authority while retaining known identities', async () => {
    const { layer, transaction } = fixture();
    await layer.scan();
    const failure = new Error('query unavailable');
    transaction.mockRejectedValueOnce(failure);
    await expect(layer.scan()).rejects.toBe(failure);
    expect(layer['getState']().lastScanTimestamp).toBeNull();
    expect(await layer.readIndexedPath(['Meeting Notes'])).toMatchObject({ path: 'canonical-id', authoritative: false });
  });

  it('reports scan completion without scanning or querying during indexed reads', async () => {
    const { layer, transaction, select, execute } = fixture();
    const scan = jest.spyOn(layer, 'scan');
    expect(await layer.readIndexedPath(['Meeting Notes'])).toEqual({
      path: undefined, indexComplete: false, authoritative: false, unindexed: [], candidates: [], failures: new Map(),
    });
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
      candidates: [{ reference: 'canonical-id', name: 'Meeting Notes' }], failures: new Map(),
    });
    expect(scan).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('database caller references', () => {
  it('resolves a row id to its identity and any other text to a name as written, with no query', async () => {
    const layer = new DatabaseStorageLayer({ transaction: jest.fn() } as never, () => TEST_USER, 'skills');
    const resolve = jest.spyOn(layer, 'resolveContentIdentity').mockResolvedValue(undefined);
    const id = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455';
    await expect(layer.resolveReference('notes.md')).resolves.toEqual({ kind: 'name', name: 'notes.md' });
    await expect(layer.resolveReference('notes')).resolves.toEqual({ kind: 'name', name: 'notes' });
    await expect(layer.resolveReference(id)).resolves.toEqual({ kind: 'identity', storageIdentity: id, requested: id });
    // The manager selects the name, as written first, through the shared rule the read applies.
    expect(resolve).not.toHaveBeenCalled();
  });

  it('reads only row ids: any other reference names no row and is absent without a query', async () => {
    const transaction = jest.fn();
    const layer = new DatabaseStorageLayer({ transaction } as never, () => TEST_USER, 'skills');
    await expect(layer.readContent('CI/CD Helper')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(layer.readContentForUpdate('not-a-row-id')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(transaction).not.toHaveBeenCalled();
  });
});
