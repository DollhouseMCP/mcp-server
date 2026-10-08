/** Owned PostgreSQL proof only. Controlled delivery faults are not provider outage claims. */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { withUserContext } from '../../../src/database/rls.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE as profile } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import type { DormantDurableMemoryComposition } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { encodeMemoryCandidate, decodeMemoryCandidate } from '../../../src/storage/DatabaseMemoryCandidateEnvelope.js';
import { MemorySaveHandler } from '../../../src/handlers/mcp-aql/MemorySaveHandler.js';
import { ManagerBackedPortfolioElementStore } from '../../../src/web-console/stores/ManagerBackedPortfolioElementStore.js';
import { PortfolioService } from '../../../src/web-console/modules/portfolio/PortfolioService.js';
import { portfolioElementEtag } from '../../../src/web-console/modules/portfolio/PortfolioDtos.js';
import { InMemoryUserIntegrationStore } from '../../../src/web-console/stores/InMemoryUserIntegrationStore.js';
import { InMemoryPortfolioSyncJobStore } from '../../../src/web-console/stores/InMemoryPortfolioSyncJobStore.js';
import type { ConsoleRequest } from '../../../src/web-console/platform/ConsolePlatformTypes.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { admittedMemoryContainer } from '../../helpers/storage/admitted-memory-container.js';
import { makeEquivalentFixture, type EquivalentFixture } from './fixtures/2905-equivalent-reconciliation-fixture.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
function phase(name: string, value: string) { console.info(`[db-candidate-handoff:${name}] ${value}`); }
const owned: { name: string; f: EquivalentFixture; directory?: string; dispose?: () => Promise<void> }[] = [];
afterEach(async () => {
  jest.restoreAllMocks();
  for (const item of owned.splice(0)) {
    phase(item.name, 'cleanup-start'); const errors: unknown[] = [];
    try { await item.dispose?.(); } catch (cause) { errors.push(cause); }
    try { await item.f.cleanup(); } catch (cause) { errors.push(cause); }
    if (item.directory) try { await rm(item.directory, { recursive: true, force: true }); } catch (cause) { errors.push(cause); }
    if (errors.length) throw new AggregateError(errors, 'Owned candidate handoff cleanup failed');
    phase(item.name, 'cleanup-end');
  }
});
async function fixture(name: string) {
  phase(name, 'fixture-start'); const f = await makeEquivalentFixture();
  const item: typeof owned[number] = { name, f }; owned.push(item);
  // Disposable fixture eligibility/provisioning only, never a production maintenance authority.
  await f.maintenance`UPDATE public.elements SET memory_entries_out_of_sync=false WHERE id=${f.memoryId}::uuid`;
  await f.maintenance`INSERT INTO public.memory_backend_modes(user_id,backend,protocol_version,profile,mode,generation)
    VALUES (${f.userId}::uuid,'database',1,${profile},'guarded',1)`;
  await f.maintenance`INSERT INTO public.memory_candidate_quotas(user_id) VALUES (${f.userId}::uuid)`;
  item.directory = await mkdtemp(path.join(os.tmpdir(), 'memory-candidate-pg-'));
  let tenant: string = f.userId; let composition!: DormantDurableMemoryComposition;
  let layer!: DatabaseMemoryStorageLayer;
  const root = admittedMemoryContainer(f.db, () => tenant, item.directory, factory => {
    const create = factory.createForElement.bind(factory);
    jest.spyOn(factory, 'createForElement').mockImplementation((type, options) => {
      const result = create(type, options); if (type === 'memories') layer = result as DatabaseMemoryStorageLayer;
      return result;
    });
    return deps => {
      composition = factory.createDurableAdmittedMemoryManager(deps,
        () => ({ contextRoot: item.directory!, sessionId: 'owned-handoff-session', transport: 'http' }));
      return composition.manager;
    };
  });
  item.dispose = () => root.container.dispose(); const manager = root.manager();
  await expect(manager.load(f.memoryId)).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
  await composition.qualify(async identity => { expect(identity.tenant).toBe(f.userId); expect(identity.store).toBe(layer); });
  const legacy = jest.spyOn(layer, 'writeContent'); const ordinary = jest.spyOn(layer, 'writeHeadIfCurrent');
  const prepare = layer.prepareHeadWriteInAdmission.bind(layer);
  const admitted = jest.spyOn(layer, 'prepareHeadWriteInAdmission');
  const request = new MemorySaveHandler({ memoryManager: manager } as unknown as ConstructorParameters<typeof MemorySaveHandler>[0],
    memoryName => `handoff:${memoryName}`, { getContext: () => ({ type: 'test', timestamp: Date.now(),
      session: { userId: tenant, sessionId: 'owned-handoff-session', tenantId: null, transport: 'http', createdAt: 0 } }) });
  const consoleStore = new ManagerBackedPortfolioElementStore({ getCurrentUserId: () => tenant, managers: {
    personas: manager, skills: manager, templates: manager, agents: manager, memories: manager, ensembles: manager,
  } });
  const service = new PortfolioService(consoleStore, new InMemoryUserIntegrationStore(), new InMemoryPortfolioSyncJobStore());
  async function rows() {
    return await f.maintenance`SELECT id,status,envelope,digest,committed_token,envelope_bytes
      FROM public.memory_candidate_handoffs WHERE user_id=${f.userId}::uuid ORDER BY created_at,id`;
  }
  async function quota() {
    const [row] = await f.maintenance`SELECT retained_rows::integer AS rows,retained_bytes::text AS bytes,
      (SELECT count(*)::integer FROM public.memory_candidate_handoffs WHERE user_id=${f.userId}::uuid) AS actual_rows,
      (SELECT coalesce(sum(envelope_bytes),0)::text FROM public.memory_candidate_handoffs WHERE user_id=${f.userId}::uuid) AS actual_bytes
      FROM public.memory_candidate_quotas WHERE user_id=${f.userId}::uuid`;
    expect(row.rows).toBe(row.actual_rows); expect(row.bytes).toBe(row.actual_bytes); return row;
  }
  async function consoleUpdate(description: string) {
    const current = await consoleStore.findByName(f.userId, 'memories', f.name); expect(current).not.toBeNull();
    const req = { query: {}, body: { metadata: { ...current!.metadata, description } },
      headers: { 'if-match': portfolioElementEtag(current!) },
      consoleContext: { correlationId: randomUUID(), receivedAt: new Date() },
      consoleAuthentication: { userId: f.userId, sessionIdHash: Buffer.alloc(32, 7), authSub: 'owned', authzVersion: 1,
        grantedCapabilities: ['console:self'], elevation: null } } as unknown as ConsoleRequest;
    return await service.updateElement(req, 'memories', f.name);
  }
  phase(name, 'fixture-end');
  return { ...f, manager, composition, root, layer, request, consoleStore, service, rows, quota, consoleUpdate,
    tenant: (next: string) => { tenant = next; }, legacy, ordinary, admitted, prepare,
    done: () => { expect(legacy).not.toHaveBeenCalled(); expect(ordinary).not.toHaveBeenCalled(); phase(name, 'assertions-complete'); } };
}

