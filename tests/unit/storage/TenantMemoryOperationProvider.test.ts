import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import type { ElementManagerDeps } from '../../../src/elements/base/BaseElementManager.js';
import { admittedMemoryContainer } from '../../helpers/storage/admitted-memory-container.js';
import { DatabaseTenantMemoryRegistry } from '../../../src/storage/DatabaseTenantMemoryRegistry.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { logger } from '../../../src/utils/logger.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { TenantMemoryOperationProvider } from '../../../src/storage/TenantMemoryOperationProvider.js';
import { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import { Memory } from '../../../src/elements/memories/Memory.js';
import type { SessionActivationRegistry } from '../../../src/state/SessionActivationState.js';
import type { PersonaManager } from '../../../src/persona/PersonaManager.js';
import type { SkillManager } from '../../../src/elements/skills/SkillManager.js';
import { Ensemble } from '../../../src/elements/ensembles/Ensemble.js';
import type { EnsembleManager } from '../../../src/elements/ensembles/EnsembleManager.js';
import { AgentManager } from '../../../src/elements/agents/AgentManager.js';
import { Agent } from '../../../src/elements/agents/Agent.js';
import { createTestStorageFactory } from '../../helpers/createTestStorageFactory.js';
import { MCPAQLHandler, type HandlerRegistry } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { Gatekeeper } from '../../../src/handlers/mcp-aql/Gatekeeper.js';
import { PermissionLevel } from '../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import { SchemaDispatcher } from '../../../src/handlers/mcp-aql/SchemaDispatcher.js';
import { DATABASE_MEMORY_LEGACY_PROFILE } from '../../../src/storage/DatabaseMemoryLegacyMutationGuard.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { PortfolioPullHandler, type PortfolioPullHandlerDependencies } from '../../../src/handlers/PortfolioPullHandler.js';
import { ElementInstaller } from '../../../src/collection/ElementInstaller.js';
import { ElementType } from '../../../src/portfolio/PortfolioManager.js';
import type { PortfolioIndexManager } from '../../../src/portfolio/PortfolioIndexManager.js';
import type { UnifiedIndexManager } from '../../../src/portfolio/UnifiedIndexManager.js';
import { PortfolioHandler } from '../../../src/handlers/PortfolioHandler.js';
import type { TenantMemoryIndexDependencies } from '../../../src/portfolio/TenantMemoryIndexView.js';
import { CollectionHandler } from '../../../src/handlers/CollectionHandler.js';
import { SubmitToPortfolioTool, type SubmitToPortfolioToolDependencies } from '../../../src/tools/portfolio/submitToPortfolioTool.js';
import { PortfolioSyncManager, type PortfolioSyncManagerDependencies } from '../../../src/portfolio/PortfolioSyncManager.js';
import { FileDiscoveryUtil } from '../../../src/utils/FileDiscoveryUtil.js';
import { SyncHandler } from '../../../src/handlers/SyncHandlerV2.js';
import { PathService } from '../../../src/paths/PathService.js';
import { PerUserPathResolver } from '../../../src/paths/PerUserPathResolver.js';
import { PackageResourceLocator } from '../../../src/paths/PackageResourceLocator.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { IndexConfigManager } from '../../../src/portfolio/config/IndexConfig.js';
import type { GitHubClient } from '../../../src/collection/GitHubClient.js';

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
  let role = { rolsuper: false, rolbypassrls: false };
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
  return { registry, directory, container: root.container, tracker: root.container.resolve<ContextTracker>('ContextTracker'), db, scope, first, second, modes, builds, execute, transaction,
    setPause: (value: Promise<void>) => { pause = value; },
    setRole: (value: typeof role) => { role = value; },
    fail: (cause: unknown) => { failure = { cause }; } };
}


function invocation(tracker: ContextTracker, tenant: string, sessionId = randomUUID()) {
  return tracker.createSessionContext('test', { userId: tenant, sessionId,
    tenantId: null, transport: 'http', createdAt: 1 });
}

function indexDependencies(f: Awaited<ReturnType<typeof fixture>>): TenantMemoryIndexDependencies {
  const paths=new PathService({userResolver:new PerUserPathResolver(f.directory),packageLocator:new PackageResourceLocator(),userIdResolver:()=>f.first});
  const portfolio=new PortfolioManager(f.container.resolve('FileOperationsService'),{baseDir:f.directory},{pathService:paths,contextTracker:f.tracker});
  return {portfolioManager:portfolio,pathService:paths,indexConfig:new IndexConfigManager(),config:f.container.resolve('ConfigManager'),
    fileOperations:f.container.resolve('FileOperationsService'),remote:{githubIndexer:f.container.resolve('GitHubPortfolioIndexer'),
      githubClient:f.container.resolve('GitHubClient'),apiCache:f.container.resolve('APICache'),collectionIndexCache:f.container.resolve('CollectionIndexCache'),
      rateLimitTracker:f.container.resolve('RateLimitTracker'),performanceMonitor:f.container.resolve('PerformanceMonitor'),fileOperations:f.container.resolve('FileOperationsService')}};
}

function remoteCollection(f: Awaited<ReturnType<typeof fixture>>, provider: TenantMemoryOperationProvider,
  invoke: () => Promise<{content:{type:string;text:string}[]}>): CollectionHandler {
  const paths=new PathService({userResolver:new PerUserPathResolver(f.directory),packageLocator:new PackageResourceLocator(),userIdResolver:()=>f.first});
  const portfolio=new PortfolioManager(f.container.resolve('FileOperationsService'),{baseDir:f.directory},{pathService:paths,contextTracker:f.tracker});
  const installer=new ElementInstaller({} as GitHubClient,{memoryRegistry:f.registry,portfolioManager:portfolio,fileOperations:f.container.resolve('FileOperationsService')});
  const submit=new SubmitToPortfolioTool(f.container.resolve('APICache'),{memoryRegistry:f.registry,
    authManager:{},portfolioRepoManager:{},portfolioManager:portfolio,rateLimiter:{},fileOperations:f.container.resolve('FileOperationsService'),tokenManager:{}} as unknown as SubmitToPortfolioToolDependencies);
  const browser={browseCollection:async()=>{await invoke();return {items:[]};},formatBrowseResults:()=> 'remote-only collection'};
  const search={searchCollection:async()=>{await invoke();return [];},formatSearchResults:()=> 'remote-only collection',
    searchCollectionWithOptions:async()=>{await invoke();return {results:[],pagination:{}};},formatSearchResultsWithPagination:()=> 'remote-only collection',getCacheStats:async()=>({index:{isValid:false,hasCache:false,elements:0,age:0}})};
  const details={getCollectionContent:async()=>{await invoke();return {metadata:{},content:''};},formatPersonaDetails:()=> 'remote-only collection'};
  const cache={getCacheStats:async()=>{await invoke();return {isValid:false,itemCount:0,cacheAge:0};},getCacheFilePath:()=>path.join(f.directory,'absent')};
  const args=[browser,search,details,installer,cache,portfolio,f.container.resolve('APICache'),f.container.resolve('PersonaManager'),submit,undefined,
    {ensureInitialized:async()=>{}},f.container.resolve('PersonaIndicatorService'),f.container.resolve('FileOperationsService'),
    {provider,dependencies:{portfolioManager:portfolio,pathService:paths,indexConfig:new IndexConfigManager(),
      config:f.container.resolve('ConfigManager'),fileOperations:f.container.resolve('FileOperationsService'),remote:{githubIndexer:{},collectionIndexer:{}}}}];
  return new CollectionHandler(...args as ConstructorParameters<typeof CollectionHandler>);
}

