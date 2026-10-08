/** Required isolated PostgreSQL proof, not live cohort activation. */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { DatabaseMemoryModeEnforcingStorageLayerFactory } from '../../../src/storage/DatabaseMemoryModeEnforcingStorageLayerFactory.js';
import { DatabaseMemoryLegacyMutationGuard, DATABASE_MEMORY_LEGACY_PROFILE as legacyProfile } from '../../../src/storage/DatabaseMemoryLegacyMutationGuard.js';
import { DatabaseMemoryAdmissionGate, DATABASE_MEMORY_ADMISSION_PROFILE as protectedProfile } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { MemoryHeadUpdateAdapter } from '../../../src/storage/MemoryHeadUpdateAdapter.js';
import { withUserContext } from '../../../src/database/rls.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { makeEquivalentFixture, type EquivalentFixture } from './fixtures/2905-equivalent-reconciliation-fixture.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
const owned: { fixture: EquivalentFixture; name: string }[] = [];
function phase(name: string, value: string) { console.info(`[db-legacy-denial:${name}] ${value}`); }
afterEach(async () => {
  jest.restoreAllMocks();
  for (const { fixture: f, name } of owned.splice(0)) {
    phase(name, 'cleanup-start'); await f.cleanup(); phase(name, 'cleanup-end');
  }
});
async function fixture(name: string) {
  phase(name, 'fixture-start');
  const f = await makeEquivalentFixture(); owned.push({ fixture: f, name });
  // Owned disposable fixture only; not production reconciliation authority.
  await f.maintenance`UPDATE public.elements SET memory_entries_out_of_sync=false WHERE id=${f.memoryId}::uuid`;
  const factory = new DatabaseMemoryModeEnforcingStorageLayerFactory(f.db, () => f.userId);
  const store = factory.createForElement('memories', { elementDir: '/unused', fileExtension: '.yaml', scanCooldownMs: 0 }) as DatabaseMemoryStorageLayer;
  const metadata = { author: 'test-author', version: '1.0.0', description: '', tags: ['test'] };
  const seed = (mode = 'legacy', profile = legacyProfile) => f.maintenance`INSERT INTO public.memory_backend_modes
    (user_id,backend,protocol_version,profile,mode,generation) VALUES (${f.userId}::uuid,'database',1,${profile},${mode},1)`;
  phase(name, 'fixture-end');
  return { ...f, factory, store, metadata, seed };
}

