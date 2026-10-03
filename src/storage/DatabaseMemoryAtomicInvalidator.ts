/** Dormant maintenance only. Historical receipts never authorize apply or activation. */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { PostgresJsSession, PostgresJsTransaction } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql, type SQL, type ExtractTablesWithRelations } from 'drizzle-orm';
import type * as schema from '../database/schema/index.js';
import type { DrizzleTx } from '../database/db-utils.js';
import { observeDatabaseMemoryMaintenanceCatalog } from './DatabaseMemoryMaintenanceCatalogVerifier.js';
import { captureDatabaseMemoryOwnerManifest, verifyDatabaseMemoryOwnerInvalidation } from './DatabaseMemoryOwnerManifest.js';
import type { MemoryTagAuditOwner } from './DatabaseMemoryLegacyTagAuditor.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const NIL = '00000000-0000-0000-0000-000000000000';
const DIGEST = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const LIMITS = Object.freeze({ owners: 10_000, tags: 100_000, bytes: 16 * 1024 * 1024,
  lockMilliseconds: 1_000, statementMilliseconds: 5_000, operationMilliseconds: 30_000 });

export interface MemoryAtomicInvalidationRequest {
  readonly runId: string;
  readonly candidateCommit: string;
  readonly expectedCatalogSha256: string;
  readonly maintenanceEvidenceSha256: string;
  readonly maintenanceEvidenceId: string;
  readonly declaredContextId: string;
  readonly databaseName: string;
  readonly databaseOid: string;
}
type Reason = 'invalid-request' | 'abandoned' | 'deadline' | 'context' | 'catalog' |
  'conflict' | 'invalid-receipt' | 'incomplete-census' | 'unsafe-reference' | 'revision' | 'query';
export class Refusal extends Error {
  constructor(readonly reason: Reason, cause?: unknown) { super(`Atomic memory invalidation refused: ${reason}`, cause === undefined ? undefined : { cause }); }
}
export interface CapturedMemoryMaintenanceRequest extends MemoryAtomicInvalidationRequest { readonly requestSha256: string }
function byteBound(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 1 &&
    Buffer.byteLength(value, 'utf8') <= maximum && !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value;
}
export function captureRequest(input: MemoryAtomicInvalidationRequest): CapturedMemoryMaintenanceRequest {
  let value: MemoryAtomicInvalidationRequest;
  try {
    const fields = ['runId', 'candidateCommit', 'expectedCatalogSha256', 'maintenanceEvidenceSha256',
      'maintenanceEvidenceId', 'declaredContextId', 'databaseName', 'databaseOid'] as const;
    if (!input || typeof input !== 'object' || Reflect.ownKeys(input).length !== fields.length ||
      fields.some(field => !Object.hasOwn(input, field))) throw new Error('Invalid request fields');
    value = Object.fromEntries(fields.map(field => [field, input[field]])) as unknown as MemoryAtomicInvalidationRequest;
  } catch { throw new Refusal('invalid-request'); }
  if (typeof value.runId !== 'string' || !UUID.test(value.runId) || value.runId.toLowerCase() === NIL ||
    typeof value.candidateCommit !== 'string' || !COMMIT.test(value.candidateCommit) || /^0{40}$/u.test(value.candidateCommit) ||
    typeof value.expectedCatalogSha256 !== 'string' || !DIGEST.test(value.expectedCatalogSha256) ||
    typeof value.maintenanceEvidenceSha256 !== 'string' || !DIGEST.test(value.maintenanceEvidenceSha256) ||
    !byteBound(value.maintenanceEvidenceId, 128) || !byteBound(value.declaredContextId, 128) ||
    !byteBound(value.databaseName, 63) || typeof value.databaseOid !== 'string' ||
    !/^[1-9]\d{0,9}$/u.test(value.databaseOid) || BigInt(value.databaseOid) > 4294967295n) throw new Refusal('invalid-request');
  const canonical = { ...value, runId: value.runId.toLowerCase() };
  const encoded = JSON.stringify([1, canonical.runId, canonical.candidateCommit, canonical.expectedCatalogSha256,
    canonical.maintenanceEvidenceSha256, canonical.maintenanceEvidenceId, canonical.declaredContextId,
    canonical.databaseName, canonical.databaseOid, LIMITS]);
  return Object.freeze({ ...canonical, requestSha256: createHash('sha256').update(encoded).digest('hex') });
}

