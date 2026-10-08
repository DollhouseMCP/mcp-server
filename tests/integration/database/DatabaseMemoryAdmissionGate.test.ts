/** Dormant admission authority only; not head eligibility or activation proof. */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { sql } from 'drizzle-orm';
import { MemoryHeadUpdateAdapter } from '../../../src/storage/MemoryHeadUpdateAdapter.js';
import { DatabaseMemoryAdmissionGate, DATABASE_MEMORY_ADMISSION_PROFILE as profile,
  type DatabaseMemoryAdmissionBinding } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { withUserContext } from '../../../src/database/rls.js';
import { makeEquivalentFixture, type EquivalentFixture } from './fixtures/2905-equivalent-reconciliation-fixture.js';

const fixtures: { fixture: EquivalentFixture; caseName: string }[] = [];
function phase(caseName: string, value: string): void { console.info(`[db-admission:${caseName}] ${value}`); }
afterEach(async () => {
  for (const { fixture: f, caseName } of fixtures.splice(0)) {
    phase(caseName, 'cleanup-start'); await f.cleanup(); phase(caseName, 'cleanup-end');
  }
});
async function fixture(caseName: string) {
  phase(caseName, 'fixture-start');
  const f = await makeEquivalentFixture(); fixtures.push({ fixture: f, caseName });
  phase(caseName, 'fixture-end');
  const adapter = new MemoryHeadUpdateAdapter({ backend: 'database', store: f.layer }, () => f.userId);
  let binding: DatabaseMemoryAdmissionBinding = { tenant: f.userId, backend: 'database', db: f.db,
    store: f.layer, adapter, enabled: true, profile };
  const gate = new DatabaseMemoryAdmissionGate(f.db, f.layer, () => binding);
  const seed = async (tenant = f.userId) => f.maintenance`INSERT INTO public.memory_backend_modes
    (user_id,backend,protocol_version,profile,mode,generation) VALUES (${tenant}::uuid,'database',1,${profile},'guarded',1)`;
  return { ...f, gate, adapter, seed, change: (value: Partial<DatabaseMemoryAdmissionBinding>) => { binding = { ...binding, ...value }; } };
}