describe('attributed database memory startup reads (controlled DB transport)', () => {
  it('preserves explicit LEGACY seed behavior while selecting DB autoload metadata', async () => {
    const f=await fixture();f.modes.set(f.first,[{protocol_version:1,profile:DATABASE_MEMORY_LEGACY_PROFILE,mode:'legacy',generation:'1'}]);
    const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const operation=await provider.resolve(provider.capture());expect(operation.manager.isGuardedHeadUpdateEnabled()).toBe(false);
      const metadata=f.container.resolve<import('../../../src/services/MetadataService.js').MetadataService>('MetadataService');
      const memory=new Memory({name:'Legacy autoload',autoLoad:true},metadata,operation.manager);
      const list=jest.spyOn(operation.manager,'list').mockResolvedValue([memory]);
      const seed=jest.spyOn(operation.manager,'installSeedMemories').mockResolvedValue(undefined);
      const result=await operation.manager.loadAndActivateAutoLoadMemories(operation.assertCurrent);
      expect(result.loaded).toBe(1);expect(result.errors).toEqual([]);expect(seed).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledWith({strictDatabase:true});
    });
  });

  it('routes actual Container autoload and activation restore through the captured manager without retrieving a root owner',async()=>{
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    const context=f.tracker.createSessionContext('background-task',{userId:f.first,sessionId:randomUUID(),tenantId:null,transport:'stdio',createdAt:1});
    await f.tracker.runAsync(context,async()=>{
      const operation=await provider.resolve(provider.capture());
      const metadata=f.container.resolve<import('../../../src/services/MetadataService.js').MetadataService>('MetadataService');
      const memory=new Memory({name:'Startup owner',autoLoad:true},metadata,operation.manager);
      const list=jest.spyOn(operation.manager,'list').mockResolvedValue([memory]);
      const seed=jest.spyOn(operation.manager,'installSeedMemories');
      f.container.register('DatabaseTenantMemoryRegistry',()=>f.registry);f.container.register('DatabaseInstance',()=>f.db);
      const fixed=jest.fn(()=>{throw new Error('Unattributed root retrieval');});f.container.replace('MemoryManager',fixed);
      f.container.replace('ConfigManager',()=>({getConfig:()=>({autoLoad:{enabled:true}})}));
      f.container.replace('PersonaManager',()=>({activatePersona:async()=>({success:true})}));
      f.container.replace('SkillManager',()=>({activateSkill:async()=>({success:true})}));
      f.container.replace('AgentManager',()=>({activateAgent:async()=>({success:true})}));
      f.container.replace('EnsembleManager',()=>({activateEnsemble:async()=>({success:true})}));
      const container=f.container as unknown as {
        deferredMemoryAutoload():Promise<void>;
        restoreActivations(store:import('../../../src/state/IActivationStateStore.js').IActivationStateStore):Promise<void>;
      };
      await container.deferredMemoryAutoload();
      expect((await operation.manager.getActiveMemories()).map(m=>m.metadata.name)).toEqual(['Startup owner']);
      const activate=jest.spyOn(operation.manager,'activateMemory');
      const remove=jest.fn();
      const store={getActivations:(type:string)=>type==='memory'?[{name:'Startup owner',activatedAt:'2026-10-08T00:00:00Z'}]:[],
        getSessionId:()=>context.session!.sessionId,removeStaleActivation:remove,recordActivation:jest.fn()};
      await container.restoreActivations(store as unknown as import('../../../src/state/IActivationStateStore.js').IActivationStateStore);
      expect(activate).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();
      expect(seed).not.toHaveBeenCalled();expect(fixed).not.toHaveBeenCalled();operation.assertCurrent();
      const cause=new Error('Captured startup active-owner census failure');
      list.mockImplementation(async options=>{if(options?.strictDatabase)throw cause;return [];});
      await expect(container.restoreActivations(store as unknown as import('../../../src/state/IActivationStateStore.js').IActivationStateStore)).rejects.toBe(cause);
      expect(remove).not.toHaveBeenCalled();expect(activate).not.toHaveBeenCalled();
      expect(store.getActivations('memory')).toEqual([{name:'Startup owner',activatedAt:'2026-10-08T00:00:00Z'}]);
    });
  });

  it('strictly selects and sorts existing guarded autoload owners without installing seeds or sharing session activation', async () => {
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    const first=invocation(f.tracker,f.first);const second=invocation(f.tracker,f.first);
    await f.tracker.runAsync(first,async()=>{
      const operation=await provider.resolve(provider.capture());const manager=operation.manager;
      const metadata=f.container.resolve<import('../../../src/services/MetadataService.js').MetadataService>('MetadataService');
      const late=new Memory({name:'Late autoload',autoLoad:true,priority:9},metadata,manager);
      const early=new Memory({name:'Early autoload',autoLoad:true,priority:1},metadata,manager);
      const omitted=new Memory({name:'Manual owner',autoLoad:false},metadata,manager);
      const list=jest.spyOn(manager,'list').mockResolvedValue([late,omitted,early]);
      const seed=jest.spyOn(manager,'installSeedMemories');
      await expect(manager.getAutoLoadMemories(operation.assertCurrent)).resolves.toEqual([early,late]);
      const result=await manager.loadAndActivateAutoLoadMemories(operation.assertCurrent);
      expect(result.loaded).toBe(2);expect(result.errors).toEqual([]);expect(seed).not.toHaveBeenCalled();
      expect(list).toHaveBeenCalledWith({strictDatabase:true});
      expect((await manager.getActiveMemories()).map(memory=>memory.metadata.name)).toEqual(['Late autoload','Early autoload']);
      await f.tracker.runAsync(second,async()=>{
        const other=await provider.resolve(provider.capture());expect(other.manager).toBe(manager);
        await expect(other.manager.getActiveMemories()).resolves.toEqual([]);
      });
      operation.assertCurrent();
    });
  });

  it('preserves a strict selected backend rejection and refuses binding drift before any owner activation', async () => {
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    const context=invocation(f.tracker,f.first);
    await f.tracker.runAsync(context,async()=>{
      const operation=await provider.resolve(provider.capture());const cause=new Error('Original startup DB read rejection');
      const list=jest.spyOn(operation.manager,'list').mockRejectedValue(cause);
      jest.spyOn(logger,'error').mockImplementation(()=>{throw new Error('Secondary startup observer rejection');});
      await expect(operation.manager.loadAndActivateAutoLoadMemories(operation.assertCurrent)).rejects.toBe(cause);
      const metadata=f.container.resolve<import('../../../src/services/MetadataService.js').MetadataService>('MetadataService');
      const memory=new Memory({name:'Drifting owner',autoLoad:true},metadata,operation.manager);
      const activate=jest.spyOn(memory,'activate');
      list.mockImplementation(async()=>{context.requestId=randomUUID();return [memory];});
      await expect(operation.manager.loadAndActivateAutoLoadMemories(operation.assertCurrent)).rejects.toThrow('context changed');
      expect(activate).not.toHaveBeenCalled();
    });
  });
});
describe('trusted memory caller capture with actual registry/managers', () => {
  it('refuses missing invocation before selecting any slot or building a manager', async () => {
    const f = await fixture(); const tracker = f.tracker;
    const provider = new TenantMemoryOperationProvider(f.registry, tracker);
    expect(() => provider.capture()).toThrow('Attributed'); expect(f.builds).not.toHaveBeenCalled();
  });
  it('shares one actual manager for same-tenant sessions while preserving each distinct invocation', async () => {
    const f = await fixture(); const tracker = f.tracker;
    const provider = new TenantMemoryOperationProvider(f.registry, tracker);
    const one = invocation(tracker, f.first); const two = invocation(tracker, f.first);
    const [a,b] = await Promise.all([one,two].map(context => tracker.runAsync(context, async () => {
      const bound = await provider.resolve(provider.capture()); bound.assertCurrent(); return bound;
    })));
    expect(a.manager).toBe(b.manager); expect(f.builds).toHaveBeenCalledTimes(1);
    tracker.run(one, a.assertCurrent); tracker.run(two, b.assertCurrent);
    expect(() => tracker.run(two, a.assertCurrent)).toThrow('context changed');
  });
  it('keeps different effective tenants in separate actual manager/factory entries', async () => {
    const f = await fixture(); const tracker = f.tracker;
    const provider = new TenantMemoryOperationProvider(f.registry, tracker);
    const [a,b] = await Promise.all([f.first,f.second].map(tenant => f.scope.run(tenant, () =>
      tracker.runAsync(invocation(tracker, tenant), async () => provider.resolve(provider.capture())))));
    expect(a.manager).not.toBe(b.manager); expect(f.builds).toHaveBeenCalledTimes(2);
  });
  it('refuses forged caller capture without reading a mode or selecting a fallback', async () => {
    const f = await fixture(); const provider = new TenantMemoryOperationProvider(f.registry, f.tracker);
    await expect(provider.resolve({protocolVersion:1})).rejects.toThrow('Authentic');
    expect(f.transaction).not.toHaveBeenCalled(); expect(f.builds).not.toHaveBeenCalled();
  });
  it.each(['request','session'])('refuses original %s drift while awaiting the exact initialization', async drift => {
    const f = await fixture(); const tracker = f.tracker;
    const provider = new TenantMemoryOperationProvider(f.registry, tracker);
    const context = invocation(tracker, f.first); const barrier = deferred(); f.setPause(barrier.promise);
    await tracker.runAsync(context, async () => {
      const pending = provider.resolve(provider.capture());
      if (drift === 'request') context.requestId = randomUUID();
      else context.session = Object.freeze({...context.session!, sessionId:randomUUID()});
      barrier.resolve(); await expect(pending).rejects.toThrow('context changed');
    });
  });
  it('rechecks effective override and registry closure without selecting another manager', async () => {
    const f = await fixture(); const tracker = f.tracker;
    const provider = new TenantMemoryOperationProvider(f.registry, tracker);
    await tracker.runAsync(invocation(tracker, f.first), async () => {
      const bound = await provider.resolve(provider.capture());
      expect(() => f.scope.run(f.second, bound.assertCurrent)).toThrow('binding');
      expect(f.builds).toHaveBeenCalledTimes(1);
      f.registry.close(); expect(bound.assertCurrent).toThrow('closed');
    });
  });
  it.each([null,undefined])('retains exact primitive initialization rejection %p when both observers throw', async cause => {
    const f = await fixture(); const tracker = f.tracker; f.fail(cause);
    const provider = new TenantMemoryOperationProvider(f.registry, tracker);
    jest.spyOn(SecurityMonitor,'logSecurityEvent').mockImplementation(() => { throw new Error('private sink'); });
    jest.spyOn(logger,'warn').mockImplementation(() => { throw new Error('private logger'); });
    await tracker.runAsync(invocation(tracker, f.first), async () => {
      await expect(provider.resolve(provider.capture())).rejects.toBe(cause);
    });
    expect(f.builds).not.toHaveBeenCalled();
  });
});

