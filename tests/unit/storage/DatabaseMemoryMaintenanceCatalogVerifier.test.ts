import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import { verifyDatabaseMemoryMaintenanceCatalog as verify, observeDatabaseMemoryMaintenanceCatalog as compose } from '../../../src/storage/DatabaseMemoryMaintenanceCatalogVerifier.js';

type Row = Record<string, unknown>;
const receipt = 'memory_head_invalidation_runs';
const owner = "(user_id = (current_setting('app.current_user_id'::text, true))::uuid)";
const columns = [
  ['run_id', 'uuid'], ['format_version', 'int4'], ['claim', 'text'], ['request_sha256', 'text'],
  ['catalog_sha256', 'text'], ['pre_manifest_sha256', 'text'], ['post_manifest_sha256', 'text'],
  ['maintenance_evidence_sha256', 'text'], ['candidate_commit', 'text'], ['maintenance_evidence_id', 'text'],
  ['declared_context_id', 'text'], ['database_name', 'text'], ['effective_role', 'text'], ['database_oid', 'int8'],
  ['server_version_num', 'int4'], ['owner_count', 'int4'], ['tag_count', 'int4'], ['started_at', 'timestamptz'],
  ['finished_at', 'timestamptz'], ['can_apply', 'bool'], ['can_activate', 'bool'],
];
const checks: [string, string[], string][] = [
  ['run_id', ['run_id'], "(run_id <> '00000000-0000-0000-0000-000000000000'::uuid)"],
  ['claim', ['format_version', 'claim', 'can_apply', 'can_activate'], "((format_version = 1) AND (claim = 'historical-exact-owner-set-invalidation'::text) AND (can_apply = false) AND (can_activate = false))"],
  ['digests', ['request_sha256', 'catalog_sha256', 'pre_manifest_sha256', 'post_manifest_sha256', 'maintenance_evidence_sha256', 'candidate_commit'], "((request_sha256 ~ '^[a-f0-9]{64}$'::text) AND (catalog_sha256 ~ '^[a-f0-9]{64}$'::text) AND (pre_manifest_sha256 ~ '^[a-f0-9]{64}$'::text) AND (post_manifest_sha256 ~ '^[a-f0-9]{64}$'::text) AND (maintenance_evidence_sha256 ~ '^[a-f0-9]{64}$'::text) AND (candidate_commit ~ '^[a-f0-9]{40}$'::text) AND (candidate_commit <> repeat('0'::text, 40)))"],
  ['declarations', ['maintenance_evidence_id', 'declared_context_id'], '(((octet_length(maintenance_evidence_id) >= 1) AND (octet_length(maintenance_evidence_id) <= 128)) AND ((octet_length(declared_context_id) >= 1) AND (octet_length(declared_context_id) <= 128)))'],
  ['attribution', ['database_name', 'effective_role', 'database_oid', 'server_version_num'], "(((octet_length(database_name) >= 1) AND (octet_length(database_name) <= 63)) AND ((octet_length(effective_role) >= 1) AND (octet_length(effective_role) <= 63)) AND ((database_oid >= 1) AND (database_oid <= '4294967295'::bigint)) AND (server_version_num > 0))"],
  ['counts', ['owner_count', 'tag_count'], '(((owner_count >= 0) AND (owner_count <= 10000)) AND ((tag_count >= 0) AND (tag_count <= 100000)))'],
  ['times', ['started_at', 'finished_at'], '(isfinite(started_at) AND isfinite(finished_at) AND (finished_at >= started_at))'],
];
const policies: [string, string, string, string | null, string | null, string[]][] = [
  ['elements', 'select', 'r', `(${owner} OR ((visibility)::text = 'public'::text))`, null, ['elements.user_id', 'elements.visibility']],
  ['element_tags', 'select', 'r', `(${owner} OR (EXISTS ( SELECT 1\n   FROM elements\n  WHERE ((elements.id = element_tags.element_id) AND ((elements.visibility)::text = 'public'::text)))))`, null, ['element_tags.user_id', 'element_tags.element_id', 'elements.id', 'elements.visibility']],
  ...['elements', 'element_tags'].flatMap(table => [
    [table, 'insert', 'a', null, owner, [`${table}.user_id`]],
    [table, 'update', 'w', owner, owner, [`${table}.user_id`]],
    [table, 'delete', 'd', owner, null, [`${table}.user_id`]],
  ] as [string, string, string, string | null, string | null, string[]][]),
  ['memory_entries', 'user_isolation', '*', owner, null, ['memory_entries.user_id']],
];
function deps(table: string, keys: string[], policy: boolean): Row[] {
  return [...(policy ? [{ safe: true, kind: 'a', relation: table, column: null }] : keys.map(column => ({ safe: true, kind: 'a', relation: table, column }))),
    ...keys.map(key => ({ safe: true, kind: 'n', relation: policy ? key.split('.')[0] : table, column: policy ? key.split('.')[1] : key }))];
}
function observation(): Record<string, unknown> {
  return { version: 170010, noDefaults: true, noTriggers: true, noRules: true,
    relations: ['elements', 'element_tags', 'memory_entries', receipt, '__drizzle_migrations'].map(name => ({ name,
      schema: name === '__drizzle_migrations' ? 'drizzle' : 'public', kind: 'r', persistence: 'p', partition: false,
      inheritance: false, rls: name !== '__drizzle_migrations', force: name !== '__drizzle_migrations' })),
    columns: columns.map(([name, type], index) => ({ table: receipt, name, position: index + 1, typeSchema: 'pg_catalog', type,
      typmod: -1, notNull: true, generated: '', identity: '', dropped: false, collationResolved: true, collation: type === 'text' ? 'pg_catalog.default' : null })),
    ledgerColumns: ['hash', 'created_at'].map((name, index) => ({ table: '__drizzle_migrations', name, typeSchema: 'pg_catalog',
      type: index === 0 ? 'text' : 'int8', typmod: -1, notNull: index === 0, generated: '', identity: '', dropped: false })),
    constraints: [{ name: `${receipt}_pkey`, type: 'p', keys: ['run_id'], expression: null, expressionSafe: true, dependencies: null,
      validated: true, deferrable: false, deferred: false, local: true, inherited: 0, parent: '0', noInherit: true },
    ...checks.map(([suffix, keys, expression]) => ({ name: `${receipt}_${suffix}_check`, type: 'c', keys, expression,
      expressionSafe: true, dependencies: deps(receipt, keys, false), validated: true, deferrable: false, deferred: false,
      local: true, inherited: 0, parent: '0', noInherit: false }))],
    indexes: [{ name: `${receipt}_pkey`, schema: 'public', binding: true, kind: 'i', method: 'btree', key: 'run_id', typeBinding: true,
      opclass: 'pg_catalog.uuid_ops', defaultOpclass: true, unique: true, primary: true, immediate: true, valid: true, ready: true,
      live: true, keyCount: 1, attributeCount: 1, predicateNull: true, expressionsNull: true, collationZero: true, optionZero: true }],
    policies: policies.map(([table, suffix, command, using, check, keys]) => ({ table, name: `${table}_${suffix}`, command,
      permissive: true, publicOnly: true, using, check, expressionsSafe: true, dependencies: deps(table, keys, true) })),
    ledger: [['1790553601000', 'd1bc52dd84d079342a544e1d3d89489d65a17de1edce648435a6ef2a0106fc5c'],
      ['1790553602000', '96e2bc6c743fe74e3624646288b624064cfb10979358af09936e8d468bfcc297'],
      ['1790812800000', '7612017368287c81176a9c590a7a48ad71fe539f0cd1e67528fe97a0221b8b36']]
      .map(([timestamp, hash]) => ({ timestamp, hash, hashSafe: true })),
  };
}
async function run(value: unknown) {
  const execute = jest.fn<DrizzleTx['execute']>().mockResolvedValue(value as Awaited<ReturnType<DrizzleTx['execute']>>);
  const result = await verify({ execute } as unknown as DrizzleTx);
  expect(execute).toHaveBeenCalledTimes(1);
  return result;
}
describe('dormant maintenance catalog observation', () => {
  it('verifies the supplied bounded healthy observation without conferring authority', async () => {
    const result = await run([observation()]);
    expect(result).toMatchObject({ status: 'verified', descriptorSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      canBackfill: false, canApply: false, canActivate: false, provesCompleteCatalog: false,
      provesExecutionResolution: false, provesCoherentSnapshot: false });
    expect(Object.isFrozen(result)).toBe(true);
    const reordered = observation();
    for (const key of ['relations', 'columns', 'ledgerColumns', 'constraints', 'indexes', 'policies', 'ledger']) (reordered[key] as Row[]).reverse();
    expect(await run([reordered])).toEqual(result);
  });
  it('hashes every checked portable descriptor rather than instance identities', async () => {
    const value = observation();
    for (const key of ['constraints', 'policies']) {
      for (const row of value[key] as Row[]) {
        if (row.dependencies === null) continue;
        const raw = row.dependencies as Row[];
        const keyOf = (item: Row) => item.column === null ? String(item.relation) : `${String(item.relation)}.${String(item.column)}`;
        row.dependencies = { safe: true, bounded: true, automatic: raw.filter(item => item.kind === 'a').map(keyOf).sort(),
          normal: [...new Set(raw.filter(item => item.kind === 'n').map(keyOf))].sort() };
      }
    }
    const contract = { formatVersion: 1, scope: 'memory-maintenance-receipt-policy-ledger',
      relations: value.relations, columns: value.columns, ledgerColumns: value.ledgerColumns,
      constraints: value.constraints, indexes: value.indexes,
      // Production contract order is table/operation, independent of observed order.
      policies: (value.policies as Row[]).sort((a, b) => {
        const names = ['elements_select', 'elements_insert', 'elements_update', 'elements_delete',
          'element_tags_select', 'element_tags_insert', 'element_tags_update', 'element_tags_delete', 'memory_entries_user_isolation'];
        return names.indexOf(String(a.name)) - names.indexOf(String(b.name));
      }), ledger: value.ledger, noDefaults: true, noTriggers: true, noRules: true,
      canBackfill: false, canApply: false, canActivate: false, provesCompleteCatalog: false,
      provesExecutionResolution: false, provesCoherentSnapshot: false };
    const hash = () => createHash('sha256').update(JSON.stringify(contract), 'utf8').digest('hex');
    const result = await run([observation()]); expect(result.descriptorSha256).toBe(hash());
    (contract.relations as Row[])[0].force = false; expect(hash()).not.toBe(result.descriptorSha256);
  });
  it.each(['relations', 'columns', 'ledgerColumns', 'constraints', 'indexes', 'policies', 'ledger'])('refuses missing/overflow %s', async key => {
    const missing = observation(); (missing[key] as Row[]).pop();
    expect(await run([missing])).toMatchObject({ reason: 'incomplete_observation' });
    const overflow = observation(); (overflow[key] as Row[]).push((overflow[key] as Row[])[0]);
    expect(await run([overflow])).toMatchObject({ reason: 'incomplete_observation' });
  });
  it.each(['noDefaults', 'noTriggers', 'noRules'])('refuses receipt %s drift', async key => {
    const value = observation(); value[key] = false;
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it('allows bounded overlapping policy dependencies but refuses CHECK duplicates', async () => {
    const value = observation(); const update = (value.policies as Row[]).find(row => row.name === 'elements_update')!;
    (update.dependencies as Row[]).push({ ...(update.dependencies as Row[])[1] });
    expect(await run([value])).toMatchObject({ status: 'verified' });
    const check = (value.constraints as Row[])[1]; (check.dependencies as Row[]).push({ ...(check.dependencies as Row[])[1] });
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it.each(['constraints', 'policies'])('refuses unsafe, missing and overflow %s dependencies', async key => {
    for (const replacement of [null, [{ safe: false }], Array.from({ length: 17 }, () => ({ safe: true, kind: 'n', relation: 'elements', column: 'user_id' }))]) {
      const value = observation(); (value[key] as Row[])[key === 'constraints' ? 1 : 0].dependencies = replacement;
      expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
    }
  });
  it('pins exact ledger hashes and timestamps to committed UTF8 migration artifacts', async () => {
    const names = ['0056_memory_head_revision', '0057_memory_tag_revision', '0058_memory_head_invalidation_runs'];
    const journal = JSON.parse(readFileSync(new URL('../../../src/database/migrations/meta/_journal.json', import.meta.url), 'utf8'));
    const ledger = observation().ledger as Row[];
    names.forEach((name, index) => {
      const bytes = readFileSync(new URL(`../../../src/database/migrations/${name}.sql`, import.meta.url), 'utf8');
      expect(createHash('sha256').update(bytes, 'utf8').digest('hex')).toBe(ledger[index].hash);
      expect(String(journal.entries.find((entry: { tag: string }) => entry.tag === name).when)).toBe(ledger[index].timestamp);
    });
    const value = observation(); (value.ledger as Row[])[0].timestamp = '1';
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it('returns a fixed refusal without leaking query failures', async () => {
    const execute = jest.fn<DrizzleTx['execute']>().mockRejectedValue(new Error('private-secret'));
    const result = await verify({ execute } as unknown as DrizzleTx);
    expect(result.reason).toBe('query_failed'); expect(JSON.stringify(result)).not.toContain('private-secret');
  });
  const drifts: [string, string][] = [
    ...['schema', 'kind', 'persistence', 'partition', 'inheritance', 'rls', 'force'].map(key => ['relations', key] as [string, string]),
    ...['position', 'typeSchema', 'type', 'typmod', 'notNull', 'generated', 'identity', 'dropped', 'collationResolved', 'collation'].map(key => ['columns', key] as [string, string]),
    ...['typeSchema', 'type', 'typmod', 'notNull', 'generated', 'identity', 'dropped'].map(key => ['ledgerColumns', key] as [string, string]),
    ...['validated', 'deferrable', 'deferred', 'local', 'inherited', 'parent', 'noInherit', 'keys', 'expression', 'expressionSafe'].map(key => ['constraints', key] as [string, string]),
    ...['schema', 'binding', 'kind', 'method', 'key', 'typeBinding', 'opclass', 'defaultOpclass', 'unique', 'primary', 'immediate', 'valid', 'ready', 'live', 'keyCount', 'attributeCount', 'predicateNull', 'expressionsNull', 'collationZero', 'optionZero'].map(key => ['indexes', key] as [string, string]),
    ...['command', 'permissive', 'publicOnly', 'using', 'check', 'expressionsSafe'].map(key => ['policies', key] as [string, string]),
    ...['timestamp', 'hash', 'hashSafe'].map(key => ['ledger', key] as [string, string]),
  ];
  it.each(drifts)('refuses portable %s.%s drift', async (key, field) => {
    const value = observation(); const row = (value[key] as Row[])[key === 'constraints' ? 1 : 0];
    row[field] = typeof row[field] === 'boolean' ? !row[field] : typeof row[field] === 'number' ? Number(row[field]) + 1 : ['unexpected'];
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it.each(['unsafe_class', 'foreign_relation', 'wrong_column', 'wrong_kind', 'automatic_duplicate'])('refuses %s dependency', async drift => {
    const value = observation(); const dependencies = (value.policies as Row[])[0].dependencies as Row[];
    if (drift === 'unsafe_class') dependencies[1].safe = false;
    if (drift === 'foreign_relation') dependencies[1].relation = 'users';
    if (drift === 'wrong_column') dependencies[1].column = 'id';
    if (drift === 'wrong_kind') dependencies[1].kind = 'i';
    if (drift === 'automatic_duplicate') dependencies.push({ ...dependencies[0] });
    expect(await run([value])).toMatchObject({ reason: 'contract_mismatch' });
  });
  it('rejects invalid observation envelopes and unsupported servers', async () => {
    for (const value of [null, [], [null], [observation(), observation()]]) expect(await run(value)).toMatchObject({ reason: 'incomplete_observation' });
    for (const version of [160010, 180000, '170010', null]) {
      const value = observation(); value.version = version;
      expect(await run([value])).toMatchObject({ reason: 'unsupported_server' });
    }
  });
  it('composes only actual helper observations and stops on a refused component', async () => {
    const execute = jest.fn<DrizzleTx['execute']>().mockRejectedValue(new Error('private execution failure'));
    expect(await compose({ execute } as unknown as DrizzleTx)).toMatchObject({ scope: 'memory-maintenance-composed-observations',
      status: 'refused', reason: 'query_failed', descriptorSha256: null, provesCoherentSnapshot: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('binds policy and receipt expectations to their reviewed static artifacts', () => {
    const artifact = (name: string) => readFileSync(new URL(`../../../src/database/migrations/${name}`, import.meta.url), 'utf8');
    const receiptSql = artifact('0058_memory_head_invalidation_runs.sql');
    for (const [name] of columns) expect(receiptSql.split('\n').find(line => line.trimStart().startsWith(`"${name}" `))).toContain(name === 'run_id' ? 'PRIMARY KEY' : 'NOT NULL');
    for (const [suffix] of checks) expect(receiptSql).toContain(`"${receipt}_${suffix}_check"`);
    expect(receiptSql).toContain('FORCE ROW LEVEL SECURITY');
    expect(receiptSql).toContain('historical-exact-owner-set-invalidation');
    const entries = artifact('0004_fts_and_rls.sql');
    expect(entries).toContain("_upsert_policy('memory_entries', 'memory_entries_user_isolation'");
    const elements = artifact('0005_visibility_rls.sql');
    const tags = artifact('0006_tags_public_visibility.sql');
    for (const [table, suffix] of policies.filter(row => row[0] !== 'memory_entries')) {
      expect(table === 'elements' ? elements : tags).toContain(`CREATE POLICY "${table}_${suffix}"`);
    }
    expect(tags).toContain('"elements"."id" = "element_tags"."element_id"');
    expect(tags).toContain('"elements"."visibility" = \'public\'');
  });
});
