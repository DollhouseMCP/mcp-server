import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import type { IStorageLayer } from '../../../src/storage/IStorageLayer.js';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import type { ElementManagerDeps } from '../../../src/elements/base/BaseElementManager.js';
import { admittedMemoryContainer } from '../../helpers/storage/admitted-memory-container.js';
import { DatabaseTenantMemoryRegistry } from '../../../src/storage/DatabaseTenantMemoryRegistry.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { DATABASE_MEMORY_LEGACY_PROFILE } from '../../../src/storage/DatabaseMemoryLegacyMutationGuard.js';
import { TenantMemoryOperationProvider } from '../../../src/storage/TenantMemoryOperationProvider.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { PathService } from '../../../src/paths/PathService.js';
import { PerUserPathResolver } from '../../../src/paths/PerUserPathResolver.js';
import { PackageResourceLocator } from '../../../src/paths/PackageResourceLocator.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { IndexConfigManager } from '../../../src/portfolio/config/IndexConfig.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import type { UnifiedSearchResult } from '../../../src/portfolio/UnifiedIndexManager.js';
import { TriggerMetricsTracker } from '../../../src/portfolio/enhanced-index/TriggerMetricsTracker.js';
import { CacheFactory } from '../../../src/cache/LRUCache.js';
import { Memory } from '../../../src/elements/memories/Memory.js';
import type { TenantMemoryIndexDependencies } from '../../../src/portfolio/TenantMemoryIndexView.js';
import { bindTenantMemoryIndexView } from '../../../src/portfolio/TenantMemoryIndexView.js';
import { EnhancedIndexHandler } from '../../../src/handlers/EnhancedIndexHandler.js';
import { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import { MCPAQLHandler, type HandlerRegistry } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { Gatekeeper } from '../../../src/handlers/mcp-aql/Gatekeeper.js';
import { PermissionLevel } from '../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import { EnhancedIndexManager } from '../../../src/portfolio/EnhancedIndexManager.js';

const owned: Array<() => Promise<void>> = [];
afterEach(async () => { try { for (const cleanup of owned.splice(0)) await cleanup(); } finally { jest.restoreAllMocks(); } });

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tenant-index-view-'));
  const tenant = randomUUID();
  const execute = jest.fn(async (statement: SQL) => {
    const query = new PgDialect().sqlToQuery(statement);
    if (query.sql.includes('pg_roles')) return [{ rolsuper: false, rolbypassrls: false }];
    if (query.sql.includes('memory_backend_modes')) return [{ protocol_version: 1, profile: DATABASE_MEMORY_ADMISSION_PROFILE, mode: 'guarded', generation: '1' }];
    return [];
  });
  const db = { transaction: async (body: (tx: { execute: typeof execute }) => Promise<unknown>) => body({ execute }) } as unknown as DatabaseInstance;
  let template!: ElementManagerDeps;
  const root = admittedMemoryContainer(db, () => tenant, directory, factory => incoming => {
    template = incoming; return factory.createAdmittedMemoryManager(incoming);
  });
  root.manager();
  const container = root.container;
  const tracker = container.resolve<ContextTracker>('ContextTracker');
  const paths = new PathService({ userResolver: new PerUserPathResolver(directory), packageLocator: new PackageResourceLocator(), userIdResolver: () => tenant });
  const portfolio = new PortfolioManager(container.resolve('FileOperationsService'), { baseDir: directory }, { pathService: paths, contextTracker: tracker });
  const registry = new DatabaseTenantMemoryRegistry({ db, getEffectiveTenant: () => tenant,
    createManagerDeps: (factory, resolver) => ({ ...template, fileWatchService: undefined, portfolioManager: portfolio,
      storageLayerFactory: factory, getCurrentUserId: resolver }),
    getAttribution: () => ({ contextRoot: 'test-root', sessionId: 'test-session', transport: 'http' }),
  });
  const provider = new TenantMemoryOperationProvider(registry, tracker);
  const context = tracker.createSessionContext('test', { userId: tenant, sessionId: randomUUID(), tenantId: tenant, transport: 'http', createdAt: 1 });
  const deps = { portfolioManager: portfolio, pathService: paths, fileOperations: container.resolve<FileOperationsService>('FileOperationsService'),
    indexConfig: new IndexConfigManager(), config: container.resolve<ConfigManager>('ConfigManager') };
  owned.push(async () => { try { await container.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } });
  return { directory, tenant, execute, tracker, provider, registry, context, deps, container };
}