export interface MemoryMaintenanceInvocation {
  abandoned: boolean;
  drained: boolean;
  callbackStarted: boolean;
  acknowledgedAbort: boolean;
  settled: boolean;
  resolved: boolean;
  readonly abort: object;
  refusal: Reason | null;
  readonly deadline: number;
}
type ReservedTransaction = PostgresJsTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;
// Drizzle 0.45.2's session generic incorrectly requires root Sql, while its own
// transaction constructor accepts a TransactionSql session. Pin that constructor boundary.
const ReservedSession = PostgresJsSession as unknown as new (
  client: TransactionSql, dialect: PgDialect, relationalSchema: undefined
) => ConstructorParameters<typeof PostgresJsTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>>[1];
function checkInvocation(invocation: MemoryMaintenanceInvocation): void {
  if (invocation.abandoned) throw new Refusal('abandoned');
  if (performance.now() >= invocation.deadline) throw new Refusal('deadline');
}

/** Root postgres-js clients have begin; transaction clients expose savepoint instead. */
function requireRootConnection(connection: Sql): void {
  if (typeof connection.begin !== 'function' || 'savepoint' in connection) throw new Refusal('context');
}
export async function transaction<T>(connection: Sql, invocation: MemoryMaintenanceInvocation, body: (tx: DrizzleTx) => Promise<T>): Promise<T> {
  try {
    return await connection.begin('isolation level repeatable read read write', async client => {
      invocation.callbackStarted = true;
      try {
        checkInvocation(invocation);
        // Reserved clients omit root-client options; use Drizzle's transaction session directly.
        const dialect = new PgDialect();
        const session = new ReservedSession(client, dialect, undefined);
        const tx: ReservedTransaction = new PostgresJsTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>(dialect, session, undefined);
        return await body(tx);
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        invocation.refusal = error.reason;
        throw invocation.abort;
      } finally { invocation.drained = true; }
    }) as T;
  } catch (error) {
    invocation.abandoned = true;
    // Only the private sentinel survives an acknowledged ROLLBACK in pinned postgres-js.
    if (error === invocation.abort) {
      invocation.acknowledgedAbort = true;
      throw new Refusal(invocation.refusal ?? 'query');
    }
    throw error;
  } finally { invocation.settled = true; }
}

