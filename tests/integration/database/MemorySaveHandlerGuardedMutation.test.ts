/** Actual guarded AQL requests on independently owned required-CI PostgreSQL fixtures. */
import { describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Memory } from '../../../src/elements/memories/Memory.js';
import { MemorySaveHandler } from '../../../src/handlers/mcp-aql/MemorySaveHandler.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { DatabaseMemoryReconciliationInspector } from '../../../src/storage/DatabaseMemoryReconciliationInspector.js';
import { MemoryHeadUpdateAdapter } from '../../../src/storage/MemoryHeadUpdateAdapter.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { MetadataService } from '../../../src/services/MetadataService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { makeEquivalentFixture, type EquivalentFixture } from './fixtures/2905-equivalent-reconciliation-fixture.js';

class PublicationObservedManager extends MemoryManager {
  publicationFailure?: Error;
  protected override async afterSave(memory: Memory, locator: string): Promise<void> {
    await super.afterSave(memory, locator);
    if (this.publicationFailure) throw this.publicationFailure;
  }
}
const requiredDescribe = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
async function isolated(body: (f: EquivalentFixture, makeManager: (getUser?: () => string) => Promise<{
  manager: PublicationObservedManager; adapter: MemoryHeadUpdateAdapter; layer: DatabaseMemoryStorageLayer;
}>) => Promise<void>): Promise<void> {
  const f = await makeEquivalentFixture();
  const managers: MemoryManager[] = [];
  const directories: string[] = [];
  let primary: { cause: unknown } | undefined;
  try {
    // Disposable test setup only: verify equivalence before resetting the fixture dirty marker.
    // This direct reset is not a maintenance qualification procedure or production authority.
    const seeded = await f.snapshot();
    expect(await new DatabaseMemoryReconciliationInspector(f.db, () => f.userId)
      .inspect({ userId: f.userId, memoryId: f.memoryId }))
      .toMatchObject({ status: 'equivalent', dirty: true, canApply: false });
    expect(await f.snapshot()).toEqual(seeded);
    await f.maintenance`UPDATE public.elements SET memory_entries_out_of_sync=false WHERE id=${f.memoryId}::uuid`;
    await body(f, async (getUser = () => f.userId) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'memory-update-pg-'));
      directories.push(directory);
      const metadataService = new MetadataService();
      const fileLockManager = new FileLockManager();
      const fileOperationsService = new FileOperationsService(fileLockManager);
      const layer = new DatabaseMemoryStorageLayer(f.db, getUser);
      const adapter = new MemoryHeadUpdateAdapter({ backend: 'database', store: layer }, getUser);
      const manager = new PublicationObservedManager({
        portfolioManager: new PortfolioManager(fileOperationsService, { baseDir: directory }), fileLockManager,
        fileOperationsService, validationRegistry: new ValidationRegistry(
          new ValidationService(), new TriggerValidationService(), metadataService),
        serializationService: new SerializationService(), metadataService,
        eventDispatcher: new ElementEventDispatcher(), getCurrentUserId: getUser,
        storageLayerFactory: { createForElement: () => layer },
      }, adapter);
      managers.push(manager);
      return { manager, adapter, layer };
    });
  } catch (cause) { primary = { cause }; }
  const cleanupFailures: unknown[] = [];
  for (const manager of managers) {
    try { manager.dispose(); } catch (cause) { cleanupFailures.push(cause); }
  }
  try { await f.cleanup(); } catch (cause) { cleanupFailures.push(cause); }
  for (const directory of directories) {
    try { await rm(directory, { recursive: true, force: true }); } catch (cause) { cleanupFailures.push(cause); }
  }
  if (cleanupFailures.length) throw new AggregateError([
    ...(primary ? [primary.cause] : []), ...cleanupFailures,
  ], 'Manager assertion or owned cleanup failed');
  if (primary) throw primary.cause;
}