function remoteDependencies(f: Awaited<ReturnType<typeof fixture>>): NonNullable<TenantMemoryIndexDependencies['remote']> {
  return {
    githubIndexer: f.container.resolve('GitHubPortfolioIndexer'),
    githubClient: f.container.resolve('GitHubClient'), apiCache: f.container.resolve('APICache'),
    collectionIndexCache: f.container.resolve('CollectionIndexCache'),
    rateLimitTracker: f.container.resolve('RateLimitTracker'),
    performanceMonitor: f.container.resolve('PerformanceMonitor'), fileOperations: f.deps.fileOperations,
  };
}

function indexCaller(f:Awaited<ReturnType<typeof fixture>>) {
  return new EnhancedIndexHandler(undefined,f.container.resolve('PersonaIndicatorService'),{provider:f.provider,dependencies:f.deps});
}

function indexAql(f:Awaited<ReturnType<typeof fixture>>,enhanced:EnhancedIndexHandler,gatekeeper:Gatekeeper) {
  const c=f.container;
  const elementCRUD=new ElementCRUDHandler(c.resolve('SkillManager'),c.resolve('TemplateManager'),c.resolve('TemplateRenderer'),
    c.resolve('AgentManager'),undefined,c.resolve('EnsembleManager'),c.resolve('PersonaManager'),f.deps.portfolioManager,
    c.resolve('InitializationService'),c.resolve('PersonaIndicatorService'),c.resolve('FileOperationsService'),
    c.resolve('ElementQueryService'),c.resolve('ValidationRegistry'),undefined,undefined,undefined,c.resolve('SessionActivationRegistry'),f.tracker,
    {memoryProvider:f.provider});
  const handlers:Omit<HandlerRegistry,'memoryManager'>={elementCRUD,agentManager:c.resolve('AgentManager'),
    templateRenderer:c.resolve('TemplateRenderer'),elementQueryService:c.resolve('ElementQueryService'),
    portfolioManager:f.deps.portfolioManager,gatekeeper,enhancedIndexHandler:enhanced};
  const handler=new MCPAQLHandler(handlers,f.tracker,f.provider);
  owned.push(()=>handler.dispose());return handler;
}

