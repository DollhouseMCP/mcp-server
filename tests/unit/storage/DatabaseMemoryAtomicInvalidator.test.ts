import { describe, expect, it, jest } from '@jest/globals';
import type { Sql } from 'postgres';
import type { MemoryAtomicInvalidationRequest } from '../../../src/storage/DatabaseMemoryAtomicInvalidator.js';
// These tests qualify the outcome envelope; real catalog/SQL proof belongs to CI PG.
jest.unstable_mockModule('../../../src/storage/DatabaseMemoryMaintenanceCatalogVerifier.js', () => ({
  observeDatabaseMemoryMaintenanceCatalog: async () => ({ status: 'verified', descriptorSha256: 'b'.repeat(64) }),
}));
const { DatabaseMemoryAtomicInvalidator } = await import('../../../src/storage/DatabaseMemoryAtomicInvalidator.js');

const request = (): MemoryAtomicInvalidationRequest => ({ runId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  candidateCommit: 'a'.repeat(40), expectedCatalogSha256: 'b'.repeat(64), maintenanceEvidenceSha256: 'c'.repeat(64),
  maintenanceEvidenceId: 'quiescence-record', declaredContextId: 'declared-maintenance', databaseName: 'owned_test', databaseOid: '123' });
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Callback = (client: unknown) => Promise<unknown>;
function fixture(behavior?: (callback: Callback, client: unknown) => Promise<unknown>) {
  const statements: string[] = [];
  let calls = 0;
  const client = { options: { parsers: {}, serializers: {} }, unsafe: async (query: string, _parameters?: unknown[]): Promise<unknown[]> => {
    statements.push(query);
    return []; // A real proof cannot be obtained from an absent context row.
  } };
  const connection = { begin: async (_options: string, callback: Callback) => {
    calls++;
    return behavior ? behavior(callback, client) : callback(client);
  } } as unknown as Sql;
  return { connection, client, statements, calls: () => calls };
}

