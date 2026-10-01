import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import { verifyDatabaseMemoryInvalidationStructure as verify } from '../../../src/storage/DatabaseMemoryInvalidationStructureVerifier.js';

const columnSpecs: [string, string, string, number][] = [
  ['elements', 'id', 'uuid', -1], ['elements', 'user_id', 'uuid', -1], ['elements', 'raw_content', 'text', -1],
  ['elements', 'storage_revision', 'int8', -1], ['elements', 'memory_entries_out_of_sync', 'bool', -1],
  ['elements', 'updated_at', 'timestamptz', -1], ['elements', 'element_type', 'varchar', 36], ['elements', 'visibility', 'varchar', 36],
  ['element_tags', 'element_id', 'uuid', -1], ['element_tags', 'user_id', 'uuid', -1], ['element_tags', 'tag', 'varchar', 132],
  ['memory_entries', 'id', 'uuid', -1], ['memory_entries', 'user_id', 'uuid', -1], ['memory_entries', 'memory_id', 'uuid', -1], ['users', 'id', 'uuid', -1],
];
const keys = [['elements', 'elements_pkey', ['id']], ['element_tags', 'element_tags_element_id_tag_pk', ['element_id', 'tag']],
  ['memory_entries', 'memory_entries_pkey', ['id']]] as const;
const foreignKeys = [['elements', 'elements_user_id_users_id_fk', 'user_id', 'users'],
  ['element_tags', 'element_tags_element_id_elements_id_fk', 'element_id', 'elements'],
  ['element_tags', 'element_tags_user_id_users_id_fk', 'user_id', 'users'],
  ['memory_entries', 'memory_entries_memory_id_elements_id_fk', 'memory_id', 'elements'],
  ['memory_entries', 'memory_entries_user_id_users_id_fk', 'user_id', 'users']];
const flags = { validated: true, deferrable: false, deferred: false, local: true, inherited: 0, parent: '0' };
const equality = 'pg_catalog.=(pg_catalog.uuid,pg_catalog.uuid)->pg_catalog.uuid_eq';
const referenceIndex = (table: string) => ({ table, schema: 'public', key: 'id', binding: true,
  method: 'btree', opclass: 'pg_catalog.uuid_ops', defaultOpclass: true, unique: true, immediate: true,
  valid: true, ready: true, live: true, keyCount: 1, attributeCount: 1, predicateNull: true, expressionsNull: true,
  collation: null, collationResolved: true, option: 0 });
