/** Dormant PG17 receipt/policy/ledger metadata; never maintenance authority. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '../database/db-utils.js';
import { verifyDatabaseMemoryInvalidationCatalog } from './DatabaseMemoryInvalidationCatalogVerifier.js';
import { verifyDatabaseMemoryInvalidationStructure } from './DatabaseMemoryInvalidationStructureVerifier.js';

type Descriptor = Record<string, unknown>;
const RECEIPT = 'memory_head_invalidation_runs';
const COLUMNS: readonly (readonly [string, string])[] = [
  ['run_id', 'uuid'], ['format_version', 'int4'], ['claim', 'text'], ['request_sha256', 'text'],
  ['catalog_sha256', 'text'], ['pre_manifest_sha256', 'text'], ['post_manifest_sha256', 'text'],
  ['maintenance_evidence_sha256', 'text'], ['candidate_commit', 'text'], ['maintenance_evidence_id', 'text'],
  ['declared_context_id', 'text'], ['database_name', 'text'], ['effective_role', 'text'], ['database_oid', 'int8'],
  ['server_version_num', 'int4'], ['owner_count', 'int4'], ['tag_count', 'int4'],
  ['started_at', 'timestamptz'], ['finished_at', 'timestamptz'], ['can_apply', 'bool'], ['can_activate', 'bool'],
];
// PG17 deparse expectations pinned to reviewed 0058; never learned from live rows.
const CHECKS: readonly (readonly [string, readonly string[], string])[] = [
  ['run_id', ['run_id'], "(run_id <> '00000000-0000-0000-0000-000000000000'::uuid)"],
  ['claim', ['format_version', 'claim', 'can_apply', 'can_activate'],
    "((format_version = 1) AND (claim = 'historical-exact-owner-set-invalidation'::text) AND (can_apply = false) AND (can_activate = false))"],
  ['digests', ['request_sha256', 'catalog_sha256', 'pre_manifest_sha256', 'post_manifest_sha256', 'maintenance_evidence_sha256', 'candidate_commit'],
    "((request_sha256 ~ '^[a-f0-9]{64}$'::text) AND (catalog_sha256 ~ '^[a-f0-9]{64}$'::text) AND (pre_manifest_sha256 ~ '^[a-f0-9]{64}$'::text) AND (post_manifest_sha256 ~ '^[a-f0-9]{64}$'::text) AND (maintenance_evidence_sha256 ~ '^[a-f0-9]{64}$'::text) AND (candidate_commit ~ '^[a-f0-9]{40}$'::text) AND (candidate_commit <> repeat('0'::text, 40)))"],
  ['declarations', ['maintenance_evidence_id', 'declared_context_id'],
    '(((octet_length(maintenance_evidence_id) >= 1) AND (octet_length(maintenance_evidence_id) <= 128)) AND ((octet_length(declared_context_id) >= 1) AND (octet_length(declared_context_id) <= 128)))'],
  ['attribution', ['database_name', 'effective_role', 'database_oid', 'server_version_num'],
    "(((octet_length(database_name) >= 1) AND (octet_length(database_name) <= 63)) AND ((octet_length(effective_role) >= 1) AND (octet_length(effective_role) <= 63)) AND ((database_oid >= 1) AND (database_oid <= '4294967295'::bigint)) AND (server_version_num > 0))"],
  ['counts', ['owner_count', 'tag_count'],
    '(((owner_count >= 0) AND (owner_count <= 10000)) AND ((tag_count >= 0) AND (tag_count <= 100000)))'],
  ['times', ['started_at', 'finished_at'], '(isfinite(started_at) AND isfinite(finished_at) AND (finished_at >= started_at))'],
];
const OWN = "(user_id = (current_setting('app.current_user_id'::text, true))::uuid)";
const TAG_SELECT = `(${OWN} OR (EXISTS ( SELECT 1
   FROM elements
  WHERE ((elements.id = element_tags.element_id) AND ((elements.visibility)::text = 'public'::text)))))`;
const POLICIES: readonly (readonly [string, string, string, string | null, string | null, readonly string[]])[] = [
  ['elements', 'elements_select', 'r', `(${OWN} OR ((visibility)::text = 'public'::text))`, null, ['elements.user_id', 'elements.visibility']],
  ['elements', 'elements_insert', 'a', null, OWN, ['elements.user_id']],
  ['elements', 'elements_update', 'w', OWN, OWN, ['elements.user_id']],
  ['elements', 'elements_delete', 'd', OWN, null, ['elements.user_id']],
  ['element_tags', 'element_tags_select', 'r', TAG_SELECT, null, ['element_tags.user_id', 'element_tags.element_id', 'elements.id', 'elements.visibility']],
  ['element_tags', 'element_tags_insert', 'a', null, OWN, ['element_tags.user_id']],
  ['element_tags', 'element_tags_update', 'w', OWN, OWN, ['element_tags.user_id']],
  ['element_tags', 'element_tags_delete', 'd', OWN, null, ['element_tags.user_id']],
  ['memory_entries', 'memory_entries_user_isolation', '*', OWN, null, ['memory_entries.user_id']],
];
const LEDGER = [
  { name: '0056_memory_head_revision', timestamp: '1790553601000', hash: 'd1bc52dd84d079342a544e1d3d89489d65a17de1edce648435a6ef2a0106fc5c' },
  { name: '0057_memory_tag_revision', timestamp: '1790553602000', hash: '96e2bc6c743fe74e3624646288b624064cfb10979358af09936e8d468bfcc297' },
  { name: '0058_memory_head_invalidation_runs', timestamp: '1790812800000', hash: '7612017368287c81176a9c590a7a48ad71fe539f0cd1e67528fe97a0221b8b36' },
];

export interface MemoryMaintenanceCatalogProof {
  readonly formatVersion: 1;
  readonly scope: 'memory-maintenance-receipt-policy-ledger' | 'memory-maintenance-composed-observations';
  readonly status: 'verified' | 'refused';
  readonly reason: 'unsupported_server' | 'incomplete_observation' | 'contract_mismatch' | 'query_failed' | null;
  readonly descriptorSha256: string | null;
  readonly canBackfill: false;
  readonly canApply: false;
  readonly canActivate: false;
  readonly provesCompleteCatalog: false;
  readonly provesExecutionResolution: false;
  readonly provesCoherentSnapshot: false;
}
const FLAGS = { validated: true, deferrable: false, deferred: false, local: true, inherited: 0, parent: '0', noInherit: false };
function ordinal(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
function dependencies(table: string, keys: readonly string[], policy: boolean): Descriptor {
  const normal = keys.map(key => policy ? key : `${table}.${key}`);
  normal.sort(ordinal);
  return { safe: true, bounded: true, automatic: policy ? [table] : normal, normal };
}
function expected(): Record<string, Descriptor[]> {
  return {
    relations: ['elements', 'element_tags', 'memory_entries', RECEIPT].map(name => ({ name, schema: 'public', kind: 'r', persistence: 'p', partition: false,
      inheritance: false, rls: true, force: true })).concat([{ name: '__drizzle_migrations', schema: 'drizzle', kind: 'r', persistence: 'p', partition: false,
      inheritance: false, rls: false, force: false }]),
    columns: COLUMNS.map(([name, type], index) => ({ table: RECEIPT, name, position: index + 1, typeSchema: 'pg_catalog', type,
      typmod: -1, notNull: true, generated: '', identity: '', dropped: false, collationResolved: true,
      collation: type === 'text' ? 'pg_catalog.default' : null })),
    ledgerColumns: ['hash', 'created_at'].map((name, index) => ({ table: '__drizzle_migrations', name, typeSchema: 'pg_catalog',
      type: index === 0 ? 'text' : 'int8', typmod: -1, notNull: index === 0, generated: '', identity: '', dropped: false })),
    constraints: [{ name: `${RECEIPT}_pkey`, type: 'p', keys: ['run_id'], expression: null, expressionSafe: true,
      dependencies: null, ...FLAGS, noInherit: true },
    ...CHECKS.map(([suffix, keys, expression]) => ({ name: `${RECEIPT}_${suffix}_check`, type: 'c', keys, expression,
      expressionSafe: true, dependencies: dependencies(RECEIPT, keys, false), ...FLAGS }))],
    indexes: [{ name: `${RECEIPT}_pkey`, schema: 'public', binding: true, kind: 'i', method: 'btree', key: 'run_id',
      typeBinding: true, opclass: 'pg_catalog.uuid_ops', defaultOpclass: true, unique: true, primary: true,
      immediate: true, valid: true, ready: true, live: true, keyCount: 1, attributeCount: 1,
      predicateNull: true, expressionsNull: true, collationZero: true, optionZero: true }],
    policies: POLICIES.map(([table, name, command, using, check, keys]) => ({ table, name, command, permissive: true,
      publicOnly: true, using, check, expressionsSafe: true, dependencies: dependencies(table, keys, true) })),
    ledger: LEDGER.map(({ timestamp, hash }) => ({ timestamp, hash, hashSafe: true })),
  };
}

// Sentinels and CASE guards retain unexpected object existence without
// projecting unbounded expression, role, dependency or key vectors.
const OBSERVE = sql`WITH relations AS MATERIALIZED (
  SELECT r.*,n.nspname FROM pg_catalog.pg_class r JOIN pg_catalog.pg_namespace n ON n.oid=r.relnamespace
  WHERE (n.nspname='public' AND r.relname IN ('elements','element_tags','memory_entries','memory_head_invalidation_runs'))
    OR (n.nspname='drizzle' AND r.relname='__drizzle_migrations') LIMIT 6
), receipt AS MATERIALIZED (SELECT * FROM relations WHERE nspname='public' AND relname='memory_head_invalidation_runs'),
columns AS MATERIALIZED (SELECT a.* FROM pg_catalog.pg_attribute a JOIN receipt r ON r.oid=a.attrelid WHERE a.attnum>0 LIMIT 22),
ledger_columns AS MATERIALIZED (SELECT a.* FROM pg_catalog.pg_attribute a JOIN relations r ON r.oid=a.attrelid
  WHERE r.nspname='drizzle' AND a.attname IN ('hash','created_at') LIMIT 3),
constraints AS MATERIALIZED (SELECT c.* FROM pg_catalog.pg_constraint c JOIN receipt r ON r.oid=c.conrelid LIMIT 9),
indexes AS MATERIALIZED (SELECT i.*,r.relnamespace FROM pg_catalog.pg_index i JOIN receipt r ON r.oid=i.indrelid LIMIT 2),
policies AS MATERIALIZED (SELECT p.*,r.relname FROM pg_catalog.pg_policy p JOIN relations r ON r.oid=p.polrelid WHERE r.nspname='public' LIMIT 10)
SELECT pg_catalog.current_setting('server_version_num')::integer AS version,
 (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',r.relname,'schema',r.nspname,
   'kind',r.relkind,'persistence',r.relpersistence,'partition',r.relispartition,'rls',r.relrowsecurity,'force',r.relforcerowsecurity,
   'inheritance',EXISTS(SELECT 1 FROM pg_catalog.pg_inherits h WHERE h.inhrelid=r.oid OR h.inhparent=r.oid LIMIT 1))), '[]'::jsonb) FROM relations r) AS relations,
 (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('table','memory_head_invalidation_runs','name',a.attname,
   'position',a.attnum,'typeSchema',tn.nspname,'type',t.typname,'typmod',a.atttypmod,'notNull',a.attnotnull,
   'generated',a.attgenerated,'identity',a.attidentity,'dropped',a.attisdropped,
   'collationResolved',a.attcollation=0 OR (co.oid IS NOT NULL AND cn.oid IS NOT NULL),
   'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||co.collname END)), '[]'::jsonb)
   FROM columns a LEFT JOIN pg_catalog.pg_type t ON t.oid=a.atttypid LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
   LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace) AS columns,
 (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('table','__drizzle_migrations','name',a.attname,
   'typeSchema',tn.nspname,'type',t.typname,'typmod',a.atttypmod,'notNull',a.attnotnull,
   'generated',a.attgenerated,'identity',a.attidentity,'dropped',a.attisdropped)), '[]'::jsonb)
   FROM ledger_columns a LEFT JOIN pg_catalog.pg_type t ON t.oid=a.atttypid LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace) AS "ledgerColumns",
 (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',c.conname,'type',c.contype,
   'keys',CASE WHEN pg_catalog.cardinality(c.conkey)<=6 THEN (SELECT pg_catalog.jsonb_agg(a.attname ORDER BY k.n)
     FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY k(num,n) LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num) END,
   'expression',CASE WHEN c.contype='c' AND pg_catalog.octet_length(pg_catalog.pg_get_expr(c.conbin,c.conrelid))<=4096
     THEN pg_catalog.pg_get_expr(c.conbin,c.conrelid) END,
   'expressionSafe',c.contype='p' OR (c.contype='c' AND pg_catalog.octet_length(pg_catalog.pg_get_expr(c.conbin,c.conrelid))<=4096),
   'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred,'local',c.conislocal,
   'inherited',c.coninhcount,'parent',c.conparentid::text,'noInherit',c.connoinherit,
   'dependencies',CASE WHEN c.contype='c' THEN (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
     'safe',d.objsubid=0 AND d.refclassid='pg_catalog.pg_class'::pg_catalog.regclass AND r.oid=c.conrelid
       AND d.refobjsubid>0 AND a.attnum IS NOT NULL AND NOT a.attisdropped,
     'kind',d.deptype,'relation',r.relname,'column',a.attname)), '[]'::jsonb)
     FROM (SELECT * FROM pg_catalog.pg_depend WHERE classid='pg_catalog.pg_constraint'::pg_catalog.regclass AND objid=c.oid LIMIT 17) d
     LEFT JOIN pg_catalog.pg_class r ON r.oid=d.refobjid AND d.refclassid='pg_catalog.pg_class'::pg_catalog.regclass
     LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attnum=d.refobjsubid) END)), '[]'::jsonb) FROM constraints c) AS constraints,
 (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',ic.relname,'schema',ns.nspname,'kind',ic.relkind,
   'binding',c.oid IS NOT NULL AND c.conindid=i.indexrelid AND c.conrelid=i.indrelid AND ic.relnamespace=i.relnamespace,
   'method',am.amname,'key',a.attname,'typeBinding',t.typname='uuid' AND tn.nspname='pg_catalog' AND o.opcintype=t.oid,
   'opclass',onsp.nspname||'.'||o.opcname,'defaultOpclass',o.opcdefault,
   'unique',i.indisunique,'primary',i.indisprimary,'immediate',i.indimmediate,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,
   'keyCount',i.indnkeyatts,'attributeCount',i.indnatts,'predicateNull',i.indpred IS NULL,'expressionsNull',i.indexprs IS NULL,
   'collationZero',pg_catalog.cardinality(i.indcollation::oid[])=1 AND i.indcollation[0]=0,
   'optionZero',pg_catalog.cardinality(i.indoption::smallint[])=1 AND i.indoption[0]=0)), '[]'::jsonb)
   FROM indexes i LEFT JOIN constraints c ON c.contype='p' AND c.conindid=i.indexrelid
   LEFT JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid LEFT JOIN pg_catalog.pg_namespace ns ON ns.oid=ic.relnamespace
   LEFT JOIN pg_catalog.pg_am am ON am.oid=ic.relam
   LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND pg_catalog.cardinality(i.indkey::smallint[])=1 AND a.attnum=i.indkey[0]
   LEFT JOIN pg_catalog.pg_type t ON t.oid=a.atttypid LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
   LEFT JOIN pg_catalog.pg_opclass o ON pg_catalog.cardinality(i.indclass::oid[])=1 AND o.oid=i.indclass[0] AND o.opcmethod=ic.relam
   LEFT JOIN pg_catalog.pg_namespace onsp ON onsp.oid=o.opcnamespace) AS indexes,
 (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('table',p.relname,'name',p.polname,'command',p.polcmd,
   'permissive',p.polpermissive,'publicOnly',pg_catalog.cardinality(p.polroles)=1 AND p.polroles[1]=0,
   'using',CASE WHEN pg_catalog.octet_length(pg_catalog.pg_get_expr(p.polqual,p.polrelid))<=4096 THEN pg_catalog.pg_get_expr(p.polqual,p.polrelid) END,
   'check',CASE WHEN pg_catalog.octet_length(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))<=4096 THEN pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) END,
   'expressionsSafe',(p.polqual IS NULL OR pg_catalog.octet_length(pg_catalog.pg_get_expr(p.polqual,p.polrelid))<=4096)
     AND (p.polwithcheck IS NULL OR pg_catalog.octet_length(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))<=4096),
   'dependencies',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
     'safe',d.objsubid=0 AND d.refclassid='pg_catalog.pg_class'::pg_catalog.regclass AND rn.nspname='public'
       AND (d.refobjsubid=0 OR (a.attnum IS NOT NULL AND NOT a.attisdropped)),
     'kind',d.deptype,'relation',r.relname,'column',CASE WHEN d.refobjsubid=0 THEN NULL ELSE a.attname END)), '[]'::jsonb)
     FROM (SELECT * FROM pg_catalog.pg_depend WHERE classid='pg_catalog.pg_policy'::pg_catalog.regclass AND objid=p.oid LIMIT 17) d
     LEFT JOIN pg_catalog.pg_class r ON r.oid=d.refobjid AND d.refclassid='pg_catalog.pg_class'::pg_catalog.regclass
     LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid=r.relnamespace
     LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attnum=d.refobjsubid))), '[]'::jsonb) FROM policies p) AS policies,
 (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('timestamp',l.created_at::text,
   'hash',CASE WHEN pg_catalog.octet_length(l.hash)=64 THEN l.hash END,'hashSafe',pg_catalog.octet_length(l.hash)=64)), '[]'::jsonb)
   FROM (SELECT hash,created_at FROM drizzle.__drizzle_migrations
     WHERE created_at IN (1790553601000,1790553602000,1790812800000)
       OR hash IN ('d1bc52dd84d079342a544e1d3d89489d65a17de1edce648435a6ef2a0106fc5c',
         '96e2bc6c743fe74e3624646288b624064cfb10979358af09936e8d468bfcc297',
         '7612017368287c81176a9c590a7a48ad71fe539f0cd1e67528fe97a0221b8b36') LIMIT 7) l) AS ledger,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attrdef d JOIN receipt r ON r.oid=d.adrelid LIMIT 1) AS "noDefaults",
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t JOIN receipt r ON r.oid=t.tgrelid LIMIT 1) AS "noTriggers",
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite w JOIN receipt r ON r.oid=w.ev_class LIMIT 1) AS "noRules"`;

function proof(reason: MemoryMaintenanceCatalogProof['reason'], digest: string | null = null,
  composed = false): MemoryMaintenanceCatalogProof {
  return Object.freeze({ formatVersion: 1, scope: composed ? 'memory-maintenance-composed-observations' : 'memory-maintenance-receipt-policy-ledger',
    status: reason === null ? 'verified' : 'refused', reason, descriptorSha256: digest, canBackfill: false, canApply: false,
    canActivate: false, provesCompleteCatalog: false, provesExecutionResolution: false, provesCoherentSnapshot: false });
}
function record(value: unknown): value is Descriptor {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function rows(value: unknown): value is Descriptor[] { return Array.isArray(value) && value.every(record); }
function dependencyKey(row: Descriptor, policy: boolean): string | null {
  if (row.safe !== true || typeof row.relation !== 'string') return null;
  if (row.column === null) return policy ? row.relation : null;
  if (typeof row.column !== 'string') return null;
  return `${row.relation}.${row.column}`;
}
function appendDependency(row: Descriptor, key: string, automatic: string[], normal: string[]): boolean {
  if (row.kind === 'a') automatic.push(key);
  else if (row.kind === 'n' && row.column !== null) normal.push(key);
  else return false;
  return true;
}
function normalizeDependencies(value: unknown, policy: boolean): Descriptor | null {
  if (!rows(value) || value.length > 16) return null;
  const automatic: string[] = [], normal: string[] = [];
  for (const row of value) {
    const key = dependencyKey(row, policy);
    if (key === null || !appendDependency(row, key, automatic, normal)) return null;
  }
  if (!policy && new Set(normal).size !== normal.length) return null;
  if (new Set(automatic).size !== automatic.length) return null;
  automatic.sort(ordinal);
  const uniqueNormal = [...new Set(normal)];
  uniqueNormal.sort(ordinal);
  return { safe: true, bounded: true, automatic, normal: uniqueNormal };
}
function collectionRefusal(key: string, value: unknown, descriptors: Descriptor[]): MemoryMaintenanceCatalogProof['reason'] {
  if (!rows(value) || value.length !== descriptors.length) return 'incomplete_observation';
  const captured = value.map(row => ({ ...row }));
  if (key === 'constraints' || key === 'policies') {
    for (const row of captured) if (row.dependencies !== null) row.dependencies = normalizeDependencies(row.dependencies, key === 'policies');
  }
  const valid = key === 'ledger'
    ? descriptors.every(descriptor => captured.filter(row => isDeepStrictEqual(row, descriptor)).length === 1)
    : matches(captured, descriptors);
  return valid ? null : 'contract_mismatch';
}
function matches(actual: Descriptor[], wanted: Descriptor[]): boolean {
  return wanted.every(descriptor => {
    const found = actual.filter(row => row.name === descriptor.name && row.table === descriptor.table
      && (descriptor.schema === undefined || row.schema === descriptor.schema));
    return found.length === 1 && Object.entries(descriptor).every(([key, value]) => isDeepStrictEqual(found[0][key], value));
  });
}
/** Caller transaction, one observation; no locks, role changes or resolution proof. */
export async function verifyDatabaseMemoryMaintenanceCatalog(tx: DrizzleTx): Promise<MemoryMaintenanceCatalogProof> {
  try {
    const observed = await tx.execute(OBSERVE);
    if (!rows(observed) || observed.length !== 1) return proof('incomplete_observation');
    const value = observed[0];
    if (!Number.isInteger(value.version) || Number(value.version) < 170000 || Number(value.version) >= 180000) return proof('unsupported_server');
    const wanted = expected();
    for (const [key, descriptors] of Object.entries(wanted)) {
      const reason = collectionRefusal(key, value[key], descriptors);
      if (reason !== null) return proof(reason);
    }
    if (value.noDefaults !== true || value.noTriggers !== true || value.noRules !== true) return proof('contract_mismatch');
    const encoded = JSON.stringify({ formatVersion: 1, scope: 'memory-maintenance-receipt-policy-ledger', ...wanted,
      noDefaults: true, noTriggers: true, noRules: true, canBackfill: false, canApply: false, canActivate: false,
      provesCompleteCatalog: false, provesExecutionResolution: false, provesCoherentSnapshot: false });
    return proof(null, createHash('sha256').update(encoded, 'utf8').digest('hex'));
  } catch { return proof('query_failed'); }
}
/** Actual reads on one caller tx; multiple READ COMMITTED observations are NOT a snapshot proof. */
export async function observeDatabaseMemoryMaintenanceCatalog(tx: DrizzleTx): Promise<MemoryMaintenanceCatalogProof> {
  const functions = await verifyDatabaseMemoryInvalidationCatalog(tx);
  if (functions.status !== 'verified') return proof(functions.reason, null, true);
  const structure = await verifyDatabaseMemoryInvalidationStructure(tx);
  if (structure.status !== 'verified') return proof(structure.reason, null, true);
  const maintenance = await verifyDatabaseMemoryMaintenanceCatalog(tx);
  if (maintenance.status !== 'verified') return proof(maintenance.reason, null, true);
  const encoded = JSON.stringify({ formatVersion: 1, scope: 'memory-maintenance-composed-observations',
    functions: functions.descriptorSha256, structure: structure.descriptorSha256, maintenance: maintenance.descriptorSha256,
    canBackfill: false, canApply: false, canActivate: false, provesCompleteCatalog: false,
    provesExecutionResolution: false, provesCoherentSnapshot: false });
  return proof(null, createHash('sha256').update(encoded, 'utf8').digest('hex'), true);
}
