/** Actual dormant console UPDATE on uniquely owned required-CI PostgreSQL fixtures. */
import { describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Memory } from '../../../src/elements/memories/Memory.js';
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
import { ManagerBackedPortfolioElementStore } from '../../../src/web-console/stores/ManagerBackedPortfolioElementStore.js';
import { PortfolioElementVersionConflictError } from '../../../src/web-console/stores/IPortfolioElementStore.js';
import { makeEquivalentFixture, type EquivalentFixture } from './fixtures/2905-equivalent-reconciliation-fixture.js';

class ObservedManager extends MemoryManager {
  publicationFailure?: Error;
  protected override async afterSave(memory: Memory, locator: string): Promise<void> {
    await super.afterSave(memory, locator);
    if (this.publicationFailure) throw this.publicationFailure;
  }
}
function phase(label: string, name: string): void {
  process.stderr.write(`CONSOLE_MEMORY_PG_PHASE ${JSON.stringify({ case: label, phase: name })}\n`);
}
phase('suite', 'module-loaded');
const requiredDescribe = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
type Context = { f: EquivalentFixture; manager: ObservedManager; layer: DatabaseMemoryStorageLayer;
  store: ManagerBackedPortfolioElementStore; mark: (name: string) => void };
async function isolated(label: string, body: (context: Context) => Promise<void>): Promise<void> {
  const mark = (name: string) => phase(label, name);
  mark('fixture-start');
  const f = await makeEquivalentFixture();
  let directory: string | undefined;
  let manager: ObservedManager | undefined;
  let primary: { cause: unknown } | undefined;
  try {
    mark('fixture-ready');
    const original = await f.snapshot();
    expect(await new DatabaseMemoryReconciliationInspector(f.db, () => f.userId)
      .inspect({ userId: f.userId, memoryId: f.memoryId }))
      .toMatchObject({ status: 'equivalent', dirty: true, canApply: false });
    expect(await f.snapshot()).toEqual(original);
    // Disposable fixture only; equivalent data is proven before clearing the test marker.
    await f.maintenance`UPDATE public.elements SET memory_entries_out_of_sync=false WHERE id=${f.memoryId}::uuid`;
    directory = await mkdtemp(path.join(os.tmpdir(), 'console-memory-pg-'));
    const metadataService = new MetadataService();
    const fileLockManager = new FileLockManager();
    const fileOperationsService = new FileOperationsService(fileLockManager);
    const getUser = () => f.userId;
    const layer = new DatabaseMemoryStorageLayer(f.db, getUser);
    const adapter = new MemoryHeadUpdateAdapter({ backend: 'database', store: layer }, getUser);
    manager = new ObservedManager({
      portfolioManager: new PortfolioManager(fileOperationsService, { baseDir: directory }), fileLockManager,
      fileOperationsService, metadataService, serializationService: new SerializationService(),
      validationRegistry: new ValidationRegistry(new ValidationService(), new TriggerValidationService(), metadataService),
      eventDispatcher: new ElementEventDispatcher(), getCurrentUserId: getUser,
      storageLayerFactory: { createForElement: () => layer },
    }, adapter);
    const store = new ManagerBackedPortfolioElementStore({ getCurrentUserId: getUser, managers: {
      personas: manager, skills: manager, templates: manager, agents: manager, memories: manager, ensembles: manager,
    } });
    mark('precondition-ready');
    await body({ f, manager, layer, store, mark });
    mark('assertions-complete');
  } catch (cause) { primary = { cause }; }
  mark('cleanup-begin');
  const cleanupFailures: unknown[] = [];
  try { manager?.dispose(); } catch (cause) { cleanupFailures.push(cause); }
  try { await f.cleanup(); } catch (cause) { cleanupFailures.push(cause); }
  if (directory) {
    try { await rm(directory, { recursive: true, force: true }); } catch (cause) { cleanupFailures.push(cause); }
  }
  mark(cleanupFailures.length ? 'cleanup-error' : 'cleanup-end');
  if (cleanupFailures.length) throw new AggregateError([
    ...(primary ? [primary.cause] : []), ...cleanupFailures,
  ], 'Console assertions or owned cleanup failed');
  if (primary) throw primary.cause;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function baseline({ f, store }: Context) {
  const record = await store.findByName(f.userId, 'memories', f.name);
  expect(record).not.toBeNull();
  expect(record?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  return record!;
}
function input(context: Context, contentHash: string | undefined) {
  return { userId: context.f.userId, type: 'memories' as const, canonicalName: context.f.name,
    expectedVersion: 1, expectedContentHash: contentHash, metadata: { description: 'Console submitted description' },
    now: new Date('2026-10-04T17:00:00Z') };
}

requiredDescribe('actual guarded console memory UPDATE with owned PostgreSQL', () => {
  it('commits the public update with preserved full fields and a matching response ETag without legacy writes', () => isolated('success', async context => {
    const { f, manager, layer, store, mark } = context;
    const raw = `${f.raw}\nunique_id: ${f.memoryId}\ninstructions: Preserve console instructions\nextensions:\n  nested:\n    evidence: preserved\n`;
    expect(await f.layer.writeContent('memories', f.name, raw,
      { author: 'test-author', version: '1.0.0', description: '', tags: [] })).toBe(f.memoryId);
    const before = await f.layer.readHeadSnapshot(f.memoryId);
    const observed = await baseline(context);
    expect(observed.metadata.unique_id).toBe(f.memoryId);
    const legacy = jest.spyOn(layer, 'writeContent');
    const importFallback = jest.spyOn(manager, 'importElement');
    mark('operation-begin');
    const response = await store.update(input(context, observed.contentHash));
    mark('operation-end');
    expect(response).not.toBeNull();
    expect(response?.metadata.unique_id).toBe(f.memoryId);
    const committed = await f.layer.readHeadSnapshot(f.memoryId);
    expect(BigInt(committed.token.revision)).toBeGreaterThan(BigInt(before.token.revision));
    expect(committed.content).toContain('Preserved entry');
    const loaded = await manager.load(f.memoryId);
    expect(loaded.instructions).toBe('Preserve console instructions');
    expect(loaded.extensions).toEqual({ nested: { evidence: 'preserved' } });
    expect(loaded.metadata.author).toBe('test-author');
    expect(loaded.metadata.description).toBe('Console submitted description');
    expect((await f.layer.getEntries(f.memoryId)).map(entry => entry.entryId)).toEqual(['one']);
    const subsequent = await store.findByName(f.userId, 'memories', f.name);
    expect(subsequent?.metadata.unique_id).toBe(f.memoryId);
    expect(response?.contentHash).toBe(subsequent?.contentHash);
    expect(response?.content).toBe(subsequent?.content);
    expect(legacy).not.toHaveBeenCalled();
    expect(importFallback).not.toHaveBeenCalled();
  }));

  it('preserves legacy YAML name with admitted logical row identity and refuses a mismatched raw row', () => isolated('legacy-name', async context => {
    const {f, manager, layer, store, mark} = context;
    const data = yaml.load(f.raw, {schema: yaml.JSON_SCHEMA}) as Record<string, unknown>;
    data.name = 'R&D'; data.unique_id = f.memoryId;
    await f.layer.writeContent('memories', f.name, yaml.dump(data),
      {author: 'test-author', version: '1.0.0', description: '', tags: []});
    await f.maintenance`UPDATE public.elements SET name='RD' WHERE id=${f.memoryId}::uuid`;
    const before = await f.layer.readHeadSnapshot(f.memoryId); expect(before.token.name).toBe('RD');
    const observed = await store.findByName(f.userId, 'memories', 'rd'); expect(observed?.displayName).toBe('R&D');
    const write = jest.spyOn(layer, 'writeHeadIfCurrent'); const legacy = jest.spyOn(layer, 'writeContent');
    mark('operation-begin');
    const response = await store.update({...input(context, observed!.contentHash), canonicalName: 'rd', displayName: 'R&D'});
    mark('operation-end');
    expect(response?.displayName).toBe('R&D'); expect(response?.name).toBe('RD'); expect(write).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled();
    const committed = await f.layer.readHeadSnapshot(f.memoryId); expect(committed.token.name).toBe('RD');
    expect((yaml.load(committed.content) as {metadata: {name: string; unique_id: string}}).metadata).toMatchObject({name: 'R&D', unique_id: f.memoryId});
    expect((await f.layer.getEntries(f.memoryId)).map(entry => entry.entryId)).toEqual(['one']);
    expect((await store.findByName(f.userId, 'memories', 'rd'))?.contentHash).toBe(response?.contentHash);
    // Backend row/token identity remains strict; no migration or name repair.
    await f.maintenance`UPDATE public.elements SET name='R&D' WHERE id=${f.memoryId}::uuid`;
    const refused = await f.snapshot(); const save = jest.spyOn(manager, 'save'); write.mockClear();
    await expect(store.findByName(f.userId, 'memories', 'rd')).rejects.toMatchObject({code: 'EHEADCONFLICT'});
    expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(await f.snapshot()).toEqual(refused);
  }));

  it.each(['child', 'tag'] as const)('retains original authority after actual %s interference at the prepared-save barrier', kind => isolated(`conflict-${kind}`, async context => {
    const { f, manager, store, mark } = context;
    const observed = await baseline(context);
    const entered = gate(); const resume = gate();
    let candidate: Memory | undefined;
    const save = manager.save.bind(manager);
    jest.spyOn(manager, 'save').mockImplementation(async (memory, locator, options) => {
      candidate = memory; mark('barrier-entered'); entered.release();
      await resume.promise; mark('barrier-released'); return save(memory, locator, options);
    });
    mark('operation-begin');
    const outcome = store.update(input(context, observed.contentHash))
      .then(value => { mark('operation-end'); return { value }; }, cause => { mark('operation-end'); return { cause }; });
    try {
      await Promise.race([entered.promise, outcome.then(result => {
        if ('cause' in result) throw result.cause;
        throw new Error('Console update settled before its prepared-save barrier');
      })]);
      expect(candidate).toBeDefined();
      if (kind === 'child') await f.layer.addEntry(f.memoryId, { entryId: 'accepted-console-child',
        timestamp: new Date('2026-10-04T12:00:00Z'), content: 'Accepted concurrent child' });
      else await f.ordinary.begin(async tx => {
        await tx`SELECT pg_catalog.set_config('app.current_user_id',${f.userId},true)`;
        await tx`INSERT INTO public.element_tags(element_id,user_id,tag) VALUES (${f.memoryId}::uuid,${f.userId}::uuid,'accepted-console-tag')`;
      });
      const winner = await f.snapshot();
      resume.release();
      const result = await outcome;
      expect('cause' in result).toBe(true);
      expect('value' in result).toBe(false);
      expect(await f.snapshot()).toEqual(winner);
      const retained = store.getPendingGuardedUpdate(f.userId, f.name);
      expect(retained?.status).toBe('refused');
      expect(retained?.candidate).toBe(candidate);
      expect(retained?.manager).toBe(manager);
      if (!('cause' in result)) throw new Error('Expected real conditional refusal');
      expect(result.cause).toBeInstanceOf(PortfolioElementVersionConflictError);
      const pending = manager.getPendingHeadUpdate(candidate!);
      expect(retained?.cause).toBe(pending?.cause);
      expect(pending?.cause).toMatchObject({ code: 'ESTALE' });
      expect(pending?.candidate?.content).toContain('Console submitted description');
      await expect(store.update(input(context, observed.contentHash))).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
      expect(await f.snapshot()).toEqual(winner);
    } finally { resume.release(); await outcome; }
  }));

  it('refuses a dirty head without a conditional or legacy write', () => isolated('dirty', async context => {
    const { f, manager, layer, store, mark } = context;
    const observed = await baseline(context);
    await f.layer.addEntry(f.memoryId, { entryId: 'dirty-console', timestamp: new Date('2026-10-04T12:00:00Z'), content: 'Accepted dirty child' });
    const before = await f.snapshot();
    const save = jest.spyOn(manager, 'save');
    const legacy = jest.spyOn(layer, 'writeContent');
    mark('operation-begin');
    await expect(store.update(input(context, observed.contentHash))).rejects.toMatchObject({ code: 'EHEADOUTOFSYNC' });
    mark('operation-end');
    expect(save).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(await f.snapshot()).toEqual(before);
  }));

  it('retains actual committed receipt when the subsequent publication fails and does not replay', () => isolated('known-commit', async context => {
    const { f, manager, store, mark } = context;
    const observed = await baseline(context);
    const before = await f.layer.readHeadSnapshot(f.memoryId);
    const failure = new Error('Controlled console postcommit publication failure');
    manager.publicationFailure = failure;
    mark('operation-begin');
    await expect(store.update(input(context, observed.contentHash))).rejects.toBe(failure);
    mark('operation-end');
    const retained = store.getPendingGuardedUpdate(f.userId, f.name);
    expect(retained?.status).toBe('committed-publication-failed');
    expect(retained?.manager).toBe(manager);
    expect(retained?.cause).toBe(failure);
    expect(retained?.candidate).toBeDefined();
    const pending = manager.getPendingHeadUpdate(retained!.candidate!);
    expect(pending?.status).toBe('committed-publication-failed');
    expect(pending?.cause).toBe(failure);
    expect(pending?.committedToken).toBeDefined();
    const committed = await f.layer.readHeadSnapshot(f.memoryId);
    expect(BigInt(committed.token.revision)).toBeGreaterThan(BigInt(before.token.revision));
    expect(committed.content).toContain('Console submitted description');
    const snapshot = await f.snapshot(); manager.publicationFailure = undefined;
    await expect(store.update(input(context, observed.contentHash))).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
    expect(await f.snapshot()).toEqual(snapshot);
  }));
});
