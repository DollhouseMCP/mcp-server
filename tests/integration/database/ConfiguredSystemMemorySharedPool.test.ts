/** Owned database writer/public-read boundary, not authenticated HTTP or cold exclusion. */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../../src/database/schema/index.js';
import type { ElementManagerDeps } from '../../../src/elements/base/BaseElementManager.js';
import { DatabaseTenantMemoryRegistry } from '../../../src/storage/DatabaseTenantMemoryRegistry.js';
import { DATABASE_MEMORY_LEGACY_PROFILE } from '../../../src/storage/DatabaseMemoryLegacyMutationGuard.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { DatabaseSharedPoolWriteStrategy, SharedPoolInstaller } from '../../../src/collection/shared-pool/SharedPoolInstaller.js';
import { DatabaseProvenanceStore } from '../../../src/collection/shared-pool/DatabaseProvenanceStore.js';
import { DeploymentSeedLoader } from '../../../src/collection/shared-pool/DeploymentSeedLoader.js';
import { SYSTEM_USER_UUID } from '../../../src/collection/shared-pool/SharedPoolConfig.js';
import { admittedMemoryContainer } from '../../helpers/storage/admitted-memory-container.js';
import { makeEquivalentFixture, type EquivalentFixture } from './fixtures/2905-equivalent-reconciliation-fixture.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
const raw = 'name: shared-owned-fixture\nmemoryType: user\nentries: []\ntags: []';
const request = { name: 'shared-owned-fixture', elementType: 'memories', content: raw,
  origin: 'deployment_seed' as const, sourceUrl: null, sourceVersion: null };