function observation() {
  return { version: 170010, inheritance: false,
    relations: ['elements', 'element_tags', 'memory_entries', 'users'].map((name, i) => ({ name, oid: String(i + 1), schema: 'public', kind: 'r', persistence: 'p', partition: false })),
    columns: columnSpecs.map(([table, name, type, typmod]) => ({ table, name, typeSchema: 'pg_catalog', type, typmod,
      notNull: true, generated: '', identity: '', dropped: false, collationResolved: true, collation: ['text', 'varchar'].includes(type) ? 'pg_catalog.default' : null })),
    constraints: [...keys.map(([table, name, keys]) => ({ table, name, keys, type: 'p', referenceIndex: null, equalityOperators: null, referenceBinding: true, referenceSchema: null, reference: null, referenceKeys: null,
      update: ' ', delete: ' ', match: ' ', ...flags })), ...foreignKeys.map(([table, name, key, reference]) => ({ table, name, keys: [key], type: 'f', referenceBinding: true,
      referenceIndex: referenceIndex(reference), equalityOperators: [equality, equality, equality],
      referenceSchema: 'public', reference, referenceKeys: ['id'], update: 'a', delete: 'c', match: 's', ...flags }))],
    indexes: keys.map(([table, name, keys]) => ({ table, name, schema: 'public', keys, method: 'btree', unique: true, primary: true, valid: true, ready: true,
      live: true, predicateNull: true, expressionsNull: true, keyCount: keys.length, attributeCount: keys.length, binding: true,
      opclasses: keys.map(name => name === 'tag' ? 'pg_catalog.text_ops' : 'pg_catalog.uuid_ops'),
      collations: keys.map(name => name === 'tag' ? 'pg_catalog.default' : null), collationBinding: true, collationResolved: true, options: keys.map(() => 0) })),
    checks: [{ table: 'elements', name: 'elements_storage_revision_positive', keys: ['storage_revision'], expression: '(storage_revision > 0)', safe: true, builtinExpressionOnly: true, ...flags }],
    defaults: [{ table: 'elements', name: 'storage_revision', expression: '1', safe: true },
      { table: 'elements', name: 'memory_entries_out_of_sync', expression: 'true', safe: true }] };
}
async function run(value: unknown) {
  const execute = jest.fn<DrizzleTx['execute']>().mockResolvedValue(value as Awaited<ReturnType<DrizzleTx['execute']>>);
  const result = await verify({ execute } as unknown as DrizzleTx);
  expect(execute).toHaveBeenCalledTimes(1);
  return result;
}
describe('partial required memory invalidation structure', () => {
  it('pins the bounded contract to reviewed migration attributes, keys, FKs, defaults and check', async () => {
    const artifact = (name: string) => readFileSync(new URL(`../../../src/database/migrations/${name}`, import.meta.url), 'utf8');
    const initial = artifact('0000_icy_mephistopheles.sql');
    for (const [table, name, type, typmod] of columnSpecs.filter(value => !['storage_revision', 'memory_entries_out_of_sync'].includes(value[1])
      && !(value[0] === 'element_tags' && value[1] === 'user_id'))) {
      const definition = initial.match(new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`, 'u'))?.[1];
      expect(definition).toContain(`"${name}" ${type === 'int8' ? 'bigint' : type === 'bool' ? 'boolean' : type === 'timestamptz' ? 'timestamp with time zone' : type}${typmod > 0 ? `(${typmod - 4})` : ''}`);
      expect(definition?.split('\n').find(line => line.trimStart().startsWith(`"${name}" `))).toContain('NOT NULL');
    }
    expect(initial).toContain('PRIMARY KEY("element_id","tag")');
    for (const [, name] of foreignKeys.filter(value => value[1] !== 'element_tags_user_id_users_id_fk')) expect(initial).toContain(`CONSTRAINT "${name}" FOREIGN KEY`);
    expect(artifact('0001_spotty_ken_ellis.sql')).toContain('"memory_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action');
    expect(artifact('0003_flat_rattler.sql')).toContain('"element_tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action');
    expect(artifact('0003_flat_rattler.sql')).toContain('ALTER TABLE "element_tags" ADD COLUMN "user_id" uuid NOT NULL');
    const revision = artifact('0056_memory_head_revision.sql');
    expect(revision).toContain('"storage_revision" BIGINT NOT NULL DEFAULT 1');
    expect(revision).toContain('"memory_entries_out_of_sync" BOOLEAN NOT NULL DEFAULT TRUE');
    expect(revision).toContain('CHECK ("storage_revision" > 0)');
    expect(await run([observation()])).toMatchObject({ status: 'verified', canBackfill: false, canApply: false, canActivate: false });
  });
  it('hashes every portable checked semantic, independently of observation order and instance IDs', async () => {
    const value = observation();
    const { version: _version, ...portable } = value;
    const contract = { formatVersion: 1, scope: 'memory-invalidation-required-structure', inheritance: portable.inheritance,
      relations: portable.relations.map(({ oid: _oid, ...rest }) => rest), columns: portable.columns, constraints: portable.constraints,
      indexes: portable.indexes, checks: portable.checks, defaults: portable.defaults, canBackfill: false, canApply: false, canActivate: false,
      provesCompleteCatalog: false, provesExecutionResolution: false };
    const hash = () => createHash('sha256').update(JSON.stringify(contract), 'utf8').digest('hex');
    const result = await run([value]); expect(result.descriptorSha256).toBe(hash()); expect(Object.isFrozen(result)).toBe(true);
    contract.indexes[0].options[0] = 1; expect(hash()).not.toBe(result.descriptorSha256);
    const reordered = observation(); reordered.relations.forEach(row => { row.oid = String(Number(row.oid) + 100); });
    for (const key of ['relations', 'columns', 'constraints', 'indexes', 'checks', 'defaults'] as const) reordered[key].reverse();
    expect(await run([reordered])).toEqual(result);
  });
  it.each(['relations', 'columns', 'constraints', 'indexes', 'checks', 'defaults'] as const)('refuses missing and overflow %s', async key => {
    const missing = observation(); missing[key].pop(); expect(await run([missing])).toMatchObject({ reason: 'incomplete_observation' });
    const overflow = observation(); (overflow[key] as unknown[]).push(overflow[key][0]); expect(await run([overflow])).toMatchObject({ reason: 'incomplete_observation' });
  });
  const drifts: readonly (readonly [keyof ReturnType<typeof observation>, string])[] = [
    ...['schema', 'kind', 'persistence', 'partition'].map(key => ['relations', key] as const),
    ...['typeSchema', 'type', 'typmod', 'notNull', 'generated', 'identity', 'dropped', 'collation', 'collationResolved'].map(key => ['columns', key] as const),
    ...['keys', 'referenceBinding', 'referenceSchema', 'reference', 'referenceKeys', 'update', 'delete', 'match', 'validated', 'deferrable', 'deferred', 'local', 'inherited', 'parent'].map(key => ['constraints', key] as const),
    ...['keys', 'method', 'schema', 'unique', 'primary', 'valid', 'ready', 'live', 'predicateNull', 'expressionsNull', 'keyCount', 'attributeCount', 'binding', 'opclasses', 'collations', 'collationBinding', 'collationResolved', 'options'].map(key => ['indexes', key] as const),
    ...['keys', 'expression', 'safe', 'inherited'].map(key => ['checks', key] as const),
    ...['expression', 'safe'].map(key => ['defaults', key] as const),
  ];
  // Non-DDL-mutable flags are mock catalog observations, never pg_catalog edits.
  it.each(drifts)('refuses %s.%s drift including unsupported catalog flags', async (collection, key) => {
    const value = observation(); Object.assign((value[collection] as unknown[])[0] as object, { [key]: 'drift' });
    expect(await run([value])).toMatchObject({ status: 'refused', reason: 'contract_mismatch', descriptorSha256: null });
  });
  it('refuses inheritance, duplicate identities, oversized guarded expressions and wrong collation identities', async () => {
    const value = observation(); value.inheritance = true; expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
    value.inheritance = false; value.relations[1].oid = value.relations[0].oid; expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
    const oversized = observation(); Object.assign(oversized.checks[0], { safe: false, expression: null });
    expect(await run([oversized])).toMatchObject({ reason: 'contract_mismatch' });
    for (const column of observation().columns.filter(row => row.collation !== null)) {
      const changed = observation(); Object.assign(changed.columns.find(row => row.table === column.table && row.name === column.name)!, { collation: 'pg_catalog.C' });
      expect(await run([changed])).toMatchObject({ reason: 'contract_mismatch' });
    }
  });
  it.each([160000, 180000, '170010', null])('refuses unsupported server %p', async version => {
    expect(await run([{ ...observation(), version }])).toMatchObject({ reason: 'unsupported_server' });
  });
  it.each(['0', '4294967296', '01', '1.0', 'not-an-oid', '1１', '1١', 9007199254740992])('refuses invalid or noncanonical relation OID %p', async oid => {
    const value = observation(); Object.assign(value.relations[0], { oid });
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it('accepts the uint32 maximum OID without digesting instance identity', async () => {
    const first = await run([observation()]); const value = observation(); value.relations[0].oid = '4294967295';
    expect(await run([value])).toEqual(first);
  });
  it.each(['keys', 'referenceKeys'] as const)('refuses a missing attribute retained in the raw constraint %s vector', async key => {
    const value = observation(); Object.assign(value.constraints[3], { [key]: [null] });
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
    Object.assign(value.constraints[3], { [key]: ['user_id', null] });
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it.each(['keys', 'opclasses'] as const)('refuses missing index %s entries rather than dropping them', async key => {
    const value = observation(); Object.assign(value.indexes[0], { [key]: [null] });
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it('distinguishes unresolved nonzero collation from legitimate zero on UUID columns and index keys', async () => {
    const column = observation(); Object.assign(column.columns[0], { collation: null, collationResolved: false });
    expect(await run([column])).toMatchObject({ reason: 'contract_mismatch' });
    const index = observation(); Object.assign(index.indexes[0], { collations: [null], collationResolved: false });
    expect(await run([index])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it('rejects an independently validated FK with the wrong exact referenced relation', async () => {
    const value = observation(); value.constraints[3].reference = 'elements';
    expect(value.constraints[3].validated).toBe(true);
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it('refuses explicit custom operator/function dependency despite the same positive-check rendering', async () => {
    const value = observation(); value.checks[0].builtinExpressionOnly = false;
    expect(value.checks[0].expression).toBe('(storage_revision > 0)');
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it('refuses custom FK comparison semantics and the selected custom reference index', async () => {
    const value = observation(); Object.assign(value.constraints[3], {
      equalityOperators: ['fixture.=(uuid,uuid)', equality, equality],
      referenceIndex: { ...referenceIndex('users'), opclass: 'fixture.custom_uuid_ops' },
    });
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it.each([0, 1, 2])('refuses missing or nonbuiltin FK equality vector %i independently', async index => {
    const value = observation(); const operators = [equality, equality, equality]; operators[index] = 'fixture.custom_eq';
    Object.assign(value.constraints[3], { equalityOperators: operators });
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
    Object.assign(value.constraints[3], { equalityOperators: [null, null, null] });
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it.each(Object.keys(referenceIndex('users')))('refuses selected FK supporting-index %s drift independently', async key => {
    const value = observation(); Object.assign(value.constraints[3], { referenceIndex: { ...referenceIndex('users'), [key]: 'drift' } });
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it('refuses missing/oversized FK equality observations without losing constraint presence', async () => {
    const value = observation(); Object.assign(value.constraints[3], { equalityOperators: null });
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
    Object.assign(value.constraints[3], { equalityOperators: [equality, equality, equality, equality] });
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it('refuses incomplete results and strips driver errors', async () => {
    expect(await run([])).toMatchObject({ reason: 'incomplete_observation' });
    const execute = jest.fn<DrizzleTx['execute']>().mockRejectedValue(new Error('private SQL credentials'));
    const result = await verify({ execute } as unknown as DrizzleTx);
    expect(result.reason).toBe('query_failed'); expect(JSON.stringify(result)).not.toContain('private'); expect(result).not.toHaveProperty('cause');
  });
});