function crud(f: Awaited<ReturnType<typeof fixture>>, provider: TenantMemoryOperationProvider,
  tracker: ContextTracker, fixed?: MemoryManager, agent?: AgentManager): ElementCRUDHandler {
  const c = f.container;
  const initialization = c.resolve<{ensureInitialized:()=>Promise<void>}>('InitializationService');
  jest.spyOn(initialization, 'ensureInitialized').mockResolvedValue(undefined);
  return new ElementCRUDHandler(c.resolve('SkillManager'),c.resolve('TemplateManager'),c.resolve('TemplateRenderer'),
    agent ?? c.resolve('AgentManager'),fixed,c.resolve('EnsembleManager'),c.resolve('PersonaManager'),c.resolve('PortfolioManager'),
    c.resolve('InitializationService'),c.resolve('PersonaIndicatorService'),c.resolve('FileOperationsService'),
    c.resolve('ElementQueryService'),c.resolve('ValidationRegistry'),undefined,undefined,undefined,c.resolve('SessionActivationRegistry'),tracker,
    {memoryProvider:provider});
}
describe('actual CRUD and activation caller plumbing (transport reads controlled)', () => {
  it('refuses missing/structural configured providers and a different tracker rather than using a fixed manager', async () => {
    const f=await fixture();const tracker=f.tracker;
    const provider=new TenantMemoryOperationProvider(f.registry,tracker);const fixed=await f.registry.resolve(f.registry.capture());
    const list=jest.spyOn(fixed,'list');
    expect(()=>crud(f,undefined as unknown as TenantMemoryOperationProvider,tracker,fixed)).toThrow('Actual trusted');
    expect(()=>crud(f,{} as TenantMemoryOperationProvider,tracker,fixed)).toThrow('Actual trusted');
    expect(()=>crud(f,provider,new ContextTracker(),fixed)).toThrow('tracker binding mismatch');
    expect(list).not.toHaveBeenCalled();
  });

  it('uses one selected actual manager for a different tenant instead of the supplied cached root instance', async () => {
    const f = await fixture(); const tracker = f.tracker;
    const provider = new TenantMemoryOperationProvider(f.registry, tracker);
    const first = await f.scope.run(f.first, () => f.registry.resolve(f.registry.capture()));
    const second = await f.scope.run(f.second, () => f.registry.resolve(f.registry.capture()));
    const firstList = jest.spyOn(first,'list').mockResolvedValue([new Memory({name:'first-owner'},f.container.resolve('MetadataService'))]);
    const secondList = jest.spyOn(second,'list').mockResolvedValue([new Memory({name:'second-owner'},f.container.resolve('MetadataService'))]);
    const handler = crud(f,provider,tracker,first);
    const resolve = jest.spyOn(provider,'resolve');
    const result = await f.scope.run(f.second, () => tracker.runAsync(invocation(tracker,f.second),
      () => handler.getElements('memory')));
    expect(result).toHaveLength(1); expect((result[0] as Memory).metadata.name).toBe('second-owner');
    expect(firstList).not.toHaveBeenCalled();expect(secondList).toHaveBeenCalledTimes(1);expect(resolve).toHaveBeenCalledTimes(1);
  });
  it('binds the real memory activation strategy to the selected manager with no fixed fallback', async () => {
    const f = await fixture();const tracker = f.tracker;
    const provider = new TenantMemoryOperationProvider(f.registry,tracker);
    const manager = await f.registry.resolve(f.registry.capture());
    const memory = new Memory({name:'selected-owner'},f.container.resolve('MetadataService'));
    const activate = jest.spyOn(manager,'activateMemory').mockResolvedValue({success:true,memory,message:'activated'});
    const handler = crud(f,provider,tracker);
    await tracker.runAsync(invocation(tracker,f.first), async () => {
      const result = await handler.activateElement('selected-owner','memory');
      expect(result.content[0].text).toContain('selected-owner');
    });
    expect(activate).toHaveBeenCalledTimes(1);
  });
  it('refuses missing or changed invocation before initialization or any cached-manager read', async () => {
    const f = await fixture();const tracker = f.tracker;
    const provider = new TenantMemoryOperationProvider(f.registry,tracker);
    const fixed = await f.registry.resolve(f.registry.capture()); const list = jest.spyOn(fixed,'list').mockResolvedValue([]);
    const handler = crud(f,provider,tracker,fixed);
    await expect(handler.getElements('memory')).rejects.toThrow('Attributed');
    expect(list).not.toHaveBeenCalled();
    const context = invocation(tracker,f.first); const original = provider.resolve.bind(provider);
    jest.spyOn(provider,'resolve').mockImplementation(async capture => {
      const operation = await original(capture); context.requestId = randomUUID();return operation;
    });
    await tracker.runAsync(context, async () => {
      await expect(handler.getElements('memory')).rejects.toThrow('context changed');
    });
    expect(list).not.toHaveBeenCalled();
  });
  it('passes the selected actual memory manager through the real ensemble activation strategy', async () => {
    const f = await fixture(); const tracker = f.tracker;
    const provider = new TenantMemoryOperationProvider(f.registry,tracker);
    const manager = await f.registry.resolve(f.registry.capture());
    const ensemble = new Ensemble({name:'selected-ensemble'},[],f.container.resolve('MetadataService'));
    const activate = jest.spyOn(ensemble,'activateEnsemble').mockImplementation(async (_portfolio, managers) => {
      expect(managers.memoryManager).toBe(manager);
      return {success:true,activatedElements:[],failedElements:[],elementResults:[],conflicts:[],totalDuration:0};
    });
    jest.spyOn(f.container.resolve<EnsembleManager>('EnsembleManager'),'activateEnsemble')
      .mockResolvedValue({success:true,ensemble,message:'activated'});
    const handler = crud(f,provider,tracker);
    await tracker.runAsync(invocation(tracker,f.first), async () => {
      const result = await handler.activateElement('selected-ensemble','ensemble');
      expect(result.content[0].text).toContain('selected-ensemble');
    });
    expect(activate).toHaveBeenCalledTimes(1);
  });
  it('refuses changed invocation after an awaited body before delivering its result', async () => {
    const f = await fixture(); const tracker = f.tracker;
    const provider = new TenantMemoryOperationProvider(f.registry,tracker);
    const manager = await f.registry.resolve(f.registry.capture()); const context = invocation(tracker,f.first);
    const entry = deferred(); const release = deferred();
    const list = jest.spyOn(manager,'list').mockImplementation(async () => {entry.resolve();await release.promise;return [];});
    const handler = crud(f,provider,tracker);
    await tracker.runAsync(context,async () => {
      const pending=handler.getElements('memory');
      try { await entry.promise;context.requestId=randomUUID(); }
      finally {release.resolve();}
      await expect(pending).rejects.toThrow('context changed');
    });
    expect(list).toHaveBeenCalledTimes(1); // Already-started work is not cancelled or labelled rolled back.
  });
  it('refuses unattributed configured agent execution before tenant selection or state effects', async () => {
    const f=await fixture();const tracker=f.tracker;
    const provider=new TenantMemoryOperationProvider(f.registry,tracker);const handler=crud(f,provider,tracker);
    const agent=f.container.resolve<AgentManager>('AgentManager');
    const execute=jest.spyOn(agent,'executeAgent');const resume=jest.spyOn(agent,'continueAgentExecution');
    await expect(handler.executeAgent('agent',{})).rejects.toThrow('Attributed');
    await expect(handler.continueAgentExecution({agentName:'agent'})).rejects.toThrow('Attributed');
    expect(execute).not.toHaveBeenCalled();expect(resume).not.toHaveBeenCalled();expect(f.builds).not.toHaveBeenCalled();
  });

  it('coalesces policy work only within the same parent, actual manager and session', async () => {
    const f=await fixture();const tracker=f.tracker;const provider=new TenantMemoryOperationProvider(f.registry,tracker);
    await Promise.all([f.first,f.second].map(tenant => f.scope.run(tenant,()=>f.registry.resolve(f.registry.capture()))));
    const handler=crud(f,provider,tracker); const release=deferred(); const twoCollections=deferred();
    const init=f.container.resolve<{ensureInitialized:()=>Promise<void>}>('InitializationService');
    let count=0;
    jest.spyOn(init,'ensureInitialized').mockImplementation(async () => { if (++count===2) twoCollections.resolve(); await release.promise; });
    jest.spyOn(f.container.resolve<PersonaManager>('PersonaManager'),'getActivePersonas').mockReturnValue([]);
    jest.spyOn(f.container.resolve<SkillManager>('SkillManager'),'getActiveSkills').mockResolvedValue([]);
    jest.spyOn(f.container.resolve<AgentManager>('AgentManager'),'getActiveAgents').mockResolvedValue([]);
    jest.spyOn(f.container.resolve<EnsembleManager>('EnsembleManager'),'getActiveEnsembles').mockResolvedValue([]);
    const sessionId=randomUUID();const first=invocation(tracker,f.first,sessionId);const second=invocation(tracker,f.second,sessionId);
    const requests=[first,first,second].map(context=>f.scope.run(context.session!.userId,()=>
      tracker.runAsync(context,()=>handler.getActiveElementsForPolicy())));
    try { await Promise.race([twoCollections.promise,Promise.all(requests).then(()=>{throw new Error('Policy completed before collection barrier');})]); }
    finally {release.resolve();}
    await expect(Promise.all(requests)).resolves.toEqual([[],[],[]]);
    expect(count).toBe(2);
  });

  it('keeps actual session activation sets separate when two sessions share one actual tenant manager', async () => {
    const f=await fixture();const tracker=f.tracker;const provider=new TenantMemoryOperationProvider(f.registry,tracker);
    const manager=await f.registry.resolve(f.registry.capture());
    const one=new Memory({name:'session-one-memory'},f.container.resolve('MetadataService'));
    const two=new Memory({name:'session-two-memory'},f.container.resolve('MetadataService'));
    jest.spyOn(manager,'findByName').mockImplementation(async name=>name===one.metadata.name?one:two);
    jest.spyOn(manager,'list').mockResolvedValue([one,two]);
    const handler=crud(f,provider,tracker);const first=invocation(tracker,f.first);const second=invocation(tracker,f.first);
    await Promise.all([[first,one],[second,two]].map(([context,memory])=>
      tracker.runAsync(context as ReturnType<typeof invocation>,()=>handler.activateElement((memory as Memory).metadata.name,'memory'))));
    const state=f.container.resolve<SessionActivationRegistry>('SessionActivationRegistry');
    expect([...state.get(first.session!.sessionId)!.memories]).toEqual(['session-one-memory']);
    expect([...state.get(second.session!.sessionId)!.memories]).toEqual(['session-two-memory']);
    await tracker.runAsync(first,async()=>expect((await manager.getActiveMemories()).map(memory=>memory.metadata.name)).toEqual(['session-one-memory']));
    await tracker.runAsync(second,async()=>expect((await manager.getActiveMemories()).map(memory=>memory.metadata.name)).toEqual(['session-two-memory']));
  });

});


