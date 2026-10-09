/** Required service-owned PostgreSQL proof; no live admission or eligibility claim. */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { DatabaseMemoryAdmissionGate, DATABASE_MEMORY_ADMISSION_PROFILE as profile,
  type DatabaseMemoryAdmissionBinding } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { DatabaseMemoryStorageLayer, type PreparedDatabaseMemoryHeadWrite } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { MemoryHeadUpdateAdapter } from '../../../src/storage/MemoryHeadUpdateAdapter.js';
import { DatabaseMemoryReconciliationInspector } from '../../../src/storage/DatabaseMemoryReconciliationInspector.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { makeEquivalentFixture, type EquivalentFixture } from './fixtures/2905-equivalent-reconciliation-fixture.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
const owned: { fixture: EquivalentFixture; name: string }[] = [];
function phase(name: string, value: string): void { console.info(`[db-admitted-write:${name}] ${value}`); }
afterEach(async () => {
  jest.restoreAllMocks();
  for (const { fixture: f, name } of owned.splice(0)) {
    phase(name, 'cleanup-start'); await f.cleanup(); phase(name, 'cleanup-end');
  }
});
async function fixture(name: string) {
  phase(name, 'fixture-start');
  const f = await makeEquivalentFixture(); owned.push({ fixture: f, name });
  expect(await new DatabaseMemoryReconciliationInspector(f.db, () => f.userId)
    .inspect({ userId: f.userId, memoryId: f.memoryId })).toMatchObject({ status: 'equivalent', dirty: true });
  // Disposable test setup only; not maintenance/adoption or production eligibility authority.
  await f.maintenance`UPDATE public.elements SET memory_entries_out_of_sync=false WHERE id=${f.memoryId}::uuid`;
  await f.maintenance`INSERT INTO public.memory_backend_modes(user_id,backend,protocol_version,profile,mode,generation)
    VALUES (${f.userId}::uuid,'database',1,${profile},'guarded',1)`;
  let gate: DatabaseMemoryAdmissionGate;
  const adapter = new MemoryHeadUpdateAdapter({ backend: 'database', store: f.layer }, () => f.userId, () => gate);
  let binding: DatabaseMemoryAdmissionBinding = { tenant: f.userId, backend: 'database', db: f.db,
    store: f.layer, adapter, enabled: true, profile };
  gate = new DatabaseMemoryAdmissionGate(f.db, f.layer, () => binding);
  const content = f.raw.replace('Preserved entry', 'Known accepted edit');
  const metadata = { author: 'test-author', version: '1.0.0', description: '', tags: ['test'] };
  phase(name, 'fixture-end');
  return { ...f, gate, adapter, content, metadata, change: (value: Partial<DatabaseMemoryAdmissionBinding>) => { binding = { ...binding, ...value }; } };
}

