import { afterAll, afterEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { memoryHeadInvalidationRuns as runs } from '../../../src/database/schema/memoryHeadInvalidationRuns.js';
import { closeTestDb, getTestAdminDb, getTestDb } from './test-db-helpers.js';

const ownedIds: string[] = [];
function receipt(overrides: Partial<typeof runs.$inferInsert> = {}): typeof runs.$inferInsert {
  const runId = randomUUID(); ownedIds.push(runId);
  return { runId, formatVersion: 1, claim: 'historical-exact-owner-set-invalidation',
    requestSha256: 'a'.repeat(64), catalogSha256: 'b'.repeat(64), preManifestSha256: 'c'.repeat(64),
    postManifestSha256: 'd'.repeat(64), maintenanceEvidenceSha256: 'e'.repeat(64), candidateCommit: 'f'.repeat(40),
    maintenanceEvidenceId: 'declared-window', declaredContextId: 'unverified-fixture-context',
    databaseName: 'fixture-db', effectiveRole: 'fixture-operator', databaseOid: 1, serverVersionNum: 170000,
    ownerCount: 0, tagCount: 0, startedAt: new Date('2026-10-01T00:00:00Z'),
    finishedAt: new Date('2026-10-01T00:00:00Z'), canApply: false, canActivate: false, ...overrides };
}
afterEach(async () => {
  for (const id of ownedIds.splice(0)) await getTestAdminDb().delete(runs).where(eq(runs.runId, id));
});
afterAll(closeTestDb);

// Required real-PG suite: no availability skip or fallback database.
describe('dormant historical memory invalidation receipt schema', () => {
  it('installs an empty operator table with FORCE RLS, no policies, foreign keys or owner payload columns', async () => {
    const [table] = await getTestAdminDb().execute(sql`SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE oid='public.memory_head_invalidation_runs'::regclass`);
    expect(table).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await getTestAdminDb().execute(sql`SELECT 1 FROM pg_policy WHERE polrelid='public.memory_head_invalidation_runs'::regclass`)).toHaveLength(0);
    expect(await getTestAdminDb().execute(sql`SELECT 1 FROM pg_constraint WHERE conrelid='public.memory_head_invalidation_runs'::regclass AND contype='f'`)).toHaveLength(0);
    const columns = await getTestAdminDb().execute(sql`SELECT column_name,is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='memory_head_invalidation_runs'`);
    expect(columns).toHaveLength(21);
    expect(columns.every(row => row.is_nullable === 'NO' && !['owner_id', 'user_id', 'raw_content', 'owners'].includes(String(row.column_name)))).toBe(true);
    expect(await getTestAdminDb().select().from(runs)).toHaveLength(0);
  });
  it('round-trips empty and cap-bound historical attribution without authority', async () => {
    for (const values of [receipt(), receipt({ ownerCount: 10000, tagCount: 100000, databaseOid: 4294967295,
      maintenanceEvidenceId: 'é'.repeat(64), declaredContextId: 'x'.repeat(128), databaseName: 'x'.repeat(63), effectiveRole: 'x'.repeat(63) })]) {
      const [stored] = await getTestAdminDb().insert(runs).values(values).returning();
      expect(stored).toEqual(values);
    }
  });
  it.each([
    { formatVersion: 2 }, { claim: 'current-coverage' }, { canApply: true }, { canActivate: true },
    { requestSha256: 'A'.repeat(64) }, { catalogSha256: 'a'.repeat(63) }, { preManifestSha256: 'g'.repeat(64) },
    { postManifestSha256: '' }, { maintenanceEvidenceSha256: 'a'.repeat(65) }, { candidateCommit: 'a'.repeat(39) },
    { candidateCommit: '0'.repeat(40) },
    { maintenanceEvidenceId: '' }, { maintenanceEvidenceId: 'é'.repeat(65) }, { declaredContextId: 'x'.repeat(129) },
    { databaseName: '' }, { databaseName: 'é'.repeat(32) }, { effectiveRole: 'x'.repeat(64) },
    { databaseOid: -1 }, { databaseOid: 0 }, { databaseOid: 4294967296 }, { serverVersionNum: 0 },
    { ownerCount: -1 }, { ownerCount: 10001 }, { tagCount: -1 }, { tagCount: 100001 },
    { finishedAt: new Date('2026-09-30T23:59:59Z') },
  ] as Partial<typeof runs.$inferInsert>[])('refuses out-of-contract receipt %j', async overrides => {
    await expect(getTestAdminDb().insert(runs).values(receipt(overrides))).rejects.toThrow();
    expect(await getTestAdminDb().select().from(runs)).toHaveLength(0);
  });
  it.each(['started_at', 'finished_at'])('refuses nonfinite %s at the database boundary', async field => {
    const values = receipt(); await getTestAdminDb().insert(runs).values(values);
    await expect(getTestAdminDb().execute(sql`UPDATE public.memory_head_invalidation_runs
      SET ${sql.identifier(field)}='infinity'::timestamptz WHERE run_id=${values.runId}::uuid`)).rejects.toThrow();
    expect(await getTestAdminDb().select().from(runs)).toEqual([values]);
  });
  it('refuses duplicate run IDs instead of rewriting historical bindings', async () => {
    const values = receipt(); await getTestAdminDb().insert(runs).values(values);
    await expect(getTestAdminDb().insert(runs).values({ ...values, ownerCount: 1 })).rejects.toThrow();
    expect(await getTestAdminDb().select().from(runs)).toEqual([values]);
  });
  it('denies app row access despite bootstrap DML grants and verifies whole-table ACL exclusions', async () => {
    const values = receipt(); await getTestAdminDb().insert(runs).values(values);
    const [proof] = await getTestDb().execute(sql`SELECT r.rolsuper, r.rolbypassrls,
      pg_get_userbyid(c.relowner)=current_user AS owns_table,
      has_table_privilege(current_user,c.oid,'SELECT') AS can_select,
      has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,
      has_table_privilege(current_user,c.oid,'UPDATE') AS can_update,
      has_table_privilege(current_user,c.oid,'DELETE') AS can_delete,
      has_table_privilege(current_user,c.oid,'TRUNCATE') AS has_truncate,
      has_table_privilege(current_user,c.oid,'REFERENCES') AS has_references
      FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user
      AND c.oid='public.memory_head_invalidation_runs'::regclass`);
    expect(proof).toEqual({ rolsuper: false, rolbypassrls: false, owns_table: false,
      can_select: true, can_insert: true, can_update: true, can_delete: true, has_truncate: false, has_references: false });
    expect(await getTestDb().select().from(runs)).toHaveLength(0);
    await expect(getTestDb().insert(runs).values(receipt())).rejects.toThrow();
    expect(await getTestDb().update(runs).set({ ownerCount: 1 }).returning()).toHaveLength(0);
    expect(await getTestDb().delete(runs).returning()).toHaveLength(0);
    expect(await getTestAdminDb().select().from(runs)).toEqual([values]);
  });
});