required('bounded candidate handoff and owning publication on PostgreSQL', () => {
  it('reuses slots beyond 64 successful central saves and completes actual AQL/console tails', async () => {
    const f = await fixture('success-slot-reuse'); const memory = await f.manager.load(f.memoryId);
    f.admitted.mockImplementationOnce(async (...args) => {
      // Independently visible prepared evidence proves the handoff COMMIT
      // preceded this actual conditional-write callback.
      const rows = await f.rows(); expect(rows).toHaveLength(1); expect(rows[0].status).toBe('prepared');
      expect(decodeMemoryCandidate({ bytes: rows[0].envelope, digest: rows[0].digest }))
        .toMatchObject({ name: args[2], content: args[3], metadata: args[4] });
      return await f.prepare(...args);
    });
    for (let index = 0; index < 65; index++) {
      await memory.addEntry(`Known successful save ${index}`); await memory.save();
      expect(await f.rows()).toHaveLength(0); expect((await f.quota()).rows).toBe(0);
    }
    const receipt = await f.request.dispatch('addEntry', { element_name: f.name, content: 'Actual AQL tail' }) as { id: string };
    expect(receipt.id).toEqual(expect.any(String)); expect(await f.rows()).toHaveLength(0);
    const response = await f.consoleUpdate('Actual console service tail');
    expect(response.status).toBe(200); expect(response.headers?.ETag).toMatch(/^"sha256:/);
    expect(await f.rows()).toHaveLength(0); expect((await f.quota()).rows).toBe(0);
    expect((await f.layer.getEntries(f.memoryId)).map(entry => entry.content)).toContain('Known successful save 64');
    expect(f.admitted).toHaveBeenCalledTimes(67); f.done();
  });

  it('retains the exact refused candidate while full head/tag/child/volume state stays unchanged', async () => {
    const f = await fixture('cas-refusal'); const memory = await f.manager.load(f.memoryId);
    await memory.addEntry('Exact refused multibyte candidate λ🦋');
    await f.layer.addEntry(f.memoryId, { entryId: 'concurrent', timestamp: new Date(), content: 'Accepted other writer' });
    const before = await f.snapshot(); await expect(memory.save()).rejects.toMatchObject({ code: 'ESTALE' });
    expect(await f.snapshot()).toEqual(before); const rows = await f.rows(); expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('prepared'); expect(rows[0].committed_token).toBeNull();
    const candidate = decodeMemoryCandidate({ bytes: rows[0].envelope, digest: rows[0].digest });
    // Memory admission validates/normalizes the entry before serializing it.
    // Durable evidence must equal the actual complete CAS argument, not raw input.
    expect(f.admitted).toHaveBeenCalledTimes(1);
    const submitted = f.admitted.mock.calls[0];
    expect({ name: candidate.name, content: candidate.content, metadata: candidate.metadata })
      .toStrictEqual({ name: submitted[2], content: submitted[3], metadata: submitted[4] });
    expect(f.manager.getPendingHeadUpdate(memory)?.candidate).toMatchObject({ name: candidate.name, content: candidate.content, metadata: candidate.metadata });
    await withUserContext(f.db, f.userId, async tx => {
      expect(await tx.execute(sql`DELETE FROM public.memory_candidate_handoffs WHERE user_id=${f.userId}::uuid`)).toHaveLength(0);
    });
    expect(await f.rows()).toHaveLength(1); expect((await f.quota()).rows).toBe(1); f.done();
  });

  it('refuses missing quota and runtime quota tampering without any head dispatch', async () => {
    const f = await fixture('quota-tamper'); const before = await f.snapshot();
    await withUserContext(f.db, f.userId, async tx => {
      expect(await tx.execute(sql`UPDATE public.memory_candidate_quotas SET retained_rows=0 WHERE user_id=${f.userId}::uuid RETURNING user_id`)).toHaveLength(0);
      expect(await tx.execute(sql`DELETE FROM public.memory_candidate_quotas WHERE user_id=${f.userId}::uuid RETURNING user_id`)).toHaveLength(0);
    });
    await expect(withUserContext(f.db, f.foreignUserId, tx => tx.execute(sql`INSERT INTO public.memory_candidate_quotas(user_id) VALUES (${f.foreignUserId}::uuid)`)))
      .rejects.toThrow();
    await f.maintenance`DELETE FROM public.memory_candidate_quotas WHERE user_id=${f.userId}::uuid`;
    const memory = await f.manager.load(f.memoryId); await memory.addEntry('Unaccepted missing quota');
    await expect(memory.save()).rejects.toMatchObject({ cause: {
      code: '23514', message: 'Candidate handoff quota is unavailable'
    } });
    expect(f.admitted).not.toHaveBeenCalled();
    expect(await f.rows()).toHaveLength(0); expect(await f.snapshot()).toEqual(before); f.done();
  });

  it('enforces capacity atomically across independent SQL connections using actual stored bytes', async () => {
    const f = await fixture('concurrent-quota');
    const candidate = { name: f.name, content: 'Exact bounded retained copy',
      metadata: { author: 'test', version: '1', description: '', tags: [], extension: { undefinedValue: undefined, unicode: 'λ\ud800' } } };
    const encoded = encodeMemoryCandidate(candidate);
    const hash = createHash('sha256').update('fixture-owned-unexposed-retirement-secret').digest('hex');
    for (let index = 0; index < 63; index++) await withUserContext(f.db, f.userId, tx => tx.execute(sql`
      INSERT INTO public.memory_candidate_handoffs(id,user_id,envelope,digest,retire_hash,envelope_bytes)
      VALUES (${randomUUID()}::uuid,${f.userId}::uuid,${encoded.bytes},${encoded.digest},${hash},-999)`));
    const reserve = (client: typeof f.maintenance) => client.begin(async tx => {
      await tx`SELECT set_config('app.current_user_id',${f.userId},true)`;
      return await tx`INSERT INTO public.memory_candidate_handoffs(id,user_id,envelope,digest,retire_hash,envelope_bytes)
        VALUES (${randomUUID()}::uuid,${f.userId}::uuid,${encoded.bytes},${encoded.digest},${hash},0)`;
    });
    const outcomes = await Promise.allSettled([reserve(f.maintenance), reserve(f.competitor)]);
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1);
    const quota = await f.quota(); expect(quota.rows).toBe(64); expect(BigInt(quota.bytes)).toBe(BigInt(encoded.bytes.length) * 64n);
    const rows = await f.rows(); expect(rows.every(row => row.envelope_bytes === encoded.bytes.length)).toBe(true);
    expect(decodeMemoryCandidate({ bytes: rows[0].envelope, digest: rows[0].digest })).toEqual({ name: f.name,
      content: 'Exact bounded retained copy', metadata: { author: 'test', version: '1', description: '', tags: [],
        extension: { undefinedValue: undefined, unicode: 'λ\ud800' } } });
    await expect(withUserContext(f.db, f.userId, tx => tx.execute(sql`UPDATE public.memory_candidate_handoffs
      SET envelope=${Buffer.from('substitution')} WHERE id=${rows[0].id}::uuid`))).rejects.toMatchObject({ cause: {
        code: '23514', message: 'Candidate handoff evidence is immutable'
      } });
    await expect(withUserContext(f.db, f.userId, tx => tx.execute(sql`UPDATE public.memory_candidate_handoffs
      SET status='published' WHERE id=${rows[0].id}::uuid`))).rejects.toThrow();
    await withUserContext(f.db, f.foreignUserId, async tx => {
      expect(await tx.execute(sql`SELECT id FROM public.memory_candidate_handoffs WHERE user_id=${f.userId}::uuid`)).toHaveLength(0);
    });
    expect((await f.quota()).rows).toBe(64); f.done();
  });

  it.each(['handoff', 'head'] as const)('preserves exact evidence and closes boot after controlled %s completion loss', async stage => {
    const f = await fixture(`${stage}-completion-loss`); const memory = await f.manager.load(f.memoryId);
    await memory.addEntry(`Exact ${stage} uncertain attempt`); const before = await f.snapshot();
    const cause = new Error(`Controlled ${stage} completion loss`); const original = f.db.transaction.bind(f.db);
    let count = 0;
    const spy = jest.spyOn(f.db, 'transaction').mockImplementation(async body => {
      const result = await original(body);
      // Saving uses handoff transaction then head transaction, without an intervening read.
      if (++count === (stage === 'handoff' ? 1 : 2)) throw cause;
      return result;
    });
    await expect(memory.save()).rejects.toBe(cause); spy.mockRestore();
    const rows = await f.rows(); expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(stage === 'handoff' ? 'prepared' : 'committed');
    expect(decodeMemoryCandidate({ bytes: rows[0].envelope, digest: rows[0].digest }).content).toContain(`Exact ${stage} uncertain attempt`);
    expect(f.manager.getPendingHeadUpdate(memory)).toMatchObject({ status: 'unknown', cause });
    if (stage === 'handoff') { expect(f.admitted).not.toHaveBeenCalled(); expect(await f.snapshot()).toEqual(before); }
    else { expect(rows[0].committed_token).toMatchObject({ ...(await f.layer.readHeadSnapshot(f.memoryId)).token }); }
    await expect(f.manager.load(f.memoryId)).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    await expect(f.composition.qualify(async () => {})).rejects.toThrow('Retained memory outcomes');
    expect((await f.quota()).rows).toBe(1); f.done();
  });

  it('retains prepared evidence on controlled failed head completion and never invents known rollback', async () => {
    const f = await fixture('failed-head-completion'); const memory = await f.manager.load(f.memoryId);
    await memory.addEntry('Must stay recoverable after failed completion'); const before = await f.snapshot();
    const cause = new Error('Controlled precommit completion failure'); const original = f.db.transaction.bind(f.db); let count = 0;
    const spy = jest.spyOn(f.db, 'transaction').mockImplementation(body => ++count === 2
      ? original(async tx => { await body(tx); throw cause; }) : original(body));
    await expect(memory.save()).rejects.toBe(cause); spy.mockRestore();
    expect(await f.snapshot()).toEqual(before); expect((await f.rows())[0]).toMatchObject({ status: 'prepared', committed_token: null });
    expect(f.manager.getPendingHeadUpdate(memory)).toMatchObject({ status: 'unknown', cause });
    expect((await f.quota()).rows).toBe(1); f.done();
  });

  it('rechecks closed admission after handoff delivery before any head dispatch', async () => {
    const f = await fixture('close-before-dispatch'); const memory = await f.manager.load(f.memoryId);
    await memory.addEntry('Exact closed-before-dispatch candidate'); const before = await f.snapshot();
    const original = f.db.transaction.bind(f.db);
    const spy = jest.spyOn(f.db, 'transaction').mockImplementationOnce(async body => {
      const value = await original(body); f.composition.close(); return value;
    });
    await expect(memory.save()).rejects.toMatchObject({ code: 'EMEMORYBOOT' }); spy.mockRestore();
    expect(f.admitted).not.toHaveBeenCalled(); expect(await f.snapshot()).toEqual(before);
    const rows = await f.rows(); expect(rows).toHaveLength(1); expect(rows[0].status).toBe('prepared');
    expect(decodeMemoryCandidate({ bytes: rows[0].envelope, digest: rows[0].digest }).content).toContain('Exact closed-before-dispatch candidate');
    expect((await f.quota()).rows).toBe(1); f.done();
  });

  it.each(['central', 'aql', 'console'] as const)('keeps committed candidates when the actual %s owning tail fails', async kind => {
    const f = await fixture(`${kind}-publication-failure`); const cause = new Error('Controlled owning tail failure');
    if (kind === 'central') {
      const memory = await f.manager.load(f.memoryId); await memory.addEntry('Committed central tail');
      jest.spyOn(f.manager as unknown as { afterSave: (element: unknown, locator: string) => Promise<void> }, 'afterSave')
        .mockRejectedValueOnce(cause);
      await expect(memory.save()).rejects.toBe(cause);
      expect(f.manager.getPendingHeadUpdate(memory)).toMatchObject({ status: 'committed-publication-failed', cause });
    } else if (kind === 'aql') {
      const observe = SecurityMonitor.logSecurityEvent.bind(SecurityMonitor);
      jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(event => {
        if (event.source === 'MemorySaveHandler.guardedMutation') throw cause;
        observe(event);
      });
      await expect(f.request.dispatch('addEntry', { element_name: f.name, content: 'Committed AQL tail' })).rejects.toBe(cause);
    } else {
      const update = f.consoleStore.update.bind(f.consoleStore);
      jest.spyOn(f.consoleStore, 'update').mockImplementation(async input => {
        const record = await update(input);
        if (record) Object.defineProperty(record, 'updatedAt', { get: () => { throw cause; } });
        return record;
      });
      await expect(f.consoleUpdate('Committed console tail')).rejects.toBe(cause);
    }
    const rows = await f.rows(); expect(rows).toHaveLength(1); expect(rows[0].status).toBe('committed');
    expect(rows[0].committed_token).toMatchObject({ ...(await f.layer.readHeadSnapshot(f.memoryId)).token });
    const quota = await f.quota(); expect(quota.rows).toBe(1); expect(Number(quota.bytes)).toBeGreaterThan(rows[0].envelope.length);
    f.done();
  });

  it('keeps known committed and published success when retirement delivery is lost', async () => {
    const f = await fixture('retirement-loss'); const memory = await f.manager.load(f.memoryId);
    await memory.addEntry('Known success despite lost cleanup delivery'); const original = f.db.transaction.bind(f.db);
    const cause = new Error('Controlled lost retirement completion'); let count = 0;
    const spy = jest.spyOn(f.db, 'transaction').mockImplementation(async body => {
      const result = await original(body); if (++count === 3) throw cause; return result;
    });
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent'); await expect(memory.save()).resolves.toBeUndefined();
    spy.mockRestore(); expect(f.manager.getPendingHeadUpdate(memory)).toBeUndefined();
    expect((await f.layer.readHeadSnapshot(f.memoryId)).content).toContain('Known success despite lost cleanup delivery');
    expect(await f.rows()).toHaveLength(0); expect((await f.quota()).rows).toBe(0);
    expect(audit.mock.calls.some(([event]) => event.source === 'DatabaseMemoryCandidateHandoff' &&
      event.details.includes('head-outcome=known-committed; application-publication=completed'))).toBe(true);
    f.done();
  });

  it('starts a separately constructed controller closed and cannot recover admission from stored evidence', async () => {
    const f = await fixture('fresh-process-closed'); const memory = await f.manager.load(f.memoryId);
    await memory.addEntry('Preserved across controller replacement');
    jest.spyOn(f.manager as unknown as { afterSave: (element: unknown, locator: string) => Promise<void> }, 'afterSave')
      .mockRejectedValueOnce(new Error('Controlled unfinished publication'));
    await expect(memory.save()).rejects.toThrow(); const directory = await mkdtemp(path.join(os.tmpdir(), 'memory-fresh-boot-pg-'));
    let fresh!: DormantDurableMemoryComposition;
    const root = admittedMemoryContainer(f.db, () => f.userId, directory, factory => deps => {
      fresh = factory.createDurableAdmittedMemoryManager(deps, () => ({ contextRoot: directory, sessionId: 'fresh', transport: 'http' }));
      return fresh.manager;
    });
    try {
      const manager = root.manager(); const before = await f.snapshot();
      await expect(manager.load(f.memoryId)).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
      expect((await fresh.inspectRetained())[0].candidate.content).toContain('Preserved across controller replacement');
      await expect(fresh.qualify(async () => {})).rejects.toThrow('Retained memory outcomes');
      expect(await f.snapshot()).toEqual(before); expect((await f.quota()).rows).toBe(1);
    } finally { await root.container.dispose(); await rm(directory, { recursive: true, force: true }); }
    f.done();
  });
});
