/** Boot-specific mode/handoff contracts; not a complete execution-resolution proof. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '../database/db-utils.js';

const COLUMNS: Record<string, readonly string[]> = {
  memory_backend_modes: ['user_id:uuid:true', 'backend:text:true', 'protocol_version:int4:true',
    'profile:text:true', 'mode:text:true', 'generation:int8:true'],
  memory_candidate_quotas: ['user_id:uuid:true', 'retained_rows:int4:true', 'retained_bytes:int8:true'],
  memory_candidate_handoffs: ['id:uuid:true', 'user_id:uuid:true', 'envelope:bytea:true', 'digest:text:true',
    'retire_hash:text:true', 'envelope_bytes:int4:true', 'status:text:true', 'committed_token:jsonb:false', 'created_at:timestamptz:true'],
};
const GUARDS = {
  memory_backend_modes_guard: { relation: 'memory_backend_modes', definer: false,
    body: '655ebe25ccf4e29b70a777d67e1fedec04d5595477eb3b6372e542fa46019bbd' },
  memory_candidate_handoff_guard: { relation: 'memory_candidate_handoffs', definer: true,
    body: '7fddcb5cf098a61473c47f190c3f8387219676e881deea90fb82b29859d0b615' },
};
const TENANT = "user_id = NULLIF(current_setting('app.current_user_id'::text, true), ''::text)::uuid";
const QUOTA_OWNER = "CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner\n   FROM pg_class\n  WHERE pg_class.oid = 'public.memory_candidate_quotas'::regclass::oid))";
const POLICIES = [
  ['memory_backend_modes', 'memory_backend_modes_select', 'r', TENANT, null],
  ['memory_backend_modes', 'memory_backend_modes_lock', 'w', TENANT, 'false'],
  ['memory_candidate_quotas', 'memory_candidate_quota_owner', '*', QUOTA_OWNER, QUOTA_OWNER],
  ['memory_candidate_handoffs', 'memory_candidate_handoff_select', 'r', TENANT, null],
  ['memory_candidate_handoffs', 'memory_candidate_handoff_insert', 'a', null, TENANT],
  ['memory_candidate_handoffs', 'memory_candidate_handoff_update', 'w', TENANT, TENANT],
  ['memory_candidate_handoffs', 'memory_candidate_handoff_delete', 'd', `${TENANT} AND status = 'published'::text`, null],
];
// Exact PG17 rendered predicates; parentheses and casts are part of the contract.
const CHECKS: Record<string, readonly string[]> = {
  "memory_backend_modes": [
    "backend = 'database'::text",
    "generation > 0",
    "mode = ANY (ARRAY['legacy'::text, 'guarded'::text, 'read_only'::text])",
    "length(profile) > 0",
    "protocol_version > 0"
  ],
  "memory_candidate_quotas": [
    "retained_bytes >= 0 AND retained_bytes <= 67108864",
    "retained_rows >= 0 AND retained_rows <= 64"
  ],
  "memory_candidate_handoffs": [
    "envelope_bytes = (octet_length(envelope) + COALESCE(octet_length(committed_token::text), 0))",
    "(status = ANY (ARRAY['prepared'::text, 'refused'::text])) AND committed_token IS NULL OR (status = ANY (ARRAY['committed'::text, 'published'::text])) AND committed_token IS NOT NULL AND jsonb_typeof(committed_token) = 'object'::text",
    "committed_token IS NULL OR octet_length(committed_token::text) <= 4096",
    "digest ~ '^[0-9a-f]{64}$'::text",
    "envelope_bytes >= 1 AND envelope_bytes <= 1048576",
    "octet_length(envelope) >= 1 AND octet_length(envelope) <= 1048576",
    "retire_hash ~ '^[0-9a-f]{64}$'::text",
    "status = ANY (ARRAY['prepared'::text, 'refused'::text, 'committed'::text, 'published'::text])"
  ]
};
const PRIMARY_KEYS: Record<string, readonly string[]> = {
  memory_backend_modes: ['user_id', 'backend'], memory_candidate_quotas: ['user_id'], memory_candidate_handoffs: ['id'],
};

// Preserve quoted literals, parentheses and casts. Ignore only outside-literal
// whitespace/case in the pinned PG17 rendering; this is not SQL equivalence.
function expression(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('Unknown memory catalog expression');
  return value.split(/('(?:''|[^'])*')/u).map((part, index) => index % 2
    ? part : part.replace(/\s/gu, '').toLowerCase()).join('');
}

export async function requireGuardedMemoryBootCatalog(tx: DrizzleTx): Promise<void> {
  // Deterministic schema qualification in pg_get_expr's regclass rendering.
  await tx.execute(sql`SET LOCAL search_path = 'pg_catalog'`);
  const relations = await tx.execute(sql`SELECT c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
    ARRAY(SELECT tn.nspname || ':' || a.attname || ':' || t.typname || ':' || a.attnotnull::text
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
      JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY a.attnum) AS columns
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('memory_backend_modes','memory_candidate_quotas','memory_candidate_handoffs')`);
  if (relations.length !== 3 || relations.some(row => typeof row.relname !== 'string' ||
      !COLUMNS[row.relname] || row.relkind !== 'r' || row.relrowsecurity !== true || row.relforcerowsecurity !== true ||
      !isDeepStrictEqual(row.columns, COLUMNS[row.relname].map(column => `pg_catalog:${column}`)))) {
    throw new Error('Guarded memory relation contract refused');
  }

  await requireConstraints(tx);

  const guards = await tx.execute(sql`SELECT p.proname, p.prosecdef, p.proconfig, p.prosrc, p.pronargs,
    p.prorettype='pg_catalog.trigger'::regtype AS returns_trigger, l.lanname,
    c.relname, p.proowner=c.relowner AS same_owner,
    t.tgenabled, t.tgtype, t.tgisinternal, t.tgqual IS NULL AS no_qualification,
    octet_length(t.tgargs)=0 AS no_arguments, t.tgattr::text='' AS no_columns
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    JOIN pg_catalog.pg_trigger t ON t.tgfoid=p.oid
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace cn ON cn.oid=c.relnamespace
    WHERE n.nspname='public' AND cn.nspname='public'
      AND p.proname IN ('memory_backend_modes_guard','memory_candidate_handoff_guard')
      AND octet_length(p.prosrc)<=16384`);
  if (guards.length !== 2 || guards.some(row => {
    const expected = GUARDS[row.proname as keyof typeof GUARDS];
    return !expected || row.relname !== expected.relation || row.prosecdef !== expected.definer ||
      row.pronargs !== 0 || row.returns_trigger !== true || row.lanname !== 'plpgsql' || row.same_owner !== true ||
      !isDeepStrictEqual(row.proconfig, ['search_path=pg_catalog']) || typeof row.prosrc !== 'string' ||
      createHash('sha256').update(row.prosrc.trim()).digest('hex') !== expected.body ||
      row.tgenabled !== 'O' || row.tgtype !== 31 || row.tgisinternal !== false ||
      row.no_qualification !== true || row.no_arguments !== true || row.no_columns !== true;
  })) throw new Error('Guarded memory trigger contract refused');

  const policies = await tx.execute(sql`SELECT c.relname, p.polname, p.polcmd, p.polpermissive,
    p.polroles::text AS roles, pg_catalog.pg_get_expr(p.polqual,p.polrelid,true) AS qualification,
    pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid,true) AS checking
    FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('memory_backend_modes','memory_candidate_quotas','memory_candidate_handoffs')`);
  const actual = policies.map(row => [row.relname, row.polname, row.polcmd,
    expression(row.qualification), expression(row.checking)]);
  const expected = POLICIES.map(([relation, name, command, qualification, checking]) =>
    [relation, name, command, expression(qualification), expression(checking)]);
  const sort = (values: unknown[][]) => values.map(value => JSON.stringify(value)).sort();
  if (policies.some(row => row.polpermissive !== true || row.roles !== '{0}') ||
      !isDeepStrictEqual(sort(actual), sort(expected))) throw new Error('Guarded memory policy contract refused');
  // The existing Drizzle schema binds unqualified relation names to public.
  // Keep catalog builtins first while restoring that pinned relation schema.
  await tx.execute(sql`SET LOCAL search_path = 'pg_catalog', 'public'`);
}

async function requireConstraints(tx: DrizzleTx): Promise<void> {
  const rows = await tx.execute(sql`SELECT r.relname,c.contype,c.convalidated,c.condeferrable,c.condeferred,
    c.conislocal,c.coninhcount,c.conparentid::text AS parent,
    ARRAY(SELECT a.attname FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY k(num,position)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.position) AS keys,
    CASE WHEN c.contype='c' AND octet_length(pg_catalog.pg_get_expr(c.conbin,c.conrelid,true))<=4096
      THEN pg_catalog.pg_get_expr(c.conbin,c.conrelid,true) END AS expression,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_constraint'::regclass
      AND d.objid=c.oid AND d.refclassid IN ('pg_catalog.pg_operator'::regclass,'pg_catalog.pg_proc'::regclass)) AS builtin_only,
    i.indisunique,i.indisprimary,i.indisvalid,i.indisready,i.indislive,
    i.indpred IS NULL AND i.indexprs IS NULL AS plain_index,
    i.indnkeyatts=cardinality(c.conkey) AND i.indnatts=cardinality(c.conkey) AS exact_index_keys
    FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class r ON r.oid=c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=r.relnamespace
    LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.conindid AND i.indrelid=c.conrelid
    WHERE n.nspname='public' AND r.relname IN ('memory_backend_modes','memory_candidate_quotas','memory_candidate_handoffs')
    LIMIT 20`);
  if (rows.length !== 18 || rows.some(row => row.convalidated !== true || row.condeferrable !== false ||
      row.condeferred !== false || row.conislocal !== true || row.coninhcount !== 0 || row.parent !== '0')) {
    throw new Error('Guarded memory constraint contract refused');
  }
  for (const relation of Object.keys(CHECKS)) {
    const primary = rows.filter(row => row.relname === relation && row.contype === 'p');
    if (primary.length !== 1 || !isDeepStrictEqual(primary[0].keys, PRIMARY_KEYS[relation]) ||
        ['indisunique','indisprimary','indisvalid','indisready','indislive','plain_index','exact_index_keys']
          .some(key => primary[0][key] !== true)) throw new Error('Guarded memory primary key refused');
    const checks = rows.filter(row => row.relname === relation && row.contype === 'c');
    if (checks.some(row => row.builtin_only !== true || typeof row.expression !== 'string') ||
        !isDeepStrictEqual(checks.map(row => expression(row.expression)).sort(), CHECKS[relation].map(expression).sort())) {
      throw new Error('Guarded memory bounds or outcome constraints refused');
    }
  }
}