describe('atomic invalidation private operation envelope', () => {
  it.each([
    { runId: '00000000-0000-0000-0000-000000000000' }, { candidateCommit: '0'.repeat(40) },
    { databaseOid: '0' }, { databaseOid: '4294967296' }, { databaseOid: '0123' },
    { databaseName: 'x'.repeat(64) }, { maintenanceEvidenceId: 'é'.repeat(65) }, { declaredContextId: '\ud800' },
  ])('refuses invalid request before transaction: %j', async changes => {
    const f = fixture();
    expect(await new DatabaseMemoryAtomicInvalidator(f.connection).invalidate({ ...request(), ...changes }))
      .toEqual({ status: 'aborted', reason: 'invalid-request' });
    expect(f.calls()).toBe(0);
  });

  it('uses SET LOCAL and all ordered locks before its first SELECT', async () => {
    const f = fixture();
    expect(await new DatabaseMemoryAtomicInvalidator(f.connection).invalidate(request()))
      .toEqual({ status: 'aborted', reason: 'context' });
    expect(f.statements.slice(0, 3)).toEqual([
      'SET LOCAL search_path = pg_catalog, public, pg_temp', "SET LOCAL lock_timeout = '1000ms'", "SET LOCAL statement_timeout = '5000ms'",
    ]);
    expect(f.statements.slice(3, 7)).toEqual(['memory_head_invalidation_runs', 'elements', 'element_tags', 'memory_entries']
      .map(table => `LOCK TABLE "public"."${table}" IN EXCLUSIVE MODE`));
    expect(f.statements[7]).toMatch(/^SELECT/u);
    expect(f.statements).not.toEqual(expect.arrayContaining([expect.stringContaining('INSERT INTO')]));
  });

  it('allows explicit retry after acknowledged rollback, including a different run ID', async () => {
    const f = fixture();
    const invalidator = new DatabaseMemoryAtomicInvalidator(f.connection);
    expect((await invalidator.invalidate(request())).status).toBe('aborted');
    expect((await invalidator.invalidate({ ...request(), runId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })).status).toBe('aborted');
    expect(f.calls()).toBe(2);
  });

  it('rollback rejection stays unknown and blocks a different run ID', async () => {
    const f = fixture(async (callback, client) => {
      try { return await callback(client); }
      catch { throw new Error('simulated rollback failure'); }
    });
    const invalidator = new DatabaseMemoryAtomicInvalidator(f.connection);
    expect(await invalidator.invalidate(request())).toEqual({ status: 'unknown', reason: null });
    expect(await invalidator.invalidate({ ...request(), runId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }))
      .toEqual({ status: 'unknown', reason: null });
    expect(f.calls()).toBe(1);
  });

  it('never infers drainage when the callback has not started', async () => {
    const f = fixture(async () => { throw new Error('begin acknowledgement lost'); });
    const fresh = fixture();
    const invalidator = new DatabaseMemoryAtomicInvalidator(f.connection);
    expect((await invalidator.invalidate(request())).status).toBe('unknown');
    expect((await invalidator.resolveRun(request(), fresh.connection)).status).toBe('unknown');
    expect(fresh.calls()).toBe(0);
  });

  it('a previous operation sentinel or forged refusal-shaped object cannot prove a new rollback acknowledgement', async () => {
    let previous: unknown;
    let operation = 0;
    const f = fixture(async (callback, client) => {
      if (++operation > 1) throw previous;
      try { return await callback(client); }
      catch (error) { previous = error; throw error; }
    });
    const executor = new DatabaseMemoryAtomicInvalidator(f.connection);
    expect((await executor.invalidate(request())).status).toBe('aborted');
    expect((await executor.invalidate({ ...request(), runId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })).status).toBe('unknown');
    const forged = fixture(async () => { throw { reason: 'context', drained: true, acknowledgedAbort: true }; });
    expect((await new DatabaseMemoryAtomicInvalidator(forged.connection).invalidate(request())).status).toBe('unknown');
  });

  it('late callback sees abandonment before any SET or LOCK; resolver refusal does not release original uncertainty', async () => {
    let callback!: Callback;
    let reserved: unknown;
    const f = fixture(async (body, client) => { callback = body; reserved = client; throw new Error('outer rejection'); });
    const fresh = fixture();
    const invalidator = new DatabaseMemoryAtomicInvalidator(f.connection);
    expect((await invalidator.invalidate(request())).status).toBe('unknown');
    expect((await invalidator.resolveRun(request(), fresh.connection)).status).toBe('unknown');
    await expect(callback(reserved)).rejects.toBeDefined();
    expect(f.statements).toHaveLength(0);
    expect(await invalidator.resolveRun(request(), fresh.connection)).toEqual({ status: 'refused', reason: 'context' });
    expect((await invalidator.invalidate({ ...request(), runId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })).status).toBe('unknown');
  });

  it('rejection during an awaited lock prevents the next lock and all mutation', async () => {
    const lock = gate<unknown[]>();
    const entered = gate<void>();
    const lost = gate<never>();
    let callbackDone!: Promise<unknown>;
    const f = fixture(async (body, client) => {
      callbackDone = body(client);
      return Promise.race([callbackDone, lost.promise]);
    });
    f.client.unsafe = async query => {
      f.statements.push(query);
      if (query.startsWith('LOCK')) { entered.resolve(); return lock.promise; }
      return [];
    };
    const invalidator = new DatabaseMemoryAtomicInvalidator(f.connection);
    const outcome = invalidator.invalidate(request());
    await entered.promise;
    lost.reject(new Error('connection closed'));
    expect((await outcome).status).toBe('unknown');
    lock.resolve([]);
    await expect(callbackDone).rejects.toBeDefined();
    expect(f.statements.filter(query => query.startsWith('LOCK'))).toHaveLength(1);
    expect(f.statements.some(query => /UPDATE|INSERT/u.test(query))).toBe(false);
  });

  it('rejects untracked cold resolution rather than proving absence', async () => {
    const f = fixture();
    const fresh = fixture();
    expect(await new DatabaseMemoryAtomicInvalidator(f.connection).resolveRun(request(), fresh.connection))
      .toEqual({ status: 'refused', reason: 'context' });
    expect(fresh.calls()).toBe(0);
  });
});

