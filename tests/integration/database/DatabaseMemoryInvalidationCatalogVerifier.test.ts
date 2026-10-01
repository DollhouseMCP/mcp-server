import { afterAll, describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import { verifyDatabaseMemoryInvalidationCatalog as verify } from '../../../src/storage/DatabaseMemoryInvalidationCatalogVerifier.js';
import { closeTestDb, getTestAdminDb, getTestDb } from './test-db-helpers.js';

afterAll(closeTestDb);
async function rolledBack(check: (tx: DrizzleTx) => Promise<void>): Promise<void> {
  const rollback = new Error('owned catalog fixture rollback');
  try {
    await getTestAdminDb().transaction(async tx => { await check(tx); throw rollback; });
  } catch (error) { if (error !== rollback) throw error; }
}
const migration = readFileSync(new URL('../../../src/database/migrations/0056_memory_head_revision.sql', import.meta.url), 'utf8');
const markBody = migration.match(/CREATE FUNCTION mark_memory_head_out_of_sync\([^;]*?AS \$\$([\s\S]*?)\$\$;/u)?.[1];
if (markBody === undefined) throw new Error('Missing exact reviewed mark-owner fixture body');
const quotedBody = `'${markBody.replaceAll("'", "''")}'`;

// Required real-PG suite; no availability skip or fallback database.
describe('live partial PG17 memory invalidation function/trigger proof', () => {
  it('verifies the actual migration chain and accepts ordinary-role catalog visibility', async () => {
    const admin = await getTestAdminDb().transaction(tx => verify(tx));
    const ordinary = await getTestDb().transaction(tx => verify(tx));
    expect(admin).toMatchObject({ status: 'verified', reason: null, canBackfill: false, canApply: false,
      canActivate: false, provesExecutionResolution: false });
    expect(ordinary).toEqual(admin);
    const [role] = await getTestDb().execute(sql`SELECT rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user`);
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });
  it.each([
    'ALTER FUNCTION public.bump_element_storage_revision() SECURITY DEFINER',
    'ALTER FUNCTION public.bump_element_storage_revision() STRICT',
    "ALTER FUNCTION public.bump_element_storage_revision() SET search_path='public'",
    'ALTER FUNCTION public.bump_element_storage_revision() STABLE',
    'ALTER FUNCTION public.bump_element_storage_revision() PARALLEL SAFE',
    'ALTER FUNCTION public.bump_element_storage_revision() LEAKPROOF',
    'ALTER FUNCTION public.mark_memory_head_out_of_sync(uuid,uuid) SUPPORT pg_catalog.textlike_support',
    'ALTER TABLE public.elements DISABLE TRIGGER elements_storage_revision_update',
    'DROP TRIGGER element_tags_memory_head_revision_change ON public.element_tags',
    'CREATE TRIGGER unexpected_catalog_probe BEFORE UPDATE ON public.elements FOR EACH ROW EXECUTE FUNCTION public.bump_element_storage_revision()',
    'DROP TABLE public.memory_entries',
    'DROP FUNCTION public.invalidate_memory_tag_owner(uuid,uuid,boolean)',
    "CREATE FUNCTION public.mark_memory_head_out_of_sync(integer,integer) RETURNS boolean LANGUAGE sql AS 'SELECT true'",
  ])('refuses actual catalog drift: %s', async statement => {
    await rolledBack(async tx => {
      await tx.execute(sql.raw(statement));
      const result = await verify(tx);
      expect(result.status).toBe('refused'); expect(result.descriptorSha256).toBeNull();
      expect(result.canApply).toBe(false); expect(result.canActivate).toBe(false);
    });
  });
  it('rejects body-byte drift without any trigger change', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql.raw(`CREATE OR REPLACE FUNCTION public.mark_memory_head_out_of_sync(p_memory_id UUID,p_user_id UUID)
        RETURNS BOOLEAN LANGUAGE plpgsql AS '${(markBody + '\n-- changed').replaceAll("'", "''")}'`));
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it('rejects defaults while the argument types/body/attachment remain unchanged', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql.raw(`CREATE OR REPLACE FUNCTION public.mark_memory_head_out_of_sync(p_memory_id UUID,p_user_id UUID DEFAULT NULL)
        RETURNS BOOLEAN LANGUAGE plpgsql AS ${quotedBody}`));
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it('rejects a set-returning replacement of the same named helper', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql`DROP FUNCTION public.mark_memory_head_out_of_sync(uuid,uuid)`);
      await tx.execute(sql`CREATE FUNCTION public.mark_memory_head_out_of_sync(p_memory_id UUID,p_user_id UUID)
        RETURNS SETOF BOOLEAN LANGUAGE plpgsql AS 'BEGIN RETURN NEXT true; END;'`);
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it('rejects a same-spelling type in another namespace rather than trusting rendered names', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql`CREATE DOMAIN pg_temp.uuid AS pg_catalog.uuid`);
      await tx.execute(sql`DROP FUNCTION public.mark_memory_head_out_of_sync(pg_catalog.uuid,pg_catalog.uuid)`);
      await tx.execute(sql`CREATE FUNCTION public.mark_memory_head_out_of_sync(p_memory_id pg_temp.uuid,p_user_id pg_temp.uuid)
        RETURNS BOOLEAN LANGUAGE plpgsql AS 'BEGIN RETURN true; END;'`);
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it('retains oversized function presence but refuses its guarded body projection', async () => {
    await rolledBack(async tx => {
      const oversized = 'BEGIN RETURN true; END;\n--' + 'x'.repeat(16384);
      await tx.execute(sql.raw(`CREATE OR REPLACE FUNCTION public.mark_memory_head_out_of_sync(p_memory_id UUID,p_user_id UUID)
        RETURNS BOOLEAN LANGUAGE plpgsql AS '${oversized}'`));
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch', descriptorSha256: null });
    });
  });
  it.each([
    'BEFORE UPDATE OF raw_content ON public.elements FOR EACH ROW EXECUTE FUNCTION public.bump_element_storage_revision()',
    'BEFORE UPDATE ON public.elements FOR EACH ROW WHEN (OLD.raw_content IS DISTINCT FROM NEW.raw_content) EXECUTE FUNCTION public.bump_element_storage_revision()',
    "BEFORE UPDATE ON public.elements FOR EACH ROW EXECUTE FUNCTION public.bump_element_storage_revision('extra')",
    'AFTER UPDATE ON public.elements FOR EACH ROW EXECUTE FUNCTION public.bump_element_storage_revision()',
    'BEFORE UPDATE ON public.elements FOR EACH ROW EXECUTE FUNCTION public.bump_memory_tag_head_revision()',
  ])('rejects attachment semantics drift: %s', async definition => {
    await rolledBack(async tx => {
      await tx.execute(sql`DROP TRIGGER elements_storage_revision_update ON public.elements`);
      await tx.execute(sql.raw(`CREATE TRIGGER elements_storage_revision_update ${definition}`));
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it('leaves execution resolution unproved even with a temp relation shadow', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql`CREATE TEMP TABLE elements (id uuid)`);
      expect(await verify(tx)).toMatchObject({ status: 'verified', provesExecutionResolution: false, canApply: false });
    });
  });
});
