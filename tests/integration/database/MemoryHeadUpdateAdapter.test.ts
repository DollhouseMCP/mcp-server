/** Actual central manager commits on independently owned required-CI PostgreSQL fixtures. */
import { describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

const requiredDescribe = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
async function isolated(body: (f: EquivalentFixture, makeManager: (getUser?: () => string) => Promise<{
  manager: MemoryManager; adapter: MemoryHeadUpdateAdapter; layer: DatabaseMemoryStorageLayer;
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
      const manager = new MemoryManager({
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

requiredDescribe('dormant central memory UPDATE with owned PostgreSQL', () => {
  it('manager save and Memory.save commit captured content and refresh durable authority without legacy upsert', () => isolated(async (f, makeManager) => {
    const { manager, layer } = await makeManager();
    const legacy = jest.spyOn(layer, 'writeContent');
    const before = await f.layer.readHeadSnapshot(f.memoryId);
    const memory = await manager.load(f.memoryId);
    expect([...memory.getEntries().values()].map(entry => entry.content)).toContain('Preserved entry');
    await memory.addEntry('First central committed entry');
    await manager.save(memory);
    const first = await f.layer.readHeadSnapshot(f.memoryId);
    expect(first.content).toContain('First central committed entry');
    expect(BigInt(first.token.revision)).toBeGreaterThan(BigInt(before.token.revision));
    await memory.addEntry('Second self-save committed entry');
    await memory.save();
    const second = await f.layer.readHeadSnapshot(f.memoryId);
    expect(second.content).toContain('First central committed entry');
    expect(second.content).toContain('Second self-save committed entry');
    expect(BigInt(second.token.revision)).toBeGreaterThan(BigInt(first.token.revision));
    expect(legacy).not.toHaveBeenCalled();
  }));

  it('two independently loaded copies reject the stale save and retain its attempted bytes', () => isolated(async (f, makeManager) => {
    const first = await makeManager();
    const second = await makeManager();
    const winner = await first.manager.load(f.memoryId);
    const stale = await second.manager.load(f.memoryId);
    expect(stale).not.toBe(winner);
    await winner.addEntry('Accepted winner');
    await first.manager.save(winner);
    await stale.addEntry('Recoverable stale attempt');
    const committed = await f.snapshot();
    await expect(second.manager.save(stale)).rejects.toMatchObject({ code: 'ESTALE' });
    expect(await f.snapshot()).toEqual(committed);
    const pending = second.manager.getPendingHeadUpdate(stale);
    expect(pending?.status).toBe('refused');
    expect(pending?.candidate?.content).toContain('Recoverable stale attempt');
    expect(pending?.candidate?.content).not.toContain('Accepted winner');
    expect([...stale.getEntries().values()].map(entry => entry.content)).toContain('Recoverable stale attempt');
    expect((await f.layer.readHeadSnapshot(f.memoryId)).content).not.toContain('Recoverable stale attempt');
  }));

  it.each(['child', 'tag'] as const)('a real direct %s edit invalidates the loaded authority without stale replay', kind => isolated(async (f, makeManager) => {
    const { manager } = await makeManager();
    const memory = await manager.load(f.memoryId);
    await memory.addEntry('Pending whole-head attempt');
    if (kind === 'child') {
      await f.layer.addEntry(f.memoryId, { entryId: 'external-child', timestamp: new Date('2026-10-03T12:00:00Z'), content: 'Accepted external child' });
    } else {
      // The real tag trigger requires authenticated transaction-local tenant context.
      await f.ordinary.begin(async tx => {
        await tx`SELECT pg_catalog.set_config('app.current_user_id',${f.userId},true)`;
        await tx`INSERT INTO public.element_tags(element_id,user_id,tag) VALUES (${f.memoryId}::uuid,${f.userId}::uuid,'external-tag')`;
      });
    }
    const changed = await f.snapshot();
    await expect(manager.save(memory)).rejects.toMatchObject({ code: 'ESTALE' });
    expect(await f.snapshot()).toEqual(changed);
    expect(manager.getPendingHeadUpdate(memory)?.candidate?.content).toContain('Pending whole-head attempt');
  }));

  it('a dirty head refuses central load without changing database content', () => isolated(async (f, makeManager) => {
    await f.layer.addEntry(f.memoryId, { entryId: 'dirty-child', timestamp: new Date('2026-10-03T13:00:00Z'), content: 'Unsynchronized child' });
    const before = await f.snapshot();
    expect(before.dirty).toBe(true);
    const { manager } = await makeManager();
    await expect(manager.load(f.memoryId)).rejects.toMatchObject({ code: 'EHEADOUTOFSYNC' });
    expect(await f.snapshot()).toEqual(before);
  }));

  it('tenant switching cannot retarget a loaded working copy and foreign RLS cannot load its head', () => isolated(async (f, makeManager) => {
    let user = f.userId;
    const { manager } = await makeManager(() => user);
    const memory = await manager.load(f.memoryId);
    await memory.addEntry('Attempt from original tenant');
    const before = await f.snapshot();
    user = f.foreignUserId;
    await expect(manager.save(memory)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    const foreign = await makeManager(() => f.foreignUserId);
    await expect(foreign.manager.load(f.memoryId)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.snapshot()).toEqual(before);
  }));
});
