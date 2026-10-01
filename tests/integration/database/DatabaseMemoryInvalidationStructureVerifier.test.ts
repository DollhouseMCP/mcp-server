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
    'ALTER TABLE public.elements ALTER COLUMN raw_content TYPE varchar',
    'ALTER TABLE public.elements ALTER COLUMN raw_content TYPE text COLLATE "C"',
    'ALTER TABLE public.elements ALTER COLUMN element_type TYPE varchar(32) COLLATE "C"',
    'ALTER TABLE public.elements ALTER COLUMN visibility DROP NOT NULL',
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
  it('rejects custom selected UUID-index/FK equality while preserving all eight subject keys', async () => {
    await rolledBack(async tx => {
      await tx.execute(sql`CREATE SCHEMA structural_fk_fixture`);
      await tx.execute(sql`CREATE FUNCTION structural_fk_fixture.always_true(uuid,uuid)
        RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'`);
      await tx.execute(sql`CREATE OPERATOR structural_fk_fixture.= (LEFTARG=uuid, RIGHTARG=uuid,
        FUNCTION=structural_fk_fixture.always_true)`);
      await tx.execute(sql`CREATE OPERATOR CLASS structural_fk_fixture.custom_uuid_ops FOR TYPE uuid USING btree AS
        OPERATOR 1 pg_catalog.< (uuid,uuid), OPERATOR 2 pg_catalog.<= (uuid,uuid),
        OPERATOR 3 structural_fk_fixture.= (uuid,uuid), OPERATOR 4 pg_catalog.>= (uuid,uuid),
        OPERATOR 5 pg_catalog.> (uuid,uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid,uuid)`);
      // No rows are deleted. CASCADE removes user FKs transactionally; restore
      // all three required user FKs before testing. Subject PKs are untouched.
      await tx.execute(sql`ALTER TABLE public.users DROP CONSTRAINT users_pkey CASCADE`);
      await tx.execute(sql`CREATE UNIQUE INDEX structural_fk_selected_index ON public.users (id structural_fk_fixture.custom_uuid_ops)`);
      await tx.execute(sql`ALTER TABLE public.elements ADD CONSTRAINT elements_user_id_users_id_fk
        FOREIGN KEY(user_id) REFERENCES public.users(id) ON DELETE CASCADE ON UPDATE NO ACTION`);
      await tx.execute(sql`ALTER TABLE public.element_tags ADD CONSTRAINT element_tags_user_id_users_id_fk
        FOREIGN KEY(user_id) REFERENCES public.users(id) ON DELETE CASCADE ON UPDATE NO ACTION`);
      await tx.execute(sql`ALTER TABLE public.memory_entries ADD CONSTRAINT memory_entries_user_id_users_id_fk
        FOREIGN KEY(user_id) REFERENCES public.users(id) ON DELETE CASCADE ON UPDATE NO ACTION`);
      const [inventory] = await tx.execute(sql`SELECT count(*)::integer AS total,
        count(*) FILTER (WHERE c.contype='p')::integer AS primary_keys,
        count(*) FILTER (WHERE c.contype='f')::integer AS foreign_keys FROM pg_catalog.pg_constraint c
        WHERE c.conrelid IN ('public.elements'::regclass,'public.element_tags'::regclass,'public.memory_entries'::regclass)
          AND c.contype IN ('p','f')`);
      expect(inventory).toEqual({ total: 8, primary_keys: 3, foreign_keys: 5 });
      const [actual] = await tx.execute(sql`SELECT i.indexrelid='public.structural_fk_selected_index'::regclass AS selected_index,
        c.conpfeqop=ARRAY[o.oid] AND c.conppeqop=ARRAY[o.oid] AND c.conffeqop=ARRAY[o.oid] AS custom_equality,
        c.convalidated AS validated FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_index i ON i.indexrelid=c.conindid
        JOIN pg_catalog.pg_operator o ON o.oid=c.conpfeqop[1] JOIN pg_catalog.pg_namespace n ON n.oid=o.oprnamespace
        WHERE c.conrelid='public.element_tags'::regclass AND c.conname='element_tags_user_id_users_id_fk'
          AND n.nspname='structural_fk_fixture' AND o.oprname='='`);
      expect(actual).toEqual({ selected_index: true, custom_equality: true, validated: true });
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

describe('actual FK internal trigger enforcement state', () => {
  it.each([['child', 'DISABLE'], ['parent', 'ENABLE REPLICA']])('refuses %s trigger mode while retaining the FK/index', async (side, action) => {
    await rolledBack(async tx => {
      const [trigger] = await tx.execute(sql`SELECT t.tgname,r.relname,c.conindid::text AS index_oid
        FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_trigger t ON t.tgconstraint=c.oid
        JOIN pg_catalog.pg_class r ON r.oid=t.tgrelid
        WHERE c.conname='element_tags_user_id_users_id_fk' AND c.conrelid='public.element_tags'::pg_catalog.regclass
          AND t.tgrelid=CASE WHEN ${side}='child' THEN c.conrelid ELSE c.confrelid END
        ORDER BY t.tgtype LIMIT 1`);
      expect(trigger).toBeDefined();
      await tx.execute(sql`ALTER TABLE public.${sql.identifier(String(trigger.relname))} ${sql.raw(action)} TRIGGER ${sql.identifier(String(trigger.tgname))}`);
      const [constraint] = await tx.execute(sql`SELECT convalidated,conindid::text AS index_oid FROM pg_catalog.pg_constraint WHERE conname='element_tags_user_id_users_id_fk' AND conrelid='public.element_tags'::pg_catalog.regclass`);
      expect(constraint).toMatchObject({ convalidated: true, index_oid: trigger.index_oid });
      expect(await verify(tx)).toMatchObject({ status: 'refused', reason: 'contract_mismatch' });
    });
  });
});