type Row = Record<string, unknown>;
async function query(tx: DrizzleTx, invocation: MemoryMaintenanceInvocation, statement: SQL): Promise<Row[]> {
  checkInvocation(invocation);
  const result = await tx.execute(statement);
  checkInvocation(invocation);
  if (!Array.isArray(result)) throw new Refusal('query');
  return result as Row[];
}
interface Context { databaseName: string; databaseOid: string; effectiveRole: string; serverVersionNum: number }
async function lockAndProve(tx: DrizzleTx, invocation: MemoryMaintenanceInvocation, request: CapturedMemoryMaintenanceRequest, archiveExclusion = false): Promise<Context> {
  await query(tx, invocation, sql`SET LOCAL search_path = pg_catalog, public, pg_temp`);
  await query(tx, invocation, sql`SET LOCAL lock_timeout = '1000ms'`);
  await query(tx, invocation, sql`SET LOCAL statement_timeout = '5000ms'`);
  // No SELECT precedes these locks: the repeatable-read snapshot starts afterwards.
  // Acquire each fixed lock sequentially, with invocation checks at every await.
  await query(tx, invocation, sql`LOCK TABLE ${sql.identifier('public')}.${sql.identifier('memory_head_invalidation_runs')} IN EXCLUSIVE MODE`);
  await query(tx, invocation, sql`LOCK TABLE ${sql.identifier('public')}.${sql.identifier('elements')} IN EXCLUSIVE MODE`);
  await query(tx, invocation, sql`LOCK TABLE ${sql.identifier('public')}.${sql.identifier('element_tags')} IN EXCLUSIVE MODE`);
  await query(tx, invocation, sql`LOCK TABLE ${sql.identifier('public')}.${sql.identifier('memory_entries')} IN EXCLUSIVE MODE`);
  if (archiveExclusion) await query(tx, invocation, sql`LOCK TABLE public.memory_volumes IN EXCLUSIVE MODE`);
  return proveContext(tx, invocation, request);
}
async function proveContext(tx: DrizzleTx, invocation: MemoryMaintenanceInvocation, request: CapturedMemoryMaintenanceRequest): Promise<Context> {
  const [row] = await query(tx, invocation, sql`SELECT
    pg_catalog.current_database() AS name, d.oid::text AS oid, current_user::text AS actor,
    pg_catalog.current_setting('server_version_num')::integer AS version,
    (r.rolsuper OR r.rolbypassrls) AS privileged,
    pg_catalog.current_setting('session_replication_role') = 'origin' AS origin,
    pg_catalog.current_setting('transaction_isolation') = 'repeatable read' AND
      pg_catalog.current_setting('transaction_read_only') = 'off' AS isolation,
    NOT pg_catalog.row_security_active('public.elements'::pg_catalog.regclass) AND
      NOT pg_catalog.row_security_active('public.element_tags'::pg_catalog.regclass) AND
      NOT pg_catalog.row_security_active('public.memory_entries'::pg_catalog.regclass) AND
      NOT pg_catalog.row_security_active('public.memory_head_invalidation_runs'::pg_catalog.regclass) AS visibility,
    pg_catalog.has_table_privilege(current_user, 'public.elements', 'SELECT') AND
      pg_catalog.has_table_privilege(current_user, 'public.elements', 'UPDATE') AND
      pg_catalog.has_table_privilege(current_user, 'public.element_tags', 'SELECT') AND
      pg_catalog.has_table_privilege(current_user, 'public.element_tags', 'UPDATE') AND
      pg_catalog.has_table_privilege(current_user, 'public.memory_entries', 'SELECT') AND
      pg_catalog.has_table_privilege(current_user, 'public.memory_entries', 'UPDATE') AND
      pg_catalog.has_table_privilege(current_user, 'public.memory_head_invalidation_runs', 'SELECT') AND
      pg_catalog.has_table_privilege(current_user, 'public.memory_head_invalidation_runs', 'UPDATE') AND
      pg_catalog.has_table_privilege(current_user, 'public.memory_head_invalidation_runs', 'INSERT') AS rights,
    pg_catalog.to_regclass('elements') = 'public.elements'::pg_catalog.regclass AND
      pg_catalog.to_regclass('element_tags') = 'public.element_tags'::pg_catalog.regclass AND
      pg_catalog.to_regclass('memory_entries') = 'public.memory_entries'::pg_catalog.regclass AND
      pg_catalog.to_regclass('memory_head_invalidation_runs') = 'public.memory_head_invalidation_runs'::pg_catalog.regclass AND
      pg_catalog.to_regprocedure('mark_memory_head_out_of_sync(uuid,uuid)') =
        'public.mark_memory_head_out_of_sync(uuid,uuid)'::pg_catalog.regprocedure AND
      pg_catalog.to_regprocedure('bump_element_storage_revision()') =
        'public.bump_element_storage_revision()'::pg_catalog.regprocedure AND
      pg_catalog.to_regprocedure('bump_memory_entry_head_revision()') =
        'public.bump_memory_entry_head_revision()'::pg_catalog.regprocedure AND
      pg_catalog.to_regprocedure('invalidate_memory_tag_owner(uuid,uuid,boolean)') =
        'public.invalidate_memory_tag_owner(uuid,uuid,boolean)'::pg_catalog.regprocedure AND
      pg_catalog.to_regprocedure('bump_memory_tag_head_revision()') =
        'public.bump_memory_tag_head_revision()'::pg_catalog.regprocedure AS resolution,
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class = 'public.elements'::pg_catalog.regclass) AS no_rules
    FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.rolname = current_user
    WHERE d.datname = pg_catalog.current_database()`);
  if (row?.name !== request.databaseName || row.oid !== request.databaseOid ||
    !byteBound(row.actor, 63) || !Number.isInteger(row.version) || Number(row.version) < 170000 ||
    Number(row.version) >= 180000 || ['privileged', 'origin', 'isolation', 'visibility', 'rights', 'resolution', 'no_rules']
      .some(key => row[key] !== true)) throw new Refusal('context');
  return { databaseName: row.name as string, databaseOid: row.oid as string,
    effectiveRole: row.actor, serverVersionNum: row.version as number };
}
async function proveCatalog(tx: DrizzleTx, invocation: MemoryMaintenanceInvocation, request: CapturedMemoryMaintenanceRequest): Promise<void> {
  checkInvocation(invocation);
  const proof = await observeDatabaseMemoryMaintenanceCatalog(tx);
  checkInvocation(invocation);
  if (proof.status !== 'verified' || proof.descriptorSha256 !== request.expectedCatalogSha256) throw new Refusal('catalog');
}
async function census(tx: DrizzleTx, invocation: MemoryMaintenanceInvocation): Promise<{ owners: readonly MemoryTagAuditOwner[]; tags: number }> {
  const [bounds] = await query(tx, invocation, sql`WITH owners AS MATERIALIZED (
    SELECT id, user_id, storage_revision, memory_entries_out_of_sync FROM public.elements
    WHERE element_type = 'memories' ORDER BY id LIMIT 10001
  ), tags AS MATERIALIZED (
    SELECT element_id, user_id, tag FROM public.element_tags ORDER BY element_id, tag COLLATE pg_catalog."C" LIMIT 100001
  ) SELECT (SELECT count(*)::integer FROM owners) AS owners,
    (SELECT count(*)::integer FROM tags) AS tags,
    (SELECT coalesce(sum(pg_catalog.octet_length(pg_catalog.row_to_json(owners)::text)),0)::text FROM owners) AS owner_bytes,
    (SELECT coalesce(sum(pg_catalog.octet_length(pg_catalog.row_to_json(tags)::text)),0)::text FROM tags) AS tag_bytes,
    (SELECT count(*)::integer FROM tags t LEFT JOIN public.elements e ON e.id=t.element_id
      WHERE e.id IS NULL OR (e.element_type='memories' AND e.user_id<>t.user_id)) AS unsafe`);
  if (!bounds || !Number.isInteger(bounds.owners) || !Number.isInteger(bounds.tags) ||
    Number(bounds.owners) > LIMITS.owners || Number(bounds.tags) > LIMITS.tags ||
    typeof bounds.owner_bytes !== 'string' || !/^\d+$/u.test(bounds.owner_bytes) ||
    typeof bounds.tag_bytes !== 'string' || !/^\d+$/u.test(bounds.tag_bytes) ||
    BigInt(bounds.owner_bytes) + BigInt(bounds.tag_bytes) > BigInt(LIMITS.bytes)) throw new Refusal('incomplete-census');
  if (bounds.unsafe !== 0) throw new Refusal('unsafe-reference');
  const owners = await query(tx, invocation, sql`SELECT id::text AS "ownerId", user_id::text AS "tenantId",
    storage_revision::text AS revision, memory_entries_out_of_sync AS dirty
    FROM public.elements WHERE element_type='memories' ORDER BY id LIMIT 10000`);
  const manifest = captureDatabaseMemoryOwnerManifest(owners as unknown as MemoryTagAuditOwner[]);
  if (manifest.ownerCount !== bounds.owners) throw new Refusal('incomplete-census');
  return { owners: manifest.owners, tags: bounds.tags as number };
}