function aql(f: Awaited<ReturnType<typeof fixture>>, provider: TenantMemoryOperationProvider,
  fixed: MemoryManager, gatekeeper: Gatekeeper, extra: Partial<HandlerRegistry> = {}): MCPAQLHandler {
  const c = f.container;
  const handlers: HandlerRegistry = { elementCRUD: crud(f,provider,f.tracker), memoryManager: fixed,
    agentManager: c.resolve('AgentManager'), templateRenderer: c.resolve('TemplateRenderer'),
    elementQueryService: c.resolve('ElementQueryService'), portfolioManager: c.resolve('PortfolioManager'), gatekeeper, ...extra };
  return new MCPAQLHandler(handlers, f.tracker, provider);
}
function permissiveGate(): Gatekeeper {
  const gate = new Gatekeeper(undefined, { enableAuditLogging: false });
  const enforce = gate.enforce.bind(gate);
  jest.spyOn(gate, 'enforce').mockImplementation((input, operations) => {
    const decision = enforce(input,operations);
    if (decision.errorCode === 'ENDPOINT_MISMATCH' || decision.errorCode === 'UNKNOWN_OPERATION') return decision;
    return { allowed:true,permissionLevel:PermissionLevel.AUTO_APPROVE,reason:'Owned test authorization' };
  });
  return gate;
}
describe('actual AQL local caller view and inert pre-gate DB construction', () => {
  it.each(['legacy','guarded'] as const)('refuses supplied filesystem watcher before %s manager construction', async mode => {
    const f=await fixture();const original=f.builds.getMockImplementation()!;
    f.modes.set(f.first,[{protocol_version:1,profile:mode==='legacy'?DATABASE_MEMORY_LEGACY_PROFILE:DATABASE_MEMORY_ADMISSION_PROFILE,mode,generation:'1'}]);
    const watchDirectory=jest.fn(()=>()=>{});
    f.builds.mockImplementation((factory,resolver)=>({...original(factory,resolver),fileWatchService:{watchDirectory} as unknown as ElementManagerDeps['fileWatchService']}));
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
      await expect(provider.resolve(provider.capture())).rejects.toThrow('excludes filesystem watchers');
    });
    expect(watchDirectory).not.toHaveBeenCalled();
  });
  it('preserves ordinary standalone manager watcher registration when enabled', async()=>{
    const f=await fixture();const original=f.builds.getMockImplementation()!;const watchDirectory=jest.fn(()=>()=>{});
    const previous=process.env.DOLLHOUSE_ENABLE_FILE_WATCHER;process.env.DOLLHOUSE_ENABLE_FILE_WATCHER='true';
    let manager:MemoryManager|undefined;
    try {
      manager=new MemoryManager({...original(f.container.resolve('StorageLayerFactory'),()=>f.first),
        fileWatchService:{watchDirectory} as unknown as ElementManagerDeps['fileWatchService']});
      expect(watchDirectory).toHaveBeenCalledTimes(1);
    } finally { if(previous===undefined)delete process.env.DOLLHOUSE_ENABLE_FILE_WATCHER;else process.env.DOLLHOUSE_ENABLE_FILE_WATCHER=previous;await manager?.dispose(); }
  });
  it('requires a genuine operation minted by the same provider for nested CRUD binding',async()=>{
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    const other=new TenantMemoryOperationProvider(f.registry,f.tracker);const handler=crud(f,provider,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const operation=await provider.resolve(provider.capture());
      expect(()=>handler.bindCapturedMemoryOperation(provider,{...operation})).toThrow('Authentic bound');
      expect(()=>handler.bindCapturedMemoryOperation(other,operation)).toThrow('provider binding mismatch');
      expect(handler.bindCapturedMemoryOperation(provider,operation)).toBeInstanceOf(ElementCRUDHandler);
    });
  });
  it('dispatches actual schema CRUD and legacy search through one selected manager without root use or recapture',async()=>{
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    const fixed=await f.registry.resolve(f.registry.capture());const selected=await f.scope.run(f.second,()=>f.registry.resolve(f.registry.capture()));
    const rootList=jest.spyOn(fixed,'list').mockResolvedValue([]);
    const list=jest.spyOn(selected,'list').mockResolvedValue([new Memory({name:'selected-owner',description:'selected-description'},f.container.resolve('MetadataService'))]);
    const resolve=jest.spyOn(provider,'resolve');const handler=aql(f,provider,fixed,permissiveGate());
    expect(SchemaDispatcher.canDispatch('list_elements',handler.operations)).toBe(true);
    expect(SchemaDispatcher.canDispatch('query_elements',handler.operations)).toBe(false);
    await f.scope.run(f.second,()=>f.tracker.runAsync(invocation(f.tracker,f.second),async()=>{
      const schema=await handler.handleRead({operation:'list_elements',params:{element_type:'memory'}});
      expect(schema.success).toBe(true);expect(JSON.stringify(schema)).toContain('selected-owner');
      const legacy=await handler.handleRead({operation:'query_elements',element_type:'memory',params:{}});
      expect(legacy.success).toBe(true);expect(JSON.stringify(legacy)).toContain('selected-owner');
    }));
    expect(rootList).not.toHaveBeenCalled();expect(list).toHaveBeenCalledTimes(2);expect(resolve).toHaveBeenCalledTimes(2);
  });
  it('denies the real gate before any tenant memory initialization, reads, repair, seed, candidate or persistence effects',async()=>{
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    const fixed=await f.registry.resolve(f.registry.capture());const gate=new Gatekeeper(undefined,{enableAuditLogging:false});
    jest.spyOn(gate,'enforce').mockReturnValue({allowed:false,permissionLevel:PermissionLevel.DENY,reason:'Owned denial'});
    const effects=['list','load','save','find','assertPersistable','repairCorruptedNames','installSeedMemories','loadAndActivateAutoLoadMemories'] as const;
    const spies=effects.map(method=>jest.spyOn(MemoryManager.prototype,method));
    const handler=aql(f,provider,fixed,gate);
    await f.scope.run(f.second,()=>f.tracker.runAsync(invocation(f.tracker,f.second),async()=>{
      const result=await handler.handleCreate({operation:'addEntry',params:{element_name:'untouched',content:'unaccepted'}});
      expect(result.success).toBe(false);
    }));
    expect(gate.enforce).toHaveBeenCalledTimes(1);expect(f.builds).toHaveBeenCalledTimes(2);
    for(const spy of spies)expect(spy).not.toHaveBeenCalled();
  });
  it('refuses changed original invocation during the policy barrier before selected-memory dispatch',async()=>{
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);const fixed=await f.registry.resolve(f.registry.capture());
    const gate=permissiveGate();const context=invocation(f.tracker,f.first);const handler=aql(f,provider,fixed,gate);
    const list=jest.spyOn(fixed,'list').mockResolvedValue([]);
    jest.spyOn(gate,'enforce').mockImplementation(()=>{context.requestId=randomUUID();return {allowed:true,permissionLevel:PermissionLevel.AUTO_APPROVE,reason:'Controlled drift'};});
    await f.tracker.runAsync(context,async()=>{
      const result=await handler.handleRead({operation:'list_elements',params:{element_type:'memory'}});
      expect(result.success).toBe(false);expect(JSON.stringify(result)).toContain('context changed');
    });
    expect(list).not.toHaveBeenCalled();
  });
  it('refuses configured execution with an ordinary agent manager and unsupported custom agent schemas before state effects',async()=>{
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);const fixed=await f.registry.resolve(f.registry.capture());
    const agent=f.container.resolve<AgentManager>('AgentManager');const execute=jest.spyOn(agent,'executeAgent');const resume=jest.spyOn(agent,'continueAgentExecution');
    const handler=aql(f,provider,fixed,permissiveGate());
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      for(const operation of ['execute_agent','continue_execution','resume_from_handoff']) {
        const result=await handler.handleExecute({operation,params:{element_name:'unexecuted'}});
        expect(result.success).toBe(false);expect(JSON.stringify(result)).toContain('Agent memory binding requires configured composition');
      }
    });
    expect(execute).not.toHaveBeenCalled();expect(resume).not.toHaveBeenCalled();
  });
  it('refuses explicit configured provider absence while preserving ordinary two-argument construction',async()=>{
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);const fixed=await f.registry.resolve(f.registry.capture());
    const configured=aql(f,provider,fixed,permissiveGate());
    const handlers=(configured as unknown as {handlers:HandlerRegistry}).handlers;
    for(const missing of [undefined,null,false])expect(()=>new MCPAQLHandler(handlers,f.tracker,missing as unknown as TenantMemoryOperationProvider)).toThrow('Actual trusted memory provider');
    expect(()=>new MCPAQLHandler({...handlers,memoryManager:fixed},f.tracker)).not.toThrow();
    expect(()=>new MCPAQLHandler(handlers,f.tracker)).toThrow('requires a fixed memory manager');
    expect(f.builds).toHaveBeenCalledTimes(1);
  });
  it('refuses structural Portfolio, Collection, Sync and index substitutes before effects',async()=>{
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);const fixed=await f.registry.resolve(f.registry.capture());
    const invoke=jest.fn(async()=>({content:[{type:'text',text:'unexpected cached operation'}]}));
    const extra={collectionHandler:{installContent:invoke,submitContent:invoke},
      portfolioHandler:{portfolioStatus:invoke,portfolioConfig:invoke,searchPortfolio:invoke,searchAll:invoke,initPortfolio:invoke,syncPortfolio:invoke},
      syncHandler:{handleSyncOperation:invoke},
      enhancedIndexHandler:{findSimilarElements:invoke,getElementRelationships:invoke,searchByVerb:invoke,getRelationshipStats:invoke}} as unknown as Partial<HandlerRegistry>;
    const handler=aql(f,provider,fixed,permissiveGate(),extra);
    const operations=[['install_collection_content','CREATE'],['submit_collection_content','CREATE'],
      ['portfolio_status','READ'],['portfolio_config','READ'],['search_portfolio','READ'],['search_all','READ'],
      ['init_portfolio','CREATE'],['sync_portfolio','CREATE'],['portfolio_element_manager','CREATE'],
      ['find_similar_elements','READ'],['get_element_relationships','READ'],['search_by_verb','READ'],['get_relationship_stats','READ']] as const;
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      for(const [operation,endpoint] of operations){
        const input={operation,params:{element_type:'persona',type:'persona',path:'personas/unknown.yaml',content:'unknown',query:'test',verb:'test',element_name:'test',operation:'download'}};
        const result=endpoint==='CREATE'?await handler.handleCreate(input):await handler.handleRead(input);
        expect(result.success).toBe(false);expect(JSON.stringify(result)).toContain('composition');
      }
    });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('preserves remote-only collection reads in configured mode',async()=>{
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);const fixed=await f.registry.resolve(f.registry.capture());
    const invoke=jest.fn(async()=>({content:[{type:'text',text:'remote-only collection'}]}));
    const resolve=jest.spyOn(provider,'resolve');
    const handler=aql(f,provider,fixed,permissiveGate(),{collectionHandler:remoteCollection(f,provider,invoke)});
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      for(const operation of ['browse_collection','search_collection','search_collection_enhanced','get_collection_content','get_collection_cache_health']){
        const result=await handler.handleRead({operation,params:{query:'test',path:'remote/path'}});
        expect(result).toMatchObject({success:true});expect(JSON.stringify(result)).toContain(operation==='get_collection_cache_health'?'Collection Cache Health':'remote-only collection');
      }
    });
    expect(invoke).toHaveBeenCalledTimes(5);expect(resolve).toHaveBeenCalledTimes(5);
  });

  it('keeps configured collection settings on the original parent while invocation views remain private',async()=>{
    const f=await fixture(),provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    const handler=remoteCollection(f,provider,async()=>({content:[]}));
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      await handler.configureCollectionSubmission(true);
      expect(handler.isAutoSubmitEnabled()).toBe(true);
      expect(JSON.stringify(await handler.getCollectionSubmissionConfig())).toContain('Enabled');
      await handler.configureCollectionSubmission(false);expect(handler.isAutoSubmitEnabled()).toBe(false);
    });
  });

  it('preserves original collection binding drift over cleanup and throwing logging observers',async()=>{
    const f=await fixture(),provider=new TenantMemoryOperationProvider(f.registry,f.tracker),context=invocation(f.tracker,f.first);
    const handler=remoteCollection(f,provider,async()=>{context.requestId=randomUUID();return {content:[]};});
    await f.tracker.runAsync(context,async()=>{
      let originalCause:unknown;const check=provider.assertOperation.bind(provider);
      jest.spyOn(provider,'assertOperation').mockImplementation(operation=>{try{check(operation);}catch(cause){originalCause??=cause;throw cause;}});
      jest.spyOn(logger,'error').mockImplementation(()=>{throw new Error('Secondary observer');});
      const caught=await handler.browseCollection().catch(cause=>cause);
      expect(originalCause).toBeInstanceOf(Error);expect(caught).toBe(originalCause);
    });
  });

});


