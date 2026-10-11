/** Owned DB AQL binding proof, not production auth/boot qualification. */
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
import { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import { MCPAQLHandler, type HandlerRegistry } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { Gatekeeper } from '../../../src/handlers/mcp-aql/Gatekeeper.js';
import { PermissionLevel } from '../../../src/handlers/mcp-aql/GatekeeperTypes.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
const owned: EquivalentFixture[] = [];
function phase(value: string) { console.info(`[tenant-memory-aql:actual-db] ${value}`); }
afterEach(async () => {
  jest.restoreAllMocks();
  for (const f of owned.splice(0)) { phase('cleanup-start'); await f.cleanup(); phase('cleanup-end'); }
});
required('actual AQL selected DB manager and admission transaction', () => {
  it('publishes one real admitted append and refuses invocation drift without another mutation', async () => {
    phase('fixture-start'); const f=await makeEquivalentFixture();owned.push(f);
    // Qualification setup for this uniquely owned fixture only; never live admission evidence.
    await f.maintenance`UPDATE public.elements SET memory_entries_out_of_sync=false WHERE id=${f.memoryId}::uuid`;
    await f.maintenance`INSERT INTO public.memory_backend_modes(user_id,backend,protocol_version,profile,mode,generation)
      VALUES (${f.userId}::uuid,'database',1,${DATABASE_MEMORY_ADMISSION_PROFILE},'guarded',1)`;
    await f.maintenance`INSERT INTO public.memory_candidate_quotas(user_id) VALUES (${f.userId}::uuid)`;
    const directory=await mkdtemp(path.join(os.tmpdir(),'pg-tenant-aql-'));
    let deps!:ElementManagerDeps;
    const root=admittedMemoryContainer(f.db,()=>f.userId,directory,factory=>incoming=>{
      deps=incoming;return factory.createAdmittedMemoryManager(incoming);
    });
    let handler:MCPAQLHandler|undefined;
    try {
      const fixed=root.manager();const c=root.container;const tracker=c.resolve<ContextTracker>('ContextTracker');
      const registry=new DatabaseTenantMemoryRegistry({db:f.db,getEffectiveTenant:()=>f.userId,
        createManagerDeps:(factory,resolver)=>({...deps,fileWatchService:undefined,storageLayerFactory:factory,getCurrentUserId:resolver}),
        getAttribution:()=>{
          const current=tracker.getContext();if(!current?.requestId||!current.session)throw new Error('Owned AQL attribution required');
          return {contextRoot:current.requestId,sessionId:current.session.sessionId,transport:current.session.transport};
        }});
      const provider=new TenantMemoryOperationProvider(registry,tracker);
      // Existing non-memory infrastructure is already initialized for this caller-only proof.
      jest.spyOn(c.resolve<{ensureInitialized:()=>Promise<void>}>('InitializationService'),'ensureInitialized').mockResolvedValue(undefined);
      const crud=new ElementCRUDHandler(c.resolve('SkillManager'),c.resolve('TemplateManager'),c.resolve('TemplateRenderer'),
        c.resolve('AgentManager'),undefined,c.resolve('EnsembleManager'),c.resolve('PersonaManager'),c.resolve('PortfolioManager'),
        c.resolve('InitializationService'),c.resolve('PersonaIndicatorService'),c.resolve('FileOperationsService'),
        c.resolve('ElementQueryService'),c.resolve('ValidationRegistry'),undefined,undefined,undefined,
        c.resolve('SessionActivationRegistry'),tracker,{memoryProvider:provider});
      const gate=new Gatekeeper(undefined,{enableAuditLogging:false});const originalGate=gate.enforce.bind(gate);
      const gateSpy=jest.spyOn(gate,'enforce').mockImplementation((input,operations)=>{
        const result=originalGate(input,operations);
        if(result.errorCode==='ENDPOINT_MISMATCH'||result.errorCode==='UNKNOWN_OPERATION')return result;
        return {allowed:true,permissionLevel:PermissionLevel.AUTO_APPROVE,reason:'Owned fixture authorization'};
      });
      const handlers:HandlerRegistry={elementCRUD:crud,memoryManager:fixed,agentManager:c.resolve('AgentManager'),
        templateRenderer:c.resolve('TemplateRenderer'),elementQueryService:c.resolve('ElementQueryService'),portfolioManager:c.resolve('PortfolioManager'),gatekeeper:gate};
      handler=new MCPAQLHandler(handlers,tracker,provider);const operation=handler;
      const rootRead=jest.spyOn(fixed,'loadGuardedMemoryByName');const rootSave=jest.spyOn(fixed,'save');
      const context=tracker.createSessionContext('test',{userId:f.userId,sessionId:'owned-aql-session',tenantId:null,transport:'http',createdAt:1});
      phase('fixture-end');phase('lifecycle-start');
      await tracker.runAsync(context,async()=>{
        const capture=registry.capture();
        await registry.qualify(capture,async identity=>{expect(identity.tenant).toBe(f.userId);expect(identity.backend).toBe('database');});
        const result=await operation.handleCreate({operation:'addEntry',params:{element_name:f.name,content:'Actual bound AQL accepted entry'}});
        expect(result.success).toBe(true);
        const entries=await f.layer.getEntries(f.memoryId);expect(entries.map(entry=>entry.content)).toContain('Actual bound AQL accepted entry');
        expect(entries.map(entry=>entry.content)).toContain('Preserved entry');
        const attempts=await f.maintenance`SELECT status FROM public.memory_candidate_handoffs WHERE user_id=${f.userId}::uuid`;
        expect(attempts).toHaveLength(0);
      });
      const beforeRefusal=await f.snapshot();
      const changed=tracker.createSessionContext('test',{userId:f.userId,sessionId:'owned-aql-refusal',tenantId:null,transport:'http',createdAt:2});
      gateSpy.mockImplementation(()=>{changed.requestId=randomUUID();return {allowed:true,permissionLevel:PermissionLevel.AUTO_APPROVE,reason:'Controlled invocation drift'};});
      await tracker.runAsync(changed,async()=>{
        const result=await operation.handleCreate({operation:'addEntry',params:{element_name:f.name,content:'Unaccepted drift entry'}});
        expect(result.success).toBe(false);expect(JSON.stringify(result)).toContain('context changed');
      });
      expect(await f.snapshot()).toEqual(beforeRefusal);expect(rootRead).not.toHaveBeenCalled();expect(rootSave).not.toHaveBeenCalled();
      phase('assertions-complete');
    } finally {
      try {await handler?.dispose();} finally {try {await root.container.dispose();} finally {await rm(directory,{recursive:true,force:true});}}
    }
  },30000);
});
