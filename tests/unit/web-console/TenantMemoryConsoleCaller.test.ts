import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import type { ElementManagerDeps } from '../../../src/elements/base/BaseElementManager.js';
import { admittedMemoryContainer } from '../../helpers/storage/admitted-memory-container.js';
import { DatabaseTenantMemoryRegistry } from '../../../src/storage/DatabaseTenantMemoryRegistry.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { DATABASE_MEMORY_LEGACY_PROFILE } from '../../../src/storage/DatabaseMemoryLegacyMutationGuard.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { TenantMemoryOperationProvider } from '../../../src/storage/TenantMemoryOperationProvider.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../../src/elements/memories/Memory.js';
import { ManagerBackedPortfolioElementStore, type ManagerBackedPortfolioManagers } from '../../../src/web-console/stores/ManagerBackedPortfolioElementStore.js';
import { portfolioElementEtag } from '../../../src/web-console/modules/portfolio/PortfolioDtos.js';
import { PortfolioService } from '../../../src/web-console/modules/portfolio/PortfolioService.js';
import type { ConsoleRequest } from '../../../src/web-console/platform/ConsolePlatformTypes.js';
import type { IUserIntegrationStore } from '../../../src/web-console/stores/IUserIntegrationStore.js';
import type { IPortfolioSyncJobStore } from '../../../src/web-console/stores/IPortfolioSyncJobStore.js';
import type { ConsolePortfolioElementDetailRecord } from '../../../src/web-console/stores/IPortfolioElementStore.js';
const owned: { directory: string; dispose: () => Promise<void> }[] = [];
afterEach(async () => {
  jest.restoreAllMocks();
  for (const f of owned.splice(0)) {
    try { await f.dispose(); } finally { await rm(f.directory, { recursive: true, force: true }); }
  }
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tenant-memory-registry-'));
  const scope = new AsyncLocalStorage<string>();
  const first = randomUUID();
  const second = randomUUID();
  const modes = new Map<string, Record<string, unknown>[]>([first, second].map(tenant =>
    [tenant, [{ protocol_version: 1, profile: DATABASE_MEMORY_ADMISSION_PROFILE, mode: 'guarded', generation: '1' }]]));
  let pause: Promise<void> | undefined;
  const role = { rolsuper: false, rolbypassrls: false };
  let failure: { cause: unknown } | undefined;
  const execute = jest.fn(async (query: SQL) => {
    const compiled = new PgDialect().sqlToQuery(query);
    if (compiled.sql.includes('pg_roles')) return [role];
    if (compiled.sql.includes('memory_backend_modes')) {
      await pause;
      if (failure) throw failure.cause;
      return modes.get(String(compiled.params[0])) ?? [];
    }
    return [];
  });
  const transaction = jest.fn(async (body: (tx: { execute: typeof execute }) => Promise<unknown>) => body({ execute }));
  const db = { transaction } as unknown as DatabaseInstance;
  const getTenant = () => scope.getStore() ?? first;
  let template!: ElementManagerDeps;
  const root = admittedMemoryContainer(db, getTenant, directory, factory => incoming => {
    template = incoming; return factory.createAdmittedMemoryManager(incoming);
  });
  root.manager();
  owned.push({ directory, dispose: () => root.container.dispose() });
  const builds = jest.fn((factory: ElementManagerDeps['storageLayerFactory'], resolver: () => string): ElementManagerDeps =>
    ({ ...template, fileWatchService: undefined, storageLayerFactory: factory, getCurrentUserId: resolver }));
  const registry = new DatabaseTenantMemoryRegistry({ db, getEffectiveTenant: getTenant,
    createManagerDeps: builds, getAttribution: () => ({ contextRoot: 'trusted-test-root', sessionId: 'test-session', transport: 'http' }) });
  return { registry, container: root.container, tracker: root.container.resolve<ContextTracker>('ContextTracker'), db, scope, first, second, modes, builds, execute, transaction,
    setPause: (value: Promise<void>) => { pause = value; },
    fail: (cause: unknown) => { failure = { cause }; } };
}


function invocation(tracker: ContextTracker, tenant: string, sessionId = randomUUID()) {
  return tracker.createSessionContext('test', { userId: tenant, sessionId,
    tenantId: null, transport: 'http', createdAt: 1 });
}

function composed(f: Awaited<ReturnType<typeof fixture>>) {
  const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);const c=f.container;
  const managers={personas:c.resolve('PersonaManager'),skills:c.resolve('SkillManager'),templates:c.resolve('TemplateManager'),
    agents:c.resolve('AgentManager'),memories:c.resolve('MemoryManager'),ensembles:c.resolve('EnsembleManager')} as ManagerBackedPortfolioManagers;
  const store=new ManagerBackedPortfolioElementStore({managers,getCurrentUserId:()=>f.scope.getStore()??f.first,memoryProvider:provider,contextTracker:f.tracker});
  const service=new PortfolioService(store,{} as IUserIntegrationStore,{} as IPortfolioSyncJobStore);
  return {provider,store,service,managers};
}
function request(userId:string):ConsoleRequest {
  return {params:{},query:{type:'memories'},body:{},headers:{},consoleAuthentication:{userId,sessionIdHash:Buffer.alloc(32,7),
    authSub:'owned-console-test',authzVersion:1,grantedCapabilities:['console:self'],elevation:null}} as unknown as ConsoleRequest;
}
describe('tenant-bound console caller store',()=>{
  it('rejects explicit configured absence and unbound direct calls without changing ordinary construction',async()=>{
    const f=await fixture();const {store,managers}=composed(f);const getCurrentUserId=()=>f.first;
    for(const memoryProvider of [undefined,null,false])expect(()=>new ManagerBackedPortfolioElementStore({managers,getCurrentUserId,memoryProvider:memoryProvider as unknown as TenantMemoryOperationProvider,contextTracker:f.tracker})).toThrow('Actual trusted memory provider');
    const ordinary=new ManagerBackedPortfolioElementStore({managers,getCurrentUserId});expect(ordinary.bindForOperation).toBeUndefined();
    await expect(store.listByUser(f.first,{type:'memories'})).rejects.toThrow('Bound console memory operation');
  });
  it('checks the authenticated user against the actual resolver before capture schedules initialization',async()=>{
    const f=await fixture();const {provider,store}=composed(f);const capture=jest.spyOn(provider,'capture');
    await expect(store.bindForOperation!(f.second)).rejects.toThrow('ambient user');
    expect(capture).not.toHaveBeenCalled();expect(f.builds).not.toHaveBeenCalled();
  });
  it('uses one actual selected manager for a console operation without root lookup or recapture',async()=>{
    const f=await fixture();for(const id of [f.first,f.second])f.modes.set(id,[{protocol_version:1,profile:DATABASE_MEMORY_LEGACY_PROFILE,mode:'legacy',generation:'1'}]);
    const {provider,service,managers}=composed(f);const selected=await f.scope.run(f.second,()=>f.registry.resolve(f.registry.capture()));
    const memory=new Memory({name:'Selected Console Memory',description:'Selected tenant memory'},f.container.resolve('MetadataService'));
    const rootList=jest.spyOn(managers.memories,'list').mockResolvedValue([]);const list=jest.spyOn(selected,'list').mockResolvedValue([memory]);
    const resolve=jest.spyOn(provider,'resolve');
    await f.scope.run(f.second,()=>f.tracker.runAsync(invocation(f.tracker,f.second),async()=>{
      const result=await service.listElements(request(f.second));expect(result.status).toBe(200);expect(JSON.stringify(result)).toContain('Selected Console Memory');
    }));
    expect(list).toHaveBeenCalledTimes(1);expect(rootList).not.toHaveBeenCalled();expect(resolve).toHaveBeenCalledTimes(1);
  });
  it('refuses context drift during initialization before selected discovery',async()=>{
    const f=await fixture();const {service}=composed(f);const wait=deferred();f.setPause(wait.promise);
    const list=jest.spyOn(MemoryManager.prototype,'list');const context=invocation(f.tracker,f.first);
    await f.tracker.runAsync(context,async()=>{
      const pending=service.listElements(request(f.first));context.requestId=randomUUID();wait.resolve();
      await expect(pending).rejects.toThrow('context changed');
    });expect(list).not.toHaveBeenCalled();
  });
  it('does not turn drift during an awaited list into an empty or invalid-summary success',async()=>{
    const f=await fixture();const {service}=composed(f);const selected=await f.registry.resolve(f.registry.capture());
    const entered=deferred();const release=deferred();jest.spyOn(selected,'list').mockImplementation(async()=>{entered.resolve();await release.promise;return [];});
    const context=invocation(f.tracker,f.first);
    await f.tracker.runAsync(context,async()=>{
      const pending=service.listElements(request(f.first));try{await Promise.race([entered.promise,pending.then(()=>{throw new Error('Listing completed before owned barrier');})]);context.requestId=randomUUID();}finally{release.resolve();}
      await expect(pending).rejects.toThrow('context changed');
    });
  });
  it('does not let another genuine invocation borrow an original owning publication tail',async()=>{
    const f=await fixture();const {provider,store}=composed(f);const first=invocation(f.tracker,f.first);const second=invocation(f.tracker,f.first);
    const manager=await f.registry.resolve(f.registry.capture());const candidate=new Memory({name:'tail'},f.container.resolve('MetadataService'));
    const record={userId:f.first,type:'memories',name:'tail',canonicalName:'tail',displayName:null,version:1,updatedAt:new Date(),validationStatus:'valid',tags:[],metadata:{},content:''} as ConsolePortfolioElementDetailRecord;
    const complete=jest.spyOn(manager,'completeGuardedOperation');const publish=jest.fn(async()=> 'not published');
    await f.tracker.runAsync(first,async()=>{
      const operation=await provider.resolve(provider.capture());
      const tails=(store as unknown as {publicationTails:WeakMap<object,unknown>}).publicationTails;
      tails.set(record,{manager,candidate,requestKey:'original',targetKey:'target',bindingCheck:operation.assertCurrent});
    });
    await f.tracker.runAsync(second,async()=>{
      const bound=await store.bindForOperation!(f.first);
      await expect(bound.completeUpdatePublication!(record,publish)).rejects.toThrow('context changed');
    });expect(complete).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled();
  });
  it('propagates binding failure instead of invalid-summary fallback after awaited content parsing',async()=>{
    const f=await fixture();f.modes.set(f.first,[{protocol_version:1,profile:DATABASE_MEMORY_LEGACY_PROFILE,mode:'legacy',generation:'1'}]);
    const {service}=composed(f);const manager=await f.registry.resolve(f.registry.capture());
    const memory=new Memory({name:'Parsing Memory',description:'Owned parsing memory'},f.container.resolve('MetadataService'));
    jest.spyOn(manager,'list').mockResolvedValue([memory]);const entered=deferred();const release=deferred();
    jest.spyOn(manager as unknown as {serializeElement(memory:Memory):Promise<string>},'serializeElement').mockImplementation(async()=>{entered.resolve();await release.promise;throw new Error('Owned parsing failure');});
    const context=invocation(f.tracker,f.first);
    await f.tracker.runAsync(context,async()=>{
      const pending=service.listElements(request(f.first));try{await Promise.race([entered.promise,pending.then(()=>{throw new Error('Listing completed before owned barrier');})]);context.requestId=randomUUID();}finally{release.resolve();}
      await expect(pending).rejects.toThrow('context changed');
    });
  });
  it('checks the original binding after awaited publication before retirement and retains known-commit evidence',async()=>{
    const f=await fixture();const {provider,store}=composed(f);const context=invocation(f.tracker,f.first);
    const manager=await f.registry.resolve(f.registry.capture());const candidate=new Memory({name:'tail'},f.container.resolve('MetadataService'));
    const record={userId:f.first,type:'memories',name:'tail',canonicalName:'tail',displayName:null,version:1,updatedAt:new Date(),validationStatus:'valid',tags:[],metadata:{},content:''} as ConsolePortfolioElementDetailRecord;
    let retired=0;
    jest.spyOn(manager,'completeGuardedOperation').mockImplementation(async(_candidate,publish)=>{const result=await publish();retired++;return result;});
    await f.tracker.runAsync(context,async()=>{
      const operation=await provider.resolve(provider.capture());const bound=await store.bindForOperation!(f.first);
      (store as unknown as {publicationTails:WeakMap<object,unknown>}).publicationTails.set(record,{manager,candidate,requestKey:'original',targetKey:'target',bindingCheck:operation.assertCurrent});
      await expect(bound.completeUpdatePublication!(record,async()=>{context.requestId=randomUUID();return 'already-started publication';})).rejects.toThrow('context changed');
      const retained=(store as unknown as {guardedOperations:Map<string,{status:string;candidate:Memory;manager:MemoryManager}>}).guardedOperations.get('original');
      expect(retained).toMatchObject({status:'committed-publication-failed'});expect(retained?.candidate).toBe(candidate);expect(retained?.manager).toBe(manager);
    });expect(retired).toBe(0);
  });

  it('retains committed candidate truth when context changes after update returns before owning completion',async()=>{
    const f=await fixture();const {provider,store,service}=composed(f);const context=invocation(f.tracker,f.first);
    const manager=await f.registry.resolve(f.registry.capture());const candidate=new Memory({name:'tail'},f.container.resolve('MetadataService'));
    const record={userId:f.first,type:'memories',name:'tail',canonicalName:'tail',displayName:null,version:1,contentHash:'a'.repeat(64),updatedAt:new Date(),validationStatus:'valid',tags:[],metadata:{},content:'valid content'} as ConsolePortfolioElementDetailRecord;
    const complete=jest.spyOn(manager,'completeGuardedOperation');const originalBind=store.bindForOperation!;
    jest.spyOn(store,'bindForOperation').mockImplementation(async userId=>{
      const bound=await originalBind(userId);const operation=await provider.resolve(provider.capture());
      jest.spyOn(bound,'findByName').mockResolvedValue(record);
      jest.spyOn(bound,'update').mockImplementation(async()=>{
        (store as unknown as {publicationTails:WeakMap<object,unknown>}).publicationTails.set(record,{manager,candidate,requestKey:'original',targetKey:'target',bindingCheck:operation.assertCurrent});
        context.requestId=randomUUID();return record;
      });return bound;
    });
    await f.tracker.runAsync(context,async()=>{
      const req=request(f.first);req.headers['if-match']=portfolioElementEtag(record);req.body={metadata:{description:'submitted description'}};
      await expect(service.updateElement(req,'memories','tail')).rejects.toThrow('context changed');
      const retained=(store as unknown as {guardedOperations:Map<string,{status:string;candidate:Memory;manager:MemoryManager}>}).guardedOperations.get('original');
      expect(retained?.status).toBe('committed-publication-failed');expect(retained?.candidate).toBe(candidate);expect(retained?.manager).toBe(manager);
    });expect(complete).not.toHaveBeenCalled();
  });

});
