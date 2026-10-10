/** Dormant normal-server foreground proof on the existing CI-owned PostgreSQL service. */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE as profile } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { DatabaseMemoryReconciliationInspector } from '../../../src/storage/DatabaseMemoryReconciliationInspector.js';
import { MemorySaveHandler } from '../../../src/handlers/mcp-aql/MemorySaveHandler.js';
import { ManagerBackedPortfolioElementStore } from '../../../src/web-console/stores/ManagerBackedPortfolioElementStore.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import type { Memory } from '../../../src/elements/memories/Memory.js';
import type { ElementCrudContext } from '../../../src/handlers/element-crud/types.js';
import { editElement } from '../../../src/handlers/element-crud/editElement.js';
import { upgradeElement } from '../../../src/handlers/element-crud/upgradeElement.js';
import type { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { admittedMemoryContainer } from '../../helpers/storage/admitted-memory-container.js';
import { makeEquivalentFixture, type EquivalentFixture } from './fixtures/2905-equivalent-reconciliation-fixture.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
function phase(name: string, value: string) { console.info(`[db-foreground:${name}] ${value}`); }
const owned: { name: string; f: EquivalentFixture; directory?: string; dispose?: () => Promise<void> }[] = [];
afterEach(async () => {
  jest.restoreAllMocks();
  for (const item of owned.splice(0)) {
    phase(item.name, 'cleanup-start');
    const errors: unknown[] = [];
    try { await item.dispose?.(); } catch (cause) { errors.push(cause); }
    try { await item.f.cleanup(); } catch (cause) { errors.push(cause); }
    if (item.directory) try { await rm(item.directory, { recursive: true, force: true }); } catch (cause) { errors.push(cause); }
    if (errors.length) throw new AggregateError(errors, 'Owned foreground cleanup failed');
    phase(item.name, 'cleanup-end');
  }
});
async function fixture(name: string) {
  phase(name, 'fixture-start'); const f = await makeEquivalentFixture();
  const item: typeof owned[number] = { name, f }; owned.push(item);
  expect(await new DatabaseMemoryReconciliationInspector(f.db, () => f.userId)
    .inspect({ userId: f.userId, memoryId: f.memoryId })).toMatchObject({ status: 'equivalent', dirty: true });
  // Disposable fixture preparation only; this is not production eligibility authority.
  await f.maintenance`UPDATE public.elements SET memory_entries_out_of_sync=false WHERE id=${f.memoryId}::uuid`;
  await f.layer.writeContent('memories', f.name, `${f.raw}\ninstructions: Preserve foreground instructions\nextensions:\n  evidence: preserved\n`,
    { author: 'test-author', version: '1.0.0', description: '', tags: [] });
  await f.maintenance`INSERT INTO public.memory_backend_modes(user_id,backend,protocol_version,profile,mode,generation)
    VALUES (${f.userId}::uuid,'database',1,${profile},'guarded',1)`;
  item.directory = await mkdtemp(path.join(os.tmpdir(), 'memory-foreground-pg-'));
  let user: string = f.userId;
  let layer!: DatabaseMemoryStorageLayer;
  const root = admittedMemoryContainer(f.db, () => user, item.directory, factory => {
    const create = factory.createForElement.bind(factory);
    jest.spyOn(factory, 'createForElement').mockImplementation((type, options) => {
      const created = create(type, options);
      if (type === 'memories') layer = created as DatabaseMemoryStorageLayer;
      return created;
    });
    return factory.createAdmittedMemoryManager.bind(factory);
  });
  item.dispose = () => root.container.dispose();
  const manager = root.manager(); expect(manager.isGuardedHeadUpdateEnabled()).toBe(true);
  const ordinary = jest.spyOn(layer, 'writeHeadIfCurrent'); const legacy = jest.spyOn(layer, 'writeContent');
  const admitted = jest.spyOn(layer, 'prepareHeadWriteInAdmission');
  const request = new MemorySaveHandler({ memoryManager: manager } as unknown as ConstructorParameters<typeof MemorySaveHandler>[0],
    memoryName => `foreground:${memoryName}`, { getContext: () => ({ type: 'test', timestamp: Date.now(),
      session: { userId: user, sessionId: 'owned-foreground-session', tenantId: null, transport: 'http', createdAt: 0 } }) });
  const consoleStore = new ManagerBackedPortfolioElementStore({ getCurrentUserId: () => user, managers: {
    personas: manager, skills: manager, templates: manager, agents: manager, memories: manager, ensembles: manager,
  } });
  phase(name, 'fixture-end');
  return { ...f, manager, layer, request, consoleStore, ordinary, legacy, admitted,
    user: (next: string) => { user = next; }, done: () => {
      expect(ordinary).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled(); phase(name, 'assertions-complete');
    } };
}
function barrier() {
  let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function cacheProbe(manager: MemoryManager) {
  return jest.spyOn(manager as unknown as { cacheElement(memory: Memory, locator: string): void }, 'cacheElement');
}
required('normal server dormant database foreground composition', () => {
  it('Memory.save uses the actual admitted layer and preserves full existing entries', async () => {
    const f = await fixture('central-save'); const before = await f.layer.readHeadSnapshot(f.memoryId);
    const memory = await f.manager.load(f.memoryId); await memory.addEntry('Normal DI central save', ['accepted']);
    await memory.save();
    const after = await f.layer.readHeadSnapshot(f.memoryId);
    expect(BigInt(after.token.revision)).toBeGreaterThan(BigInt(before.token.revision));
    expect(after.content).toContain('Preserved entry'); expect(after.content).toContain('Normal DI central save');
    expect((await f.layer.getEntries(f.memoryId)).map(entry => entry.content)).toContain('Normal DI central save');
    const loaded = await f.manager.load(f.memoryId);
    expect(loaded.instructions).toBe('Preserve foreground instructions');
    expect(loaded.extensions).toEqual({ evidence: 'preserved' });
    expect(loaded.metadata.author).toBe('test-author');
    expect(f.admitted).toHaveBeenCalledTimes(1); f.done();
  });
  it('immediate AQL append and clear commit through the normal manager before returning receipts', async () => {
    const f = await fixture('aql-append-clear'); const before = await f.layer.readHeadSnapshot(f.memoryId);
    const receipt = await f.request.dispatch('addEntry', { element_name: f.name, content: 'Normal DI AQL append' }) as { id: string };
    expect(receipt.id).toEqual(expect.any(String));
    const appended = await f.layer.readHeadSnapshot(f.memoryId); expect(appended.content).toContain(receipt.id);
    await f.request.dispatch('clear', { element_name: f.name });
    expect((await f.layer.getEntries(f.memoryId))).toHaveLength(0);
    expect((await f.manager.load(f.memoryId)).getEntries().size).toBe(0);
    expect(BigInt((await f.layer.readHeadSnapshot(f.memoryId)).token.revision)).toBeGreaterThan(BigInt(before.token.revision));
    expect(f.admitted).toHaveBeenCalledTimes(2); f.done();
  });
  it('console UPDATE honors its actual raw-content precondition and publishes the committed ETag', async () => {
    const f = await fixture('console-update');
    const observed = await f.consoleStore.findByName(f.userId, 'memories', f.name); expect(observed).not.toBeNull();
    const response = await f.consoleStore.update({ userId: f.userId, type: 'memories', canonicalName: f.name,
      expectedVersion: 1, expectedContentHash: observed!.contentHash, metadata: { description: 'Normal DI console update' },
      now: new Date('2026-10-07T03:00:00Z') });
    expect(response?.metadata.description).toBe('Normal DI console update');
    expect(response?.contentHash).toBe((await f.consoleStore.findByName(f.userId, 'memories', f.name))?.contentHash);
    expect((await f.layer.getEntries(f.memoryId)).map(entry => entry.entryId)).toEqual(['one']);
    expect(f.admitted).toHaveBeenCalledTimes(1); f.done();
  });
  it('delays manager cache, success audit and API completion until outer COMMIT completion is delivered', async () => {
    const f = await fixture('commit-barrier'); const memory = await f.manager.load(f.memoryId);
    await memory.addEntry('Held completion delivery');
    const cache = cacheProbe(f.manager); const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    const entered = barrier(); const resume = barrier(); const original = f.db.transaction.bind(f.db);
    jest.spyOn(f.db, 'transaction').mockImplementationOnce(async body => {
      const value = await original(body); entered.release(); await resume.promise; return value;
    });
    let settled = false;
    const pending = memory.save().finally(() => { settled = true; });
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Save settled before held outer completion'); })]);
      expect(settled).toBe(false); expect(cache).not.toHaveBeenCalled();
      expect(audit.mock.calls.some(([event]) => event.type === 'ELEMENT_EDITED')).toBe(false);
    } finally { resume.release(); await pending; }
    expect(cache).toHaveBeenCalledTimes(1); expect(audit.mock.calls.some(([event]) => event.type === 'ELEMENT_EDITED')).toBe(true);
    f.done();
  });
  it('rejects stale child authority with the complete current database snapshot preserved', async () => {
    const f = await fixture('stale-child'); const memory = await f.manager.load(f.memoryId);
    await memory.addEntry('Unaccepted stale candidate');
    await f.layer.addEntry(f.memoryId, { entryId: 'concurrent', timestamp: new Date('2026-10-07T03:00:00Z'), content: 'Accepted competing child' });
    const before = await f.snapshot();
    await expect(memory.save()).rejects.toMatchObject({ code: 'ESTALE' });
    expect(await f.snapshot()).toEqual(before);
    expect(f.manager.getPendingHeadUpdate(memory)).toMatchObject({ status: 'refused', candidate: { content: expect.stringContaining('Unaccepted stale candidate') } });
    f.done();
  });
  it('refuses effective tenant drift before authoritative writes', async () => {
    const f = await fixture('tenant-drift'); const memory = await f.manager.load(f.memoryId); const before = await f.snapshot();
    await memory.addEntry('Unaccepted wrong tenant'); f.user(f.foreignUserId);
    await expect(memory.save()).rejects.toThrow(); expect(await f.snapshot()).toEqual(before);
    expect(f.admitted).not.toHaveBeenCalled(); f.done();
  });
  it('refuses changed durable mode and unknown completion without publication or ordinary fallback', async () => {
    const f = await fixture('mode-and-unknown'); const memory = await f.manager.load(f.memoryId);
    await memory.addEntry('Refused read-only update');
    await f.maintenance`UPDATE public.memory_backend_modes SET mode='read_only' WHERE user_id=${f.userId}::uuid`;
    const before = await f.snapshot(); await expect(memory.save()).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    expect(await f.snapshot()).toEqual(before);
    await f.maintenance`UPDATE public.memory_backend_modes SET mode='guarded' WHERE user_id=${f.userId}::uuid`;
    const current = await f.manager.load(f.memoryId); await current.addEntry('Committed but unknown completion');
    const original = f.db.transaction.bind(f.db); const cause = new Error('Controlled lost commit completion');
    const cache = cacheProbe(f.manager);
    jest.spyOn(f.db, 'transaction').mockImplementationOnce(async body => { await original(body); throw cause; });
    await expect(current.save()).rejects.toBe(cause); expect(cache).not.toHaveBeenCalled();
    expect(f.manager.getPendingHeadUpdate(current)).toMatchObject({ status: 'unknown', cause,
      candidate: { content: expect.stringContaining('Committed but unknown completion') } });
    expect((await f.layer.readHeadSnapshot(f.memoryId)).content).toContain('Committed but unknown completion');
    f.done();
  });
  it('refuses unsupported foreground operations before discovery with the complete head unchanged', async () => {
    const f = await fixture('unsupported-foreground'); const before = await f.snapshot();
    const ensureInitialized = jest.fn(async () => { throw new Error('Unsupported path initialized'); });
    const lookup = jest.spyOn(f.manager, 'findByName');
    const context = { memoryManager: f.manager, ensureInitialized } as unknown as ElementCrudContext;
    expect(JSON.stringify(await editElement(context, { name: f.name, type: 'memory', input: { name: 'renamed' } }))).toContain('Guarded memory');
    expect(JSON.stringify(await upgradeElement(context, { name: f.name, type: 'memories', dry_run: true }))).toContain('Guarded memory');
    await expect(f.manager.importElement('not JSON', 'json')).rejects.toThrow('UPDATE only');
    await expect(f.manager.create({ name: 'new', description: 'Unsupported' })).rejects.toThrow('UPDATE only');
    await expect(f.manager.delete(f.name)).rejects.toThrow('UPDATE only');
    expect(ensureInitialized).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
    expect(f.admitted).not.toHaveBeenCalled(); expect(await f.snapshot()).toEqual(before); f.done();
  });
  it('preserves logical row authority for canonical legacy YAML names and refuses an incompatible owner', async () => {
    const f = await fixture('logical-yaml-name');
    await f.layer.writeContent('memories', f.name, f.raw.replace(`name: ${f.name}`, 'name: R&D'),
      { author: 'test-author', version: '1.0.0', description: '', tags: [] });
    f.legacy.mockClear();
    await f.maintenance`UPDATE public.elements SET name='RD' WHERE id=${f.memoryId}::uuid`;
    const central = await f.manager.load(f.memoryId); expect(central.metadata.name).toBe('RD');
    await central.addEntry('Logical-row central update'); await central.save();
    await f.request.dispatch('addEntry', { element_name: 'RD', content: 'Logical-row AQL update' });
    expect((await f.layer.readHeadSnapshot(f.memoryId)).token.name).toBe('RD');
    expect((await f.layer.getEntries(f.memoryId)).map(entry => entry.content)).toEqual(expect.arrayContaining(['Logical-row central update', 'Logical-row AQL update']));
    await f.maintenance`UPDATE public.elements SET name='R&D' WHERE id=${f.memoryId}::uuid`;
    const before = await f.snapshot(); const writes = f.admitted.mock.calls.length;
    await expect(f.manager.load(f.memoryId)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    await expect(f.request.dispatch('addEntry', { element_name: 'RD', content: 'Must remain unaccepted' })).rejects.toThrow();
    expect(f.admitted).toHaveBeenCalledTimes(writes); expect(await f.snapshot()).toEqual(before); f.done();
  });
});
