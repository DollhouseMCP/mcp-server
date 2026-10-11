/** Isolated required PostgreSQL composition proof, not live admission. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../../src/database/schema/index.js';
import type { ElementManagerDeps } from '../../../src/elements/base/BaseElementManager.js';
import { admittedMemoryContainer } from '../../helpers/storage/admitted-memory-container.js';
import { DatabaseTenantMemoryRegistry } from '../../../src/storage/DatabaseTenantMemoryRegistry.js';
import { requireDatabaseMemoryStartupAdmission } from '../../../src/storage/DatabaseMemoryStartupAdmission.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE as guardedProfile } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { DATABASE_MEMORY_LEGACY_PROFILE as legacyProfile } from '../../../src/storage/DatabaseMemoryLegacyMutationGuard.js';
import { makeEquivalentFixture, type EquivalentFixture } from './fixtures/2905-equivalent-reconciliation-fixture.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
const owned: { f: EquivalentFixture; name: string }[] = [];
function phase(name: string, value: string) { console.info(`[db-tenant-composition:${name}] ${value}`); }
afterEach(async () => {
  for (const { f, name } of owned.splice(0)) {
    phase(name, 'cleanup-start'); await f.cleanup(); phase(name, 'cleanup-end');
  }
});
async function fixture(name: string) {
  phase(name, 'fixture-start');
  const f = await makeEquivalentFixture(); owned.push({ f, name });
  phase(name, 'fixture-end');
  return { ...f, systemDb: drizzle(f.maintenance, { schema }) };
}
required('required PostgreSQL private tenant composition', () => {
  it('blocks configuration-off for another served protected tenant that app RLS does not expose', async () => {
    const f = await fixture('whole-database-off'); const before = await f.snapshot();
    const [endpoint] = await f.maintenance`SELECT pg_catalog.inet_server_addr()::text AS inet_text,
      pg_catalog.host(pg_catalog.inet_server_addr()) AS host_text`;
    expect(endpoint.inet_text).toMatch(/\/(32|128)$/u);
    expect(endpoint.host_text).not.toContain('/');
    await expect(requireDatabaseMemoryStartupAdmission(f.db, f.systemDb, false)).resolves.toBeUndefined();
    await f.maintenance`INSERT INTO public.memory_backend_modes
      (user_id,backend,protocol_version,profile,mode,generation)
      VALUES (${f.foreignUserId}::uuid,'database',1,${guardedProfile},'guarded',1)`;
    await expect(requireDatabaseMemoryStartupAdmission(f.db, f.systemDb, false)).rejects.toThrow('startup');
    await f.maintenance`UPDATE public.memory_backend_modes SET mode='read_only' WHERE user_id=${f.foreignUserId}::uuid`;
    await expect(requireDatabaseMemoryStartupAdmission(f.db, f.systemDb, false)).rejects.toThrow('startup');
    await expect(requireDatabaseMemoryStartupAdmission(f.db, f.systemDb, true)).resolves.toBeUndefined();
    await expect(requireDatabaseMemoryStartupAdmission(f.db, f.db, false)).rejects.toThrow('BYPASSRLS');
    expect(await f.snapshot()).toEqual(before);
    phase('whole-database-off', 'assertions-complete');
  });
  it('rejects a real different administrative database instead of accepting its empty mode catalog', async () => {
    const f = await fixture('mismatched-database'); const other = await fixture('mismatched-observer');
    const before = await f.snapshot();
    await f.maintenance`INSERT INTO public.memory_backend_modes
      (user_id,backend,protocol_version,profile,mode,generation)
      VALUES (${f.userId}::uuid,'database',1,${guardedProfile},'guarded',1)`;
    await expect(requireDatabaseMemoryStartupAdmission(f.db, other.systemDb, false)).rejects.toThrow('application database');
    expect(await f.snapshot()).toEqual(before);
    phase('mismatched-database', 'assertions-complete'); phase('mismatched-observer', 'assertions-complete');
  });
  it('refuses nullable corrupt catalog and NULL tuple rather than counting SQL unknown as valid', async () => {
    const f = await fixture('nullable-catalog');
    await f.maintenance`ALTER TABLE public.memory_backend_modes ALTER COLUMN mode DROP NOT NULL`;
    await f.maintenance`INSERT INTO public.memory_backend_modes
      (user_id,backend,protocol_version,profile,mode,generation)
      VALUES (${f.userId}::uuid,'database',1,${guardedProfile},NULL,1)`;
    await expect(requireDatabaseMemoryStartupAdmission(f.db, f.systemDb, true)).rejects.toThrow('startup');
    const [row] = await f.maintenance`SELECT mode FROM public.memory_backend_modes WHERE user_id=${f.userId}::uuid`;
    expect(row.mode).toBeNull(); phase('nullable-catalog', 'assertions-complete');
  });
  it('constructs separate actual RLS-bound legacy and closed guarded managers while sharing same-tenant entries', async () => {
    const f = await fixture('mixed-tenants'); const before = await f.snapshot();
    await f.maintenance`INSERT INTO public.memory_backend_modes
      (user_id,backend,protocol_version,profile,mode,generation) VALUES
      (${f.userId}::uuid,'database',1,${legacyProfile},'legacy',1),
      (${f.foreignUserId}::uuid,'database',1,${guardedProfile},'guarded',1)`;
    const scope = new AsyncLocalStorage<string>(); const getTenant = () => scope.getStore() ?? f.userId;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pg-tenant-registry-'));
    let deps!: ElementManagerDeps;
    const root = admittedMemoryContainer(f.db, getTenant, directory, factory => incoming => {
      deps = incoming; return factory.createAdmittedMemoryManager(incoming);
    });
    try {
      root.manager();
      const registry = new DatabaseTenantMemoryRegistry({ db: f.db, getEffectiveTenant: getTenant,
        createManagerDeps: (factory, resolver) => ({ ...deps, fileWatchService: undefined, storageLayerFactory: factory, getCurrentUserId: resolver }),
        getAttribution: () => ({ contextRoot: 'owned-pg-test', sessionId: 'test-session', transport: 'http' }) });
      const [first, same, foreign] = await Promise.all([
        scope.run(f.userId, () => registry.resolve(registry.capture())),
        scope.run(f.userId, () => registry.resolve(registry.capture())),
        scope.run(f.foreignUserId, () => registry.resolve(registry.capture())),
      ]);
      expect(first).toBe(same); expect(first).not.toBe(foreign);
      expect(first.isGuardedHeadUpdateEnabled()).toBe(false); expect(foreign.isGuardedHeadUpdateEnabled()).toBe(true);
      await expect(scope.run(f.foreignUserId, () => foreign.create({ name: 'not-admitted', description: 'unsupported' })))
        .rejects.toThrow('UPDATE only');
      registry.close();
      expect(() => scope.run(f.foreignUserId, () => registry.capture())).toThrow('closed');
      expect(await f.snapshot()).toEqual(before); phase('mixed-tenants', 'assertions-complete');
    } finally {
      try { await root.container.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
});
