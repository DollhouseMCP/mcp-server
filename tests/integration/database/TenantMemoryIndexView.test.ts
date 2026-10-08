/** Required owned-DB source/locator proof; no HTTP registration or owner admission. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import type { ElementManagerDeps } from '../../../src/elements/base/BaseElementManager.js';
import { admittedMemoryContainer } from '../../helpers/storage/admitted-memory-container.js';
import { makeEquivalentFixture, type EquivalentFixture } from './fixtures/2905-equivalent-reconciliation-fixture.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { DatabaseTenantMemoryRegistry } from '../../../src/storage/DatabaseTenantMemoryRegistry.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { TenantMemoryOperationProvider } from '../../../src/storage/TenantMemoryOperationProvider.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { PathService } from '../../../src/paths/PathService.js';
import { PerUserPathResolver } from '../../../src/paths/PerUserPathResolver.js';
import { PackageResourceLocator } from '../../../src/paths/PackageResourceLocator.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { IndexConfigManager } from '../../../src/portfolio/config/IndexConfig.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { bindTenantMemoryIndexView } from '../../../src/portfolio/TenantMemoryIndexView.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
const owned: EquivalentFixture[] = [];
function phase(value: string) { console.info(`[tenant-memory-index:actual-db] ${value}`); }
afterEach(async () => {
  jest.restoreAllMocks();
  for (const f of owned.splice(0)) { phase('cleanup-start'); await f.cleanup(); phase('cleanup-end'); }
});
required('selected tenant DB memory index and RAM-only derivation', () => {
  it('discovers absent-file DB memories, consumes UUID through actual manager and isolates tenants without rewriting heads or index files', async () => {
    phase('fixture-start'); const f = await makeEquivalentFixture(); owned.push(f);
    const foreignName = 'foreign logical session';
    const foreignLayer = new DatabaseMemoryStorageLayer(f.db, () => f.foreignUserId);
    const foreignId = await foreignLayer.writeContent('memories', foreignName, f.raw.replaceAll(f.name, foreignName),
      { author: 'test-author', version: '1.0.0', description: '', tags: [] });
    await f.maintenance`UPDATE public.elements SET memory_entries_out_of_sync=false WHERE element_type='memories'`;
    await f.maintenance`INSERT INTO public.memory_backend_modes(user_id,backend,protocol_version,profile,mode,generation) VALUES
      (${f.userId}::uuid,'database',1,${DATABASE_MEMORY_ADMISSION_PROFILE},'guarded',1),
      (${f.foreignUserId}::uuid,'database',1,${DATABASE_MEMORY_ADMISSION_PROFILE},'guarded',1)`;
    const before = await f.snapshot();
    const [headsBefore] = await f.maintenance`SELECT jsonb_agg(to_jsonb(e) ORDER BY id)::text AS heads FROM public.elements e`;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pg-tenant-index-'));
    const scope = new AsyncLocalStorage<string>(); const getTenant = () => scope.getStore() ?? f.userId;
    let deps!: ElementManagerDeps;
    const root = admittedMemoryContainer(f.db, getTenant, directory, factory => incoming => {
      deps = incoming; return factory.createAdmittedMemoryManager(incoming);
    });
    try {
      const fixed = root.manager(); const c = root.container; const tracker = c.resolve<ContextTracker>('ContextTracker');
      const paths = new PathService({ userResolver: new PerUserPathResolver(directory), packageLocator: new PackageResourceLocator(), userIdResolver: getTenant });
      const portfolio = new PortfolioManager(c.resolve('FileOperationsService'), { baseDir: directory }, { pathService: paths, contextTracker: tracker });
      const registry = new DatabaseTenantMemoryRegistry({ db: f.db, getEffectiveTenant: getTenant,
        createManagerDeps: (factory, resolver) => ({ ...deps, fileWatchService: undefined, portfolioManager: portfolio, storageLayerFactory: factory, getCurrentUserId: resolver }),
        getAttribution: () => ({ contextRoot: 'owned-index-fixture', sessionId: 'fixture', transport: 'http' }) });
      const provider = new TenantMemoryOperationProvider(registry, tracker);
      const rootList = jest.spyOn(fixed, 'list');
      const viewDeps = { portfolioManager: portfolio, pathService: paths, indexConfig: new IndexConfigManager(),
        config: c.resolve<ConfigManager>('ConfigManager'), fileOperations: c.resolve<FileOperationsService>('FileOperationsService') };
      phase('fixture-end'); phase('lifecycle-start');
      for (const [tenant, name, locator] of [[f.userId, f.name, f.memoryId], [f.foreignUserId, foreignName, foreignId]]) {
        await scope.run(tenant, () => tracker.runAsync(tracker.createSessionContext('test', {
          userId: tenant, sessionId: `owned-${tenant}`, tenantId: tenant, transport: 'http', createdAt: 1,
        }), async () => {
          const operation = await provider.resolve(provider.capture());
          const view = bindTenantMemoryIndexView(provider, operation, viewDeps);
          try {
            const entries = await view.portfolioIndex.getElementsByType(ElementType.MEMORY);
            expect(entries.map(entry => [entry.metadata.name, entry.filePath])).toEqual([[name, locator]]);
            const found = await view.portfolioIndex.findByName(name); expect(found?.filePath).toBe(locator);
            const loaded = await operation.manager.load(found!.filePath);
            expect(loaded.metadata.name).toBe(name); expect(loaded.serialize()).toContain('Preserved entry');
            expect((await operation.manager.activateMemory(name)).success).toBe(true);
            const enhanced = await view.enhancedIndex.getIndex(); expect(Object.keys(enhanced.elements.memories)).toEqual([name]);
            await view.enhancedIndex.addExtension('derived-only', { selected: name });
            await expect(view.enhancedIndex.persist()).rejects.toThrow('cannot be persisted');
          } finally { await view.dispose(); }
        }));
      }
      expect(rootList).not.toHaveBeenCalled();
      expect(await readdir(directory, { recursive: true })).toEqual([]);
      expect(await f.snapshot()).toEqual(before);
      const [headsAfter] = await f.maintenance`SELECT jsonb_agg(to_jsonb(e) ORDER BY id)::text AS heads FROM public.elements e`;
      expect(headsAfter).toEqual(headsBefore);
      await tracker.runAsync(tracker.createSessionContext('test', { userId: f.userId, sessionId: 'owned-index-drift', tenantId: f.userId, transport: 'http', createdAt: 2 }), async () => {
        const operation = await provider.resolve(provider.capture()); const view = bindTenantMemoryIndexView(provider, operation, viewDeps);
        try {
          await view.portfolioIndex.getIndex();
          tracker.getContext()!.requestId = randomUUID();
          await expect(view.portfolioIndex.search(f.name)).rejects.toThrow('context changed');
          expect(await f.snapshot()).toEqual(before);
        } finally { await view.dispose(); }
      });
      phase('assertions-complete');
    } finally { try { await root.container.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } }
  }, 30000);
});
