/** Dormant operator-only diagnostics. No report authorizes maintenance writes. */
import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { DatabaseInstance } from '../database/connection.js';
import type { DrizzleTx } from '../database/db-utils.js';

const CEILINGS = { owners: 10_000, tags: 100_000, bytes: 16 * 1024 * 1024, samples: 20, statementMs: 5_000, wallMs: 30_000 };
export interface MemoryTagAuditLimits { readonly owners: number; readonly tags: number; readonly bytes: number; readonly samples: number; readonly statementMs: number; readonly wallMs: number }
export interface MemoryTagAuditOwner { readonly tenantId: string; readonly ownerId: string; readonly revision: string; readonly dirty: boolean }
export interface MemoryTagAuditSample { readonly elementId: string; readonly tagTenantId: string; readonly parentTenantId: string | null; readonly reason: 'orphan' | 'memory_tenant_mismatch'; readonly visibility: string | null }
export interface MemoryTagAuditReport {
  readonly formatVersion: 1;
  readonly status: 'complete' | 'incomplete' | 'unknown';
  readonly canBackfill: false; readonly canApply: false; readonly canActivate: false;
  readonly reason: string | null;
  readonly counts: { readonly owners: number; readonly tags: number; readonly exact: boolean; readonly orphanTags: number; readonly mismatchedPrivateMemoryTags: number; readonly mismatchedPublicMemoryTags: number } | null;
  readonly samplesTruncated: boolean;
  /** Protected attribution, never routine logs or an authorizing receipt. */
  readonly privateReport: { readonly owners: readonly MemoryTagAuditOwner[]; readonly samples: readonly MemoryTagAuditSample[]; readonly manifestSha256: string | null };
}
class AuditRefusal extends Error { constructor(readonly reason: string) { super(reason); } }
function captureLimits(input: MemoryTagAuditLimits): MemoryTagAuditLimits {
  const captured = { ...input };
  for (const key of Object.keys(CEILINGS) as (keyof MemoryTagAuditLimits)[]) {
    const value = captured[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > CEILINGS[key]) throw new RangeError(`Invalid audit limit: ${key}`);
  }
  return Object.freeze(captured);
}
function count(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/u.test(value))) throw new AuditRefusal('invalid_projection');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AuditRefusal('invalid_projection');
  return parsed;
}
function unknownReport(reason: string): MemoryTagAuditReport {
  return { formatVersion: 1, status: 'unknown', canBackfill: false, canApply: false, canActivate: false, reason, counts: null,
    samplesTruncated: false, privateReport: { owners: [], samples: [], manifestSha256: null } };
}
function tagProjection(limit: number): SQL {
  return sql`WITH bounded AS MATERIALIZED (
    SELECT element_id, user_id, tag FROM public.element_tags ORDER BY element_id, tag LIMIT ${limit + 1}
  ), projected AS (
    SELECT b.element_id, b.user_id AS tag_user, p.user_id AS parent_user, p.element_type AS parent_type,
      p.visibility, p.id AS parent_id, row_number() OVER (ORDER BY b.element_id, b.tag) AS ordinal
    FROM bounded b LEFT JOIN public.elements p ON p.id = b.element_id
  )`;
}
/** Requires an explicitly supplied privileged operator connection; never registered in runtime DI. */
export class DatabaseMemoryLegacyTagAuditor {
  constructor(private readonly db: DatabaseInstance) {}

  async inspect(input: MemoryTagAuditLimits): Promise<MemoryTagAuditReport> {
    const limits = captureLimits(input);
    // Report-validity deadline, checked between statements; not cancellation of
    // pool acquisition, transaction setup/commit, network waits or the test barrier.
    const deadline = Date.now() + limits.wallMs;
    try {
      const report = await this.db.transaction(async tx => {
        // Must precede every SELECT, including privilege proof/set_config.
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        const actor = await this.proveScope(tx, limits, deadline);
        await this.afterSnapshot();
        const report = await this.census(tx, limits, deadline);
        const finalActor = await this.proveScope(tx, limits, deadline);
        if (actor !== finalActor) throw new AuditRefusal('scope_changed');
        return report;
      });
      if (Date.now() >= deadline) return unknownReport('deadline');
      return report;
    } catch (error) {
      // Never include SQL text, driver errors, credentials or private content.
      return unknownReport(error instanceof AuditRefusal ? error.reason : 'query_failed');
    }
  }