/** @internal Fresh current proof for equivalent reconciliation; no receipt is consulted. */
export async function observeCurrentMemoryMaintenance(tx: DrizzleTx, state: MemoryMaintenanceInvocation,
  request: CapturedMemoryMaintenanceRequest): Promise<void> {
  await lockAndProve(tx, state, request, true);
  await proveCatalog(tx, state, request);
  await census(tx, state);
}

export interface MemoryAtomicInvalidationReceipt extends MemoryAtomicInvalidationRequest {
  readonly formatVersion: 1;
  readonly claim: 'historical-exact-owner-set-invalidation';
  readonly requestSha256: string;
  readonly catalogSha256: string;
  readonly preManifestSha256: string;
  readonly postManifestSha256: string;
  readonly effectiveRole: string;
  readonly serverVersionNum: number;
  readonly ownerCount: number;
  readonly tagCount: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly canApply: false;
  readonly canActivate: false;
}
export type MemoryAtomicInvalidationOutcome =
  | { readonly status: 'committed' | 'replayed'; readonly receipt: MemoryAtomicInvalidationReceipt }
  | { readonly status: 'aborted'; readonly reason: Reason }
  | { readonly status: 'unknown' | 'absent'; readonly reason: null };
export type MemoryAtomicResolutionOutcome = MemoryAtomicInvalidationOutcome |
  { readonly status: 'refused'; readonly reason: Reason };