describe('guarded public memory discovery boundary',()=>{
  it('refuses explicit public inclusion before discovery/load without granting SYSTEM owner authority',async()=>{
    const f=await fixture();
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
      const operation=await provider.resolve(provider.capture());f.execute.mockClear();
      await expect(operation.manager.list({includePublic:true,strictDatabase:true})).rejects.toThrow('public inclusion is unavailable');
      expect(f.execute).not.toHaveBeenCalled();
    });
  });
});

describe('actual configured Container handler assembly (controlled DB transport)',()=>{
  it('constructs the complete handler bundle without retrieving any fixed root memory or index helper',async()=>{
    const f=await fixture(),deps=indexDependencies(f);
    f.container.register('DatabaseTenantMemoryRegistry',()=>f.registry);
    f.container.register('DatabaseInstance',()=>f.db);
    f.container.register('CurrentUserId',()=>f.first);
    const {DatabaseActivationStateStore}=await import('../../../src/state/DatabaseActivationStateStore.js');
    const {DatabaseConfirmationStore}=await import('../../../src/state/DatabaseConfirmationStore.js');
    const {DatabaseChallengeStore}=await import('../../../src/state/DatabaseChallengeStore.js');
    f.container.register('DatabaseActivationStateStoreClass',()=>DatabaseActivationStateStore);
    f.container.register('DatabaseConfirmationStoreClass',()=>DatabaseConfirmationStore);
    f.container.register('DatabaseChallengeStoreClass',()=>DatabaseChallengeStore);
    f.container.register('PathService',()=>deps.pathService,{override:f.container.hasRegistration('PathService')});
    f.container.register('UserPathResolver',()=>new PerUserPathResolver(f.directory),{override:f.container.hasRegistration('UserPathResolver')});
    f.container.replace('PortfolioManager',()=>deps.portfolioManager);
    const denied=jest.fn(()=>{throw new Error('Fixed root memory/index retrieval');});
    for(const name of ['MemoryManager','EnhancedIndexManager','PortfolioIndexManager','UnifiedIndexManager'])f.container.replace(name,denied);
    expect(f.container.hasRegistration('MemoryLogSink')).toBe(false);
    const persona=f.container.resolve<PersonaManager>('PersonaManager');jest.spyOn(persona,'reload').mockResolvedValue(undefined);
    Object.assign(f.container,{personasDir:deps.portfolioManager.getElementDir(ElementType.PERSONA)});
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const bundle=await f.container.bootstrapHandlers();
      expect(f.container.hasRegistration('MemoryLogSink')).toBe(true);
      expect(bundle.elementCrudHandler).toBeInstanceOf(ElementCRUDHandler);expect(bundle.collectionHandler).toBeInstanceOf(CollectionHandler);
      expect(bundle.portfolioHandler).toBeInstanceOf(PortfolioHandler);expect(bundle.syncHandler).toBeInstanceOf(SyncHandler);
      expect(bundle.mcpAqlHandler).toBeInstanceOf(MCPAQLHandler);expect(denied).not.toHaveBeenCalled();
      await bundle.mcpAqlHandler.dispose();
    });
  });
});

