/** Actual read-only boot predicate on owned databases, not HTTP/cold exclusion. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../../src/database/schema/index.js';
import type { ElementManagerDeps } from '../../../src/elements/base/BaseElementManager.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import type { DormantDurableMemoryComposition } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import { DatabaseMemoryModeEnforcingStorageLayerFactory } from '../../../src/storage/DatabaseMemoryModeEnforcingStorageLayerFactory.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { decodeMemoryCandidate } from '../../../src/storage/DatabaseMemoryCandidateEnvelope.js';
import { qualifyDatabaseMemoryTenant } from '../../../src/storage/DatabaseMemoryTenantQualification.js';
import { admittedMemoryContainer } from '../../helpers/storage/admitted-memory-container.js';
import { makeEquivalentFixture, type EquivalentFixture } from './fixtures/2905-equivalent-reconciliation-fixture.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
function phase(caseName: string, value: string) { console.info(`[memory-boot-qualification:${caseName}] ${value}`); }
async function owned(caseName: string, body: (f: EquivalentFixture, manager: MemoryManager, durable?: { composition: DormantDurableMemoryComposition; layer: DatabaseMemoryStorageLayer }) => Promise<void>, useDurable = false) {
  phase(caseName, 'fixture-start');
  const f = await makeEquivalentFixture();
  let directory: string | undefined;
  let root: ReturnType<typeof admittedMemoryContainer> | undefined;
  let failure: { cause: unknown } | undefined;
  let composition: DormantDurableMemoryComposition | undefined;
  let layer: DatabaseMemoryStorageLayer | undefined;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'memory-boot-qualification-'));
    const contextRoot = directory;
    root = admittedMemoryContainer(f.db, () => f.userId, directory,
      () => (deps: ElementManagerDeps) => {
        const isolatedDeps = { ...deps, fileWatchService: undefined };
        if (!useDurable) return new MemoryManager(isolatedDeps);
        const enforcing = new DatabaseMemoryModeEnforcingStorageLayerFactory(f.db, deps.getCurrentUserId!);
        const create = enforcing.createForElement.bind(enforcing);
        jest.spyOn(enforcing, 'createForElement').mockImplementation((type, options) => {
          const result = create(type, options);
          if (type === 'memories') layer = result as DatabaseMemoryStorageLayer;
          return result;
        });
        composition = enforcing.createDurableAdmittedMemoryManager({ ...isolatedDeps, storageLayerFactory: enforcing },
          () => ({ contextRoot, sessionId: 'owned-read-fidelity', transport: 'http' }));
        return composition.manager;
      }, true);
    await f.maintenance`UPDATE public.elements SET memory_entries_out_of_sync=false WHERE id=${f.memoryId}::uuid`;
    await f.maintenance`INSERT INTO public.memory_backend_modes(user_id,backend,protocol_version,profile,mode,generation)
      VALUES(${f.userId}::uuid,'database',1,${DATABASE_MEMORY_ADMISSION_PROFILE},'guarded',1)`;
    await f.maintenance`INSERT INTO public.memory_candidate_quotas(user_id) VALUES(${f.userId}::uuid)`;
    phase(caseName, 'fixture-end'); phase(caseName, 'lifecycle-start');
    const manager = root.manager();
    await body(f, manager, composition && layer ? { composition, layer } : undefined);
    phase(caseName, 'assertions-complete');
  } catch (cause) { failure = { cause }; }
  phase(caseName, 'cleanup-start');
  // Settle manager lifecycle before closing/dropping its database resources.
  const disposal = await Promise.allSettled([root?.container.dispose()]);
  const resources = await Promise.allSettled([f.cleanup(), directory === undefined
    ? Promise.resolve() : rm(directory, { recursive: true, force: true })]);
  const failures = [...disposal, ...resources].filter(result => result.status === 'rejected')
    .map(result => (result as PromiseRejectedResult).reason);
  if (failures.length) throw new AggregateError(failure ? [failure.cause, ...failures] : failures,
    'Owned boot qualification assertion or cleanup failed');
  jest.restoreAllMocks();
  phase(caseName, 'cleanup-end');
  if (failure) throw failure.cause;
}
function qualification(f: EquivalentFixture, manager: MemoryManager) {
  return qualifyDatabaseMemoryTenant({ appDb: f.db, systemDb: drizzle(f.maintenance, { schema }),
    tenant: f.userId, manager, checkpoint: () => undefined });
}
required('actual streaming guarded tenant boot qualification', () => {
  it('preserves supported fractional values and tied raw order through an actual save and fresh read qualification', () => owned('save-restart-fidelity', async (f, manager, durable) => {
    expect(durable).toBeDefined();
    await expect(manager.load(f.memoryId)).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    await durable!.composition.qualify(async () => { await qualification(f, manager); });
    const memory = await manager.load(f.memoryId);
    const first = await memory.addEntry('First tied insertion', [], { confidence: 0.5 });
    const second = await memory.addEntry('Second tied insertion', [], { confidence: 0.125 });
    first.timestamp = new Date('2026-10-08T12:00:00.000Z');
    second.timestamp = new Date('2026-10-08T12:00:00.000Z');
    await memory.save();
    const snapshot = await f.snapshot();
    expect(snapshot.dirty).toBe(false);
    expect(await qualification(f, manager)).toEqual({ owners: 1 });
    expect(await f.snapshot()).toEqual(snapshot);
    const entries = await durable!.layer.getEntries(f.memoryId);
    expect(entries.find(entry => entry.entryId === first.id)?.entryMetadata).toMatchObject({ confidence: 0.5 });
    expect(entries.find(entry => entry.entryId === second.id)?.entryMetadata).toMatchObject({ confidence: 0.125 });
    expect(await durable!.composition.inspectRetained()).toEqual([]);
    const raw = await durable!.layer.readContent(f.memoryId);
    expect(raw.indexOf('Second tied insertion')).toBeLessThan(raw.indexOf('First tied insertion'));
  }, true), 30000);

  it('rolls back actual synchronized child corruption before COMMIT and retains the exact attempted candidate', () => owned('post-cas-refusal', async (f, manager, durable) => {
    expect(durable).toBeDefined();
    await durable!.composition.qualify(async () => { await qualification(f, manager); });
    const memory = await manager.load(f.memoryId);
    await memory.addEntry('Sole attempted candidate', [], { confidence: 0.5 });
    // Controlled privileged fixture fault, installed only after real boot
    // verification. The trigger changes the genuine same-transaction child
    // INSERT, so the mandatory post-CAS predicate must reject its representation.
    await f.maintenance`CREATE FUNCTION public.fidelity_fault() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN NEW.content := ''Controlled SQL projection corruption''; RETURN NEW; END'`;
    await f.maintenance`CREATE TRIGGER fidelity_fault BEFORE INSERT ON public.memory_entries
      FOR EACH ROW EXECUTE FUNCTION public.fidelity_fault()`;
    const before = await f.snapshot();
    const prepared = jest.spyOn(durable!.layer, 'prepareHeadWriteInAdmission');
    const committed = jest.spyOn(manager, 'completeGuardedOperation');
    const cause = await memory.save().then(() => undefined, failure => failure);
    expect(cause).toMatchObject({ code: 'EINVALIDHEAD', message: 'Prospective memory read fidelity refused' });
    expect(prepared).toHaveBeenCalledTimes(1);
    expect(committed).not.toHaveBeenCalled();
    expect(await f.snapshot()).toEqual(before);
    const pending = manager.getPendingHeadUpdate(memory);
    expect(pending?.status).toBe('refused'); expect(pending?.cause).toBe(cause);
    const [row] = await f.maintenance`SELECT status,envelope,digest,committed_token FROM public.memory_candidate_handoffs
      WHERE user_id=${f.userId}::uuid`;
    expect(row.status).toBe('prepared'); expect(row.committed_token).toBeNull();
    const candidate = decodeMemoryCandidate({ bytes: row.envelope, digest: row.digest });
    const submitted = prepared.mock.calls[0];
    const payload = { name: candidate.name, content: candidate.content, metadata: candidate.metadata };
    expect(payload).toStrictEqual({ name: submitted[2], content: submitted[3], metadata: submitted[4] });
    expect(pending?.candidate).toStrictEqual(payload);
    const original = (candidate as typeof candidate & { handoffEvidence: { original: Record<string, unknown> } }).handoffEvidence.original;
    for (const key of ['backend', 'userId', 'ownerId', 'locator', 'name', 'revision'] as const) {
      expect(original[key]).toBe(submitted[1][key]);
    }
  }, true), 30000);

  it('qualifies exact raw/projection with an empty provisioned quota without changing any stored state', () => owned('readonly-positive', async (f, manager) => {
    const before = await f.snapshot();
    expect(await qualification(f, manager)).toEqual({ owners: 1 });
    expect(await f.snapshot()).toEqual(before);
  }), 30000);

  it('refuses a dropped quota limit and a hidden extra domain column instead of claiming the exact catalog', () => owned('catalog-negative', async (f, manager) => {
    const before = await f.snapshot();
    await f.maintenance`ALTER TABLE public.memory_candidate_quotas DROP CONSTRAINT memory_candidate_quotas_retained_rows_check`;
    await expect(qualification(f, manager)).rejects.toThrow('constraint');
    await f.maintenance`ALTER TABLE public.memory_candidate_quotas ADD CONSTRAINT memory_candidate_quotas_retained_rows_check CHECK(retained_rows BETWEEN 0 AND 64)`;
    await f.maintenance`CREATE DOMAIN public.boot_probe AS text`;
    await f.maintenance`ALTER TABLE public.memory_candidate_quotas ADD COLUMN unsupported public.boot_probe`;
    await expect(qualification(f, manager)).rejects.toThrow('relation contract');
    expect(await f.snapshot()).toEqual(before);
  }), 30000);

  it('refuses privileged malformed foreign children invisible to the ordinary tenant', () => owned('foreign-negative', async (f, manager) => {
    await f.maintenance`ALTER TABLE public.memory_entries DISABLE TRIGGER USER`;
    try {
      await f.maintenance`UPDATE public.memory_entries SET user_id=${f.foreignUserId}::uuid WHERE memory_id=${f.memoryId}::uuid`;
    } finally { await f.maintenance`ALTER TABLE public.memory_entries ENABLE TRIGGER USER`; }
    const before = await f.snapshot();
    await expect(qualification(f, manager)).rejects.toThrow('foreign, orphan or archive');
    expect(await f.snapshot()).toEqual(before);
  }), 30000);
});