required('required PostgreSQL admitted conditional UPDATE seam', () => {
  it('rolls back all head/tag/child writes and refuses escaped prospective publication', async () => {
    const f = await fixture('outer-rollback'); const before = await f.snapshot();
    const snapshot = await f.layer.readHeadSnapshot(f.memoryId); const capture = await f.gate.capture();
    const observer = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    const cause = new Error('controlled outer rollback');
    let prepared: PreparedDatabaseMemoryHeadWrite | undefined;
    const outcome = await f.gate.withAdmittedWrite(capture, async authority => {
      prepared = await f.layer.prepareHeadWriteInAdmission(authority, snapshot.token, f.name, f.content, f.metadata);
      expect(() => prepared!.publish()).toThrow();
      expect(await f.snapshot()).toEqual(before);
      expect(observer.mock.calls.some(([event]) => event.type === 'ELEMENT_EDITED')).toBe(false);
      throw cause;
    });
    expect(outcome).toEqual({ status: 'refused', cause });
    expect(await f.snapshot()).toEqual(before);
    expect(() => prepared!.publish()).toThrow();
    expect(observer.mock.calls.some(([event]) => event.type === 'ELEMENT_EDITED')).toBe(false);
    phase('outer-rollback', 'assertions-complete');
  });

  it('commits one exact transaction before advancing adapter token or publishing success', async () => {
    const f = await fixture('known-commit'); const before = await f.layer.readHeadSnapshot(f.memoryId);
    const snapshot = await f.adapter.readBoundSnapshot(f.memoryId, f.userId, 'database-root');
    const memory = {}; f.adapter.bindLoaded(memory, snapshot, f.name, 'database-root');
    f.adapter.beginUpdate(memory, f.userId, f.memoryId, f.name, 'database-root');
    const ordinary = jest.spyOn(f.layer, 'writeHeadIfCurrent');
    const legacy = jest.spyOn(f.layer, 'writeContent');
    const observer = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    const outcome = await f.adapter.write(memory, f.userId, { name: f.name, content: f.content, metadata: f.metadata });
    expect(outcome.status).toBe('committed');
    const fresh = await f.layer.readHeadSnapshot(f.memoryId);
    expect(fresh.content).toBe(f.content);
    expect(BigInt(fresh.token.revision)).toBeGreaterThan(BigInt(before.token.revision));
    expect(fresh.token.ownerId).toBe(before.token.ownerId);
    expect((await f.snapshot()).entries).toContain('Known accepted edit');
    expect(ordinary).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled();
    expect(observer.mock.calls.some(([event]) => event.type === 'ELEMENT_EDITED')).toBe(true);
    f.adapter.finishUpdate(memory);
    expect(f.adapter.beginUpdate(memory, f.userId, f.memoryId, f.name, 'database-root')).toEqual(fresh.token);
    phase('known-commit', 'assertions-complete');
  });

  it.each(['store', 'tenant'] as const)('refuses wrong %s before authoritative mutation', async kind => {
    const f = await fixture(`wrong-${kind}`); const before = await f.snapshot();
    const snapshot = await f.layer.readHeadSnapshot(f.memoryId); const c = await f.gate.capture();
    const other = new DatabaseMemoryStorageLayer(f.db, () => f.userId);
    const outcome = await f.gate.withAdmittedWrite(c, authority => kind === 'store'
      ? other.prepareHeadWriteInAdmission(authority, snapshot.token, f.name, f.content, f.metadata)
      : f.layer.prepareHeadWriteInAdmission(authority, { ...snapshot.token, userId: f.foreignUserId }, f.name, f.content, f.metadata));
    expect(outcome.status).toBe('refused');
    expect(await f.snapshot()).toEqual(before);
    phase(`wrong-${kind}`, 'assertions-complete');
  });

  it('rolls back actual conditional writes when trusted context changes before commit', async () => {
    const f = await fixture('context-drift'); const before = await f.snapshot();
    const snapshot = await f.layer.readHeadSnapshot(f.memoryId); const c = await f.gate.capture();
    let prepared: PreparedDatabaseMemoryHeadWrite | undefined;
    const outcome = await f.gate.withAdmittedWrite(c, async authority => {
      prepared = await f.layer.prepareHeadWriteInAdmission(authority, snapshot.token, f.name, f.content, f.metadata);
      f.change({ enabled: false }); return prepared;
    });
    expect(outcome).toMatchObject({ status: 'refused', cause: { code: 'EMEMORYADMISSION' } });
    expect(await f.snapshot()).toEqual(before);
    expect(() => prepared!.publish()).toThrow();
    phase('context-drift', 'assertions-complete');
  });

  it('holds a privileged mode transition until conditional persistence and outer commit complete', async () => {
    const f = await fixture('mode-transition'); const before = await f.snapshot();
    const snapshot = await f.layer.readHeadSnapshot(f.memoryId); const c = await f.gate.capture();
    const [{ pid }] = await f.competitor`SELECT pg_backend_pid() AS pid`;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    const operation = f.gate.withAdmittedWrite(c, async authority => {
      const prepared = await f.layer.prepareHeadWriteInAdmission(authority, snapshot.token, f.name, f.content, f.metadata);
      enter(); await held; return prepared;
    });
    let transition: PromiseLike<unknown> | undefined;
    try {
      await entered;
      transition = f.competitor`UPDATE public.memory_backend_modes SET mode='read_only' WHERE user_id=${f.userId}::uuid`.execute();
      let observed = false;
      for (let attempt = 0; attempt < 1000; attempt++) {
        const [{ blocked }] = await f.maintenance`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=${pid} AND NOT granted) AS blocked`;
        if (blocked) { observed = true; break; }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(observed).toBe(true);
      expect(await f.snapshot()).toEqual(before);
    } finally { release(); await operation; if (transition) await transition; }
    expect((await f.layer.readHeadSnapshot(f.memoryId)).content).toBe(f.content);
    await expect(f.gate.capture()).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    phase('mode-transition', 'assertions-complete');
  });

  it('preserves unknown authority when real COMMIT succeeds but completion delivery is lost', async () => {
    const f = await fixture('commit-delivery');
    const snapshot = await f.adapter.readBoundSnapshot(f.memoryId, f.userId, 'database-root');
    const memory = {}; f.adapter.bindLoaded(memory, snapshot, f.name, 'database-root');
    f.adapter.beginUpdate(memory, f.userId, f.memoryId, f.name, 'database-root');
    const cause = Object.assign(new Error('controlled completion delivery failure'), { code: 'ESTALE' });
    let prepared: PreparedDatabaseMemoryHeadWrite | undefined;
    const originalPrepare = f.layer.prepareHeadWriteInAdmission.bind(f.layer);
    jest.spyOn(f.layer, 'prepareHeadWriteInAdmission').mockImplementation(async (...args) => {
      prepared = await originalPrepare(...args); return prepared;
    });
    const originalTransaction = f.db.transaction.bind(f.db);
    const transaction = jest.spyOn(f.db, 'transaction').mockImplementationOnce(async body => {
      // Real driver COMMIT completes in the owned test database; the adapter is
      // deliberately denied its completion result. This is not a network fault claim.
      await originalTransaction(body); throw cause;
    });
    const outcome = await f.adapter.write(memory, f.userId, { name: f.name, content: f.content, metadata: f.metadata });
    expect(outcome).toEqual({ status: 'unknown', cause });
    expect(prepared).toBeDefined();
    expect(() => prepared!.publish()).toThrow();
    expect(transaction).toHaveBeenCalledTimes(1);
    transaction.mockRestore();
    expect((await f.layer.readHeadSnapshot(f.memoryId)).content).toBe(f.content);
    expect(f.adapter.getPendingUpdate(memory)).toMatchObject({ status: 'unknown', originalToken: snapshot.token,
      candidate: { content: f.content }, cause });
    f.adapter.finishUpdate(memory);
    expect(() => f.adapter.beginUpdate(memory, f.userId, f.memoryId, f.name, 'database-root')).toThrow();
    phase('commit-delivery', 'assertions-complete');
  });

  it('retains the committed receipt when actual store publication fails', async () => {
    const f = await fixture('publication-failure');
    const snapshot = await f.adapter.readBoundSnapshot(f.memoryId, f.userId, 'database-root');
    const memory = {}; f.adapter.bindLoaded(memory, snapshot, f.name, 'database-root');
    f.adapter.beginUpdate(memory, f.userId, f.memoryId, f.name, 'database-root');
    const cause = new Error('controlled local index publication failure');
    const publication = jest.spyOn(f.layer as unknown as { setIndex(name: string, id: string, userId: string): void }, 'setIndex')
      .mockImplementation(() => { throw cause; });
    const outcome = await f.adapter.write(memory, f.userId, { name: f.name, content: f.content, metadata: f.metadata });
    expect(outcome).toMatchObject({ status: 'committed', cause });
    expect(publication).toHaveBeenCalledTimes(1); publication.mockRestore();
    const fresh = await f.layer.readHeadSnapshot(f.memoryId);
    expect(fresh.content).toBe(f.content);
    expect(f.adapter.getPendingUpdate(memory)).toMatchObject({ status: 'committed-publication-failed',
      originalToken: snapshot.token, committedToken: fresh.token, candidate: { content: f.content }, cause });
    phase('publication-failure', 'assertions-complete');
  });

});