function happyFixture(behavior?: (callback: Callback, client: unknown) => Promise<unknown>) {
  const f = fixture(behavior);
  let receipt: Record<string, unknown> | null = null;
  let writes = 0;
  f.client.unsafe = async (statement: string, parameters?: unknown[]) => {
    f.statements.push(statement);
    if (statement.startsWith('SELECT\n')) return [{ name: 'owned_test', oid: '123', actor: 'ci_operator', version: 170010,
      privileged: true, origin: true, isolation: true, visibility: true, rights: true, resolution: true, no_rules: true }];
    if (statement.includes('WITH owners')) return [{ owners: 0, tags: 0, owner_bytes: '0', tag_bytes: '0', unsafe: 0 }];
    if (statement.includes('clock_timestamp')) return [statement.includes('AS started') ?
      { started: '9999-12-31T23:59:59.000Z' } : { finished: '+010000-01-01T00:00:00.000Z' }];
    if (statement.startsWith('INSERT')) {
      writes++;
      const p = parameters!;
      receipt = { runId: p[0], formatVersion: 1, claim: 'historical-exact-owner-set-invalidation', requestSha256: p[1],
        catalogSha256: p[2], preManifestSha256: p[3], postManifestSha256: p[4], maintenanceEvidenceSha256: p[5],
        candidateCommit: p[6], maintenanceEvidenceId: p[7], declaredContextId: p[8], databaseName: p[9], effectiveRole: p[10],
        databaseOid: p[11], serverVersionNum: p[12], ownerCount: p[13], tagCount: p[14], startedAt: p[15], finishedAt: p[16],
        canApply: false, canActivate: false };
    }
    if (statement.includes('FROM public.memory_head_invalidation_runs')) return receipt ? [receipt] : [];
    return [];
  };
  return { ...f, writes: () => writes, receipt: () => receipt! };
}
describe('historical receipt and commit envelope', () => {
  it('captures mutable request fields before the first await', async () => {
    const ready = gate<void>();
    const continueBegin = gate<void>();
    const f = happyFixture(async (callback, client) => {
      ready.resolve();
      await continueBegin.promise;
      return callback(client);
    });
    const input = request();
    const operation = new DatabaseMemoryAtomicInvalidator(f.connection).invalidate(input);
    await ready.promise;
    Object.assign(input, { databaseOid: '0', declaredContextId: 'mutated-after-await' });
    continueBegin.resolve();
    const result = await operation;
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw new Error('Expected commit');
    expect(result.receipt.databaseOid).toBe('123');
    expect(result.receipt.declaredContextId).toBe('declared-maintenance');
  });

  it.each(['privileged', 'origin', 'isolation', 'visibility', 'rights', 'resolution', 'no_rules'])('checks current %s before otherwise matching replay', async flag => {
    const f = happyFixture();
    const executor = new DatabaseMemoryAtomicInvalidator(f.connection);
    expect((await executor.invalidate(request())).status).toBe('committed');
    const original = f.client.unsafe;
    f.client.unsafe = async (statement, parameters?: unknown[]) => {
      const rows = await original(statement, parameters);
      if (statement.startsWith('SELECT\n')) (rows[0] as Record<string, unknown>)[flag] = false;
      return rows;
    };
    const offset = f.statements.length;
    expect(await executor.invalidate(request())).toEqual({ status: 'aborted', reason: 'context' });
    expect(f.statements.slice(offset).some(statement => statement.includes('FROM public.memory_head_invalidation_runs'))).toBe(false);
    expect(f.writes()).toBe(1);
  });

  it.each([
    { owners: 10001, tags: 0, owner_bytes: '0', tag_bytes: '0', unsafe: 0 },
    { owners: 0, tags: 100001, owner_bytes: '0', tag_bytes: '0', unsafe: 0 },
    { owners: 0, tags: 0, owner_bytes: '16777217', tag_bytes: '0', unsafe: 0 },
  ])('refuses a census overflow without any mutation', async bounds => {
    const f = happyFixture();
    const original = f.client.unsafe;
    f.client.unsafe = async (statement, parameters?: unknown[]) => statement.includes('WITH owners') ?
      [bounds] : original(statement, parameters);
    expect(await new DatabaseMemoryAtomicInvalidator(f.connection).invalidate(request()))
      .toEqual({ status: 'aborted', reason: 'incomplete-census' });
    expect(f.writes()).toBe(0);
    expect(f.statements.some(statement => statement.startsWith('UPDATE'))).toBe(false);
  });

  it('callback completion with lost commit acknowledgement is unknown until receipt resolution; blocks other IDs', async () => {
    const f = happyFixture(async (callback, client) => {
      await callback(client);
      throw new Error('lost commit acknowledgement');
    });
    const executor = new DatabaseMemoryAtomicInvalidator(f.connection);
    expect(await executor.invalidate(request())).toEqual({ status: 'unknown', reason: null });
    expect(f.writes()).toBe(1);
    expect((await executor.invalidate({ ...request(), runId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })).status).toBe('unknown');
    const fresh = fixture(async callback => callback(f.client));
    expect((await executor.resolveRun(request(), fresh.connection)).status).toBe('replayed');
    // A subsequent explicit request is permitted only after successful resolution.
    expect((await executor.invalidate(request())).status).toBe('unknown'); // this fixture again loses outer acknowledgement
    expect(f.writes()).toBe(1);
  });

  it('a resolver lock failure leaves original uncertainty; proven absence permits only an explicit retry', async () => {
    const f = fixture(async (callback, client) => {
      try { return await callback(client); }
      catch { throw new Error('rollback acknowledgement lost'); }
    });
    const executor = new DatabaseMemoryAtomicInvalidator(f.connection);
    expect((await executor.invalidate(request())).status).toBe('unknown');
    const timeout = fixture();
    timeout.client.unsafe = async statement => {
      timeout.statements.push(statement);
      if (statement.startsWith('LOCK')) throw new Error('lock timeout');
      return [];
    };
    expect((await executor.resolveRun(request(), timeout.connection)).status).toBe('unknown');
    expect((await executor.invalidate({ ...request(), runId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })).status).toBe('unknown');
    const absent = happyFixture();
    expect(await executor.resolveRun(request(), absent.connection)).toEqual({ status: 'absent', reason: null });
    expect(absent.writes()).toBe(0);
    const calls = f.calls();
    expect((await executor.invalidate(request())).status).toBe('unknown'); // explicit retry executes but its rollback again loses ACK
    expect(f.calls()).toBe(calls + 1);
  });

  it('accepts chronological extended-year timestamps and replays without a second insert', async () => {
    const f = happyFixture();
    const executor = new DatabaseMemoryAtomicInvalidator(f.connection);
    const first = await executor.invalidate(request());
    expect(first.status).toBe('committed');
    expect((await executor.invalidate(request())).status).toBe('replayed');
    expect(f.writes()).toBe(1);
  });
  it.each([
    ['runId', 'invalid'], ['formatVersion', 2], ['claim', 'current-authority'], ['requestSha256', 'x'],
    ['catalogSha256', 'a'.repeat(64)], ['preManifestSha256', 'x'], ['postManifestSha256', 'x'],
    ['maintenanceEvidenceSha256', 'd'.repeat(64)], ['candidateCommit', '0'.repeat(40)],
    ['maintenanceEvidenceId', 'changed'], ['declaredContextId', 'changed'], ['databaseName', 'other'],
    ['effectiveRole', ''], ['databaseOid', '0'], ['serverVersionNum', 0], ['ownerCount', 10001],
    ['tagCount', 100001], ['startedAt', 'infinity'], ['finishedAt', 'invalid'], ['canApply', true], ['canActivate', true],
  ])('does not trust matching request hash when receipt field %s is corrupt', async (field, value) => {
    const f = happyFixture();
    const executor = new DatabaseMemoryAtomicInvalidator(f.connection);
    expect((await executor.invalidate(request())).status).toBe('committed');
    f.receipt()[field as string] = value;
    const replay = await executor.invalidate(request());
    expect(replay.status).toBe('aborted');
    expect(f.writes()).toBe(1);
  });
});