describe('server-created authenticated HTTP memory provider', () => {
  it('refuses a different signed-session subject before selecting a tenant or reading storage', async () => {
    const f = await fixture();
    const provider = new TenantMemoryOperationProvider(f.registry, f.tracker, f.first);
    f.tracker.run(invocation(f.tracker, f.second), () => {
      expect(() => provider.capture()).toThrow('server-authenticated HTTP subject');
    });
    expect(f.transaction).not.toHaveBeenCalled(); expect(f.builds).not.toHaveBeenCalled();
  });
  it('refuses an effective override differing from its authentic HTTP subject before initialization', async () => {
    const f = await fixture();
    const provider = new TenantMemoryOperationProvider(f.registry, f.tracker, f.first);
    f.scope.run(f.second, () => f.tracker.run(invocation(f.tracker, f.first), () => {
      expect(() => provider.capture()).toThrow('trusted construction identity');
    }));
    expect(f.transaction).not.toHaveBeenCalled(); expect(f.builds).not.toHaveBeenCalled();
  });
  it('shares the actual tenant manager across authentic same-subject sessions without sharing their invocation', async () => {
    const f = await fixture();
    const provider = new TenantMemoryOperationProvider(f.registry, f.tracker, f.first);
    const one = invocation(f.tracker, f.first); const two = invocation(f.tracker, f.first);
    const [a,b] = await Promise.all([one,two].map(context => f.tracker.runAsync(context, async () =>
      provider.resolve(provider.capture()))));
    expect(a.manager).toBe(b.manager); expect(f.builds).toHaveBeenCalledTimes(1);
    f.tracker.run(one,a.assertCurrent); f.tracker.run(two,b.assertCurrent);
    expect(() => f.tracker.run(two,a.assertCurrent)).toThrow('context changed');
  });
  it('refuses a local transport through a configured HTTP provider before storage', async () => {
    const f = await fixture(); const provider = new TenantMemoryOperationProvider(f.registry,f.tracker,f.first);
    const context = invocation(f.tracker,f.first); context.session = Object.freeze({...context.session!,transport:'stdio'});
    f.tracker.run(context, () => expect(() => provider.capture()).toThrow('server-authenticated'));
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each([undefined,null,false,'not-a-uuid'])('refuses an explicitly configured unknown subject %p', async subject => {
    const f = await fixture();
    expect(() => new TenantMemoryOperationProvider(f.registry,f.tracker,subject as string)).toThrow();
    expect(f.transaction).not.toHaveBeenCalled();
  });
});


describe('configured AQL construction without a root manager', () => {
  it('creates no fixed memory dispatchers and uses an authentic complete view for the real read route', async () => {
    const f=await fixture(); const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    const fixed=await f.registry.resolve(f.registry.capture());
    const selected=await f.scope.run(f.second,()=>f.registry.resolve(f.registry.capture()));
    const rootList=jest.spyOn(fixed,'list').mockResolvedValue([]);
    jest.spyOn(selected,'list').mockResolvedValue([new Memory({name:'selected-tenant-row'},f.container.resolve('MetadataService'))]);
    const original=aql(f,provider,fixed,permissiveGate());
    const handlers=(original as unknown as {handlers:Omit<HandlerRegistry,'memoryManager'>}).handlers;
    expect(Object.hasOwn(handlers,'memoryManager')).toBe(false);
    const getterSessions:string[]=[];
    Object.defineProperty(handlers,'metricsSink',{configurable:true,enumerable:true,get:()=>{
      getterSessions.push(f.tracker.getSessionContext()?.userId ?? 'outside'); return undefined;
    }});
    const configured=new MCPAQLHandler(handlers,f.tracker,provider);
    expect(getterSessions).toEqual([]);
    const fields=configured as unknown as Record<string,unknown>;
    for(const key of ['searchHandler','elementCRUDDispatcher','memorySaveHandler','agentExecutionHandler','gatekeeperHandler'])
      expect(fields[key]).toBeUndefined();
    await f.scope.run(f.second,()=>f.tracker.runAsync(invocation(f.tracker,f.second),async()=>{
      const result=await configured.handleRead({operation:'list_elements',params:{element_type:'memory'}});
      expect(result.success).toBe(true); expect(JSON.stringify(result)).toContain('selected-tenant-row');
    }));
    expect(rootList).not.toHaveBeenCalled(); expect(getterSessions).not.toEqual([]);
    expect(getterSessions.every(tenant=>tenant===f.second)).toBe(true);
    await configured.dispose(); await original.dispose();
  });
});


async function composedAgent(f: Awaited<ReturnType<typeof fixture>>) {
  const c = f.container;
  const manager = new AgentManager({ memoryRegistry: f.registry, contextTracker: f.tracker,
    baseDir: f.directory, portfolioManager: c.resolve('PortfolioManager'),
    fileLockManager: c.resolve('FileLockManager'), fileOperationsService: c.resolve('FileOperationsService'),
    validationRegistry: c.resolve('ValidationRegistry'), serializationService: c.resolve('SerializationService'),
    metadataService: c.resolve('MetadataService'), eventDispatcher: c.resolve('ElementEventDispatcher'), storageLayerFactory: createTestStorageFactory(c.resolve('FileOperationsService')) });
  const owner = owned.find(item => item.directory === f.directory)!; const previous = owner.dispose;
  owner.dispose = async () => { try { await manager.dispose(); } finally { await previous(); } };
  const agent = new Agent({ name: 'Bound Reader' }, c.resolve('MetadataService'));
  Object.assign(agent.metadata,{goal:{ template:'Inspect memory',parameters:[],successCriteria:[] },
    activates:{memories:['Selected Memory']}});
  await manager.save(agent, 'bound-reader.md');
  const resolver = jest.fn(() => { throw new Error('Root memory manager must not be resolved'); });
  manager.setElementManagerResolver(resolver);
  return { manager, resolver };
}

describe('actual agent execution retains its authentic selected memory operation (DB transport controlled)', () => {
  it.each(['missing','forged','other-provider','stale'])('refuses %s binding before agent state work', async kind => {
    const f = await fixture(); const provider = new TenantMemoryOperationProvider(f.registry,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async () => {
      const {manager} = await composedAgent(f);
      const operation = await provider.resolve(provider.capture());
      const load = jest.spyOn(manager,'resolveExecutionIdentity');
      const binding = kind === 'missing' ? undefined : kind === 'forged'
        ? {provider,operation:{manager:operation.manager,assertCurrent:()=>undefined}}
        : kind === 'other-provider' ? {provider:new TenantMemoryOperationProvider(f.registry,f.tracker),operation}
        : {provider,operation};
      if(kind === 'stale') f.registry.close();
      await expect(manager.executeAgent('Bound Reader',{}, {},binding)).rejects.toThrow();
      await expect(manager.continueAgentExecution({agentName:'Bound Reader'},binding)).rejects.toThrow();
      expect(load).not.toHaveBeenCalled();
    });
  });

  it('reads the captured actual manager through real execution without calling the root resolver', async () => {
    const f = await fixture(); const provider = new TenantMemoryOperationProvider(f.registry,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async () => {
      const {manager,resolver} = await composedAgent(f);
      const operation = await provider.resolve(provider.capture());
      const memory = new Memory({name:'Selected Memory'},f.container.resolve('MetadataService'));
      await memory.addEntry('Selected tenant entry');
      const list = jest.spyOn(operation.manager,'list').mockResolvedValue([memory]);
      const result = await manager.executeAgent('Bound Reader',{}, {},{provider,operation});
      expect(result.activeElements.memories).toEqual([{name:'Selected Memory',content:"Memory 'Selected Memory' with 1 entries"}]);
      expect(list).toHaveBeenCalledTimes(1); expect(list).toHaveBeenCalledWith({strictDatabase:true});
      await manager.recordAgentStep({agentName:'Bound Reader',goalId:result.goalId,stepDescription:'Read selected memory',outcome:'success'});
      const continued = await manager.continueAgentExecution({agentName:'Bound Reader',goalId:result.goalId},{provider,operation});
      expect(continued.activeElements.memories).toEqual(result.activeElements.memories);
      expect(list).toHaveBeenCalledTimes(2);
      expect(resolver).not.toHaveBeenCalled();
    });
  });

  it('routes real configured AQL execution through one selected manager and the original provider', async () => {
    const f=await fixture(); const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const {manager,resolver}=await composedAgent(f); const selected=await f.registry.resolve(f.registry.capture());
      const memory=new Memory({name:'Selected Memory'},f.container.resolve('MetadataService')); await memory.addEntry('Selected AQL entry');
      const list=jest.spyOn(selected,'list').mockResolvedValue([memory]);
      const handler=aql(f,provider,selected,permissiveGate(),{agentManager:manager});
      const resolve=jest.spyOn(provider,'resolve');
      const result=await handler.handleExecute({operation:'execute_agent',params:{element_name:'Bound Reader',parameters:{}}});
      expect(result.success).toBe(true); expect(JSON.stringify(result)).toContain("Memory 'Selected Memory' with 1 entries");
      expect(list).toHaveBeenCalledWith({strictDatabase:true});expect(resolve).toHaveBeenCalledTimes(1);expect(resolver).not.toHaveBeenCalled();
    });
  });

  it('routes real configured CRUD execution and continuation through their captured manager', async () => {
    const f=await fixture(); const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const {manager,resolver}=await composedAgent(f); const selected=await f.registry.resolve(f.registry.capture());
      const memory=new Memory({name:'Selected Memory'},f.container.resolve('MetadataService')); await memory.addEntry('Selected CRUD entry');
      const list=jest.spyOn(selected,'list').mockResolvedValue([memory]); const resolve=jest.spyOn(provider,'resolve');
      const handler=crud(f,provider,f.tracker,undefined,manager);
      const response=await handler.executeAgent('Bound Reader',{});
      const result=JSON.parse(response.content[0].text);
      expect(result.activeElements.memories).toEqual([{name:'Selected Memory',content:"Memory 'Selected Memory' with 1 entries"}]);
      await manager.recordAgentStep({agentName:'Bound Reader',goalId:result.goalId,stepDescription:'Read selected memory',outcome:'success'});
      const continued=await handler.continueAgentExecution({agentName:'Bound Reader'});
      expect(JSON.parse(continued.content[0].text).activeElements.memories).toEqual(result.activeElements.memories);
      expect(list).toHaveBeenCalledTimes(2); expect(resolve).toHaveBeenCalledTimes(2); expect(resolver).not.toHaveBeenCalled();
    });
  });

  it('retains an original memory read rejection even when a logging observer throws', async () => {
    const f = await fixture(); const provider = new TenantMemoryOperationProvider(f.registry,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async () => {
      const {manager} = await composedAgent(f);
      const operation = await provider.resolve(provider.capture()); const cause=new Error('Exact selected read failure');
      jest.spyOn(operation.manager,'list').mockRejectedValue(cause);
      jest.spyOn(logger,'error').mockImplementation(()=>{throw new Error('Secondary logging failure');});
      await expect(manager.executeAgent('Bound Reader',{}, {},{provider,operation})).rejects.toBe(cause);
    });
  });

  it('keeps two invocation-local AQL handlers under the same outer execution and policy lock', async () => {
    const f=await fixture(); const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const {manager}=await composedAgent(f); const selected=await f.registry.resolve(f.registry.capture());
      const memory=new Memory({name:'Selected Memory'},f.container.resolve('MetadataService'));
      jest.spyOn(selected,'list').mockResolvedValue([memory]);
      const handler=aql(f,provider,selected,permissiveGate(),{agentManager:manager});
      const policyEntered=deferred(); const releasePolicy=deferred(); const secondTargetReady=deferred();
      const originalExecute=manager.executeAgent.bind(manager); let executionsCompleted=0;
      const execute=jest.spyOn(manager,'executeAgent').mockImplementation(async(...args)=>{
        const result=await originalExecute(...args); executionsCompleted++; return result;
      });
      const originalRead=manager.read.bind(manager); let heldPolicy=false;
      const read=jest.spyOn(manager,'read').mockImplementation(async name=>{
        // Hold the owning policy hydration AFTER AgentManager has released its inner state lock.
        if(executionsCompleted===1 && !heldPolicy){ heldPolicy=true;policyEntered.resolve();await releasePolicy.promise; }
        return originalRead(name);
      });
      const originalResolve=manager.resolveExecutionIdentity.bind(manager); let secondStarted=false;
      jest.spyOn(manager,'resolveExecutionIdentity').mockImplementation(async name=>{
        const identity=await originalResolve(name); if(secondStarted)secondTargetReady.resolve(); return identity;
      });
      const first=handler.handleExecute({operation:'execute_agent',params:{element_name:'Bound Reader',parameters:{}}});
      await policyEntered.promise;
      secondStarted=true;
      const second=handler.handleExecute({operation:'execute_agent',params:{element_name:'Bound Reader',parameters:{}}});
      try {
        await secondTargetReady.promise;
        // Drain the ready promise continuations; no elapsed-time or scheduling budget assertion.
        await new Promise<void>(resolve=>setImmediate(resolve));
        expect(executionsCompleted).toBe(1); expect(execute).toHaveBeenCalledTimes(1);
      } finally { releasePolicy.resolve(); }
      expect((await first).success).toBe(true); expect((await second).success).toBe(true);
      expect(execute).toHaveBeenCalledTimes(2); expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
      await handler.dispose();
    });
  });

  it('refuses original context drift during a selected memory read rather than publishing partial activation', async () => {
    const f = await fixture(); const provider = new TenantMemoryOperationProvider(f.registry,f.tracker);
    const context = invocation(f.tracker,f.first);
    await f.tracker.runAsync(context,async () => {
      const {manager} = await composedAgent(f); const operation = await provider.resolve(provider.capture());
      jest.spyOn(operation.manager,'list').mockImplementation(async()=>{context.requestId=randomUUID();return [];});
      await expect(manager.executeAgent('Bound Reader',{}, {},{provider,operation})).rejects.toThrow('context changed');
    });
  });
});


