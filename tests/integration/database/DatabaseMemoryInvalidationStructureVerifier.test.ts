import { afterAll, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import { verifyDatabaseMemoryInvalidationStructure as verify } from '../../../src/storage/DatabaseMemoryInvalidationStructureVerifier.js';
import { closeTestDb, getTestAdminDb, getTestDb } from './test-db-helpers.js';

afterAll(closeTestDb);
async function rolledBack(check: (tx: DrizzleTx) => Promise<void>): Promise<void> {
  const rollback = new Error('owned structural fixture rollback');
  try {
    await getTestAdminDb().transaction(async tx => { await check(tx); throw rollback; });
  } catch (error) { if (error !== rollback) throw error; }
  expect(await getTestAdminDb().transaction(tx => verify(tx))).toMatchObject({ status: 'verified' });
}
// Required PG17 CI suite: no availability skips, default local execution or
// pg_catalog mutation. Each legal DDL fixture is transactionally rolled back.
describe('live partial PG17 memory invalidation structure proof', () => {
  it('verifies actual migrations with an ordinary role in READ ONLY mode', async () => {
    const result = await getTestDb().transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      const [role] = await tx.execute(sql`SELECT rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user`);
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
      const [mode] = await tx.execute(sql`SHOW transaction_read_only`);
      expect(mode).toMatchObject({ transaction_read_only: 'on' });
      return verify(tx);
    });
    expect(result).toMatchObject({ status: 'verified', reason: null, canBackfill: false, canApply: false, canActivate: false,
      provesCompleteCatalog: false, provesExecutionResolution: false });
    expect(result).toEqual(await getTestAdminDb().transaction(tx => verify(tx)));
  });
  it.each(['elements', 'element_tags', 'memory_entries', 'users'])('rejects %s as an inheritance parent', async table => {
    await rolledBack(async tx => {
      await tx.execute(sql.raw(`CREATE TABLE public.structural_child_fixture () INHERITS (public.${table})`));
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it.each(['elements', 'element_tags', 'memory_entries', 'users'])('rejects %s as an inheritance child', async table => {
    await rolledBack(async tx => {
      await tx.execute(sql`CREATE TABLE public.structural_parent_fixture ()`);
      await tx.execute(sql.raw(`ALTER TABLE public.${table} INHERIT public.structural_parent_fixture`));
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it.each([
    'ALTER TABLE public.elements ALTER COLUMN raw_content DROP NOT NULL',
    'ALTER TABLE public.elements ALTER COLUMN raw_content TYPE varchar(100000)',
    'ALTER TABLE public.elements ALTER COLUMN raw_content TYPE text COLLATE "C"',
    'ALTER TABLE public.elements ALTER COLUMN element_type TYPE varchar(32) COLLATE "C"',
    'ALTER TABLE public.elements ALTER COLUMN visibility TYPE varchar(32) COLLATE "C"',
    'ALTER TABLE public.element_tags ALTER COLUMN tag TYPE varchar(128) COLLATE "C"',
    'ALTER TABLE public.elements ALTER COLUMN storage_revision SET DEFAULT 2',
    'ALTER TABLE public.elements ALTER COLUMN memory_entries_out_of_sync SET DEFAULT false',
    'ALTER TABLE public.elements ALTER COLUMN storage_revision DROP DEFAULT',
    'ALTER TABLE public.elements DROP CONSTRAINT elements_storage_revision_positive',
  ])('refuses isolated required column/default/check drift: %s', async statement => {
    await rolledBack(async tx => {
      await tx.execute(sql.raw(statement));
      expect(await verify(tx)).toMatchObject({ status: 'refused', descriptorSha256: null });
    });
  });
  it('rejects a same-spelling text domain rather than trusting rendered type names', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql`CREATE DOMAIN pg_temp.text AS pg_catalog.text`);
      await tx.execute(sql`ALTER TABLE public.elements ALTER COLUMN raw_content TYPE pg_temp.text`);
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it.each([
    'PRIMARY KEY(tag,element_id)',
    'PRIMARY KEY(element_id,tag) DEFERRABLE INITIALLY IMMEDIATE',
    'PRIMARY KEY(element_id,tag) INCLUDE(user_id)',
  ])('rejects tag PK drift with all required FKs still present: %s', async definition => {
    await rolledBack(async tx => {
      await tx.execute(sql`ALTER TABLE public.element_tags DROP CONSTRAINT element_tags_element_id_tag_pk`);
      await tx.execute(sql.raw(`ALTER TABLE public.element_tags ADD CONSTRAINT element_tags_element_id_tag_pk ${definition}`));
      const [count] = await tx.execute(sql`SELECT count(*)::integer AS count FROM pg_catalog.pg_constraint c
        WHERE c.conrelid='public.element_tags'::regclass AND c.contype='f'`);
      expect(count.count).toBe(2);
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it.each([
    'REFERENCES public.users(id) ON DELETE RESTRICT',
    'REFERENCES public.users(id) ON DELETE CASCADE DEFERRABLE',
    'REFERENCES public.users(id) ON DELETE CASCADE NOT VALID',
    // Combined target/validation drift avoids inspecting unrelated populated
    // tag rows. The unit case independently changes only reference identity.
    'REFERENCES public.elements(id) ON DELETE CASCADE NOT VALID',
  ])('rejects isolated tag tenant FK drift: %s', async definition => {
    await rolledBack(async tx => {
      await tx.execute(sql`ALTER TABLE public.element_tags DROP CONSTRAINT element_tags_user_id_users_id_fk`);
      await tx.execute(sql.raw(`ALTER TABLE public.element_tags ADD CONSTRAINT element_tags_user_id_users_id_fk FOREIGN KEY(user_id) ${definition}`));
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it('refuses extra required-table FK inventory instead of silently truncating observation', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql`ALTER TABLE public.element_tags ADD CONSTRAINT structural_extra_fk FOREIGN KEY(user_id) REFERENCES public.users(id)`);
      expect(await verify(tx)).toMatchObject({ reason: 'incomplete_observation' });
    });
  });
  it.each(['CHECK(storage_revision >= 0)', 'CHECK(storage_revision > 0) NOT VALID'])('rejects revision check drift: %s', async definition => {
    await rolledBack(async tx => {
      await tx.execute(sql`ALTER TABLE public.elements DROP CONSTRAINT elements_storage_revision_positive`);
      await tx.execute(sql.raw(`ALTER TABLE public.elements ADD CONSTRAINT elements_storage_revision_positive ${definition}`));
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it('retains oversized check presence but refuses its guarded projection', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql`ALTER TABLE public.elements DROP CONSTRAINT elements_storage_revision_positive`);
      await tx.execute(sql.raw(`ALTER TABLE public.elements ADD CONSTRAINT elements_storage_revision_positive CHECK(storage_revision > 0 AND length('${'x'.repeat(1025)}') > 0)`));
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch' });
    });
  });
  it('rejects a same-spelling custom greater-than operator despite identical deparse', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql`CREATE SCHEMA structural_operator_fixture`);
      await tx.execute(sql`CREATE FUNCTION structural_operator_fixture.always_true(bigint,integer)
        RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'`);
      await tx.execute(sql`CREATE OPERATOR structural_operator_fixture.> (LEFTARG=bigint, RIGHTARG=integer,
        FUNCTION=structural_operator_fixture.always_true)`);
      await tx.execute(sql`SET LOCAL search_path=structural_operator_fixture,pg_catalog,public`);
      await tx.execute(sql`ALTER TABLE public.elements DROP CONSTRAINT elements_storage_revision_positive`);
      await tx.execute(sql`ALTER TABLE public.elements ADD CONSTRAINT elements_storage_revision_positive CHECK(storage_revision > 0)`);
      const [actual] = await tx.execute(sql`SELECT pg_catalog.pg_get_expr(c.conbin,c.conrelid) AS expression,
        EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_constraint'::pg_catalog.regclass
          AND d.objid=c.oid AND d.objsubid=0 AND d.refclassid='pg_catalog.pg_operator'::pg_catalog.regclass) AS custom_dependency,
        c.convalidated AS validated FROM pg_catalog.pg_constraint c
        WHERE c.conrelid='public.elements'::pg_catalog.regclass AND c.conname='elements_storage_revision_positive'`);
      expect(actual).toEqual({ expression: '(storage_revision > 0)', custom_dependency: true, validated: true });
      // The first-head unit negative control proves the prior literal-only
      // matcher accepted this otherwise unchanged CHECK descriptor.
      expect(await verify(tx)).toMatchObject({ reason: 'contract_mismatch', descriptorSha256: null });
    });
  });
  it('does not claim unrelated columns/indexes/receipt checks or effective temp resolution', async () => {
    await rolledBack(async tx => {
      const original = await verify(tx);
      await tx.execute(sql`ALTER TABLE public.elements ADD COLUMN structural_unrelated integer`);
      await tx.execute(sql`CREATE INDEX structural_unrelated_index ON public.elements(structural_unrelated)`);
      await tx.execute(sql`CREATE TEMP TABLE elements (id uuid)`);
      await tx.execute(sql`ALTER TABLE public.memory_head_invalidation_runs ADD COLUMN structural_unrelated integer`);
      expect(await verify(tx)).toEqual(original);
    });
  });
});