const RECEIPT_SELECT = sql`SELECT run_id::text AS "runId", format_version AS "formatVersion", claim,
  request_sha256 AS "requestSha256", catalog_sha256 AS "catalogSha256",
  pre_manifest_sha256 AS "preManifestSha256", post_manifest_sha256 AS "postManifestSha256",
  maintenance_evidence_sha256 AS "maintenanceEvidenceSha256", candidate_commit AS "candidateCommit",
  maintenance_evidence_id AS "maintenanceEvidenceId", declared_context_id AS "declaredContextId",
  database_name AS "databaseName", effective_role AS "effectiveRole", database_oid::text AS "databaseOid",
  server_version_num AS "serverVersionNum", owner_count AS "ownerCount", tag_count AS "tagCount",
  started_at AS "startedAt", finished_at AS "finishedAt", can_apply AS "canApply", can_activate AS "canActivate"
  FROM public.memory_head_invalidation_runs`;
function finiteTimestamp(value: unknown): string {
  let date: Date | null = null;
  if (value instanceof Date) date = value;
  else if (typeof value === 'string') date = new Date(value);
  if (!date || !Number.isFinite(date.getTime())) throw new Refusal('invalid-receipt');
  return date.toISOString();
}
function readReceipt(row: Row, request: CapturedMemoryMaintenanceRequest): MemoryAtomicInvalidationReceipt {
  if (Object.keys(row).length !== 21 || row.formatVersion !== 1 ||
    row.claim !== 'historical-exact-owner-set-invalidation' || row.canApply !== false || row.canActivate !== false ||
    !byteBound(row.effectiveRole, 63) || !Number.isInteger(row.serverVersionNum) || Number(row.serverVersionNum) <= 0 ||
    !Number.isInteger(row.ownerCount) || Number(row.ownerCount) < 0 || Number(row.ownerCount) > LIMITS.owners ||
    !Number.isInteger(row.tagCount) || Number(row.tagCount) < 0 || Number(row.tagCount) > LIMITS.tags) throw new Refusal('invalid-receipt');
  for (const name of ['requestSha256', 'catalogSha256', 'preManifestSha256', 'postManifestSha256', 'maintenanceEvidenceSha256']) {
    if (typeof row[name] !== 'string' || !DIGEST.test(row[name] as string)) throw new Refusal('invalid-receipt');
  }
  const captured = captureRequest({ runId: row.runId as string, candidateCommit: row.candidateCommit as string,
    expectedCatalogSha256: row.catalogSha256 as string, maintenanceEvidenceSha256: row.maintenanceEvidenceSha256 as string,
    maintenanceEvidenceId: row.maintenanceEvidenceId as string, declaredContextId: row.declaredContextId as string,
    databaseName: row.databaseName as string, databaseOid: row.databaseOid as string });
  if (captured.requestSha256 !== row.requestSha256 || captured.requestSha256 !== request.requestSha256 ||
    row.runId !== request.runId || row.catalogSha256 !== request.expectedCatalogSha256) throw new Refusal('conflict');
  const startedAt = finiteTimestamp(row.startedAt);
  const finishedAt = finiteTimestamp(row.finishedAt);
  if (new Date(finishedAt).getTime() < new Date(startedAt).getTime()) throw new Refusal('invalid-receipt');
  return Object.freeze({ ...request, formatVersion: 1, claim: 'historical-exact-owner-set-invalidation',
    catalogSha256: row.catalogSha256 as string, preManifestSha256: row.preManifestSha256 as string,
    postManifestSha256: row.postManifestSha256 as string, effectiveRole: row.effectiveRole,
    serverVersionNum: row.serverVersionNum as number, ownerCount: row.ownerCount as number, tagCount: row.tagCount as number,
    startedAt, finishedAt, canApply: false, canActivate: false });
}
async function lookup(tx: DrizzleTx, invocation: MemoryMaintenanceInvocation, request: CapturedMemoryMaintenanceRequest): Promise<MemoryAtomicInvalidationReceipt | null> {
  const rows = await query(tx, invocation, sql`${RECEIPT_SELECT} WHERE run_id=${request.runId}::pg_catalog.uuid LIMIT 2`);
  if (rows.length > 1) throw new Refusal('invalid-receipt');
  return rows.length === 0 ? null : readReceipt(rows[0], request);
}

