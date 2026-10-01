/** Dormant PG17 required-structure observation; never maintenance authority. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '../database/db-utils.js';

export interface MemoryInvalidationStructureProof {
  readonly formatVersion: 1;
  readonly scope: 'memory-invalidation-required-structure';
  readonly status: 'verified' | 'refused';
  readonly reason: 'unsupported_server' | 'incomplete_observation' | 'contract_mismatch' | 'query_failed' | null;
  readonly descriptorSha256: string | null;
  readonly canBackfill: false;
  readonly canApply: false;
  readonly canActivate: false;
  readonly provesCompleteCatalog: false;
  readonly provesExecutionResolution: false;
}
const TABLES = ['elements', 'element_tags', 'memory_entries', 'users'];
const COLUMNS: readonly (readonly [string, string, string, number])[] = [
  ['elements', 'id', 'uuid', -1], ['elements', 'user_id', 'uuid', -1],
  ['elements', 'raw_content', 'text', -1], ['elements', 'storage_revision', 'int8', -1],
  ['elements', 'memory_entries_out_of_sync', 'bool', -1], ['elements', 'updated_at', 'timestamptz', -1],
  ['elements', 'element_type', 'varchar', 36], ['elements', 'visibility', 'varchar', 36],
  ['element_tags', 'element_id', 'uuid', -1], ['element_tags', 'user_id', 'uuid', -1],
  ['element_tags', 'tag', 'varchar', 132], ['memory_entries', 'id', 'uuid', -1],
  ['memory_entries', 'user_id', 'uuid', -1], ['memory_entries', 'memory_id', 'uuid', -1], ['users', 'id', 'uuid', -1],
];
const KEYS = [
  { table: 'elements', name: 'elements_pkey', keys: ['id'] },
  { table: 'element_tags', name: 'element_tags_element_id_tag_pk', keys: ['element_id', 'tag'] },
  { table: 'memory_entries', name: 'memory_entries_pkey', keys: ['id'] },
];
const FOREIGN_KEYS = [
  ['elements', 'elements_user_id_users_id_fk', 'user_id', 'users'],
  ['element_tags', 'element_tags_element_id_elements_id_fk', 'element_id', 'elements'],
  ['element_tags', 'element_tags_user_id_users_id_fk', 'user_id', 'users'],
  ['memory_entries', 'memory_entries_memory_id_elements_id_fk', 'memory_id', 'elements'],
  ['memory_entries', 'memory_entries_user_id_users_id_fk', 'user_id', 'users'],
];
type Descriptor = Record<string, unknown>;
const relationDescriptor = (name: string): Descriptor => ({ name, schema: 'public', kind: 'r', persistence: 'p', partition: false });
function columnDescriptor([table, name, type, typmod]: typeof COLUMNS[number]): Descriptor {
  return { table, name, typeSchema: 'pg_catalog', type, typmod, notNull: true,
    generated: '', identity: '', dropped: false, collationResolved: true, collation: ['text', 'varchar'].includes(type) ? 'pg_catalog.default' : null };
}
const constraintFlags = { validated: true, deferrable: false, deferred: false, local: true, inherited: 0, parent: '0' };
const equality = 'pg_catalog.=(pg_catalog.uuid,pg_catalog.uuid)->pg_catalog.uuid_eq';
function referenceIndexDescriptor(table: string): Descriptor {
  return { table, schema: 'public', key: 'id', binding: true, method: 'btree', opclass: 'pg_catalog.uuid_ops',
    defaultOpclass: true, unique: true, immediate: true, valid: true, ready: true, live: true,
    keyCount: 1, attributeCount: 1, predicateNull: true, expressionsNull: true,
    collation: null, collationResolved: true, option: 0 };
}
function riTriggers(table: string, reference: string): Descriptor[] {
  return [['RI_FKey_cascade_del', 9, reference, table], ['RI_FKey_check_ins', 5, table, reference],
    ['RI_FKey_check_upd', 17, table, reference], ['RI_FKey_noaction_upd', 17, reference, table]]
    .map(([name, type, relation, other]) => ({ function: `pg_catalog.${name}`, type, relation, other,
      binding: true, internal: true, enabled: 'O', parent: '0', deferrable: false, deferred: false,
      argumentsEmpty: true, columnsEmpty: true, qualificationNull: true, transitionsNull: true, functionBinding: true }));
}
function constraints(): Descriptor[] {
  return [...KEYS.map(key => ({ ...key, type: 'p', riTriggers: null, referenceIndex: null, equalityOperators: null, referenceBinding: true, referenceSchema: null, reference: null, referenceKeys: null,
    update: ' ', delete: ' ', match: ' ', ...constraintFlags })),
  ...FOREIGN_KEYS.map(([table, name, key, reference]) => ({ table, name, keys: [key], type: 'f', referenceBinding: true,
    riTriggers: riTriggers(table, reference), referenceIndex: referenceIndexDescriptor(reference), equalityOperators: [equality, equality, equality], referenceSchema: 'public',
    reference, referenceKeys: ['id'], update: 'a', delete: 'c', match: 's', ...constraintFlags }))];
}
function indexDescriptor(key: typeof KEYS[number]): Descriptor {
  return { table: key.table, name: key.name, schema: 'public', keys: key.keys, method: 'btree',
    unique: true, primary: true, valid: true, ready: true, live: true, predicateNull: true, expressionsNull: true,
    keyCount: key.keys.length, attributeCount: key.keys.length, binding: true,
    opclasses: key.keys.map(name => name === 'tag' ? 'pg_catalog.text_ops' : 'pg_catalog.uuid_ops'),
    collations: key.keys.map(name => name === 'tag' ? 'pg_catalog.default' : null),
    collationBinding: true, collationResolved: true, options: key.keys.map(() => 0) };
}
const DEFAULTS = [
  { table: 'elements', name: 'storage_revision', expression: '1', safe: true },
  { table: 'elements', name: 'memory_entries_out_of_sync', expression: 'true', safe: true },
];
const CHECK = { table: 'elements', name: 'elements_storage_revision_positive', keys: ['storage_revision'],
  expression: '(storage_revision > 0)', safe: true, builtinExpressionOnly: true, ...constraintFlags };

// Every projected collection has an overflow sentinel. Expressions and key
// vectors retain existence but never project unbounded text/arrays to Node.
const OBSERVE = sql`WITH builtin_equality AS MATERIALIZED (
  SELECT o.oid,u.oid AS uuid_oid FROM pg_catalog.pg_operator o
  JOIN pg_catalog.pg_namespace n ON n.oid=o.oprnamespace AND n.nspname='pg_catalog'
  JOIN pg_catalog.pg_type u ON u.oid=o.oprleft AND u.typname='uuid' AND u.typnamespace=n.oid
  JOIN pg_catalog.pg_type b ON b.oid=o.oprresult AND b.typname='bool' AND b.typnamespace=n.oid
  JOIN pg_catalog.pg_proc p ON p.oid=o.oprcode AND p.pronamespace=n.oid AND p.proname='uuid_eq'
  WHERE o.oprname='=' AND o.oprkind='b' AND o.oprright=u.oid AND p.prokind='f' AND NOT p.proretset
    AND p.prorettype=b.oid AND pg_catalog.cardinality(p.proargtypes::oid[])=2
    AND p.proargtypes[0]=u.oid AND p.proargtypes[1]=u.oid LIMIT 2
), relations AS MATERIALIZED (
  SELECT c.oid,c.relnamespace,n.nspname,c.relname,c.relkind,c.relpersistence,c.relispartition
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('elements','element_tags','memory_entries','users') LIMIT 5
), columns AS MATERIALIZED (
  SELECT a.*,r.relname FROM pg_catalog.pg_attribute a JOIN relations r ON r.oid=a.attrelid
  WHERE (r.relname,a.attname) IN (('elements','id'),('elements','user_id'),('elements','raw_content'),
    ('elements','storage_revision'),('elements','memory_entries_out_of_sync'),('elements','updated_at'),
    ('elements','element_type'),('elements','visibility'),('element_tags','element_id'),('element_tags','user_id'),
    ('element_tags','tag'),('memory_entries','id'),('memory_entries','user_id'),('memory_entries','memory_id'),('users','id')) LIMIT 16
), constraints AS MATERIALIZED (
  SELECT c.*,r.relname FROM pg_catalog.pg_constraint c JOIN relations r ON r.oid=c.conrelid
  WHERE r.relname<>'users' AND c.contype IN ('p','f') LIMIT 9
), checks AS MATERIALIZED (
  SELECT c.*,r.relname FROM pg_catalog.pg_constraint c JOIN relations r ON r.oid=c.conrelid
  WHERE r.relname='elements' AND c.conname='elements_storage_revision_positive' AND c.contype='c' LIMIT 2
), indexes AS MATERIALIZED (
  SELECT i.*,pg_catalog.cardinality(i.indkey::smallint[])<=2 AND pg_catalog.cardinality(i.indclass::oid[])<=2
    AND pg_catalog.cardinality(i.indcollation::oid[])<=2 AND pg_catalog.cardinality(i.indoption::smallint[])<=2 AS vectors_safe,c.conindid,c.conrelid,r.relnamespace,r.relname FROM constraints c
  JOIN pg_catalog.pg_index i ON i.indexrelid=c.conindid JOIN relations r ON r.oid=c.conrelid
  WHERE c.contype='p' LIMIT 4
), defaults AS MATERIALIZED (
  SELECT d.*,a.attname,r.relname FROM pg_catalog.pg_attrdef d
  JOIN columns a ON a.attrelid=d.adrelid AND a.attnum=d.adnum JOIN relations r ON r.oid=d.adrelid
  WHERE r.relname='elements' AND a.attname IN ('storage_revision','memory_entries_out_of_sync') LIMIT 3
)
SELECT pg_catalog.current_setting('server_version_num')::integer AS version,
  EXISTS(SELECT 1 FROM pg_catalog.pg_inherits h WHERE h.inhrelid IN (SELECT oid FROM relations)
    OR h.inhparent IN (SELECT oid FROM relations) LIMIT 1) AS inheritance,
  (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',r.oid::text,
    'name',r.relname,'schema',r.nspname,'kind',r.relkind,'persistence',r.relpersistence,'partition',r.relispartition)), '[]'::jsonb) FROM relations r) AS relations,
  (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('table',a.relname,'name',a.attname,
    'typeSchema',tn.nspname,'type',t.typname,'typmod',a.atttypmod,'notNull',a.attnotnull,
    'generated',a.attgenerated,'identity',a.attidentity,'dropped',a.attisdropped,
    'collationResolved',a.attcollation=0 OR (co.oid IS NOT NULL AND cn.oid IS NOT NULL),
    'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||co.collname END)), '[]'::jsonb)
    FROM columns a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
    LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace) AS columns,
  (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('table',c.relname,'name',c.conname,'type',c.contype,
    'keys',CASE WHEN pg_catalog.cardinality(c.conkey)<=2 THEN (SELECT pg_catalog.jsonb_agg(a.attname ORDER BY k.n)
      FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY k(num,n) LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num) END,
    'referenceBinding',CASE WHEN c.contype='p' THEN c.confrelid=0 ELSE rc.oid IS NOT NULL AND rn.oid IS NOT NULL END,
    'equalityOperators',CASE WHEN c.contype='f' THEN pg_catalog.jsonb_build_array(
      CASE WHEN pg_catalog.cardinality(c.conpfeqop)=1 AND c.conpfeqop[1]=eq.oid THEN 'pg_catalog.=(pg_catalog.uuid,pg_catalog.uuid)->pg_catalog.uuid_eq' END,
      CASE WHEN pg_catalog.cardinality(c.conppeqop)=1 AND c.conppeqop[1]=eq.oid THEN 'pg_catalog.=(pg_catalog.uuid,pg_catalog.uuid)->pg_catalog.uuid_eq' END,
      CASE WHEN pg_catalog.cardinality(c.conffeqop)=1 AND c.conffeqop[1]=eq.oid THEN 'pg_catalog.=(pg_catalog.uuid,pg_catalog.uuid)->pg_catalog.uuid_eq' END) END,
    'referenceIndex',CASE WHEN c.contype='f' THEN pg_catalog.jsonb_build_object(
      'table',rc.relname,'schema',rin.nspname,'key',ra.attname,
      'binding',ri.indexrelid=c.conindid AND ri.indrelid=c.confrelid AND ric.relnamespace=rc.relnamespace
        AND pg_catalog.cardinality(c.confkey)=1 AND pg_catalog.cardinality(ri.indkey::smallint[])=1 AND ri.indkey[0]=c.confkey[1],
      'method',ram.amname,'opclass',ron.nspname||'.'||rop.opcname,'defaultOpclass',rop.opcdefault,
      'unique',ri.indisunique,'immediate',ri.indimmediate,'valid',ri.indisvalid,'ready',ri.indisready,'live',ri.indislive,
      'keyCount',ri.indnkeyatts,'attributeCount',ri.indnatts,'predicateNull',ri.indpred IS NULL,'expressionsNull',ri.indexprs IS NULL,
      'collation',CASE WHEN pg_catalog.cardinality(ri.indcollation::oid[])=1 AND ri.indcollation[0]=0 THEN NULL ELSE 'invalid' END,
      'collationResolved',pg_catalog.cardinality(ri.indcollation::oid[])=1 AND ri.indcollation[0]=0,
      'option',CASE WHEN pg_catalog.cardinality(ri.indoption::smallint[])=1 THEN ri.indoption[0] END) END,
    'riTriggers',CASE WHEN c.contype='f' THEN (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'function',pn.nspname||'.'||p.proname,'type',t.tgtype,'relation',tr.relname,'other',tor.relname,
      'binding',tr.oid IN (c.conrelid,c.confrelid) AND tor.oid IN (c.conrelid,c.confrelid)
        AND tr.relnamespace=rns.oid AND tor.relnamespace=rns.oid AND rns.nspname='public' AND t.tgconstrindid=c.conindid,
      'internal',t.tgisinternal,'enabled',t.tgenabled,'parent',t.tgparentid::text,
      'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,
      'argumentsEmpty',t.tgnargs=0 AND pg_catalog.octet_length(t.tgargs)=0,
      'columnsEmpty',pg_catalog.cardinality(t.tgattr::smallint[])=0,'qualificationNull',t.tgqual IS NULL,
      'transitionsNull',t.tgoldtable IS NULL AND t.tgnewtable IS NULL,
      'functionBinding',pn.nspname='pg_catalog' AND p.prokind='f' AND NOT p.proretset AND p.pronargs=0 AND pg_catalog.cardinality(p.proargtypes::oid[])=0
        AND rt.typname='trigger' AND rtn.nspname='pg_catalog') ORDER BY CASE p.proname WHEN 'RI_FKey_cascade_del' THEN 1 WHEN 'RI_FKey_check_ins' THEN 2
        WHEN 'RI_FKey_check_upd' THEN 3 WHEN 'RI_FKey_noaction_upd' THEN 4 ELSE 5 END)
      FROM (SELECT * FROM pg_catalog.pg_trigger WHERE tgconstraint=c.oid LIMIT 5) t
      LEFT JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
      LEFT JOIN pg_catalog.pg_type rt ON rt.oid=p.prorettype LEFT JOIN pg_catalog.pg_namespace rtn ON rtn.oid=rt.typnamespace
      LEFT JOIN pg_catalog.pg_class tr ON tr.oid=t.tgrelid LEFT JOIN pg_catalog.pg_class tor ON tor.oid=t.tgconstrrelid
      LEFT JOIN pg_catalog.pg_namespace rns ON rns.oid=tr.relnamespace) END,
    'referenceSchema',rn.nspname,'reference',rc.relname,
    'referenceKeys',CASE WHEN pg_catalog.cardinality(c.confkey)<=2 THEN (SELECT pg_catalog.jsonb_agg(a.attname ORDER BY k.n)
      FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY k(num,n) LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num) END,
    'update',c.confupdtype,'delete',c.confdeltype,'match',c.confmatchtype,'validated',c.convalidated,
    'deferrable',c.condeferrable,'deferred',c.condeferred,'local',c.conislocal,'inherited',c.coninhcount,'parent',c.conparentid::text)), '[]'::jsonb)
    FROM constraints c LEFT JOIN pg_catalog.pg_class rc ON rc.oid=c.confrelid LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid=rc.relnamespace
    LEFT JOIN builtin_equality eq ON true LEFT JOIN pg_catalog.pg_index ri ON ri.indexrelid=c.conindid AND c.contype='f'
    LEFT JOIN pg_catalog.pg_class ric ON ric.oid=ri.indexrelid LEFT JOIN pg_catalog.pg_namespace rin ON rin.oid=ric.relnamespace
    LEFT JOIN pg_catalog.pg_am ram ON ram.oid=ric.relam
    LEFT JOIN pg_catalog.pg_attribute ra ON ra.attrelid=ri.indrelid AND ra.attnum=ri.indkey[0]
    LEFT JOIN pg_catalog.pg_opclass rop ON pg_catalog.cardinality(ri.indclass::oid[])=1 AND rop.oid=ri.indclass[0]
      AND rop.opcmethod=ric.relam AND rop.opcintype=eq.uuid_oid
    LEFT JOIN pg_catalog.pg_namespace ron ON ron.oid=rop.opcnamespace) AS constraints,
  (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('table',i.relname,'name',ic.relname,'schema',ns.nspname,
    'binding',i.conindid=i.indexrelid AND i.indrelid=i.conrelid AND ic.relnamespace=i.relnamespace,
    'keys',CASE WHEN i.vectors_safe AND i.indnatts<=2 THEN (SELECT pg_catalog.jsonb_agg(a.attname ORDER BY k.n)
      FROM pg_catalog.unnest(i.indkey::smallint[]) WITH ORDINALITY k(num,n) LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num) END,
    'method',am.amname,'unique',i.indisunique,'primary',i.indisprimary,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,
    'predicateNull',i.indpred IS NULL,'expressionsNull',i.indexprs IS NULL,'keyCount',i.indnkeyatts,'attributeCount',i.indnatts,
    'opclasses',CASE WHEN i.vectors_safe AND i.indnatts<=2 THEN (SELECT pg_catalog.jsonb_agg(n.nspname||'.'||o.opcname ORDER BY k.n)
      FROM pg_catalog.unnest(i.indclass::oid[]) WITH ORDINALITY k(oid,n) LEFT JOIN pg_catalog.pg_opclass o ON o.oid=k.oid AND o.opcmethod=ic.relam LEFT JOIN pg_catalog.pg_namespace n ON n.oid=o.opcnamespace) END,
    'collations',CASE WHEN i.vectors_safe AND i.indnatts<=2 THEN (SELECT pg_catalog.jsonb_agg(CASE WHEN k.oid=0 THEN NULL ELSE n.nspname||'.'||co.collname END ORDER BY k.n)
      FROM pg_catalog.unnest(i.indcollation::oid[]) WITH ORDINALITY k(oid,n) LEFT JOIN pg_catalog.pg_collation co ON co.oid=k.oid LEFT JOIN pg_catalog.pg_namespace n ON n.oid=co.collnamespace) END,
    'collationResolved',CASE WHEN i.vectors_safe AND i.indnatts<=2 THEN NOT EXISTS(SELECT 1
      FROM pg_catalog.unnest(i.indcollation::oid[]) k(oid) LEFT JOIN pg_catalog.pg_collation co ON co.oid=k.oid
      LEFT JOIN pg_catalog.pg_namespace n ON n.oid=co.collnamespace WHERE k.oid<>0 AND (co.oid IS NULL OR n.oid IS NULL)) ELSE false END,
    'collationBinding',CASE WHEN i.vectors_safe AND i.indnatts<=2 THEN NOT EXISTS(SELECT 1 FROM ROWS FROM
      (pg_catalog.unnest(i.indkey::smallint[]),pg_catalog.unnest(i.indcollation::oid[])) AS k(num,collation_oid)
      LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num WHERE a.attcollation IS DISTINCT FROM k.collation_oid) ELSE false END,
    'options',CASE WHEN i.vectors_safe AND i.indnatts<=2 THEN pg_catalog.to_jsonb(i.indoption::smallint[]) END)), '[]'::jsonb)
    FROM indexes i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_namespace ns ON ns.oid=ic.relnamespace JOIN pg_catalog.pg_am am ON am.oid=ic.relam) AS indexes,
  (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('table',c.relname,'name',c.conname,
    'keys',CASE WHEN pg_catalog.cardinality(c.conkey)<=1 THEN (SELECT pg_catalog.jsonb_agg(a.attname ORDER BY k.n)
      FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY k(num,n) LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num) END,
    'expression',CASE WHEN pg_catalog.octet_length(pg_catalog.pg_get_expr(c.conbin,c.conrelid))<=1024 THEN pg_catalog.pg_get_expr(c.conbin,c.conrelid) END,
    'safe',pg_catalog.octet_length(pg_catalog.pg_get_expr(c.conbin,c.conrelid))<=1024,
    'builtinExpressionOnly',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d
      WHERE d.classid='pg_catalog.pg_constraint'::pg_catalog.regclass AND d.objid=c.oid AND d.objsubid=0
      AND d.refclassid IN ('pg_catalog.pg_operator'::pg_catalog.regclass,'pg_catalog.pg_proc'::pg_catalog.regclass) LIMIT 1),
    'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred,'local',c.conislocal,'inherited',c.coninhcount,'parent',c.conparentid::text)), '[]'::jsonb) FROM checks c) AS checks,
  (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('table',d.relname,'name',d.attname,
    'expression',CASE WHEN pg_catalog.octet_length(pg_catalog.pg_get_expr(d.adbin,d.adrelid))<=1024 THEN pg_catalog.pg_get_expr(d.adbin,d.adrelid) END,
    'safe',pg_catalog.octet_length(pg_catalog.pg_get_expr(d.adbin,d.adrelid))<=1024)), '[]'::jsonb) FROM defaults d) AS defaults`;

function proof(reason: MemoryInvalidationStructureProof['reason'], digest: string | null = null): MemoryInvalidationStructureProof {
  return Object.freeze({ formatVersion: 1, scope: 'memory-invalidation-required-structure', status: reason === null ? 'verified' : 'refused',
    reason, descriptorSha256: digest, canBackfill: false, canApply: false, canActivate: false,
    provesCompleteCatalog: false, provesExecutionResolution: false });
}
function record(value: unknown): value is Descriptor {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function rows(value: unknown, count: number): value is Descriptor[] {
  return Array.isArray(value) && value.length === count && value.every(record);
}
function matches(actual: Descriptor[], expected: Descriptor[]): boolean {
  return expected.every(descriptor => {
    const found = actual.filter(row => row.name === descriptor.name && row.table === descriptor.table);
    return found.length === 1 && Object.entries(descriptor).every(([key, value]) => isDeepStrictEqual(found[0][key], value));
  });
}
/** One bounded statement, caller transaction; no effective resolution/DDL protection. */
export async function verifyDatabaseMemoryInvalidationStructure(tx: DrizzleTx): Promise<MemoryInvalidationStructureProof> {
  try {
    const result = await tx.execute(OBSERVE);
    if (!rows(result, 1)) return proof('incomplete_observation');
    const observed = result[0];
    if (!Number.isInteger(observed.version) || Number(observed.version) < 170000 || Number(observed.version) >= 180000) return proof('unsupported_server');
    const expected = { relations: TABLES.map(relationDescriptor), columns: COLUMNS.map(columnDescriptor),
      constraints: constraints(), indexes: KEYS.map(indexDescriptor), checks: [CHECK], defaults: DEFAULTS };
    for (const [key, descriptors] of Object.entries(expected)) {
      if (!rows(observed[key], descriptors.length)) return proof('incomplete_observation');
      if (!matches(observed[key], descriptors)) return proof('contract_mismatch');
    }
    const relations = observed.relations as Descriptor[];
    const ids = relations.map(row => row.oid);
    if (observed.inheritance !== false || ids.some(id => typeof id !== 'string' || !/^[1-9]\d{0,9}$/u.test(id) || Number(id) > 4294967295)
      || new Set(ids).size !== 4) return proof('contract_mismatch');
    const encoded = JSON.stringify({ formatVersion: 1, scope: 'memory-invalidation-required-structure', inheritance: false, ...expected,
      canBackfill: false, canApply: false, canActivate: false, provesCompleteCatalog: false, provesExecutionResolution: false });
    return proof(null, createHash('sha256').update(encoded, 'utf8').digest('hex'));
  } catch { return proof('query_failed'); }
}