function handler(manager: MemoryManager, getUser: () => string) {
  const context = () => ({ type: 'test' as const, timestamp: Date.now(), session: {
    userId: getUser(), sessionId: 'owned-pg-request', tenantId: null, transport: 'http' as const, createdAt: 0,
  } });
  return new MemorySaveHandler({ memoryManager: manager } as ConstructorParameters<typeof MemorySaveHandler>[0],
    name => `owned-pg-request:${name}`, { getContext: context });
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function captureCandidate(manager: MemoryManager) {
  const derive = manager.deriveGuardedMutation.bind(manager);
  const captured: { memory?: Memory; source?: Memory } = {};
  jest.spyOn(manager, 'deriveGuardedMutation').mockImplementation(source => {
    captured.source = source; captured.memory = derive(source); return captured.memory;
  });
  return captured;
}

requiredDescribe('actual guarded immediate AQL requests with owned PostgreSQL', () => {
  it('dispatch append and clear commit before receipt and preserve metadata, instructions and extensions', () => isolated(async (f, makeManager) => {
    const raw = `${f.raw}\ninstructions: Preserve instructions\nextensions:\n  evidence: preserved\n`;
    await f.layer.writeContent('memories', f.name, raw, { author: 'test-author', version: '1.0.0', description: '', tags: [] });
    const { manager, layer } = await makeManager();
    const request = handler(manager, () => f.userId);
    const legacy = jest.spyOn(layer, 'writeContent');
    const before = await f.layer.readHeadSnapshot(f.memoryId);
    const receipt = await request.dispatch('addEntry', { element_name: f.name, content: 'Committed AQL entry' }) as { id: string };
    expect(typeof receipt.id).toBe('string');
    const appended = await f.layer.readHeadSnapshot(f.memoryId);
    expect(appended.content).toContain(receipt.id);
    expect(appended.content).toContain('Committed AQL entry');
    const runtime = await manager.load(f.memoryId);
    expect(runtime.instructions).toBe('Preserve instructions');
    expect(runtime.extensions).toEqual({ evidence: 'preserved' });
    expect(runtime.metadata.author).toBe('test-author');
    expect(BigInt(appended.token.revision)).toBeGreaterThan(BigInt(before.token.revision));
    await request.dispatch('clear', { element_name: f.name });
    const cleared = await f.layer.readHeadSnapshot(f.memoryId);
    expect(BigInt(cleared.token.revision)).toBeGreaterThan(BigInt(appended.token.revision));
    const after = await manager.load(f.memoryId);
    expect(after.getEntries().size).toBe(0);
    expect(after.instructions).toBe('Preserve instructions');
    expect(after.extensions).toEqual({ evidence: 'preserved' });
    expect(after.metadata.author).toBe('test-author');
    expect(legacy).not.toHaveBeenCalled();
  }));

  it.each(['child', 'tag'] as const)('actual %s edit after derivation rejects original authority and flush cannot replay', kind => isolated(async (f, makeManager) => {
    const { manager } = await makeManager();
    const captured = captureCandidate(manager);
    const entered = gate(); const resume = gate();
    const validate = manager.assertPersistable.bind(manager);
    jest.spyOn(manager, 'assertPersistable').mockImplementation(async memory => {
      entered.release(); await resume.promise; return validate(memory);
    });
    const request = handler(manager, () => f.userId);
    const pending = request.dispatch('addEntry', { element_name: f.name, content: 'Retained original-authority attempt' });
    const outcome = pending.then(value => ({ value }), cause => ({ cause }));
    try {
      await Promise.race([entered.promise, outcome.then(result => { if ('cause' in result) throw result.cause; throw new Error('Request settled before required validation barrier'); })]);
      expect(captured.memory).toBeDefined();
      if (kind === 'child') await f.layer.addEntry(f.memoryId, { entryId: 'accepted-child', timestamp: new Date('2026-10-04T12:00:00Z'), content: 'Concurrent accepted child' });
      else await f.ordinary.begin(async tx => {
        await tx`SELECT pg_catalog.set_config('app.current_user_id',${f.userId},true)`;
        await tx`INSERT INTO public.element_tags(element_id,user_id,tag) VALUES (${f.memoryId}::uuid,${f.userId}::uuid,'accepted-tag')`;
      });
      const changed = await f.snapshot(); resume.release();
      expect(await outcome).toMatchObject({ cause: { code: 'ESTALE' } });
      expect(request.getPendingGuardedMutation(f.name)).toMatchObject({ status: 'refused', candidate: captured.memory, manager });
      expect(manager.getPendingHeadUpdate(captured.memory!)?.candidate?.content).toContain('Retained original-authority attempt');
      await request.flushPendingSaves();
      await expect(request.dispatch('clear', { element_name: f.name })).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect(await f.snapshot()).toEqual(changed);
    } finally { resume.release(); await outcome; }
  }));

  it('a direct source save wins the real CAS and the derived append cannot refresh its old authority', () => isolated(async (f, makeManager) => {
    const { manager } = await makeManager(); const captured = captureCandidate(manager);
    const entered = gate(); const resume = gate(); const validate = manager.assertPersistable.bind(manager);
    jest.spyOn(manager, 'assertPersistable').mockImplementation(async memory => { entered.release(); await resume.promise; return validate(memory); });
    const request = handler(manager, () => f.userId);
    const pending = request.dispatch('addEntry', { element_name: f.name, content: 'Stale derived append' });
    const outcome = pending.then(value => ({ value }), cause => ({ cause }));
    try {
      await Promise.race([entered.promise, outcome.then(result => { if ('cause' in result) throw result.cause; throw new Error('Request settled before required validation barrier'); })]); expect(captured.source).toBeDefined();
      await captured.source!.addEntry('Accepted direct source edit'); await manager.save(captured.source!);
      const committed = await f.snapshot(); resume.release();
      expect(await outcome).toMatchObject({ cause: { code: 'ESTALE' } });
      expect(await f.snapshot()).toEqual(committed);
      expect((await f.layer.readHeadSnapshot(f.memoryId)).content).toContain('Accepted direct source edit');
      expect(manager.getPendingHeadUpdate(captured.memory!)?.candidate?.content).toContain('Stale derived append');
    } finally { resume.release(); await outcome; }
  }));

  it('a dirty head refuses the public name route with no mutation', () => isolated(async (f, makeManager) => {
    await f.layer.addEntry(f.memoryId, { entryId: 'dirty', timestamp: new Date('2026-10-04T13:00:00Z'), content: 'Accepted divergent child' });
    const before = await f.snapshot(); const { manager } = await makeManager();
    await expect(handler(manager, () => f.userId).dispatch('addEntry', { element_name: f.name, content: 'Refused' }))
      .rejects.toMatchObject({ code: 'EHEADOUTOFSYNC' });
    expect(await f.snapshot()).toEqual(before);
  }));

  it('tenant switching after derivation cannot publish into another owner and foreign RLS cannot resolve target', () => isolated(async (f, makeManager) => {
    let tenant = f.userId; const { manager } = await makeManager(() => tenant);
    const entered = gate(); const resume = gate(); const validate = manager.assertPersistable.bind(manager);
    jest.spyOn(manager, 'assertPersistable').mockImplementation(async memory => { entered.release(); await resume.promise; return validate(memory); });
    const request = handler(manager, () => tenant);
    const pending = request.dispatch('addEntry', { element_name: f.name, content: 'Wrong-tenant attempted entry' });
    const outcome = pending.then(value => ({ value }), cause => ({ cause }));
    try {
      await Promise.race([entered.promise, outcome.then(result => { if ('cause' in result) throw result.cause; throw new Error('Request settled before required validation barrier'); })]); const before = await f.snapshot(); tenant = f.foreignUserId; resume.release();
      expect(await outcome).toMatchObject({ cause: { code: 'EHEADCONFLICT' } });
      const foreign = await makeManager(() => f.foreignUserId);
      await expect(handler(foreign.manager, () => f.foreignUserId).dispatch('clear', { element_name: f.name })).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect(await f.snapshot()).toEqual(before);
    } finally { resume.release(); await outcome; }
  }));

  it('actual commit followed by injected publication failure retains known outcome and never replays on flush', () => isolated(async (f, makeManager) => {
    const { manager } = await makeManager(); const captured = captureCandidate(manager);
    const failure = new Error('Controlled postcommit publication failure'); manager.publicationFailure = failure;
    const request = handler(manager, () => f.userId);
    await expect(request.dispatch('addEntry', { element_name: f.name, content: 'Committed once despite publication failure' })).rejects.toBe(failure);
    const pending = manager.getPendingHeadUpdate(captured.memory!);
    expect(pending?.status).toBe('committed-publication-failed'); expect(pending?.cause).toBe(failure);
    expect(pending?.committedToken).toBeDefined();
    expect(request.getPendingGuardedMutation(f.name)).toMatchObject({ status: 'known-committed', candidate: captured.memory, manager, cause: failure });
    const committed = await f.snapshot();
    expect((await f.layer.readHeadSnapshot(f.memoryId)).content).toContain('Committed once despite publication failure');
    manager.publicationFailure = undefined;
    await request.flushPendingSaves();
    await expect(request.dispatch('addEntry', { element_name: f.name, content: 'Must not replay' })).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect(await f.snapshot()).toEqual(committed);
  }));
});