describe('bound portfolio mutation helpers (actual provider, controlled remote/storage collaborators)', () => {
  function pull(f: Awaited<ReturnType<typeof fixture>>, types: ElementType[]) {
    const actions=types.map(type=>({type,name:'Bound owner',path:`${type}/bound-owner.yaml`,action:'add' as const}));
    const deps={ memoryRegistry:f.registry,
      portfolioManager:{initialize:jest.fn(async()=>{}),getElementDir:()=>f.directory},
      githubIndexer:{getIndex:jest.fn(async()=>({totalElements:types.length,elements:new Map(),username:'fixture',repository:'fixture'}))},
      portfolioRepoManager:{},syncComparer:{compareElements:()=>({toAdd:actions,toUpdate:[],toDelete:[],toSkip:[]})},
      downloader:{downloadFromGitHub:jest.fn(async()=>({content:'metadata:\n  name: Bound owner\nentries: []\n'}))},
      fileOperations:{createDirectory:jest.fn(async()=>{}),writeFile:jest.fn(async()=>{}),deleteFile:jest.fn(async()=>{})},
      tokenManager:{},
    };
    const index={rebuildIndex:jest.fn(async()=>{}),getElementsByType:jest.fn(async()=>[])};
    return {deps,index,root:new PortfolioPullHandler(deps as unknown as PortfolioPullHandlerDependencies)};
  }

  it('refuses configured unbound helpers and forged operations before remote or local effects',async()=>{
    const f=await fixture();const p=pull(f,[ElementType.SKILL]);
    await expect(p.root.executePull({direction:'pull'},'')).rejects.toThrow('Authentic selected');
    expect(p.deps.githubIndexer.getIndex).not.toHaveBeenCalled();expect(p.deps.portfolioManager.initialize).not.toHaveBeenCalled();
    const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      expect(()=>p.root.bindMemoryOperation(provider,{manager:{} as MemoryManager,assertCurrent:()=>{}},p.index as unknown as PortfolioIndexManager)).toThrow('Authentic bound');
      expect(p.deps.downloader.downloadFromGitHub).not.toHaveBeenCalled();
    });
  });

  it('preflights the complete mixed mutation set before launching any guarded partial writes',async()=>{
    const f=await fixture();const p=pull(f,[ElementType.SKILL,ElementType.MEMORY]);
    const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const operation=await provider.resolve(provider.capture());
      const bound=p.root.bindMemoryOperation(provider,operation,p.index as unknown as PortfolioIndexManager);
      await expect(bound.executePull({direction:'pull'},'')).rejects.toThrow('admitted UPDATE only');
      expect(p.deps.portfolioManager.initialize).not.toHaveBeenCalled();
      expect(p.deps.downloader.downloadFromGitHub).not.toHaveBeenCalled();expect(p.deps.fileOperations.writeFile).not.toHaveBeenCalled();
      const dry=await bound.executePull({direction:'pull',dryRun:true},'');expect(dry.content[0].text).toContain('Dry Run');
      expect(p.deps.portfolioManager.initialize).not.toHaveBeenCalled();
    });
  });

  it('refuses guarded BOTH with a memory pull decision before any non-memory push effect',async()=>{
    const f=await fixture(),p=pull(f,[ElementType.SKILL,ElementType.MEMORY]),provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    const deps=indexDependencies(f),save=jest.fn(async()=> 'unexpected upload');
    const files={exists:jest.fn(async()=>true),listDirectory:jest.fn(async()=>['Nonmemory.md']),readFile:jest.fn(async()=> '---\nname: Nonmemory\n---\ntext')};
    const args=[{getAuthStatus:async()=>({isAuthenticated:true,username:'fixture'})},deps.portfolioManager,p.root,undefined,undefined,
      {ensureInitialized:async()=>{}},f.container.resolve('PersonaIndicatorService'),f.container.resolve('ConfigManager'),files,{},
      {checkPortfolioExists:async()=>true,getRepositoryName:()=> 'fixture',saveElement:save},undefined,{provider,dependencies:deps}];
    const handler=new PortfolioHandler(...args as ConstructorParameters<typeof PortfolioHandler>);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const operation=await provider.resolve(provider.capture());jest.spyOn(operation.manager,'list').mockResolvedValue([]);
      await expect(handler.syncPortfolio({direction:'both',force:true,dryRun:false})).rejects.toThrow('admitted UPDATE only');
      expect(save).not.toHaveBeenCalled();expect(files.readFile).not.toHaveBeenCalled();expect(files.listDirectory).not.toHaveBeenCalled();
      expect(p.deps.portfolioManager.initialize).not.toHaveBeenCalled();expect(p.deps.downloader.downloadFromGitHub).not.toHaveBeenCalled();
    });
  });

  it('retains frozen primitive BOTH preflight decisions without borrowing mutated action aliases',async()=>{
    const f=await fixture(),p=pull(f,[ElementType.SKILL]),provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const operation=await provider.resolve(provider.capture());
      const bound=p.root.bindMemoryOperation(provider,operation,p.index as unknown as PortfolioIndexManager);
      await bound.preflightCombinedPull({direction:'both'});
      expect(p.deps.portfolioManager.initialize).not.toHaveBeenCalled();expect(p.index.rebuildIndex).not.toHaveBeenCalled();
      const alias=p.deps.syncComparer.compareElements().toAdd[0];alias.type=ElementType.MEMORY;alias.path='memories/changed.yaml';
      const result=await bound.executePull({direction:'both'},'');expect(result.content[0].text).toContain('Portfolio Pull Complete');
      expect(p.deps.githubIndexer.getIndex).toHaveBeenCalledTimes(1);expect(p.index.rebuildIndex).toHaveBeenCalledTimes(1);
      expect(p.deps.downloader.downloadFromGitHub).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(p.deps.downloader.downloadFromGitHub.mock.calls)).toContain('skills/bound-owner.yaml');
      expect(JSON.stringify(p.deps.downloader.downloadFromGitHub.mock.calls)).not.toContain('changed.yaml');
    });
  });

  it('preserves non-memory guarded pull and original LEGACY memory writes',async()=>{
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    for(const [tenant,type] of [[f.first,ElementType.SKILL],[f.second,ElementType.MEMORY]] as const){
      if(tenant===f.second)f.modes.set(tenant,[{protocol_version:1,profile:DATABASE_MEMORY_LEGACY_PROFILE,mode:'legacy',generation:'1'}]);
      const p=pull(f,[type]);
      await f.scope.run(tenant,()=>f.tracker.runAsync(invocation(f.tracker,tenant),async()=>{
        const operation=await provider.resolve(provider.capture());const bound=p.root.bindMemoryOperation(provider,operation,p.index as unknown as PortfolioIndexManager);
        const result=await bound.executePull({direction:'pull'},'');expect(result.content[0].text).toContain('Portfolio Pull Complete');
        expect(p.deps.portfolioManager.initialize).toHaveBeenCalledTimes(1);expect(p.deps.fileOperations.writeFile).toHaveBeenCalledTimes(1);
        expect(p.deps.downloader.downloadFromGitHub).toHaveBeenCalledTimes(1);operation.assertCurrent();
      }));
    }
  });

  it('retains the original refusal when context closes during download before persistence',async()=>{
    const f=await fixture();const p=pull(f,[ElementType.SKILL]);const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    const context=invocation(f.tracker,f.first);
    await f.tracker.runAsync(context,async()=>{
      const operation=await provider.resolve(provider.capture());const bound=p.root.bindMemoryOperation(provider,operation,p.index as unknown as PortfolioIndexManager);
      p.deps.downloader.downloadFromGitHub.mockImplementation(async()=>{jest.spyOn(f.tracker,'getContext').mockReturnValue(invocation(f.tracker,f.second));return {content:'not persisted'};});
      let firstCause:unknown;
      const original=provider.assertOperation.bind(provider);
      jest.spyOn(provider,'assertOperation').mockImplementation(op=>{try{original(op);}catch(cause){firstCause??=cause;throw cause;}});
      const caught=await bound.executePull({direction:'pull'},'').catch(cause=>cause);
      expect(firstCause).toBeInstanceOf(Error);expect(caught).toBe(firstCause);
      expect(p.deps.fileOperations.writeFile).not.toHaveBeenCalled();expect(p.deps.fileOperations.createDirectory).not.toHaveBeenCalled();
    });
  });

  it('refuses guarded collection and shared-pool memory installation before fetch or mutation',async()=>{
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    const fetch=jest.fn(async()=>({}));const sharedInstall=jest.fn(async()=>({action:'installed' as const}));
    const root=new ElementInstaller({fetchFromGitHub:fetch} as unknown as GitHubClient,{memoryRegistry:f.registry,
      portfolioManager:f.container.resolve('PortfolioManager'),fileOperations:f.container.resolve('FileOperationsService'),
      sharedPoolInstaller:{install:sharedInstall} as unknown as import('../../../src/collection/shared-pool/ISharedPoolInstaller.js').ISharedPoolInstaller});
    await expect(root.installContent('library/memories/owner.yaml')).rejects.toThrow('Authentic selected');
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const operation=await provider.resolve(provider.capture());const bound=root.bindMemoryOperation(provider,operation,{} as UnifiedIndexManager);
      await expect(bound.installContent('library/memories/owner.yaml')).rejects.toThrow('admitted UPDATE only');
      await expect(bound.installElement('Owner',ElementType.MEMORY,'library/memories/owner.yaml')).rejects.toThrow('admitted UPDATE only');
      expect(fetch).not.toHaveBeenCalled();expect(sharedInstall).not.toHaveBeenCalled();
    });
  });
});