describe('required PostgreSQL dormant DB admission', () => {
  it('admits under an ordinary role with minimal row-lock privilege and rejects actual writes', async () => {
    const f = await fixture('minimal-role'); await f.seed();
    await f.maintenance`REVOKE ALL ON public.memory_backend_modes FROM ${f.maintenance(f.roleName)}`;
    await f.maintenance`GRANT SELECT,UPDATE(generation) ON public.memory_backend_modes TO ${f.maintenance(f.roleName)}`;
    const c = await f.gate.capture();
    expect(await f.gate.withAdmission(c, async tx => {
      const [row] = await tx.execute(sql`SELECT current_setting('app.current_user_id') AS tenant,
        rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user`);
      expect(row).toMatchObject({ tenant: f.userId, rolsuper: false, rolbypassrls: false });
      return 'admitted';
    })).toBe('admitted');
    await expect(withUserContext(f.db, f.userId, tx => tx.execute(sql`UPDATE public.memory_backend_modes
      SET generation=generation WHERE user_id=${f.userId}::uuid`))).rejects.toBeDefined();
    const [row] = await f.maintenance`SELECT generation::text FROM public.memory_backend_modes WHERE user_id=${f.userId}::uuid`;
    expect(row.generation).toBe('1');
    phase('minimal-role', 'assertions-complete');
  });
  it('denies insert, no-op/material update and delete even under broad runtime CRUD grants', async () => {
    const f = await fixture('broad-grants');
    await expect(withUserContext(f.db, f.userId, tx => tx.execute(sql`INSERT INTO public.memory_backend_modes
      (user_id,backend,protocol_version,profile,mode,generation)
      VALUES (${f.userId}::uuid,'database',1,${profile},'guarded',1)`))).rejects.toBeDefined();
    const ownRows = await f.maintenance`SELECT generation FROM public.memory_backend_modes WHERE user_id=${f.userId}::uuid`;
    expect(ownRows).toHaveLength(0);
    await f.seed();
    const c = await f.gate.capture(); expect(await f.gate.withAdmission(c, async () => true)).toBe(true);
    await expect(withUserContext(f.db, f.userId, tx => tx.execute(sql`INSERT INTO public.memory_backend_modes
      (user_id,backend,protocol_version,profile,mode,generation)
      VALUES (${f.foreignUserId}::uuid,'database',1,${profile},'guarded',1)`))).rejects.toBeDefined();
    for (const statement of [sql`UPDATE public.memory_backend_modes SET generation=generation WHERE user_id=${f.userId}::uuid`,
      sql`UPDATE public.memory_backend_modes SET mode='read_only' WHERE user_id=${f.userId}::uuid`]) {
      await expect(withUserContext(f.db, f.userId, tx => tx.execute(statement))).rejects.toBeDefined();
    }
    const deleted = await withUserContext(f.db, f.userId, tx => tx.execute(sql`DELETE FROM public.memory_backend_modes
      WHERE user_id=${f.userId}::uuid RETURNING user_id`));
    expect(deleted).toHaveLength(0);
    const [row] = await f.maintenance`SELECT generation::text,mode FROM public.memory_backend_modes WHERE user_id=${f.userId}::uuid`;
    expect(row).toMatchObject({ generation: '1', mode: 'guarded' });
    phase('broad-grants', 'assertions-complete');
  });
  it('isolates tenants and refuses absent, read-only and unsupported durable states before dispatch', async () => {
    const f = await fixture('isolation'); await f.seed(f.foreignUserId);
    await expect(f.gate.capture()).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    await f.seed(); const c = await f.gate.capture(); const body = jest.fn(async () => 'bad');
    await f.maintenance`UPDATE public.memory_backend_modes SET mode='read_only' WHERE user_id=${f.userId}::uuid`;
    await expect(f.gate.withAdmission(c, body)).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    await f.maintenance`UPDATE public.memory_backend_modes SET mode='guarded',protocol_version=2 WHERE user_id=${f.userId}::uuid`;
    await expect(f.gate.capture()).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    await f.maintenance`UPDATE public.memory_backend_modes SET protocol_version=1,profile='unsupported' WHERE user_id=${f.userId}::uuid`;
    await expect(f.gate.capture()).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    expect(body).not.toHaveBeenCalled();
    phase('isolation', 'assertions-complete');
  });
  it('keeps identity sticky and monotonically advances generation without ABA/deletion', async () => {
    const f = await fixture('generation'); await f.seed(); const c = await f.gate.capture();
    await f.maintenance`UPDATE public.memory_backend_modes SET mode='read_only',generation=900 WHERE user_id=${f.userId}::uuid`;
    await f.maintenance`UPDATE public.memory_backend_modes SET mode='guarded',generation=1 WHERE user_id=${f.userId}::uuid`;
    const [row] = await f.maintenance`SELECT generation::text FROM public.memory_backend_modes WHERE user_id=${f.userId}::uuid`;
    expect(row.generation).toBe('3');
    const body = jest.fn(async () => 'bad'); await expect(f.gate.withAdmission(c, body)).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    expect(body).not.toHaveBeenCalled();
    await expect(f.maintenance`DELETE FROM public.memory_backend_modes WHERE user_id=${f.userId}::uuid`).rejects.toBeDefined();
    await expect(f.maintenance`UPDATE public.memory_backend_modes SET user_id=${f.foreignUserId}::uuid
      WHERE user_id=${f.userId}::uuid`).rejects.toBeDefined();
    await expect(f.maintenance`INSERT INTO public.memory_backend_modes(user_id,backend,protocol_version,profile,mode,generation)
      VALUES (${f.foreignUserId}::uuid,'database',1,${profile},'guarded',2)`).rejects.toBeDefined();
    phase('generation', 'assertions-complete');
  });
  it('holds the mode transition until the protected callback transaction has completed', async () => {
    const f = await fixture('mode-exclusion'); await f.seed(); const c = await f.gate.capture();
    const [{ pid }] = await f.competitor`SELECT pg_backend_pid() AS pid`;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const entry = new Promise<void>(resolve => { entered = resolve; });
    const operation = f.gate.withAdmission(c, async tx => {
      expect(tx).toBeDefined(); entered(); await held; return 'completed';
    });
    await entry;
    const transition = f.competitor`UPDATE public.memory_backend_modes SET mode='read_only' WHERE user_id=${f.userId}::uuid`.execute();
    try {
      let observed = false;
      for (let attempt = 0; attempt < 1000; attempt++) {
        const [{ blocked }] = await f.maintenance`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=${pid} AND NOT granted) AS blocked`;
        if (blocked) { observed = true; break; }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(observed).toBe(true);
      const [row] = await f.maintenance`SELECT mode,generation::text FROM public.memory_backend_modes WHERE user_id=${f.userId}::uuid`;
      expect(row).toMatchObject({ mode: 'guarded', generation: '1' });
    } finally { release(); await operation; await transition; }
    await expect(f.gate.capture()).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    phase('mode-exclusion', 'assertions-complete');
  });
  it('refuses generation overflow without wraparound and restores the owned fixture on rollback', async () => {
    const f = await fixture('overflow'); await f.seed();
    // Disposable CI database only. The intentional overflow aborts this whole
    // transaction, including its temporary fixture alteration and max value.
    await expect(f.maintenance.begin(async tx => {
      await tx`ALTER TABLE public.memory_backend_modes DISABLE TRIGGER memory_backend_modes_guard`;
      await tx`UPDATE public.memory_backend_modes SET generation=9223372036854775807 WHERE user_id=${f.userId}::uuid`;
      await tx`ALTER TABLE public.memory_backend_modes ENABLE TRIGGER memory_backend_modes_guard`;
      await tx`UPDATE public.memory_backend_modes SET mode='read_only' WHERE user_id=${f.userId}::uuid`;
    })).rejects.toMatchObject({ code: '22003' });
    const [row] = await f.maintenance`SELECT generation::text,mode FROM public.memory_backend_modes WHERE user_id=${f.userId}::uuid`;
    expect(row).toMatchObject({ generation: '1', mode: 'guarded' });
    expect(await f.gate.capture()).toMatchObject({ protocolVersion: 1 });
    phase('overflow', 'assertions-complete');
  });
  it('rolls back known callback work on post-body context/config refusal and preserves exact causes', async () => {
    const f = await fixture('rollback'); await f.seed();
    await f.maintenance`CREATE TABLE public.admission_probe(value integer NOT NULL)`;
    await f.maintenance`GRANT SELECT,INSERT ON public.admission_probe TO ${f.maintenance(f.roleName)}`;
    const c = await f.gate.capture();
    await expect(f.gate.withAdmission(c, async tx => {
      await tx.execute(sql`INSERT INTO public.admission_probe VALUES (7)`); f.change({ enabled: false });
    })).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    const [{ count }] = await f.maintenance`SELECT count(*)::integer AS count FROM public.admission_probe`;
    expect(count).toBe(0);
    f.change({ enabled: true }); const cause = new Error('controlled callback failure');
    await expect(f.gate.withAdmission(c, async tx => {
      await tx.execute(sql`INSERT INTO public.admission_probe VALUES (8)`); throw cause;
    })).rejects.toBe(cause);
    const [after] = await f.maintenance`SELECT count(*)::integer AS count FROM public.admission_probe`;
    expect(after.count).toBe(0);
    phase('rollback', 'assertions-complete');
  });
  it('refuses restart/off/missing adapter and unsupported runtime binding without legacy fallback', async () => {
    const f = await fixture('restart'); await f.seed(); const c = await f.gate.capture(); const body = jest.fn(async () => 'bad');
    const restarted = new DatabaseMemoryAdmissionGate(f.db, f.layer, () => ({ tenant: f.userId, backend: 'database',
      db: f.db, store: f.layer, adapter: f.adapter, enabled: true, profile }));
    await expect(restarted.withAdmission(c, body)).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    f.change({ enabled: false }); await expect(f.gate.withAdmission(c, body)).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    f.change({ enabled: true, adapter: undefined }); await expect(f.gate.capture()).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    expect(body).not.toHaveBeenCalled();
    phase('restart', 'assertions-complete');
  });
});
