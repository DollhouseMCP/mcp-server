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
import type { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';

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
  const builds = jest.fn((factory: ElementManagerDeps['storageLayerFactory'], resolver: () => string) =>
    ({ ...template, storageLayerFactory: factory, getCurrentUserId: resolver }));
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