/** Explicit supplied root connections only; no runtime wiring or environment discovery. */
export class DatabaseMemoryAtomicInvalidator {
  readonly #invocations = new Map<string, { request: CapturedMemoryMaintenanceRequest; state: MemoryMaintenanceInvocation }>();
  constructor(private readonly connection: Sql) { requireRootConnection(connection); }

  async invalidate(input: MemoryAtomicInvalidationRequest): Promise<MemoryAtomicInvalidationOutcome> {
    let request: CapturedMemoryMaintenanceRequest;
    try { request = captureRequest(input); }
    catch { return { status: 'aborted', reason: 'invalid-request' }; }
    const prior = this.#invocations.get(request.runId);
    if ([...this.#invocations.values()].some(({ state }) => !state.settled || !state.drained ||
      (state.abandoned && !state.acknowledgedAbort && !state.resolved))) return { status: 'unknown', reason: null };
    if (prior && (prior.request.requestSha256 !== request.requestSha256 || !prior.state.drained)) {
      return prior.request.requestSha256 !== request.requestSha256 ? { status: 'aborted', reason: 'conflict' } : { status: 'unknown', reason: null };
    }
    // An unknown prior operation is resolve-only; a new call cannot silently retry it.
    if (prior?.state.abandoned && !prior.state.acknowledgedAbort && !prior.state.resolved) return { status: 'unknown', reason: null };
    const state: MemoryMaintenanceInvocation = { abandoned: false, drained: false, callbackStarted: false, acknowledgedAbort: false, settled: false, resolved: false,
      abort: Object.freeze({}), refusal: null, deadline: performance.now() + LIMITS.operationMilliseconds };
    this.#invocations.set(request.runId, { request, state });
    try {
      return await transaction(this.connection, state, async tx => {
        const context = await lockAndProve(tx, state, request);
        await proveCatalog(tx, state, request);
        const existing = await lookup(tx, state, request);
        if (existing) return { status: 'replayed' as const, receipt: existing };
        return { status: 'committed' as const, receipt: await invalidateOwners(tx, state, request, context) };
      });
    } catch (error) {
      return error instanceof Refusal ? { status: 'aborted', reason: error.reason } : { status: 'unknown', reason: null };
    }
  }

  async resolveRun(input: MemoryAtomicInvalidationRequest, freshConnection: Sql): Promise<MemoryAtomicResolutionOutcome> {
    let request: CapturedMemoryMaintenanceRequest;
    try { request = captureRequest(input); }
    catch { return { status: 'refused', reason: 'invalid-request' }; }
    try { requireRootConnection(freshConnection); }
    catch { return { status: 'refused', reason: 'context' }; }
    if (freshConnection === this.connection) return { status: 'refused', reason: 'context' };
    const original = this.#invocations.get(request.runId);
    if (!original) return { status: 'refused', reason: 'context' };
    if (original.request.requestSha256 !== request.requestSha256) return { status: 'refused', reason: 'conflict' };
    if (!original.state.drained || !original.state.settled) return { status: 'unknown', reason: null };
    const state: MemoryMaintenanceInvocation = { abandoned: false, drained: false, callbackStarted: false, acknowledgedAbort: false, settled: false, resolved: false,
      abort: Object.freeze({}), refusal: null, deadline: performance.now() + LIMITS.operationMilliseconds };
    try {
      const result = await transaction(freshConnection, state, async tx => {
        await lockAndProve(tx, state, request);
        await proveCatalog(tx, state, request);
        const receipt = await lookup(tx, state, request);
        return receipt ? { status: 'replayed' as const, receipt } : { status: 'absent' as const, reason: null };
      });
      original.state.resolved = true;
      return result;
    } catch (error) {
      return error instanceof Refusal && state.refusal !== 'query' ?
        { status: 'refused', reason: error.reason } : { status: 'unknown', reason: null };
    }
  }
}