function phase(name: string, mark: string) { console.info(`[configured-system-memory:${name}] ${mark}`); }
async function owned(name: string, body: (f: EquivalentFixture, directory: string) => Promise<void>) {
  phase(name, 'fixture-start'); const f = await makeEquivalentFixture(); let directory: string | undefined;
  let failure: { cause: unknown } | undefined;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'system-memory-writer-'));
    phase(name, 'fixture-end'); phase(name, 'lifecycle-start');
    await body(f, directory); phase(name, 'assertions-complete');
  } catch (cause) { failure = { cause }; }
  phase(name, 'cleanup-start'); jest.restoreAllMocks();
  const settled = await Promise.allSettled([f.cleanup(), directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve()]);
  const errors = settled.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason);
  if (errors.length) throw new AggregateError(failure ? [failure.cause, ...errors] : errors, 'Owned SYSTEM assertion or cleanup failed');
  phase(name, 'cleanup-end'); if (failure) throw failure.cause;
}
function registry(f: EquivalentFixture) {
  return new DatabaseTenantMemoryRegistry({ db: f.db, getEffectiveTenant: () => f.userId,
    createManagerDeps: () => { throw new Error('No selected manager construction required'); },
    getAttribution: () => ({ contextRoot: 'owned-system-writer', sessionId: 'owned', transport: 'http' }) });
}
async function systemSnapshot(f: EquivalentFixture) {
  const [row] = await f.maintenance`SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]'::jsonb)::text FROM public.elements e) AS elements,
    (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY element_id),'[]'::jsonb)::text FROM public.element_provenance p) AS provenance`;
  return { row, projection: await f.snapshot() };
}
required('configured SYSTEM memory shared pool', () => {
  it.each(['missing', 'guarded', 'read_only'] as const)('refuses direct and actual startup seed memory writes in %s mode without changing owners', mode => owned(mode, async (f, directory) => {
    if (mode !== 'missing') await f.maintenance`INSERT INTO public.memory_backend_modes(user_id,backend,protocol_version,profile,mode,generation)
      VALUES(${SYSTEM_USER_UUID}::uuid,'database',1,${DATABASE_MEMORY_ADMISSION_PROFILE},${mode},1)`;
    const systemDb = drizzle(f.maintenance, { schema });
    const strategy = new DatabaseSharedPoolWriteStrategy(systemDb, { registry: registry(f), applicationDb: f.db });
    const before = await systemSnapshot(f);
    await expect(strategy.writeElement(request, createHash('sha256').update(raw).digest('hex'))).rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
    await mkdir(path.join(directory, 'memories')); await writeFile(path.join(directory, 'memories', `${request.name}.yaml`), raw);
    const provenance = new DatabaseProvenanceStore(systemDb);
    const seeds = new DeploymentSeedLoader(directory, new SharedPoolInstaller(provenance, strategy), provenance);
    expect(await seeds.loadSeeds()).toMatchObject({ installed: 0, failed: 1 });
    expect(await systemSnapshot(f)).toEqual(before);
    await expect(strategy.writeElement({ ...request, name: 'shared-skill', elementType: 'skills' }, 'a'.repeat(64))).resolves.toEqual(expect.any(String));
    const [skill] = await f.maintenance`SELECT count(*)::int AS count FROM public.elements WHERE user_id=${SYSTEM_USER_UUID}::uuid AND element_type='skills'`;
    expect(skill.count).toBe(1);
  }), 30000);

  it('holds the real SYSTEM LEGACY mode lock through upsert and preserves LEGACY public reads without guarded owner authority', () => owned('legacy-lock-public', async (f, directory) => {
    await f.maintenance`INSERT INTO public.memory_backend_modes(user_id,backend,protocol_version,profile,mode,generation) VALUES
      (${SYSTEM_USER_UUID}::uuid,'database',1,${DATABASE_MEMORY_LEGACY_PROFILE},'legacy',1),
      (${f.userId}::uuid,'database',1,${DATABASE_MEMORY_LEGACY_PROFILE},'legacy',1),
      (${f.foreignUserId}::uuid,'database',1,${DATABASE_MEMORY_ADMISSION_PROFILE},'guarded',1)`;
    const systemDb = drizzle(f.maintenance, { schema });
    // An owned trigger waits after the genuine strategy has acquired its mode
    // lock. The contender is a separate backend; no transaction/role is mocked.
    await f.maintenance`CREATE FUNCTION public.owned_system_write_barrier() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN PERFORM pg_advisory_xact_lock(48203211); RETURN NEW; END'`;
    await f.maintenance`CREATE TRIGGER owned_system_write_barrier BEFORE INSERT ON public.elements
      FOR EACH ROW WHEN (NEW.user_id='00000000-0000-0000-0000-000000000001'::uuid AND NEW.element_type='memories')
      EXECUTE FUNCTION public.owned_system_write_barrier()`;
    await f.competitor`SELECT pg_advisory_lock(48203211)`;
    const strategy = new DatabaseSharedPoolWriteStrategy(systemDb, { registry: registry(f), applicationDb: f.db });
    const write = strategy.writeElement(request, createHash('sha256').update(raw).digest('hex'));
    void write.catch(() => undefined); // Actual outcome is awaited after releasing our barrier.
    let barrierFailure: { cause: unknown } | undefined;
    try {
      let waiting = false;
      for (let poll = 0; poll < 200 && !waiting; poll++) {
        const [row] = await f.competitor`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks
          WHERE locktype='advisory' AND NOT granted AND objid=48203211
            AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())) AS waiting`;
        waiting = row.waiting === true;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
      await expect(f.competitor.begin(async tx => {
        await tx`SET LOCAL lock_timeout='50ms'`;
        await tx`UPDATE public.memory_backend_modes SET mode='guarded',profile=${DATABASE_MEMORY_ADMISSION_PROFILE},generation=2 WHERE user_id=${SYSTEM_USER_UUID}::uuid AND backend='database'`;
      })).rejects.toMatchObject({ code: '55P03' });
    } catch (cause) { barrierFailure = { cause }; }
    finally { await f.competitor`SELECT pg_advisory_unlock(48203211)`; }
    const id = await write;
    if (barrierFailure) throw barrierFailure.cause;
    const [systemMode] = await f.maintenance`SELECT mode FROM public.memory_backend_modes WHERE user_id=${SYSTEM_USER_UUID}::uuid`;
    expect(systemMode.mode).toBe('legacy');
    let deps!: ElementManagerDeps;
    const root = admittedMemoryContainer(f.db, () => f.userId, directory, factory => incoming => {
      deps = incoming; return factory.createAdmittedMemoryManager({ ...incoming, fileWatchService: undefined });
    });
    try {
      root.manager(); let tenant = f.userId;
      const selected = new DatabaseTenantMemoryRegistry({ db: f.db, getEffectiveTenant: () => tenant,
        createManagerDeps: (factory, resolver) => ({ ...deps, fileWatchService: undefined, storageLayerFactory: factory, getCurrentUserId: resolver }),
        getAttribution: () => ({ contextRoot: directory, sessionId: 'owned-public-read', transport: 'http' }) });
      const legacy = await selected.resolve(selected.capture());
      const before = await systemSnapshot(f);
      const listed = await legacy.list({ includePublic: true, strictDatabase: true });
      expect(listed.some(memory => memory.getFilePath() === id && memory.metadata.name === request.name)).toBe(true);
      tenant = f.foreignUserId; const guarded = await selected.resolve(selected.capture());
      await expect(guarded.list({ includePublic: true, strictDatabase: true })).rejects.toThrow('public inclusion is unavailable');
      expect(await systemSnapshot(f)).toEqual(before);
    } finally { await root.container.dispose(); }
  }), 30000);
});