describe('bound sync and submission route contracts (controlled remote ports)', () => {
  function sync(f: Awaited<ReturnType<typeof fixture>>, types: ElementType[]) {
    const deps={memoryRegistry:f.registry,configManager:{getConfig:()=>({sync:{enabled:true,individual:{require_confirmation:false},
      bulk:{download_enabled:true,upload_enabled:true,require_preview:false},privacy:{scan_for_secrets:false}}})},
      portfolioManager:{getElementDir:()=>f.directory,getElementPath:()=>path.join(f.directory,'fixture.md')},
      portfolioRepoManager:{setToken:jest.fn(),saveElement:jest.fn(async()=> 'fixture-url')},
      indexer:{getIndex:jest.fn(async()=>({totalElements:types.length,elements:new Map(types.map(type=>[type,[{name:'Owner',path:'owner.md',downloadUrl:'https://invalid.test/owner'}]]))}))},
      fileOperations:{listDirectory:jest.fn(async():Promise<string[]>=>[]),readFile:jest.fn(async():Promise<string>=>{throw new Error('No local file');}),
        createDirectory:jest.fn(async()=>{}),writeFile:jest.fn(async()=>{})},tokenManager:{getGitHubTokenAsync:jest.fn(async()=> 'controlled-fixture-token')}};
    return {deps,root:new PortfolioSyncManager(deps as unknown as PortfolioSyncManagerDependencies)};
  }

  it('refuses direct unbound sync and mixed guarded bulk before a fetch or write',async()=>{
    const f=await fixture(),s=sync(f,[ElementType.SKILL,ElementType.MEMORY]);
    await expect(s.root.handleSyncOperation({operation:'download',bulk:true,confirm:true})).rejects.toThrow('Authentic selected');
    expect(s.deps.indexer.getIndex).not.toHaveBeenCalled();
    const fetch=jest.spyOn(globalThis,'fetch');const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const operation=await provider.resolve(provider.capture()),bound=s.root.bindMemoryOperation(provider,operation);
      await expect(bound.handleSyncOperation({operation:'download',bulk:true,confirm:true})).rejects.toThrow('admitted UPDATE only');
      expect(fetch).not.toHaveBeenCalled();expect(s.deps.fileOperations.writeFile).not.toHaveBeenCalled();
      expect(s.deps.portfolioRepoManager.saveElement).not.toHaveBeenCalled();
    });
  });

  it('discovers actual selected DB memory before refusing a mixed bulk upload without remote mutation',async()=>{
    const f=await fixture(),s=sync(f,[]),provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const operation=await provider.resolve(provider.capture());
      const memory=new Memory({name:'Database only owner'},f.container.resolve('MetadataService'));
      const list=jest.spyOn(operation.manager,'list').mockResolvedValue([memory]);
      s.deps.fileOperations.listDirectory.mockResolvedValue(['Nonmemory.md']);
      const bound=s.root.bindMemoryOperation(provider,operation);
      await expect(bound.handleSyncOperation({operation:'upload',bulk:true,confirm:true})).rejects.toThrow('remote submission');
      expect(list).toHaveBeenCalledWith({strictDatabase:true});expect(s.deps.portfolioRepoManager.saveElement).not.toHaveBeenCalled();
      expect(s.deps.fileOperations.readFile).not.toHaveBeenCalled();
    });
  });

  it('routes actual AQL element-manager sync through its original operation without a nested provider selection',async()=>{
    const f=await fixture(),s=sync(f,[]),provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    const handler=new SyncHandler(s.root,{initialize:async()=>{},getSetting:()=>true} as unknown as ConstructorParameters<typeof SyncHandler>[1],
      f.container.resolve('PersonaIndicatorService'),provider);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const selected=await provider.resolve(provider.capture()),resolve=jest.spyOn(provider,'resolve');
      const composed=aql(f,provider,selected.manager,permissiveGate(),{syncHandler:handler});
      const result=await composed.handleCreate({operation:'portfolio_element_manager',params:{operation:'list-remote'}});
      expect(result).toMatchObject({success:true});expect(JSON.stringify(result)).toContain('GitHub Portfolio is Empty');
      expect(resolve).toHaveBeenCalledTimes(1);expect(s.deps.indexer.getIndex).toHaveBeenCalledTimes(1);
    });
  });

  it('retains a selected compare read failure before filesystem fallback or logging observers',async()=>{
    const f=await fixture(),s=sync(f,[]),provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const operation=await provider.resolve(provider.capture()),cause=new Error('Exact selected raw-read failure');
      jest.spyOn(operation.manager,'findGuardedMemoryForUpdate').mockRejectedValue(cause);
      jest.spyOn(logger,'error').mockImplementation(()=>{throw new Error('Secondary observer');});
      await expect(s.root.bindMemoryOperation(provider,operation).handleSyncOperation({operation:'compare',element_name:'Owner',element_type:ElementType.MEMORY})).rejects.toBe(cause);
      expect(s.deps.fileOperations.readFile).not.toHaveBeenCalled();expect(s.deps.indexer.getIndex).not.toHaveBeenCalled();
    });
  });

  it('preserves guarded non-memory and LEGACY memory uploads through their original local-file consumer',async()=>{
    const f=await fixture(),provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    for(const [tenant,type] of [[f.first,ElementType.SKILL],[f.second,ElementType.MEMORY]] as const){
      if(tenant===f.second)f.modes.set(tenant,[{protocol_version:1,profile:DATABASE_MEMORY_LEGACY_PROFILE,mode:'legacy',generation:'1'}]);
      const s=sync(f,[]);s.deps.fileOperations.readFile.mockResolvedValue('---\nname: Owner\nversion: 1.0.0\n---\nSupported local content');
      await f.scope.run(tenant,()=>f.tracker.runAsync(invocation(f.tracker,tenant),async()=>{
        const operation=await provider.resolve(provider.capture());
        const result=await s.root.bindMemoryOperation(provider,operation).handleSyncOperation({operation:'upload',element_name:'Owner',element_type:type,confirm:true});
        expect(result.success).toBe(true);expect(s.deps.portfolioRepoManager.saveElement).toHaveBeenCalledTimes(1);
        expect(s.deps.fileOperations.readFile).toHaveBeenCalledTimes(1);
      }));
    }
  });

  function submit(f: Awaited<ReturnType<typeof fixture>>, matchMemory: boolean) {
    // Controlled index discovery supplies a safe relative path; stat/read are mocked.
    const file='skill.md';
    const auth={getAuthStatus:jest.fn(async()=>({isAuthenticated:false}))};
    const files={stat:jest.fn(async()=>({size:20})),readFile:jest.fn(async()=> '---\nname: Owner\n---\nSupported content')};
    const root=new SubmitToPortfolioTool(f.container.resolve('APICache'),{memoryRegistry:f.registry,authManager:auth,
      portfolioRepoManager:{},portfolioManager:{getBaseDir:()=>f.directory,getElementDir:(type:ElementType)=>path.join(f.directory,type)},
      rateLimiter:{},fileOperations:files,tokenManager:{}} as unknown as SubmitToPortfolioToolDependencies);
    const index={findByName:jest.fn(async(_name:string,options:{elementType:ElementType})=>
      options.elementType===(matchMemory?ElementType.MEMORY:ElementType.SKILL)
        ? {filePath:matchMemory?randomUUID():file,filename:'skill.md',metadata:{name:'Owner'}} : null)};
    return {root,index,auth,files};
  }

  it('continues generic guarded non-memory submission discovery to its ordinary authentication boundary',async()=>{
    const f=await fixture(),s=submit(f,false),provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const operation=await provider.resolve(provider.capture());
      const result=await s.root.bindMemoryOperation(provider,operation,s.index as unknown as PortfolioIndexManager).execute({name:'Owner'});
      expect(result.error).toBe('NOT_AUTHENTICATED');expect(s.auth.getAuthStatus).toHaveBeenCalledTimes(1);
      expect(s.files.readFile).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses a genuine guarded memory match in generic discovery before any filepath read',async()=>{
    const f=await fixture(),s=submit(f,true),provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const operation=await provider.resolve(provider.capture());
      await expect(s.root.bindMemoryOperation(provider,operation,s.index as unknown as PortfolioIndexManager).execute({name:'Owner'})).rejects.toThrow('remote submission');
      expect(s.files.readFile).not.toHaveBeenCalled();expect(s.files.stat).not.toHaveBeenCalled();expect(s.auth.getAuthStatus).not.toHaveBeenCalled();
    });
  });
  it.each(['guarded','legacy'] as const)('keeps %s portfolio not-found suggestions on the supported source',async mode=>{
    const f=await fixture(),s=submit(f,false),provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    if(mode==='legacy')f.modes.set(f.first,[{protocol_version:1,profile:DATABASE_MEMORY_LEGACY_PROFILE,mode:'legacy',generation:'1'}]);
    s.index.findByName.mockResolvedValue(null);
    for(const [type,name] of [[ElementType.MEMORY,'owner-memory'],[ElementType.SKILL,'owner-skill']] as const){
      const dir=path.join(f.directory,type);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,`${name}.md`),'Stale local suggestion');
    }
    // Keep the main lookup absent; suggestions observe the actual owned stale files.
    const scan=jest.spyOn(FileDiscoveryUtil,'findFile').mockImplementation(async(dir,name)=>{
      if(name!=='*')return null;
      try{const file=(await readdir(dir))[0];return file?path.join(dir,file):null;}catch{return null;}
    });
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const operation=await provider.resolve(provider.capture());
      const result=await s.root.bindMemoryOperation(provider,operation,s.index as unknown as PortfolioIndexManager).execute({name:'owner'});
      expect(result.error).toBe('CONTENT_NOT_FOUND');expect(result.message).toContain('owner-skill');
      if(mode==='guarded')expect(result.message).not.toContain('owner-memory');else expect(result.message).toContain('owner-memory');
      expect(scan.mock.calls.filter(([dir,name])=>dir===path.join(f.directory,ElementType.MEMORY)&&name==='*')).toHaveLength(mode==='guarded'?0:1);
      expect(s.files.readFile).not.toHaveBeenCalled();expect(s.auth.getAuthStatus).not.toHaveBeenCalled();
    });
  });

  it.each(['guarded','legacy'] as const)('keeps %s collection not-found suggestions on the supported source',async mode=>{
    const f=await fixture(),provider=new TenantMemoryOperationProvider(f.registry,f.tracker);
    if(mode==='legacy')f.modes.set(f.first,[{protocol_version:1,profile:DATABASE_MEMORY_LEGACY_PROFILE,mode:'legacy',generation:'1'}]);
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      const operation=await provider.resolve(provider.capture()),deps=indexDependencies(f);
      for(const [type,name] of [[ElementType.MEMORY,'owner-memory'],[ElementType.SKILL,'owner-skill']] as const){
        const dir=deps.portfolioManager.getElementDir(type);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,`${name}.md`),'Stale local suggestion');
      }
      const discover=FileDiscoveryUtil.findFile.bind(FileDiscoveryUtil);
      const scan=jest.spyOn(FileDiscoveryUtil,'findFile').mockImplementation(async(dir,name,options)=>
        options?.cacheResults===false?discover(dir,name,options):null);
      const index={findByName:jest.fn(async()=>null)};
      const view={portfolioIndex:index,unifiedIndex:{},assertCurrent:operation.assertCurrent} as unknown as ReturnType<typeof import('../../../src/portfolio/TenantMemoryIndexView.js').bindTenantMemoryIndexView>;
      const remote=jest.fn(async()=>({content:[]}));
      const result=await remoteCollection(f,provider,remote).bindMemoryOperation(provider,operation,view).submitContent('owner');
      const message=result.content.map(item=>item.text).join('');
      expect(message).toContain('owner-skill');
      if(mode==='guarded')expect(message).not.toContain('owner-memory');else expect(message).toContain('owner-memory');
      expect(scan.mock.calls.filter(([dir,,options])=>dir===deps.portfolioManager.getElementDir(ElementType.MEMORY)&&options?.cacheResults===false)).toHaveLength(mode==='guarded'?0:1);
      expect(remote).not.toHaveBeenCalled();
    });
  });

});
