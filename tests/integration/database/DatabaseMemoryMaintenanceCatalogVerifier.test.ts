import { afterAll, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import { verifyDatabaseMemoryMaintenanceCatalog as verify, observeDatabaseMemoryMaintenanceCatalog as compose } from '../../../src/storage/DatabaseMemoryMaintenanceCatalogVerifier.js';
import { closeTestDb, getTestAdminDb, getTestDb } from './test-db-helpers.js';

afterAll(closeTestDb);
async function rolledBack(check: (tx: DrizzleTx) => Promise<void>): Promise<void> {
  const rollback = new Error('owned maintenance catalog fixture rollback');
  try {
    await getTestAdminDb().transaction(async tx => { await check(tx); throw rollback; });
  } catch (error) { if (error !== rollback) throw error; }
  expect(await getTestAdminDb().transaction(tx => verify(tx))).toMatchObject({ status: 'verified' });
}
// Required existing PG17 CI harness only. No availability skips, fixture roles,
// grants, pg_catalog edits, unrelated row deletion or committed DDL.
describe('live dormant maintenance catalog observations', () => {
  it('qualifies existing ordinary-role permissions and READ ONLY observations', async () => {
    const result = await getTestDb().transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      const [role] = await tx.execute(sql`SELECT rolsuper,rolbypassrls,
        pg_catalog.has_schema_privilege(current_user,'drizzle','USAGE') AS usage,
        pg_catalog.has_table_privilege(current_user,'drizzle.__drizzle_migrations','SELECT') AS readable
        FROM pg_catalog.pg_roles WHERE rolname=current_user`);
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false, usage: true, readable: true });
      const [mode] = await tx.execute(sql`SHOW transaction_read_only`);
      expect(mode).toMatchObject({ transaction_read_only: 'on' });
      return verify(tx);
    });
    expect(result).toMatchObject({ status: 'verified', canBackfill: false, canApply: false, canActivate: false,
      provesCoherentSnapshot: false, provesCompleteCatalog: false, provesExecutionResolution: false });
    expect(result).toEqual(await getTestAdminDb().transaction(tx => verify(tx)));
  });
  it('composes actual observations without claiming isolation or authority', async () => {
    const result = await getTestDb().transaction(async tx => { await tx.execute(sql`SET TRANSACTION READ ONLY`); return compose(tx); });
    expect(result).toMatchObject({ status: 'verified', scope: 'memory-maintenance-composed-observations',
      provesCoherentSnapshot: false, canBackfill: false, canApply: false, canActivate: false });
  });
  it.each([
    'ALTER TABLE public.memory_head_invalidation_runs ALTER COLUMN claim DROP NOT NULL',
    'ALTER TABLE public.memory_head_invalidation_runs ALTER COLUMN claim SET DEFAULT \'fixture\'',
    'ALTER TABLE public.memory_head_invalidation_runs ALTER COLUMN claim TYPE text COLLATE "C"',
    'ALTER TABLE public.memory_head_invalidation_runs ADD COLUMN fixture_extra text',
    'ALTER TABLE public.memory_head_invalidation_runs DROP CONSTRAINT memory_head_invalidation_runs_times_check',
    'CREATE INDEX maintenance_fixture_extra ON public.memory_head_invalidation_runs(run_id)',
    'CREATE RULE maintenance_fixture_rule AS ON INSERT TO public.memory_head_invalidation_runs DO INSTEAD NOTHING',
    'CREATE TRIGGER maintenance_fixture_trigger BEFORE INSERT ON public.memory_head_invalidation_runs FOR EACH STATEMENT EXECUTE FUNCTION pg_catalog.suppress_redundant_updates_trigger()',
    'CREATE POLICY maintenance_fixture_policy ON public.memory_head_invalidation_runs USING (true)',
    'ALTER TABLE public.memory_head_invalidation_runs NO FORCE ROW LEVEL SECURITY',
    'ALTER TABLE public.elements DISABLE ROW LEVEL SECURITY',
    'ALTER TABLE public.element_tags NO FORCE ROW LEVEL SECURITY',
    'ALTER TABLE public.memory_entries NO FORCE ROW LEVEL SECURITY',
    'ALTER POLICY elements_select ON public.elements USING (true)',
    'ALTER POLICY elements_insert ON public.elements WITH CHECK (true)',
    'ALTER POLICY elements_update ON public.elements TO CURRENT_USER',
    'CREATE POLICY maintenance_fixture_extra ON public.element_tags USING (true)',
    'UPDATE drizzle.__drizzle_migrations SET hash=repeat(\'a\',64) WHERE created_at=1790553601000',
    'UPDATE drizzle.__drizzle_migrations SET created_at=1 WHERE created_at=1790553601000',
    'INSERT INTO drizzle.__drizzle_migrations(hash,created_at) SELECT hash,created_at FROM drizzle.__drizzle_migrations WHERE created_at=1790553601000',
  ])('refuses legal rollback-owned catalog drift: %s', async statement => {
    await rolledBack(async tx => {
      await tx.execute(sql.raw(statement));
      expect(await verify(tx)).toMatchObject({ status: 'refused', descriptorSha256: null });
    });
  });
  it('refuses a restrictive policy even with the original expression', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql`DROP POLICY elements_delete ON public.elements`);
      await tx.execute(sql`CREATE POLICY elements_delete ON public.elements AS RESTRICTIVE FOR DELETE
        USING (user_id=current_setting('app.current_user_id',true)::uuid)`);
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it('refuses a policy command change with the original owner expression', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql`DROP POLICY elements_delete ON public.elements`);
      await tx.execute(sql`CREATE POLICY elements_delete ON public.elements FOR SELECT
        USING (user_id=current_setting('app.current_user_id',true)::uuid)`);
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it.each(['NOT VALID', 'NO INHERIT'])('refuses receipt CHECK flag drift: %s', async modifier => {
    await rolledBack(async tx => {
      await tx.execute(sql`ALTER TABLE public.memory_head_invalidation_runs DROP CONSTRAINT memory_head_invalidation_runs_run_id_check`);
      await tx.execute(sql.raw(`ALTER TABLE public.memory_head_invalidation_runs ADD CONSTRAINT memory_head_invalidation_runs_run_id_check
        CHECK(run_id <> '00000000-0000-0000-0000-000000000000'::uuid) ${modifier}`));
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it('refuses a deferred receipt primary key without deleting historical rows', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql`ALTER TABLE public.memory_head_invalidation_runs DROP CONSTRAINT memory_head_invalidation_runs_pkey`);
      await tx.execute(sql`ALTER TABLE public.memory_head_invalidation_runs ADD CONSTRAINT memory_head_invalidation_runs_pkey
        PRIMARY KEY(run_id) DEFERRABLE INITIALLY IMMEDIATE`);
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it('refuses a matching ledger hash with a null declaration timestamp', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql`UPDATE drizzle.__drizzle_migrations SET created_at=NULL WHERE created_at=1790553601000`);
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  // The fixture-first path also changes rendering of other builtin calls;
  // this is combined expression/dependency drift, not an isolated cause proof.
  // The unit case isolates unsafe dependency, and the receipt operator below
  // supplies independent live CHECK dependency coverage.
  it('refuses combined same-deparse custom current_setting dependency drift', async () => {
    await rolledBack(async tx => {
      const [before] = await tx.execute(sql`SELECT pg_catalog.pg_get_expr(polqual,polrelid) AS expression
        FROM pg_catalog.pg_policy WHERE polrelid='public.elements'::pg_catalog.regclass AND polname='elements_delete'`);
      await tx.execute(sql`CREATE SCHEMA maintenance_fixture`);
      await tx.execute(sql`CREATE FUNCTION maintenance_fixture.current_setting(text,boolean) RETURNS text LANGUAGE sql AS 'SELECT NULL::text'`);
      await tx.execute(sql`SET LOCAL search_path=maintenance_fixture,public,pg_catalog`);
      await tx.execute(sql`ALTER POLICY elements_delete ON public.elements USING (user_id=current_setting('app.current_user_id',true)::uuid)`);
      const [after] = await tx.execute(sql`SELECT pg_catalog.pg_get_expr(p.polqual,p.polrelid) AS expression,
        EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_policy'::pg_catalog.regclass
          AND d.objid=p.oid AND d.refclassid='pg_catalog.pg_proc'::pg_catalog.regclass) AS custom
        FROM pg_catalog.pg_policy p WHERE p.polrelid='public.elements'::pg_catalog.regclass AND p.polname='elements_delete'`);
      expect(after).toMatchObject({ expression: before.expression, custom: true });
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it('refuses a same-deparse receipt CHECK using a custom UUID inequality', async () => {
    await rolledBack(async tx => {
      const [before] = await tx.execute(sql`SELECT pg_catalog.pg_get_expr(conbin,conrelid) AS expression
        FROM pg_catalog.pg_constraint WHERE conrelid='public.memory_head_invalidation_runs'::pg_catalog.regclass
        AND conname='memory_head_invalidation_runs_run_id_check'`);
      await tx.execute(sql`CREATE SCHEMA maintenance_fixture`);
      await tx.execute(sql`CREATE FUNCTION maintenance_fixture.uuid_ne(uuid,uuid) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'`);
      await tx.execute(sql`CREATE OPERATOR maintenance_fixture.<> (LEFTARG=uuid,RIGHTARG=uuid,FUNCTION=maintenance_fixture.uuid_ne)`);
      await tx.execute(sql`SET LOCAL search_path=maintenance_fixture,public,pg_catalog`);
      await tx.execute(sql`ALTER TABLE public.memory_head_invalidation_runs DROP CONSTRAINT memory_head_invalidation_runs_run_id_check`);
      await tx.execute(sql`ALTER TABLE public.memory_head_invalidation_runs ADD CONSTRAINT memory_head_invalidation_runs_run_id_check
        CHECK(run_id <> '00000000-0000-0000-0000-000000000000'::uuid)`);
      const [after] = await tx.execute(sql`SELECT pg_catalog.pg_get_expr(c.conbin,c.conrelid) AS expression,c.convalidated,
        EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_constraint'::pg_catalog.regclass
          AND d.objid=c.oid AND d.refclassid='pg_catalog.pg_operator'::pg_catalog.regclass) AS custom
        FROM pg_catalog.pg_constraint c WHERE c.conrelid='public.memory_head_invalidation_runs'::pg_catalog.regclass
        AND c.conname='memory_head_invalidation_runs_run_id_check'`);
      expect(after).toMatchObject({ expression: before.expression, convalidated: true, custom: true });
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it('refuses same-deparse tag subquery bound to a foreign elements relation', async () => {
    await rolledBack(async tx => {
      const [before] = await tx.execute(sql`SELECT pg_catalog.pg_get_expr(polqual,polrelid) AS expression
        FROM pg_catalog.pg_policy WHERE polrelid='public.element_tags'::pg_catalog.regclass AND polname='element_tags_select'`);
      await tx.execute(sql`CREATE SCHEMA maintenance_fixture`);
      await tx.execute(sql`CREATE TABLE maintenance_fixture.elements(id uuid,visibility varchar(32))`);
      await tx.execute(sql`SET LOCAL search_path=maintenance_fixture,public,pg_catalog`);
      await tx.execute(sql`ALTER POLICY element_tags_select ON public.element_tags USING (
        user_id=current_setting('app.current_user_id',true)::uuid OR EXISTS (
          SELECT 1 FROM elements WHERE elements.id=element_tags.element_id AND elements.visibility='public'))`);
      const [after] = await tx.execute(sql`SELECT pg_catalog.pg_get_expr(p.polqual,p.polrelid) AS expression,
        EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_policy'::pg_catalog.regclass
          AND d.objid=p.oid AND d.refclassid='pg_catalog.pg_class'::pg_catalog.regclass
          AND d.refobjid='maintenance_fixture.elements'::pg_catalog.regclass) AS foreign_relation
        FROM pg_catalog.pg_policy p WHERE p.polrelid='public.element_tags'::pg_catalog.regclass AND p.polname='element_tags_select'`);
      expect(after).toMatchObject({ expression: before.expression, foreign_relation: true });
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
});