  /** @internal Deterministic snapshot barrier; no production callback. */
  protected afterSnapshot(): Promise<void> { return Promise.resolve(); }

  private async query(tx: DrizzleTx, limits: MemoryTagAuditLimits, deadline: number, query: SQL): Promise<Record<string, unknown>[]> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AuditRefusal('deadline');
    await tx.execute(sql`SELECT set_config('statement_timeout', ${String(Math.min(remaining, limits.statementMs))}, true)`);
    const rows = await tx.execute(query);
    if (Date.now() >= deadline) throw new AuditRefusal('deadline');
    return Array.from(rows) as Record<string, unknown>[];
  }

  private async proveScope(tx: DrizzleTx, limits: MemoryTagAuditLimits, deadline: number): Promise<string> {
    const [proof] = await this.query(tx, limits, deadline, sql`SELECT current_user AS actor,
      (r.rolsuper OR r.rolbypassrls) AS privileged,
      current_setting('transaction_read_only') = 'on' AS readonly,
      current_setting('transaction_isolation') = 'repeatable read' AS repeatable,
      NOT row_security_active('public.elements') AND NOT row_security_active('public.element_tags') AS global_visibility,
      has_table_privilege(current_user, 'public.elements', 'SELECT') AND
        has_table_privilege(current_user, 'public.element_tags', 'SELECT') AS readable
      FROM pg_roles r WHERE r.rolname = current_user`);
    if (proof?.privileged !== true || proof.readable !== true || proof.global_visibility !== true) throw new AuditRefusal('privilege_unproved');
    if (proof.readonly !== true || proof.repeatable !== true) throw new AuditRefusal('scope_unproved');
    const [schema] = await this.query(tx, limits, deadline, sql`SELECT
      (SELECT count(*) = 2 AND bool_and(c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('elements', 'element_tags')) AS tables,
      (SELECT count(*) = 2 AND bool_and(a.attnotnull AND (
          (a.attname = 'storage_revision' AND a.atttypid = 'bigint'::regtype) OR
          (a.attname = 'memory_entries_out_of_sync' AND a.atttypid = 'boolean'::regtype)))
        FROM pg_attribute a WHERE a.attrelid = 'public.elements'::regclass
        AND a.attname IN ('storage_revision', 'memory_entries_out_of_sync') AND NOT a.attisdropped) AS columns,
      (SELECT count(*) = 4 AND bool_and(a.atttypid = 'uuid'::regtype AND a.attnotnull)
        FROM pg_attribute a WHERE NOT a.attisdropped AND (
          (a.attrelid = 'public.elements'::regclass AND a.attname IN ('id', 'user_id')) OR
          (a.attrelid = 'public.element_tags'::regclass AND a.attname IN ('element_id', 'user_id')))) AS identities,
      (SELECT count(*) = 2 FROM pg_constraint c WHERE c.contype = 'p' AND (
        (c.conrelid = 'public.elements'::regclass AND
          (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ordinality)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['id']) OR
        (c.conrelid = 'public.element_tags'::regclass AND
          (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ordinality)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['element_id', 'tag']))) AS keys,
      EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'public.element_tags'::regclass AND t.tgname = 'element_tags_memory_head_revision_change'
          AND t.tgenabled IN ('O', 'A') AND NOT p.prosecdef) AS trigger`);
    if (schema?.tables !== true || schema.columns !== true || schema.identities !== true || schema.keys !== true || schema.trigger !== true) throw new AuditRefusal('schema_unproved');
    if (typeof proof.actor !== 'string') throw new AuditRefusal('scope_unproved');
    return proof.actor;
  }

  private async census(tx: DrizzleTx, limits: MemoryTagAuditLimits, deadline: number): Promise<MemoryTagAuditReport> {
    const [ownerBounds] = await this.query(tx, limits, deadline, sql`WITH bounded AS MATERIALIZED (
      SELECT id, user_id, storage_revision::text, memory_entries_out_of_sync FROM public.elements
      WHERE element_type = 'memories' ORDER BY id LIMIT ${limits.owners + 1}
    ) SELECT count(*) AS seen, coalesce(sum(octet_length(row_to_json(bounded)::text)), 0) AS bytes FROM bounded`);
    const [tagBounds] = await this.query(tx, limits, deadline, sql`${tagProjection(limits.tags)} SELECT count(*) AS seen,
      coalesce(sum(octet_length(row_to_json(projected)::text)), 0) AS bytes,
      count(*) FILTER (WHERE parent_id IS NULL) AS orphans,
      count(*) FILTER (WHERE parent_type = 'memories' AND parent_user <> tag_user AND visibility <> 'public') AS private_mismatch,
      count(*) FILTER (WHERE parent_type = 'memories' AND parent_user <> tag_user AND visibility = 'public') AS public_mismatch
      FROM projected`);
    const ownersSeen = count(ownerBounds?.seen);
    const tagsSeen = count(tagBounds?.seen);
    const complete = ownersSeen <= limits.owners && tagsSeen <= limits.tags &&
      count(ownerBounds?.bytes) + count(tagBounds?.bytes) <= limits.bytes;
    if (!complete) return this.report({ status: 'incomplete', reason: 'coverage_limit', owners: ownersSeen, tags: tagsSeen, bounds: tagBounds, manifest: [], samples: [], digest: null });
    const ownerRows = await this.query(tx, limits, deadline, sql`SELECT id AS "ownerId", user_id AS "tenantId",
      storage_revision::text AS revision, memory_entries_out_of_sync AS dirty FROM public.elements
      WHERE element_type = 'memories' ORDER BY id LIMIT ${limits.owners}`);
    const owners = ownerRows.map(row => ({
      tenantId: String(row.tenantId), ownerId: String(row.ownerId), revision: String(row.revision), dirty: row.dirty === true,
    }));
    const samples = await this.query(tx, limits, deadline, sql`${tagProjection(limits.tags)} SELECT
      element_id AS "elementId", tag_user AS "tagTenantId", parent_user AS "parentTenantId", visibility,
      CASE WHEN parent_id IS NULL THEN 'orphan' ELSE 'memory_tenant_mismatch' END AS reason
      FROM projected WHERE parent_id IS NULL OR (parent_type = 'memories' AND parent_user <> tag_user)
      ORDER BY ordinal LIMIT ${limits.samples}`) as unknown as MemoryTagAuditSample[];
    const serialized = JSON.stringify(owners);
    if (Buffer.byteLength(serialized, 'utf8') + Buffer.byteLength(JSON.stringify(samples), 'utf8') > limits.bytes) {
      return this.report({ status: 'incomplete', reason: 'output_limit', owners: ownersSeen, tags: tagsSeen, bounds: tagBounds, manifest: [], samples: [], digest: null });
    }
    return this.report({ status: 'complete', reason: null, owners: ownersSeen, tags: tagsSeen, bounds: tagBounds, manifest: owners, samples,
      digest: createHash('sha256').update(serialized, 'utf8').digest('hex') });
  }

  private report(input: { status: 'complete' | 'incomplete'; reason: string | null; owners: number; tags: number;
    bounds: Record<string, unknown>; manifest: MemoryTagAuditOwner[]; samples: MemoryTagAuditSample[]; digest: string | null }): MemoryTagAuditReport {
    const { status, reason, owners, tags, bounds, manifest, samples, digest } = input;
    const orphanTags = count(bounds.orphans);
    const mismatchedPrivateMemoryTags = count(bounds.private_mismatch);
    const mismatchedPublicMemoryTags = count(bounds.public_mismatch);
    return { formatVersion: 1, status, reason, canBackfill: false, canApply: false, canActivate: false,
      counts: { owners, tags, exact: status === 'complete', orphanTags, mismatchedPrivateMemoryTags, mismatchedPublicMemoryTags },
      samplesTruncated: orphanTags + mismatchedPrivateMemoryTags + mismatchedPublicMemoryTags > samples.length,
      privateReport: { owners: manifest, samples, manifestSha256: digest } };
  }
}