required('required PostgreSQL explicit legacy mutation permission', () => {
  it('permits actual factory raw writes and direct children only for explicit legacy mode', async () => {
    const f = await fixture('legacy-factory'); await f.seed();
    const content = f.raw.replace('Preserved entry', 'Explicit legacy edit');
    expect(await f.store.writeContent('memories', f.name, content, f.metadata)).toBe(f.memoryId);
    expect((await f.store.readHeadSnapshot(f.memoryId)).content).toBe(content);
    await f.store.addEntry(f.memoryId, { entryId: 'extra', timestamp: new Date(), content: 'Extra entry' });
    expect((await f.snapshot()).entries).toContain('Extra entry');
    await f.store.removeEntry(f.memoryId, 'extra');
    expect((await f.snapshot()).entries).not.toContain('Extra entry');
    await f.store.addEntry(f.memoryId, { entryId: 'expired', timestamp: new Date(0), expiresAt: new Date(1), content: 'Expired entry' });
    expect(await f.store.purgeExpiredEntries()).toBe(1);
    expect((await f.snapshot()).entries).not.toContain('Expired entry');
    phase('legacy-factory', 'assertions-complete');
  });
  it('refuses every actual legacy entrypoint for missing, guarded and read-only rows', async () => {
    const f = await fixture('all-entrypoints');
    const token = (await f.store.readHeadSnapshot(f.memoryId)).token;
    const operations = [
      () => f.store.writeContent('memories', f.name, f.raw, f.metadata),
      () => f.store.writeHeadIfCurrent(token, f.name, f.raw, f.metadata),
      () => f.store.addEntry(f.memoryId, { entryId: 'not-added', timestamp: new Date(), content: 'Denied' }),
      () => f.store.removeEntry(f.memoryId, 'one'),
      () => f.store.purgeExpiredEntries(),
      () => f.store.deleteContentByIdentity('memories', f.name),
      () => f.store.deleteContent('memories', f.name),
    ];
    const before = await f.snapshot();
    const observer = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    for (const mode of ['missing', 'guarded', 'read_only']) {
      if (mode === 'guarded') await f.seed(mode, protectedProfile);
      if (mode === 'read_only') await f.maintenance`UPDATE public.memory_backend_modes SET mode='read_only' WHERE user_id=${f.userId}::uuid`;
      for (const operation of operations) await expect(operation()).rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
      expect(await f.snapshot()).toEqual(before);
    }
    expect(observer.mock.calls.filter(([event]) => event.source === 'DatabaseMemoryLegacyMutationGuard')).toHaveLength(21);
    expect(observer.mock.calls.some(([event]) => event.type === 'ELEMENT_EDITED' || event.type === 'ELEMENT_DELETED')).toBe(false);
    phase('all-entrypoints', 'assertions-complete');
  });
  it('guards inherited identity delete while preserving identity mismatch and real legacy deletion', async () => {
    const f = await fixture('identity-delete'); await f.seed();
    const before = await f.snapshot();
    await expect(f.store.deleteContentByIdentity('memories', f.name, { id: randomUUID(), name: f.name })).rejects.toMatchObject({ code: 'ESTALE' });
    expect(await f.snapshot()).toEqual(before);
    expect(await f.store.deleteContentByIdentity('memories', f.name, { id: f.memoryId, name: f.name })).toEqual({ id: f.memoryId, name: f.name });
    const after = await f.snapshot();
    expect(after.parent).toBeNull(); expect(JSON.parse(after.entries)).toEqual([]); expect(JSON.parse(after.tags)).toEqual([]);
    phase('identity-delete', 'assertions-complete');
  });
  it('retains ordinary role row-lock admission while denying mode seeding and mutation', async () => {
    const f = await fixture('ordinary-role');
    await expect(withUserContext(f.db, f.userId, tx => tx.execute(sql`INSERT INTO public.memory_backend_modes
      (user_id,backend,protocol_version,profile,mode,generation) VALUES (${f.userId}::uuid,'database',1,${legacyProfile},'legacy',1)`))).rejects.toBeDefined();
    expect(await f.maintenance`SELECT generation FROM public.memory_backend_modes WHERE user_id=${f.userId}::uuid`).toHaveLength(0);
    await f.seed();
    await f.maintenance`REVOKE ALL ON public.memory_backend_modes FROM ${f.maintenance(f.roleName)}`;
    await f.maintenance`GRANT SELECT,UPDATE(generation) ON public.memory_backend_modes TO ${f.maintenance(f.roleName)}`;
    const [role] = await withUserContext(f.db, f.userId, tx => tx.execute(sql`SELECT rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user`));
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    await f.store.removeEntry(f.memoryId, 'one');
    await expect(withUserContext(f.db, f.userId, tx => tx.execute(sql`UPDATE public.memory_backend_modes SET generation=generation WHERE user_id=${f.userId}::uuid`))).rejects.toBeDefined();
    const [row] = await f.maintenance`SELECT mode,generation::text FROM public.memory_backend_modes WHERE user_id=${f.userId}::uuid`;
    expect(row).toEqual({ mode: 'legacy', generation: '1' });
    phase('ordinary-role', 'assertions-complete');
  });
  it('forbids privileged protected-to-legacy downgrade and retains sticky generation invariants', async () => {
    const f = await fixture('sticky-mode'); await f.seed();
    await f.maintenance`UPDATE public.memory_backend_modes SET mode='guarded',profile=${protectedProfile} WHERE user_id=${f.userId}::uuid`;
    for (const mode of ['guarded', 'read_only']) {
      if (mode === 'read_only') await f.maintenance`UPDATE public.memory_backend_modes SET mode='read_only' WHERE user_id=${f.userId}::uuid`;
      const before = await f.maintenance`SELECT * FROM public.memory_backend_modes WHERE user_id=${f.userId}::uuid`;
      await expect(f.maintenance`UPDATE public.memory_backend_modes SET mode='legacy',profile=${legacyProfile},protocol_version=1,generation=1 WHERE user_id=${f.userId}::uuid`).rejects.toBeDefined();
      expect(await f.maintenance`SELECT * FROM public.memory_backend_modes WHERE user_id=${f.userId}::uuid`).toEqual(before);
    }
    await expect(f.maintenance`DELETE FROM public.memory_backend_modes WHERE user_id=${f.userId}::uuid`).rejects.toBeDefined();
    await expect(f.maintenance`UPDATE public.memory_backend_modes SET user_id=${f.foreignUserId}::uuid WHERE user_id=${f.userId}::uuid`).rejects.toBeDefined();
    const [row] = await f.maintenance`SELECT generation::text FROM public.memory_backend_modes WHERE user_id=${f.userId}::uuid`;
    expect(row.generation).toBe('3');
    phase('sticky-mode', 'assertions-complete');
  });
  it('holds the actual legacy DML transaction against a competing mode promotion', async () => {
    const f = await fixture('mode-exclusion'); await f.seed();
    let entered!: () => void; const entry = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const original = DatabaseMemoryLegacyMutationGuard.prototype.requireLegacyInTransaction;
    jest.spyOn(DatabaseMemoryLegacyMutationGuard.prototype, 'requireLegacyInTransaction').mockImplementation(async function (this: DatabaseMemoryLegacyMutationGuard, tx, store, tenant) {
      await original.call(this, tx, store, tenant); entered(); await held;
    });
    const operation = f.store.removeEntry(f.memoryId, 'one');
    let transition: PromiseLike<unknown> | undefined;
    let settled: PromiseSettledResult<unknown>[] = [];
    try {
      await Promise.race([entry, operation.then(() => { throw new Error('Operation completed before held barrier'); })]);
      const [{ pid }] = await f.competitor`SELECT pg_backend_pid() AS pid`;
      transition = f.competitor`UPDATE public.memory_backend_modes SET mode='guarded',profile=${protectedProfile} WHERE user_id=${f.userId}::uuid`.execute();
      let observed = false;
      for (let attempt = 0; attempt < 1000; attempt++) {
        const [{ blocked }] = await f.maintenance`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=${pid} AND NOT granted) AS blocked`;
        if (blocked) { observed = true; break; }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(observed).toBe(true);
      expect((await f.snapshot()).entries).toContain('Preserved entry');
    } finally {
      release();
      settled = await Promise.allSettled([operation, ...(transition ? [transition] : [])]);
    }
    expect(settled.every(result => result.status === 'fulfilled')).toBe(true);
    jest.restoreAllMocks();
    expect((await f.snapshot()).entries).not.toContain('Preserved entry');
    await expect(f.store.removeEntry(f.memoryId, 'one')).rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
    phase('mode-exclusion', 'assertions-complete');
  });
  it('rolls back actual DML when tenant context drifts at the post-body recheck', async () => {
    const f = await fixture('post-dml-drift'); await f.seed(); const before = await f.snapshot();
    let tenant = f.userId; let dmlInvoked = false;
    const guard = new DatabaseMemoryLegacyMutationGuard(f.db, () => tenant);
    const store = new DatabaseMemoryStorageLayer(f.db, () => tenant, guard);
    const context = guard.requireContext.bind(guard);
    jest.spyOn(guard, 'requireContext').mockImplementation((value, captured) => {
      if (dmlInvoked) tenant = f.foreignUserId;
      context(value, captured);
    });
    const check = guard.requireLegacyInTransaction.bind(guard);
    jest.spyOn(guard, 'requireLegacyInTransaction').mockImplementation(async (tx, value, captured) => {
      await check(tx, value, captured);
      const remove = tx.delete.bind(tx);
      jest.spyOn(tx, 'delete').mockImplementation(table => { dmlInvoked = true; return remove(table); });
    });
    await expect(store.removeEntry(f.memoryId, 'one')).rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
    expect(dmlInvoked).toBe(true); expect(await f.snapshot()).toEqual(before);
    phase('post-dml-drift', 'assertions-complete');
  });
  it('keeps admitted conditional persistence separate from denied ordinary CAS', async () => {
    const f = await fixture('admitted-separation'); await f.seed('guarded', protectedProfile);
    const snapshot = await f.store.readHeadSnapshot(f.memoryId);
    await expect(f.store.writeHeadIfCurrent(snapshot.token, f.name, f.raw, f.metadata)).rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
    const adapter = new MemoryHeadUpdateAdapter({ backend: 'database', store: f.store }, () => f.userId);
    const gate = new DatabaseMemoryAdmissionGate(f.db, f.store, () => ({ tenant: f.userId, backend: 'database', db: f.db,
      store: f.store, adapter, enabled: true, profile: protectedProfile }));
    const capture = await gate.capture(); const content = f.raw.replace('Preserved entry', 'Admitted edit');
    const outcome = await gate.withAdmittedWrite(capture, authority => f.store.prepareHeadWriteInAdmission(authority, snapshot.token, f.name, content, f.metadata));
    expect(outcome.status).toBe('committed');
    if (outcome.status !== 'committed') throw new Error('Expected known commit');
    outcome.value.publish();
    expect((await f.store.readHeadSnapshot(f.memoryId)).content).toBe(content);
    expect((await f.snapshot()).entries).toContain('Admitted edit');
    phase('admitted-separation', 'assertions-complete');
  });
});
