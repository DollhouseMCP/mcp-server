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
import type { AgentManager } from '../../../src/elements/agents/AgentManager.js';
import { MCPAQLHandler, type HandlerRegistry } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { Gatekeeper } from '../../../src/handlers/mcp-aql/Gatekeeper.js';
import { PermissionLevel } from '../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import { SchemaDispatcher } from '../../../src/handlers/mcp-aql/SchemaDispatcher.js';
import { DATABASE_MEMORY_LEGACY_PROFILE } from '../../../src/storage/DatabaseMemoryLegacyMutationGuard.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';

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
  return { registry, container: root.container, tracker: root.container.resolve<ContextTracker>('ContextTracker'), db, scope, first, second, modes, builds, execute, transaction,
    setPause: (value: Promise<void>) => { pause = value; },
    setRole: (value: typeof role) => { role = value; },
    fail: (cause: unknown) => { failure = { cause }; } };
}


function invocation(tracker: ContextTracker, tenant: string, sessionId = randomUUID()) {
  return tracker.createSessionContext('test', { userId: tenant, sessionId,
    tenantId: null, transport: 'http', createdAt: 1 });
}
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
  tracker: ContextTracker, fixed?: MemoryManager): ElementCRUDHandler {
  const c = f.container;
  const initialization = c.resolve<{ensureInitialized:()=>Promise<void>}>('InitializationService');
  jest.spyOn(initialization, 'ensureInitialized').mockResolvedValue(undefined);
  return new ElementCRUDHandler(c.resolve('SkillManager'),c.resolve('TemplateManager'),c.resolve('TemplateRenderer'),
    c.resolve('AgentManager'),fixed,c.resolve('EnsembleManager'),c.resolve('PersonaManager'),c.resolve('PortfolioManager'),
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
  it('refuses independently cached agent-memory execution before either agent entrypoint', async () => {
    const f=await fixture();const tracker=f.tracker;
    const provider=new TenantMemoryOperationProvider(f.registry,tracker);const handler=crud(f,provider,tracker);
    const agent=f.container.resolve<AgentManager>('AgentManager');
    const execute=jest.spyOn(agent,'executeAgent');const resume=jest.spyOn(agent,'continueAgentExecution');
    await expect(handler.executeAgent('agent',{})).rejects.toThrow('agent memory composition');
    await expect(handler.continueAgentExecution({agentName:'agent'})).rejects.toThrow('agent memory composition');
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
  it('refuses direct and schema/execution agent routes before independent cached memory-resolver effects',async()=>{
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);const fixed=await f.registry.resolve(f.registry.capture());
    const agent=f.container.resolve<AgentManager>('AgentManager');const execute=jest.spyOn(agent,'executeAgent');const resume=jest.spyOn(agent,'continueAgentExecution');
    const handler=aql(f,provider,fixed,permissiveGate());
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      for(const operation of ['execute_agent','continue_execution','resume_from_handoff']) {
        const result=await handler.handleExecute({operation,params:{element_name:'unexecuted'}});
        expect(result.success).toBe(false);expect(JSON.stringify(result)).toContain('composition is required');
      }
    });
    expect(execute).not.toHaveBeenCalled();expect(resume).not.toHaveBeenCalled();
  });
  it('refuses explicit configured provider absence while preserving ordinary two-argument construction',async()=>{
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);const fixed=await f.registry.resolve(f.registry.capture());
    const configured=aql(f,provider,fixed,permissiveGate());
    const handlers=(configured as unknown as {handlers:HandlerRegistry}).handlers;
    for(const missing of [undefined,null,false])expect(()=>new MCPAQLHandler(handlers,f.tracker,missing as unknown as TenantMemoryOperationProvider)).toThrow('Actual trusted memory provider');
    expect(()=>new MCPAQLHandler(handlers,f.tracker)).not.toThrow();
    expect(f.builds).toHaveBeenCalledTimes(1);
  });
  it('refuses cached portfolio/index and local collection paths before effects, including explicit non-memory filters',async()=>{
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
        expect(result.success).toBe(false);expect(JSON.stringify(result)).toContain('portfolio/index memory composition');
      }
    });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('preserves remote-only collection reads in configured mode',async()=>{
    const f=await fixture();const provider=new TenantMemoryOperationProvider(f.registry,f.tracker);const fixed=await f.registry.resolve(f.registry.capture());
    const invoke=jest.fn(async()=>({content:[{type:'text',text:'remote-only collection'}]}));
    const handler=aql(f,provider,fixed,permissiveGate(),{collectionHandler:{browseCollection:invoke,searchCollection:invoke,searchCollectionEnhanced:invoke,getCollectionContent:invoke,getCollectionCacheHealth:invoke} as unknown as HandlerRegistry['collectionHandler']});
    await f.tracker.runAsync(invocation(f.tracker,f.first),async()=>{
      for(const operation of ['browse_collection','search_collection','search_collection_enhanced','get_collection_content','get_collection_cache_health']){
        const result=await handler.handleRead({operation,params:{query:'test',path:'remote/path'}});
        expect(result.success).toBe(true);expect(JSON.stringify(result)).toContain('remote-only collection');
      }
    });
    expect(invoke).toHaveBeenCalledTimes(5);
  });

});
