/** Owned DB console caller proof, not production authentication/boot qualification. */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ElementManagerDeps } from '../../../src/elements/base/BaseElementManager.js';
import { admittedMemoryContainer } from '../../helpers/storage/admitted-memory-container.js';
import { makeEquivalentFixture, type EquivalentFixture } from './fixtures/2905-equivalent-reconciliation-fixture.js';
import { DatabaseTenantMemoryRegistry } from '../../../src/storage/DatabaseTenantMemoryRegistry.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { TenantMemoryOperationProvider } from '../../../src/storage/TenantMemoryOperationProvider.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { ManagerBackedPortfolioElementStore, type ManagerBackedPortfolioManagers } from '../../../src/web-console/stores/ManagerBackedPortfolioElementStore.js';
import { PortfolioService } from '../../../src/web-console/modules/portfolio/PortfolioService.js';
import type { ConsoleRequest } from '../../../src/web-console/platform/ConsolePlatformTypes.js';
import type { IUserIntegrationStore } from '../../../src/web-console/stores/IUserIntegrationStore.js';
import type { IPortfolioSyncJobStore } from '../../../src/web-console/stores/IPortfolioSyncJobStore.js';
const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
const owned: EquivalentFixture[] = [];
function phase(value:string){console.info(`[tenant-memory-console:actual-db] ${value}`);}
afterEach(async()=>{jest.restoreAllMocks();for(const f of owned.splice(0)){phase('cleanup-start');await f.cleanup();phase('cleanup-end');}});
function request(userId:string):ConsoleRequest{return {params:{},query:{},body:{},headers:{},consoleAuthentication:{userId,sessionIdHash:Buffer.alloc(32,7),authSub:'owned-console',authzVersion:1,grantedCapabilities:['console:self'],elevation:null}} as unknown as ConsoleRequest;}
required('actual tenant-bound console service DB caller',()=>{
  it('uses one selected manager through conditional UPDATE and owning ETag publication without root fallback',async()=>{
    phase('fixture-start');const f=await makeEquivalentFixture();owned.push(f);
    await f.maintenance`UPDATE public.elements SET memory_entries_out_of_sync=false WHERE id=${f.memoryId}::uuid`;
    await f.maintenance`INSERT INTO public.memory_backend_modes(user_id,backend,protocol_version,profile,mode,generation) VALUES (${f.userId}::uuid,'database',1,${DATABASE_MEMORY_ADMISSION_PROFILE},'guarded',1)`;
    await f.maintenance`INSERT INTO public.memory_candidate_quotas(user_id) VALUES (${f.userId}::uuid)`;
    const directory=await mkdtemp(path.join(os.tmpdir(),'pg-tenant-console-'));let deps!:ElementManagerDeps;
    const root=admittedMemoryContainer(f.db,()=>f.userId,directory,factory=>incoming=>{deps=incoming;return factory.createAdmittedMemoryManager(incoming);});
    try{
      const fixed=root.manager();const c=root.container;const tracker=c.resolve<ContextTracker>('ContextTracker');
      const registry=new DatabaseTenantMemoryRegistry({db:f.db,getEffectiveTenant:()=>f.userId,
        createManagerDeps:(factory,resolver)=>({...deps,fileWatchService:undefined,storageLayerFactory:factory,getCurrentUserId:resolver}),
        getAttribution:()=>{const current=tracker.getContext();if(!current?.requestId||!current.session)throw new Error('Owned attribution required');return {contextRoot:current.requestId,sessionId:current.session.sessionId,transport:current.session.transport};}});
      const provider=new TenantMemoryOperationProvider(registry,tracker);const resolve=jest.spyOn(provider,'resolve');
      const managers={personas:c.resolve('PersonaManager'),skills:c.resolve('SkillManager'),templates:c.resolve('TemplateManager'),agents:c.resolve('AgentManager'),memories:fixed,ensembles:c.resolve('EnsembleManager')} as ManagerBackedPortfolioManagers;
      const store=new ManagerBackedPortfolioElementStore({managers,getCurrentUserId:()=>f.userId,memoryProvider:provider,contextTracker:tracker});
      const service=new PortfolioService(store,{} as IUserIntegrationStore,{} as IPortfolioSyncJobStore);
      const rootRead=jest.spyOn(fixed,'findGuardedMemoryForUpdate');const rootSave=jest.spyOn(fixed,'save');
      const context=tracker.createSessionContext('test',{userId:f.userId,sessionId:'owned-console-session',tenantId:f.userId,transport:'http',createdAt:1});
      phase('fixture-end');phase('lifecycle-start');
      await tracker.runAsync(context,async()=>{
        // Uniquely owned fixture qualification only; not live admission/authentication evidence.
        await registry.qualify(registry.capture(),async identity=>{expect(identity.tenant).toBe(f.userId);expect(identity.backend).toBe('database');});
        const read=await service.getElement(request(f.userId),'memories',f.name);expect(read.status).toBe(200);expect(typeof read.headers?.ETag).toBe('string');
        resolve.mockClear();const req=request(f.userId);req.headers['if-match']=String(read.headers!.ETag);req.body={metadata:{description:'Actual selected console UPDATE'}};
        const updated=await service.updateElement(req,'memories',f.name);expect(updated.status).toBe(200);expect(typeof updated.headers?.ETag).toBe('string');
        expect(resolve).toHaveBeenCalledTimes(1);
        const fresh=await service.getElement(request(f.userId),'memories',f.name);expect(fresh.headers?.ETag).toBe(updated.headers?.ETag);
        const head=await f.layer.readHeadSnapshot(f.memoryId);expect(head.content).toContain('Preserved entry');expect(head.content).toContain('Actual selected console UPDATE');
        expect(await f.maintenance`SELECT status FROM public.memory_candidate_handoffs WHERE user_id=${f.userId}::uuid`).toHaveLength(0);
      });
      const before=await f.snapshot();const changed=tracker.createSessionContext('test',{userId:f.userId,sessionId:'owned-console-refusal',tenantId:f.userId,transport:'http',createdAt:2});
      const originalResolve=provider.resolve.bind(provider);resolve.mockImplementationOnce(async capture=>{const operation=await originalResolve(capture);changed.requestId=randomUUID();return operation;});
      await tracker.runAsync(changed,()=>expect(service.getElement(request(f.userId),'memories',f.name)).rejects.toThrow('context changed'));
      expect(await f.snapshot()).toEqual(before);expect(rootRead).not.toHaveBeenCalled();expect(rootSave).not.toHaveBeenCalled();phase('assertions-complete');
    }finally{try{await root.container.dispose();}finally{await rm(directory,{recursive:true,force:true});}}
  },30000);
});