async function invalidateOwners(tx: DrizzleTx, state: MemoryMaintenanceInvocation, request: CapturedMemoryMaintenanceRequest, context: Context): Promise<MemoryAtomicInvalidationReceipt> {
  const observed = await census(tx, state);
  const before = captureDatabaseMemoryOwnerManifest(observed.owners);
  if (before.owners.some(owner => owner.revision === '9223372036854775807')) throw new Refusal('revision');
  const [clock] = await query(tx, state, sql`SELECT pg_catalog.clock_timestamp() AS started`);
  const startedAt = finiteTimestamp(clock.started);
  let changed: Row[] = [];
  if (before.ownerCount > 0) {
    const values = sql.join(before.owners.map(owner => sql`(${owner.ownerId}::pg_catalog.uuid,
      ${owner.tenantId}::pg_catalog.uuid,${owner.revision}::pg_catalog.int8)`), sql`, `);
    changed = await query(tx, state, sql`UPDATE public.elements e SET memory_entries_out_of_sync=true
      FROM (VALUES ${values}) AS expected(id,tenant,revision)
      WHERE e.id=expected.id AND e.user_id=expected.tenant AND e.storage_revision=expected.revision AND e.element_type='memories'
      RETURNING e.id::text AS "ownerId",e.user_id::text AS "tenantId",e.storage_revision::text AS revision,e.memory_entries_out_of_sync AS dirty`);
  }
  let verified;
  try { verified = verifyDatabaseMemoryOwnerInvalidation(before.owners, changed as unknown as MemoryTagAuditOwner[]); }
  catch { throw new Refusal('revision'); }
  const after = await census(tx, state);
  if (after.tags !== observed.tags || captureDatabaseMemoryOwnerManifest(after.owners).sha256 !== verified.after.sha256) throw new Refusal('incomplete-census');
  const current = await proveContext(tx, state, request);
  if (JSON.stringify(current) !== JSON.stringify(context)) throw new Refusal('context');
  await proveCatalog(tx, state, request);
  const [finished] = await query(tx, state, sql`SELECT pg_catalog.clock_timestamp() AS finished`);
  const finishedAt = finiteTimestamp(finished.finished);
  await query(tx, state, sql`INSERT INTO public.memory_head_invalidation_runs
    (run_id,format_version,claim,request_sha256,catalog_sha256,pre_manifest_sha256,post_manifest_sha256,
     maintenance_evidence_sha256,candidate_commit,maintenance_evidence_id,declared_context_id,database_name,
     effective_role,database_oid,server_version_num,owner_count,tag_count,started_at,finished_at,can_apply,can_activate)
    VALUES (${request.runId}::pg_catalog.uuid,1,'historical-exact-owner-set-invalidation',${request.requestSha256},
      ${request.expectedCatalogSha256},${before.sha256},${verified.after.sha256},${request.maintenanceEvidenceSha256},
      ${request.candidateCommit},${request.maintenanceEvidenceId},${request.declaredContextId},${context.databaseName},
      ${context.effectiveRole},${context.databaseOid}::pg_catalog.int8,${context.serverVersionNum},${before.ownerCount},${observed.tags},
      ${startedAt}::pg_catalog.timestamptz,${finishedAt}::pg_catalog.timestamptz,false,false)`);
  const receipt = await lookup(tx, state, request);
  if (receipt?.preManifestSha256 !== before.sha256 || receipt.postManifestSha256 !== verified.after.sha256 ||
    receipt.ownerCount !== before.ownerCount || receipt.tagCount !== observed.tags) throw new Refusal('invalid-receipt');
  return receipt;
}
