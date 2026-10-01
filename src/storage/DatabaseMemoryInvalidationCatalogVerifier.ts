/** Dormant, partial PG17 metadata proof. Never authorizes maintenance writes. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '../database/db-utils.js';

export interface MemoryInvalidationCatalogProof {
  readonly formatVersion: 1;
  readonly scope: 'memory-invalidation-functions-and-user-triggers';
  readonly status: 'verified' | 'refused';
  readonly reason: 'unsupported_server' | 'incomplete_observation' | 'contract_mismatch' | 'query_failed' | null;
  readonly descriptorSha256: string | null;
  readonly canBackfill: false;
  readonly canApply: false;
  readonly canActivate: false;
  readonly provesExecutionResolution: false;
}

interface FunctionContract {
  readonly name: string;
  readonly args: readonly string[];
  readonly argNames: readonly string[] | null;
  readonly returns: string;
  readonly body: string;
}
// Pinned reviewed artifacts, not expectations learned from the live database.
const FUNCTIONS: readonly FunctionContract[] = [
  { name: "bump_element_storage_revision", args: [], argNames: null, returns: "trigger", body: `
BEGIN
  NEW.storage_revision := OLD.storage_revision + 1;
  IF OLD.element_type = 'memories' AND NEW.raw_content IS DISTINCT FROM OLD.raw_content THEN
    NEW.memory_entries_out_of_sync := TRUE;
  END IF;
  RETURN NEW;
END;
` },
  { name: "mark_memory_head_out_of_sync", args: ["uuid", "uuid"], argNames: ["p_memory_id", "p_user_id"], returns: "bool", body: `
DECLARE affected INTEGER;
BEGIN
  UPDATE "elements" SET "updated_at" = NOW(), "memory_entries_out_of_sync" = TRUE
    WHERE "id" = p_memory_id AND "user_id" = p_user_id AND "element_type" = 'memories';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
` },
  { name: "bump_memory_entry_head_revision", args: [], argNames: null, returns: "trigger", body: `
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT mark_memory_head_out_of_sync(NEW."memory_id", NEW."user_id") THEN
      RAISE EXCEPTION 'Memory entry owner does not match a live memory head' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    -- Cascading parent deletion has no remaining head to invalidate.
    PERFORM mark_memory_head_out_of_sync(OLD."memory_id", OLD."user_id");
    RETURN OLD;
  END IF;

  -- Moving an entry between heads is not exposed by the application, but a
  -- direct UPDATE must invalidate both snapshots. Use a stable update order.
  IF (OLD."memory_id", OLD."user_id") IS DISTINCT FROM (NEW."memory_id", NEW."user_id") THEN
    IF OLD."memory_id" < NEW."memory_id" THEN
      IF NOT mark_memory_head_out_of_sync(OLD."memory_id", OLD."user_id") OR
         NOT mark_memory_head_out_of_sync(NEW."memory_id", NEW."user_id") THEN
        RAISE EXCEPTION 'Memory entry owner does not match a live memory head' USING ERRCODE = '23503';
      END IF;
    ELSE
      IF NOT mark_memory_head_out_of_sync(NEW."memory_id", NEW."user_id") OR
         NOT mark_memory_head_out_of_sync(OLD."memory_id", OLD."user_id") THEN
        RAISE EXCEPTION 'Memory entry owner does not match a live memory head' USING ERRCODE = '23503';
      END IF;
    END IF;
  ELSE
    IF NOT mark_memory_head_out_of_sync(NEW."memory_id", NEW."user_id") THEN
      RAISE EXCEPTION 'Memory entry owner does not match a live memory head' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
` },
  { name: "invalidate_memory_tag_owner", args: ["uuid", "uuid", "bool"], argNames: ["p_element_id", "p_user_id", "p_deleting"], returns: "void", body: `
DECLARE parent_type VARCHAR; parent_user UUID;
BEGIN
  SELECT element_type, user_id INTO parent_type, parent_user
    FROM elements WHERE id = p_element_id;
  IF NOT FOUND THEN
    -- Parent/account cascades can already have removed the parent. DELETE
    -- also permits cleanup of legacy tags whose parent is invisible to RLS.
    IF p_deleting THEN RETURN; END IF;
    RAISE EXCEPTION 'Tag owner does not match a visible live head' USING ERRCODE = '23503';
  END IF;
  -- Preserve existing tag behavior for visible non-memory elements.
  IF parent_type <> 'memories' THEN RETURN; END IF;
  IF parent_user IS DISTINCT FROM p_user_id OR
     p_user_id IS DISTINCT FROM current_setting('app.current_user_id', true)::uuid THEN
    -- A visible malformed memory tag can affect public tag projections.
    -- Fail closed even on deletion; audited legacy cleanup is a release gate.
    RAISE EXCEPTION 'Tag owner does not match a live memory head' USING ERRCODE = '23503';
  END IF;
  IF NOT mark_memory_head_out_of_sync(p_element_id, p_user_id) THEN
    IF p_deleting THEN RETURN; END IF;
    RAISE EXCEPTION 'Tag owner does not match a live memory head' USING ERRCODE = '23503';
  END IF;
END;
` },
  { name: "bump_memory_tag_head_revision", args: [], argNames: null, returns: "trigger", body: `
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM invalidate_memory_tag_owner(NEW.element_id, NEW.user_id, FALSE);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM invalidate_memory_tag_owner(OLD.element_id, OLD.user_id, TRUE);
    RETURN OLD;
  END IF;
  IF (OLD.element_id, OLD.user_id) IS DISTINCT FROM (NEW.element_id, NEW.user_id) THEN
    -- Invalidate each distinct owner once, in global order. This does not
    -- eliminate tag-row -> parent versus whole-save parent -> tag deadlocks.
    IF (OLD.element_id, OLD.user_id) < (NEW.element_id, NEW.user_id) THEN
      PERFORM invalidate_memory_tag_owner(OLD.element_id, OLD.user_id, FALSE);
      PERFORM invalidate_memory_tag_owner(NEW.element_id, NEW.user_id, FALSE);
    ELSE
      PERFORM invalidate_memory_tag_owner(NEW.element_id, NEW.user_id, FALSE);
      PERFORM invalidate_memory_tag_owner(OLD.element_id, OLD.user_id, FALSE);
    END IF;
  ELSE
    PERFORM invalidate_memory_tag_owner(NEW.element_id, NEW.user_id, FALSE);
  END IF;
  RETURN NEW;
END;
` },
];

const TRIGGERS = [
  { table: 'element_tags', name: 'element_tags_memory_head_revision_change', function: 'bump_memory_tag_head_revision', type: 31 },
  { table: 'elements', name: 'elements_storage_revision_update', function: 'bump_element_storage_revision', type: 19 },
  { table: 'memory_entries', name: 'memory_entries_head_revision_change', function: 'bump_memory_entry_head_revision', type: 31 },
] as const;
const TABLES = ['element_tags', 'elements', 'memory_entries'];

// Limits include one overflow sentinel. No unbounded body/config/default value
// leaves PostgreSQL. All catalogs/lookups are explicitly pg_catalog-qualified.
const OBSERVE = sql`WITH relations AS MATERIALIZED (
  SELECT c.oid, n.nspname, c.relname, c.relkind FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('elements','element_tags','memory_entries') LIMIT 4
), functions AS MATERIALIZED (
  SELECT p.oid,p.proname,p.proargtypes,p.prorettype,p.prolang,p.prokind,p.proretset,p.provariadic,
    p.proisstrict,p.prosecdef,p.provolatile,p.proleakproof,p.proparallel,p.pronargdefaults,p.prosupport,p.pronargs,
    p.proconfig IS NULL AS config_null,p.proallargtypes IS NULL AS all_args_null,p.proargmodes IS NULL AS arg_modes_null,
    CASE WHEN pg_catalog.octet_length(p.proargnames::text)<=2048 THEN p.proargnames ELSE NULL END AS arg_names,
    p.proargnames IS NULL OR pg_catalog.octet_length(p.proargnames::text)<=2048 AS arg_names_safe,
    pg_catalog.octet_length(p.prosrc) AS body_bytes,
    CASE WHEN pg_catalog.octet_length(p.prosrc)<=16384 THEN p.prosrc ELSE NULL END AS body,n.nspname
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('bump_element_storage_revision',
    'mark_memory_head_out_of_sync','bump_memory_entry_head_revision',
    'invalidate_memory_tag_owner','bump_memory_tag_head_revision') LIMIT 6
), triggers AS MATERIALIZED (
  SELECT t.tgrelid,t.tgfoid,t.tgname,t.tgtype,t.tgenabled,t.tgnargs,t.tgconstraint,t.tgconstrrelid,t.tgconstrindid,
    t.tgdeferrable,t.tginitdeferred,pg_catalog.octet_length(t.tgargs)=0 AS args_empty,
    pg_catalog.cardinality(t.tgattr::smallint[])=0 AS columns_empty,t.tgqual IS NULL AS qual_null,r.relname
  FROM pg_catalog.pg_trigger t JOIN relations r ON r.oid=t.tgrelid
  WHERE NOT t.tgisinternal LIMIT 4
)
SELECT pg_catalog.current_setting('server_version_num')::integer AS version,
  (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'oid',r.oid::text,'schema',r.nspname,'name',r.relname,'kind',r.relkind)), '[]'::jsonb)
    FROM relations r) AS relations,
  (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'oid',p.oid::text,'schema',p.nspname,'name',p.proname,
    'args',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'schema',tn.nspname,'name',ty.typname) ORDER BY a.ordinality),'[]'::jsonb)
      FROM pg_catalog.unnest(p.proargtypes::oid[]) WITH ORDINALITY a(oid,ordinality)
      JOIN pg_catalog.pg_type ty ON ty.oid=a.oid JOIN pg_catalog.pg_namespace tn ON tn.oid=ty.typnamespace),
    'argNames',p.arg_names,'argNamesSafe',p.arg_names_safe,
    'returns',pg_catalog.jsonb_build_object('schema',rn.nspname,'name',rt.typname),
    'language',l.lanname,'kind',p.prokind,'setReturning',p.proretset,'variadic',p.provariadic::text,
    'strict',p.proisstrict,'definer',p.prosecdef,'volatility',p.provolatile,'leakproof',p.proleakproof,
    'parallel',p.proparallel,'defaults',p.pronargdefaults,'support',p.prosupport::oid::text,
    'configNull',p.config_null,'allArgsNull',p.all_args_null,'argModesNull',p.arg_modes_null,
    'argCount',p.pronargs,'bodyBytes',p.body_bytes,'body',p.body)), '[]'::jsonb)
    FROM functions p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    JOIN pg_catalog.pg_type rt ON rt.oid=p.prorettype JOIN pg_catalog.pg_namespace rn ON rn.oid=rt.typnamespace) AS functions,
  (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'tableOid',t.tgrelid::text,'table',t.relname,'functionOid',t.tgfoid::text,'name',t.tgname,
    'type',t.tgtype,'enabled',t.tgenabled,'args',t.tgnargs,'argsEmpty',t.args_empty,
    'columnsEmpty',t.columns_empty,'qualNull',t.qual_null,
    'constraint',t.tgconstraint::text,'constraintRelation',t.tgconstrrelid::text,'constraintIndex',t.tgconstrindid::text,
    'deferrable',t.tgdeferrable,'initiallyDeferred',t.tginitdeferred)), '[]'::jsonb) FROM triggers t) AS triggers`;

function proof(reason: MemoryInvalidationCatalogProof['reason'], digest: string | null = null): MemoryInvalidationCatalogProof {
  return Object.freeze({ formatVersion: 1, scope: 'memory-invalidation-functions-and-user-triggers',
    status: reason === null ? 'verified' : 'refused', reason, descriptorSha256: digest,
    canBackfill: false, canApply: false, canActivate: false, provesExecutionResolution: false });
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function rows(value: unknown, count: number): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length === count && value.every(record);
}
function oid(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,9}$/u.test(value) && Number(value) <= 4294967295;
}
function matches(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => isDeepStrictEqual(actual[key], value));
}
function functionDescriptor(expected: FunctionContract): Record<string, unknown> {
  return { name: expected.name, schema: 'public', args: expected.args.map(name => ({ schema: 'pg_catalog', name })),
    argNames: expected.argNames, argNamesSafe: true, returns: { schema: 'pg_catalog', name: expected.returns },
    language: 'plpgsql', kind: 'f', setReturning: false, variadic: '0', strict: false,
    definer: false, volatility: 'v', leakproof: false, parallel: 'u', defaults: 0, support: '0',
    configNull: true, allArgsNull: true, argModesNull: true, argCount: expected.args.length,
    bodyBytes: Buffer.byteLength(expected.body, 'utf8'), body: expected.body };
}
function triggerDescriptor(expected: typeof TRIGGERS[number]): Record<string, unknown> {
  return { ...expected, enabled: 'O', args: 0, argsEmpty: true, columnsEmpty: true, qualNull: true,
    constraint: '0', constraintRelation: '0', constraintIndex: '0', deferrable: false, initiallyDeferred: false };
}

/** One statement on the caller transaction; no role, snapshot, timeout or lock changes. */
export async function verifyDatabaseMemoryInvalidationCatalog(tx: DrizzleTx): Promise<MemoryInvalidationCatalogProof> {
  try {
    const observed = await tx.execute(OBSERVE);
    if (!rows(observed, 1)) return proof('incomplete_observation');
    const observation = observed[0];
    if (!Number.isInteger(observation.version) || Number(observation.version) < 170000 || Number(observation.version) >= 180000) {
      return proof('unsupported_server');
    }
    if (!rows(observation.relations, 3) || !rows(observation.functions, 5) || !rows(observation.triggers, 3)) {
      return proof('incomplete_observation');
    }
    const relations = observation.relations;
    const functions = observation.functions;
    const triggers = observation.triggers;
    const relationIds = new Set<string>();
    const functionIds = new Set<string>();
    for (const name of TABLES) {
      const found = relations.filter(item => item.name === name);
      if (found.length !== 1 || !matches(found[0], { schema: 'public', kind: 'r' }) || !oid(found[0].oid)) {
        return proof('contract_mismatch');
      }
      relationIds.add(found[0].oid);
    }
    for (const expected of FUNCTIONS) {
      const found = functions.filter(item => item.name === expected.name);
      if (found.length !== 1) return proof('contract_mismatch');
      const actual = found[0];
      if (!oid(actual.oid) || !matches(actual, functionDescriptor(expected))) return proof('contract_mismatch');
      functionIds.add(actual.oid);
    }
    if (relationIds.size !== 3 || functionIds.size !== 5) return proof('contract_mismatch');
    for (const expected of TRIGGERS) {
      const found = triggers.filter(item => item.name === expected.name);
      const boundFunction = functions.find(item => item.name === expected.function);
      if (found.length !== 1 || !matches({ ...found[0], function: boundFunction?.name }, {
        ...triggerDescriptor(expected), tableOid: relations.find(item => item.name === expected.table)?.oid,
        functionOid: boundFunction?.oid,
      })) return proof('contract_mismatch');
    }
    // Only portable reviewed semantics enter this digest, never instance OIDs.
    const encoded = JSON.stringify({ formatVersion: 1, scope: 'memory-invalidation-functions-and-user-triggers',
      relations: TABLES.map(name => ({ name, schema: 'public', kind: 'r' })),
      functions: FUNCTIONS.map(functionDescriptor), triggers: TRIGGERS.map(triggerDescriptor),
      canBackfill: false, canApply: false, canActivate: false,
      provesExecutionResolution: false });
    return proof(null, createHash('sha256').update(encoded, 'utf8').digest('hex'));
  } catch {
    // No SQL, driver message, cause, credentials or function body in refusal.
    return proof('query_failed');
  }
}
