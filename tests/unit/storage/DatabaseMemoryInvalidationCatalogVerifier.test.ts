import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import { verifyDatabaseMemoryInvalidationCatalog as verify } from '../../../src/storage/DatabaseMemoryInvalidationCatalogVerifier.js';

const migrations = [
  readFileSync(new URL('../../../src/database/migrations/0056_memory_head_revision.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../../../src/database/migrations/0057_memory_tag_revision.sql', import.meta.url), 'utf8'),
];
const definitions = [
  ['bump_element_storage_revision', [], null, 'trigger'],
  ['mark_memory_head_out_of_sync', ['uuid', 'uuid'], ['p_memory_id', 'p_user_id'], 'bool'],
  ['bump_memory_entry_head_revision', [], null, 'trigger'],
  ['invalidate_memory_tag_owner', ['uuid', 'uuid', 'bool'], ['p_element_id', 'p_user_id', 'p_deleting'], 'void'],
  ['bump_memory_tag_head_revision', [], null, 'trigger'],
] as const;
const headers = [
  'CREATE FUNCTION bump_element_storage_revision() RETURNS trigger\nLANGUAGE plpgsql AS $$',
  'CREATE FUNCTION mark_memory_head_out_of_sync(p_memory_id UUID, p_user_id UUID) RETURNS BOOLEAN\nLANGUAGE plpgsql AS $$',
  'CREATE FUNCTION bump_memory_entry_head_revision() RETURNS trigger\nLANGUAGE plpgsql AS $$',
  'CREATE FUNCTION invalidate_memory_tag_owner(p_element_id UUID, p_user_id UUID, p_deleting BOOLEAN)\nRETURNS VOID LANGUAGE plpgsql SECURITY INVOKER AS $$',
  'CREATE FUNCTION bump_memory_tag_head_revision() RETURNS trigger\nLANGUAGE plpgsql SECURITY INVOKER AS $$',
];
function body(name: string): string {
  const matches = [...migrations.join('\n').matchAll(new RegExp(`(CREATE FUNCTION ${name}\\([^;]*?AS \\$\\$)([\\s\\S]*?)\\$\\$;`, 'gu'))];
  expect(matches).toHaveLength(1);
  expect(matches[0][1]).toBe(headers[definitions.findIndex(value => value[0] === name)]);
  return matches[0][2];
}
function observation() {
  return { version: 170010,
    relations: ['element_tags', 'elements', 'memory_entries'].map((name, index) => ({ name, oid: String(index + 1), schema: 'public', kind: 'r' })),
    functions: definitions.map(([name, args, argNames, returns], index) => ({ name, oid: String(index + 11), schema: 'public',
      args: args.map(name => ({ schema: 'pg_catalog', name })), argNames, argNamesSafe: true,
      returns: { schema: 'pg_catalog', name: returns }, language: 'plpgsql', kind: 'f', setReturning: false,
      variadic: '0', strict: false, definer: false, volatility: 'v', leakproof: false, parallel: 'u', defaults: 0,
      support: '0', configNull: true, allArgsNull: true, argModesNull: true, argCount: args.length,
      bodyBytes: Buffer.byteLength(body(name), 'utf8'), body: body(name) })),
    triggers: [
      { table: 'element_tags', tableOid: '1', functionOid: '15', name: 'element_tags_memory_head_revision_change', type: 31 },
      { table: 'elements', tableOid: '2', functionOid: '11', name: 'elements_storage_revision_update', type: 19 },
      { table: 'memory_entries', tableOid: '3', functionOid: '13', name: 'memory_entries_head_revision_change', type: 31 },
    ].map(value => ({ ...value, enabled: 'O', args: 0, argsEmpty: true, columnsEmpty: true, qualNull: true,
      constraint: '0', constraintRelation: '0', constraintIndex: '0', deferrable: false, initiallyDeferred: false })) };
}
async function run(value: unknown) {
  const execute = jest.fn<DrizzleTx['execute']>().mockResolvedValue(value as Awaited<ReturnType<DrizzleTx['execute']>>);
  const result = await verify({ execute } as unknown as DrizzleTx);
  expect(execute).toHaveBeenCalledTimes(1);
  return result;
}

