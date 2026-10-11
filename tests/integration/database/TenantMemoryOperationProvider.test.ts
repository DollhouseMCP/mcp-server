/** Required owned-DB caller proof; no production provider is registered by this slice. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { ElementManagerDeps } from '../../../src/elements/base/BaseElementManager.js';
import { admittedMemoryContainer } from '../../helpers/storage/admitted-memory-container.js';
import { makeEquivalentFixture, type EquivalentFixture } from './fixtures/2905-equivalent-reconciliation-fixture.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { DatabaseTenantMemoryRegistry } from '../../../src/storage/DatabaseTenantMemoryRegistry.js';
import { DATABASE_MEMORY_LEGACY_PROFILE } from '../../../src/storage/DatabaseMemoryLegacyMutationGuard.js';
import { TenantMemoryOperationProvider } from '../../../src/storage/TenantMemoryOperationProvider.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import type { Memory } from '../../../src/elements/memories/Memory.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
const owned: EquivalentFixture[] = [];
function phase(value: string) { console.info(`[tenant-memory-callers:actual-db] ${value}`); }
afterEach(async () => {
  jest.restoreAllMocks();
  for (const f of owned.splice(0)) { phase('cleanup-start'); await f.cleanup(); phase('cleanup-end'); }
});
required('required PostgreSQL trusted CRUD and activation caller', () => {
  it('uses the selected tenant actual manager for discovery and activation without cached root fallback or head rewrite', async () => {
    phase('fixture-start'); const f = await makeEquivalentFixture(); owned.push(f);
    const foreignLayer = new DatabaseMemoryStorageLayer(f.db, () => f.foreignUserId);
    await foreignLayer.writeContent('memories', 'foreign-fixture', f.raw.replaceAll(f.name,'foreign-fixture'),
      {author:'test-author',version:'1.0.0',description:'',tags:[]});
    await f.maintenance`INSERT INTO public.memory_backend_modes
      (user_id,backend,protocol_version,profile,mode,generation) VALUES
      (${f.userId}::uuid,'database',1,${DATABASE_MEMORY_LEGACY_PROFILE},'legacy',1),
      (${f.foreignUserId}::uuid,'database',1,${DATABASE_MEMORY_LEGACY_PROFILE},'legacy',1)`;
    const before = await f.snapshot();
    const [headsBefore] = await f.maintenance`SELECT jsonb_agg(to_jsonb(e) ORDER BY id)::text AS heads
      FROM public.elements e WHERE element_type='memories'`;
    const directory=await mkdtemp(path.join(os.tmpdir(),'pg-tenant-memory-caller-'));
    const scope=new AsyncLocalStorage<string>();const getTenant=()=>scope.getStore()??f.userId;
    let deps!:ElementManagerDeps;
    const root=admittedMemoryContainer(f.db,getTenant,directory,factory=>incoming=>{
      deps=incoming;return factory.createAdmittedMemoryManager(incoming);
    });
    try {
      root.manager();
      const registry=new DatabaseTenantMemoryRegistry({db:f.db,getEffectiveTenant:getTenant,
        createManagerDeps:(factory,resolver)=>({...deps,fileWatchService:undefined,storageLayerFactory:factory,getCurrentUserId:resolver}),
        getAttribution:()=>({contextRoot:'owned-caller-fixture',sessionId:'fixture',transport:'http'})});
      const fixed=await registry.resolve(registry.capture());
      const tracker=root.container.resolve<ContextTracker>('ContextTracker');const provider=new TenantMemoryOperationProvider(registry,tracker);
      const c=root.container;
      // This caller-only slice starts with already initialized infrastructure. Full boot wiring is a separate prerequisite.
      jest.spyOn(c.resolve<{ensureInitialized:()=>Promise<void>}>('InitializationService'),'ensureInitialized').mockResolvedValue(undefined);
      const handler=new ElementCRUDHandler(c.resolve('SkillManager'),c.resolve('TemplateManager'),c.resolve('TemplateRenderer'),
        c.resolve('AgentManager'),fixed,c.resolve('EnsembleManager'),c.resolve('PersonaManager'),c.resolve('PortfolioManager'),
        c.resolve('InitializationService'),c.resolve('PersonaIndicatorService'),c.resolve('FileOperationsService'),
        c.resolve('ElementQueryService'),c.resolve('ValidationRegistry'),undefined,undefined,undefined,c.resolve('SessionActivationRegistry'),tracker,{memoryProvider:provider});
      phase('fixture-end');phase('lifecycle-start');
      const rootReads=jest.spyOn(fixed,'list');
      await scope.run(f.foreignUserId,()=>tracker.runAsync(tracker.createSessionContext('test',{
        userId:f.foreignUserId,sessionId:'owned-foreign-session',tenantId:null,transport:'http',createdAt:1}),async()=>{
        const elements=await handler.getElements('memory') as Memory[];
        expect(elements.map(memory=>memory.metadata.name)).toEqual(['foreign-fixture']);
        const activation=await handler.activateElement('foreign-fixture','memory');
        expect(activation.content[0].text).toContain("Memory 'foreign-fixture' activated");
      }));
      expect(rootReads).not.toHaveBeenCalled();
      expect(await f.snapshot()).toEqual(before);
      const [headsAfter]=await f.maintenance`SELECT jsonb_agg(to_jsonb(e) ORDER BY id)::text AS heads
        FROM public.elements e WHERE element_type='memories'`;
      expect(headsAfter).toEqual(headsBefore);
      phase('assertions-complete');
    } finally { try {await root.container.dispose();} finally {await rm(directory,{recursive:true,force:true});} }
  },30000);
});