describe('actual configured enhanced index callers (selected DB transport controlled)',()=>{
  it('retains one original operation through all four direct guarded discovery methods without a fixed index',async()=>{
    const f=await fixture();const enhanced=indexCaller(f);const resolve=jest.spyOn(f.provider,'resolve');
    await f.tracker.runAsync(f.context,async()=>{
      const operation=await f.provider.resolve(f.provider.capture()); resolve.mockClear();
      const memory=new Memory({name:'Selected memory',description:'Owned selected notes',triggers:['remember']},f.container.resolve('MetadataService'));
      memory.setFilePath(randomUUID());const list=jest.spyOn(operation.manager,'list').mockResolvedValue([memory]);
      const write=jest.spyOn(f.deps.fileOperations,'writeFile');
      const results=await Promise.all([
        enhanced.findSimilarElements({elementName:'Selected memory',elementType:'memory',limit:5,threshold:0}),
        enhanced.getElementRelationships({elementName:'Selected memory',elementType:'memory'}),
        enhanced.searchByVerb({verb:'remember',limit:5}),enhanced.getRelationshipStats(),
      ]);
      expect(results).toHaveLength(4);expect(results.every(result=>result.content[0].text.length>0)).toBe(true);
      expect(results[3].content[0].text).toContain('Total Elements: 1');
      expect(list).toHaveBeenCalledTimes(4);expect(resolve).toHaveBeenCalledTimes(4);expect(write).not.toHaveBeenCalled();
    });
  });
  it('preserves the exact selected read failure before recovery and even a throwing logger observer',async()=>{
    const f=await fixture();const enhanced=indexCaller(f);
    await f.tracker.runAsync(f.context,async()=>{
      const operation=await f.provider.resolve(f.provider.capture());const cause=new Error('Original selected index read failure');
      const list=jest.spyOn(operation.manager,'list').mockRejectedValue(cause);
      const {logger}=await import('../../../src/utils/logger.js');
      jest.spyOn(logger,'error').mockImplementation(()=>{throw new Error('Secondary logging failure');});
      await expect(enhanced.findSimilarElements({elementName:'Selected memory',limit:5,threshold:0})).rejects.toBe(cause);
      expect(list).toHaveBeenCalledTimes(1);
    });
  });
  it('creates the real selected index only after AQL authorization and reuses the already captured operation',async()=>{
    const f=await fixture();const enhanced=indexCaller(f);const gate=new Gatekeeper(undefined,{enableAuditLogging:false});
    const enforce=jest.spyOn(gate,'enforce').mockReturnValue({allowed:false,permissionLevel:PermissionLevel.DENY,reason:'Owned denial'});
    const enter=jest.spyOn(enhanced,'withCapturedMemoryOperation');const handler=indexAql(f,enhanced,gate);
    await f.tracker.runAsync(f.context,async()=>{
      const operation=await f.provider.resolve(f.provider.capture());
      const memory=new Memory({name:'Selected memory'},f.container.resolve('MetadataService'));memory.setFilePath(randomUUID());
      const list=jest.spyOn(operation.manager,'list').mockResolvedValue([memory]);const resolve=jest.spyOn(f.provider,'resolve');
      const denied=await handler.handleRead({operation:'get_relationship_stats',params:{}});
      expect(denied.success).toBe(false);expect(enter).not.toHaveBeenCalled();expect(list).not.toHaveBeenCalled();
      enforce.mockReturnValue({allowed:true,permissionLevel:PermissionLevel.AUTO_APPROVE,reason:'Owned authorization'});resolve.mockClear();
      const result=await handler.handleRead({operation:'get_relationship_stats',params:{}});
      expect(result.success).toBe(true);expect(JSON.stringify(result)).toContain('Total Elements: 1');
      expect(enter).toHaveBeenCalledTimes(1);expect(resolve).toHaveBeenCalledTimes(1);expect(list).toHaveBeenCalledTimes(1);
    });
  });
  it('rechecks original invocation after successful awaited LEGACY index disposal before delivering the result',async()=>{
    const f=await fixture();
    f.execute.mockImplementation(async(statement:SQL)=>{
      const query=new PgDialect().sqlToQuery(statement);
      if(query.sql.includes('pg_roles'))return [{rolsuper:false,rolbypassrls:false}];
      if(query.sql.includes('memory_backend_modes'))return [{protocol_version:1,profile:DATABASE_MEMORY_LEGACY_PROFILE,mode:'legacy',generation:'1'}];
      return [];
    });
    await mkdir(f.deps.pathService.getUserPortfolioDir(f.tenant),{recursive:true});
    const enhanced=indexCaller(f);
    await f.tracker.runAsync(f.context,async()=>{
      const operation=await f.provider.resolve(f.provider.capture());
      const memory=new Memory({name:'Selected legacy memory'},f.container.resolve('MetadataService'));memory.setFilePath(randomUUID());
      jest.spyOn(operation.manager,'list').mockResolvedValue([memory]);
      const original=EnhancedIndexManager.prototype.dispose;
      const dispose=jest.spyOn(EnhancedIndexManager.prototype,'dispose').mockImplementation(async function(this:EnhancedIndexManager){
        await original.call(this);f.context.requestId=randomUUID();
      });
      await expect(enhanced.getRelationshipStats()).rejects.toThrow('context changed');
      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });
});

describe('authentic per-operation DB memory index view', () => {
  it('discovers actual selected memory metadata before any absent filesystem memory scan', async () => {
    const f = await fixture();
    await f.tracker.runAsync(f.context, async () => {
      const operation = await f.provider.resolve(f.provider.capture());
      const memory = new Memory({ name: 'Logical session name', description: 'Selected DB notes', tags: ['owned'], triggers: ['remember'] }, f.container.resolve('MetadataService'));
      const locator = randomUUID(); memory.setFilePath(locator);
      const list = jest.spyOn(operation.manager, 'list').mockResolvedValue([memory]);
      const exists = jest.spyOn(f.deps.fileOperations, 'exists').mockResolvedValue(false);
      const view = bindTenantMemoryIndexView(f.provider, operation, f.deps);
      try {
        const result = await view.portfolioIndex.findByName('Logical session name');
        expect(result).toMatchObject({ filePath: locator, filename: 'Logical session name', elementType: ElementType.MEMORY });
        expect(await view.portfolioIndex.search('Selected DB')).toHaveLength(1);
        expect((await view.enhancedIndex.getIndex()).elements.memories['Logical session name'].core.description).toBe('Selected DB notes');
        expect(list).toHaveBeenCalledTimes(1);
        expect(exists.mock.calls.some(([directory]) => directory === f.deps.pathService.getUserElementDir(ElementType.MEMORY, f.tenant))).toBe(false);
      } finally { await view.dispose(); }
    });
  });

  it('propagates original selected DB discovery failure rather than returning an empty index', async () => {
    const f = await fixture();
    await f.tracker.runAsync(f.context, async () => {
      const operation = await f.provider.resolve(f.provider.capture());
      const cause = new Error('actual selected discovery refusal');
      jest.spyOn(operation.manager, 'list').mockRejectedValue(cause);
      const view = bindTenantMemoryIndexView(f.provider, operation, f.deps);
      try { await expect(view.portfolioIndex.getIndex()).rejects.toBe(cause); }
      finally { await view.dispose(); }
    });
  });

  it('rejects original-context drift after selected listing before index publication', async () => {
    const f = await fixture();
    await f.tracker.runAsync(f.context, async () => {
      const operation = await f.provider.resolve(f.provider.capture());
      jest.spyOn(operation.manager, 'list').mockImplementation(async () => { f.context.requestId = randomUUID(); return []; });
      const view = bindTenantMemoryIndexView(f.provider, operation, f.deps);
      try { await expect(view.portfolioIndex.getIndex()).rejects.toThrow('context changed'); }
      finally { await view.dispose(); }
    });
  });

  it('refuses a forged operation, another provider, mismatched namespace and nonpersisted memory', async () => {
    const f = await fixture();
    await f.tracker.runAsync(f.context, async () => {
      const operation = await f.provider.resolve(f.provider.capture());
      expect(() => bindTenantMemoryIndexView(f.provider, { ...operation }, f.deps)).toThrow('Authentic');
      expect(() => bindTenantMemoryIndexView(new TenantMemoryOperationProvider(f.registry, f.tracker), operation, f.deps)).toThrow('Authentic');
      const wrong = new PathService({ userResolver: new PerUserPathResolver(path.join(f.directory, 'wrong')), packageLocator: new PackageResourceLocator(), userIdResolver: () => f.tenant });
      expect(() => bindTenantMemoryIndexView(f.provider, operation, { ...f.deps, pathService: wrong })).toThrow('namespace binding');
      jest.spyOn(operation.manager, 'list').mockResolvedValue([new Memory({ name: 'Unsaved' }, f.container.resolve('MetadataService'))]);
      const view = bindTenantMemoryIndexView(f.provider, operation, f.deps);
      try { await expect(view.portfolioIndex.getIndex()).rejects.toThrow('Persisted database memory locator'); }
      finally { await view.dispose(); }
    });
  });

  it.each([false, true])('never falls back from an authoritative local DB failure (stream=%s)', async streamResults => {
    const f = await fixture();
    await f.tracker.runAsync(f.context, async () => {
      const operation = await f.provider.resolve(f.provider.capture());
      const cause = new Error('local DB cannot be represented as remote or empty success');
      jest.spyOn(operation.manager, 'list').mockRejectedValue(cause);
      const remote = remoteDependencies(f);
      const remoteRead = jest.spyOn(remote.githubIndexer, 'getIndex');
      const view = bindTenantMemoryIndexView(f.provider, operation, { ...f.deps, remote });
      try {
        await expect(view.unifiedIndex!.search({ query: 'notes', includeLocal: true, includeGitHub: true, streamResults })).rejects.toBe(cause);
        expect(remoteRead).not.toHaveBeenCalled();
      } finally { await view.dispose(); }
    });
  });

  it('does not reuse structurally supplied result caches from another view in the same namespace', async () => {
    const f = await fixture();
    await f.tracker.runAsync(f.context, async () => {
      const operation = await f.provider.resolve(f.provider.capture());
      const shared = CacheFactory.createSearchResultCache<UnifiedSearchResult>();
      const remote = { ...remoteDependencies(f), resultCache: shared };
      const list = jest.spyOn(operation.manager, 'list');
      const names: string[] = [];
      for (const name of ['First notes', 'Second notes']) {
        const memory = new Memory({ name }, f.container.resolve('MetadataService')); memory.setFilePath(randomUUID());
        list.mockResolvedValue([memory]);
        const view = bindTenantMemoryIndexView(f.provider, operation, { ...f.deps, remote });
        try {
          const result = await view.unifiedIndex!.search({ query: 'notes', includeLocal: true, includeGitHub: false, includeCollection: false });
          names.push(result[0].entry.name);
        } finally { await view.dispose(); }
      }
      expect(names).toEqual(['First notes', 'Second notes']); expect(list).toHaveBeenCalledTimes(2);
      expect(shared.size).toBe(0);
    });
  });

  it.each(['scan', 'listSummaries', 'load'] as const)('preserves actual %s failure in strict selected DB listing, while ordinary listing remains compatible', async failure => {
    const f = await fixture();
    await f.tracker.runAsync(f.context, async () => {
      const operation = await f.provider.resolve(f.provider.capture());
      const layer = (operation.manager as unknown as { storageLayer: IStorageLayer }).storageLayer;
      const cause = new Error(`selected ${failure} failed`);
      jest.spyOn(layer, 'scan').mockResolvedValue({ added: [], modified: [], removed: [], unchanged: [] });
      const summaries = jest.spyOn(layer, 'listSummaries').mockResolvedValue([{ filePath: randomUUID(), name: 'broken', description: '', version: '1.0.0', author: 'test', tags: [], mtimeMs: 0, sizeBytes: 1 }]);
      if (failure === 'scan') jest.spyOn(layer, 'scan').mockRejectedValue(cause);
      else if (failure === 'listSummaries') summaries.mockRejectedValue(cause);
      else jest.spyOn(operation.manager, 'load').mockRejectedValue(cause);
      const view = bindTenantMemoryIndexView(f.provider, operation, f.deps);
      try {
        await expect(view.portfolioIndex.getIndex()).rejects.toBe(cause);
        await expect(operation.manager.list()).resolves.toEqual([]);
      } finally { await view.dispose(); }
    });
  });

  it.each(['findByName', 'search', 'getElementsByType'] as const)('refuses stale %s delivery after an already completed index read', async method => {
    const f = await fixture();
    await f.tracker.runAsync(f.context, async () => {
      const operation = await f.provider.resolve(f.provider.capture());
      jest.spyOn(operation.manager, 'list').mockResolvedValue([]);
      const view = bindTenantMemoryIndexView(f.provider, operation, f.deps);
      try {
        await view.portfolioIndex.getIndex();
        const pending = method === 'getElementsByType' ? view.portfolioIndex[method](ElementType.MEMORY) : view.portfolioIndex[method]('notes');
        f.context.requestId = randomUUID();
        await expect(pending).rejects.toThrow('context changed');
      } finally { await view.dispose(); }
    });
  });

  it('refuses a lost LEGACY binding during awaited action metrics before delivering actions', async () => {
    const f = await fixture();
    f.execute.mockImplementation(async statement => new PgDialect().sqlToQuery(statement).sql.includes('pg_roles')
      ? [{ rolsuper: false, rolbypassrls: false }]
      : [{ protocol_version: 1, profile: DATABASE_MEMORY_LEGACY_PROFILE, mode: 'legacy', generation: '1' }]);
    await f.tracker.runAsync(f.context, async () => {
      const operation = await f.provider.resolve(f.provider.capture());
      const memory = new Memory({ name: 'Legacy metrics', triggers: ['remember'] }, f.container.resolve('MetadataService')); memory.setFilePath(randomUUID());
      jest.spyOn(operation.manager, 'list').mockResolvedValue([memory]);
      await mkdir(f.deps.pathService.getUserPortfolioDir(f.tenant), { recursive: true });
      const view = bindTenantMemoryIndexView(f.provider, operation, f.deps);
      try {
        await view.enhancedIndex.getIndex();
        const originalTrack = TriggerMetricsTracker.prototype.track;
        const track = jest.spyOn(TriggerMetricsTracker.prototype, 'track').mockImplementationOnce(async function(this: TriggerMetricsTracker, ...args) {
          await originalTrack.apply(this, args); f.context.requestId = randomUUID();
        });
        await expect(view.enhancedIndex.getElementsByAction('remember')).rejects.toThrow('context changed');
        expect(track).toHaveBeenCalledTimes(1);
      } finally { await view.dispose(); }
    });
  });

  it('preserves explicit LEGACY disk persistence through the same genuine selected view', async () => {
    const f = await fixture();
    f.execute.mockImplementation(async statement => new PgDialect().sqlToQuery(statement).sql.includes('pg_roles')
      ? [{ rolsuper: false, rolbypassrls: false }]
      : [{ protocol_version: 1, profile: DATABASE_MEMORY_LEGACY_PROFILE, mode: 'legacy', generation: '1' }]);
    await f.tracker.runAsync(f.context, async () => {
      const operation = await f.provider.resolve(f.provider.capture());
      const memory = new Memory({ name: 'Legacy session' }, f.container.resolve('MetadataService')); memory.setFilePath(randomUUID());
      jest.spyOn(operation.manager, 'list').mockResolvedValue([memory]);
      const view = bindTenantMemoryIndexView(f.provider, operation, f.deps);
      try {
        await mkdir(f.deps.pathService.getUserPortfolioDir(f.tenant), { recursive: true });
        await view.enhancedIndex.getIndex();
        await expect(view.enhancedIndex.persist()).resolves.toBeUndefined();
        expect(await f.deps.fileOperations.exists(path.join(f.deps.pathService.getUserPortfolioDir(f.tenant), 'capability-index.yaml'))).toBe(true);
      } finally { await view.dispose(); }
    });
  });
});