describe('partial dormant memory invalidation catalog proof', () => {
  it('pins every body byte to the exact five reviewed migration artifacts', async () => {
    expect(migrations.join('\n').match(/CREATE FUNCTION /gu)).toHaveLength(5);
    const result = await run([observation()]);
    expect(result).toMatchObject({ status: 'verified', reason: null, canBackfill: false, canApply: false,
      canActivate: false, provesExecutionResolution: false });
    expect(result.descriptorSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('hashes portable semantics independently of instance OIDs and catalog row order', async () => {
    const first = await run([observation()]);
    const second = observation();
    second.relations.forEach(value => { value.oid = String(Number(value.oid) + 100); });
    second.functions.forEach(value => { value.oid = String(Number(value.oid) + 100); });
    second.triggers.forEach(value => { value.tableOid = String(Number(value.tableOid) + 100); value.functionOid = String(Number(value.functionOid) + 100); });
    second.functions.reverse(); second.triggers.reverse(); second.relations.reverse();
    expect(await run([second])).toEqual(first);
  });
  it('includes every validated portable field in the versioned descriptor digest', async () => {
    const value = observation();
    const relations = value.relations.map(({ oid: _oid, ...rest }) => rest);
    const functions = value.functions.map(({ oid: _oid, ...rest }) => rest);
    const triggers = value.triggers.map(({ tableOid: _tableOid, functionOid, ...rest }) => {
      const { table, name, type, ...flags } = rest;
      return { table, name, function: value.functions.find(item => item.oid === functionOid)?.name, type, ...flags };
    });
    const contract = { formatVersion: 1, scope: 'memory-invalidation-functions-and-user-triggers', relations, functions, triggers,
      canBackfill: false, canApply: false, canActivate: false, provesExecutionResolution: false };
    const hash = () => createHash('sha256').update(JSON.stringify(contract), 'utf8').digest('hex');
    const result = await run([value]);
    expect(result.descriptorSha256).toBe(hash());
    contract.functions[0].strict = true;
    expect(hash()).not.toBe(result.descriptorSha256);
    contract.functions[0].strict = false; contract.triggers[0].enabled = 'D';
    expect(hash()).not.toBe(result.descriptorSha256);
  });
  it.each(['schema', 'args', 'argNames', 'argNamesSafe', 'returns', 'language', 'kind', 'setReturning', 'variadic',
    'strict', 'definer', 'volatility', 'leakproof', 'parallel', 'defaults', 'support', 'configNull', 'allArgsNull',
    'argModesNull', 'argCount', 'bodyBytes', 'body'])('refuses function %s drift', async key => {
    const value = observation();
    Object.assign(value.functions[0], { [key]: 'unexpected' });
    expect(await run([value])).toMatchObject({ status: 'refused', reason: 'contract_mismatch', descriptorSha256: null });
  });
  it.each(['table', 'tableOid', 'functionOid', 'type', 'enabled', 'args', 'argsEmpty', 'columnsEmpty', 'qualNull',
    'constraint', 'constraintRelation', 'constraintIndex', 'deferrable', 'initiallyDeferred'])('refuses trigger %s drift', async key => {
    const value = observation(); Object.assign(value.triggers[0], { [key]: 'unexpected' });
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it.each(['relations', 'functions', 'triggers'] as const)('refuses missing or overflow %s observations', async key => {
    const value = observation(); value[key].pop();
    expect(await run([value])).toMatchObject({ reason: 'incomplete_observation' });
    const overflow = observation(); (overflow[key] as unknown[]).push(overflow[key][0]);
    expect(await run([overflow])).toMatchObject({ reason: 'incomplete_observation' });
  });
  it('refuses duplicates, wrong type namespaces and oversized bodies rather than treating them absent', async () => {
    const duplicate = observation(); duplicate.functions[1] = duplicate.functions[0];
    expect(await run([duplicate])).toMatchObject({ reason: 'contract_mismatch' });
    const shadow = observation(); shadow.functions[0].returns.schema = 'shadow';
    expect(await run([shadow])).toMatchObject({ reason: 'contract_mismatch' });
    const oversized = observation(); Object.assign(oversized.functions[0], { body: null, bodyBytes: 16385 });
    expect(await run([oversized])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it.each([160000, 180000, '170010', null])('refuses unsupported or malformed server %p', async version => {
    expect(await run([{ ...observation(), version }])).toMatchObject({ reason: 'unsupported_server' });
  });
  it('refuses missing query results and strips all driver error text and causes', async () => {
    expect(await run([])).toMatchObject({ reason: 'incomplete_observation' });
    const execute = jest.fn<DrizzleTx['execute']>().mockRejectedValue(new Error('private SQL credential body'));
    const result = await verify({ execute } as unknown as DrizzleTx);
    expect(result).toMatchObject({ reason: 'query_failed', descriptorSha256: null });
    expect(JSON.stringify(result)).not.toContain('private'); expect(result).not.toHaveProperty('cause');
  });
});
