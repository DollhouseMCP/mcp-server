/** Dormant maintenance qualification. No production writer or historical receipt uses this API. */
import type { Sql } from 'postgres';
import { sql, type SQL } from 'drizzle-orm';
import type { DatabaseInstance } from '../database/connection.js';
import type { UserIdResolver } from '../database/UserContext.js';
import type { MemoryHeadToken } from './IMemoryHeadStore.js';
import { DatabaseMemoryReconciliationInspector, type MemoryInspectionOwner, type MemoryReconciliationInspection } from './DatabaseMemoryReconciliationInspector.js';
import { captureRequest, transaction, observeCurrentMemoryMaintenance, Refusal,
  type MemoryAtomicInvalidationRequest, type MemoryMaintenanceInvocation } from './DatabaseMemoryAtomicInvalidator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DIGEST = /^[a-f0-9]{64}$/u;
export interface MemoryEquivalentProposal extends MemoryInspectionOwner {
  readonly formatVersion: 1;
  readonly locator: string;
  readonly name: string;
  readonly revision: string;
  readonly dirty: boolean;
  readonly projectionSha256: string;
}
export type MemoryEquivalentMaintenanceRequest = MemoryAtomicInvalidationRequest;
export type MemoryEquivalentOutcome =
  | { readonly status: 'qualified' | 'already-qualified'; readonly token: MemoryHeadToken }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'unknown'; readonly attemptId: string };
type Row = Record<string, unknown>;
function captureProposal(input: MemoryEquivalentProposal): MemoryEquivalentProposal {
  const keys = ['formatVersion', 'userId', 'memoryId', 'locator', 'name', 'revision', 'dirty', 'projectionSha256'] as const;
  if (!input || typeof input !== 'object' || Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) throw new Error('invalid-proposal');
  const value = Object.fromEntries(keys.map(key => [key, input[key]])) as unknown as MemoryEquivalentProposal;
  if (value.formatVersion !== 1 || typeof value.userId !== 'string' || typeof value.memoryId !== 'string' || !UUID.test(value.userId) || !UUID.test(value.memoryId) || value.locator !== value.memoryId ||
    typeof value.name !== 'string' || Buffer.byteLength(value.name) > 4096 || typeof value.dirty !== 'boolean' ||
    typeof value.revision !== 'string' || typeof value.projectionSha256 !== 'string' || !/^[1-9]\d{0,18}$/u.test(value.revision) || BigInt(value.revision) > 9223372036854775807n || !DIGEST.test(value.projectionSha256)) throw new Error('invalid-proposal');
  return Object.freeze(value);
}
function state(): MemoryMaintenanceInvocation {
  return { abandoned: false, drained: false, callbackStarted: false, acknowledgedAbort: false, settled: false, resolved: false,
    abort: Object.freeze({}), refusal: null, deadline: performance.now() + 30_000 };
}

export class DatabaseMemoryEquivalentReconciler {
  private readonly inspector: DatabaseMemoryReconciliationInspector;
  private refreshing = false;
  private pending: { state: MemoryMaintenanceInvocation; proposal: MemoryEquivalentProposal; attemptId: string; request: ReturnType<typeof captureRequest> } | null = null;
  constructor(private readonly db: DatabaseInstance, private readonly getCurrentUserId: UserIdResolver,
    private readonly maintenanceConnection: Sql, private readonly applicationRole: string) {
    if (typeof maintenanceConnection.begin !== 'function' || 'savepoint' in maintenanceConnection ||
      typeof applicationRole !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/u.test(applicationRole)) throw new TypeError('Invalid maintenance connection or application role');
    this.inspector = new DatabaseMemoryReconciliationInspector(db, getCurrentUserId);
  }
  async prepareEquivalent(owner: MemoryInspectionOwner): Promise<{ inspection: MemoryReconciliationInspection; proposal: MemoryEquivalentProposal | null }> {
    const captured = Object.freeze({ userId: owner.userId, memoryId: owner.memoryId });
    if (typeof captured.userId !== 'string' || typeof captured.memoryId !== 'string' || !UUID.test(captured.userId) || !UUID.test(captured.memoryId) || this.getCurrentUserId() !== captured.userId) throw new TypeError('Invalid active reconciliation owner');
    return this.db.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${captured.userId}, true)`);
      const { inspection, projectionSha256 } = await this.inspector.captureEquivalentProjection(tx, captured);
      const proposal = projectionSha256 === null ? null : Object.freeze({ formatVersion: 1 as const, ...captured,
        locator: captured.memoryId, name: inspection.name, revision: inspection.revision, dirty: inspection.dirty, projectionSha256 });
      return { inspection, proposal };
    });
  }
  async qualifyEquivalent(input: MemoryEquivalentProposal, maintenance: MemoryEquivalentMaintenanceRequest): Promise<MemoryEquivalentOutcome> {
    if (this.pending) return { status: 'unknown', attemptId: this.pending.attemptId };
    let proposal: MemoryEquivalentProposal, request: ReturnType<typeof captureRequest>;
    try {
      proposal = captureProposal(input); request = captureRequest(maintenance);
      if (this.getCurrentUserId() !== proposal.userId) return { status: 'refused', reason: 'owner-mismatch' };
    } catch { return { status: 'refused', reason: 'invalid-request' }; }
    const invocation = state();
    this.pending = { state: invocation, proposal, attemptId: request.runId, request };
    let refusal: string | null = null;
    const fail = (reason: string): never => { refusal = reason; throw new Refusal('conflict'); };
    try {
      const candidate = await transaction(this.maintenanceConnection, invocation, async tx => {
        try {
        const query = async (statement: SQL): Promise<Row[]> => {
          if (performance.now() >= invocation.deadline || invocation.abandoned) fail('deadline');
          const rows = await tx.execute(statement);
          if (performance.now() >= invocation.deadline || invocation.abandoned) fail('deadline');
          if (!Array.isArray(rows)) fail('query');
          return rows as Row[];
        };
        await observeCurrentMemoryMaintenance(tx, invocation, request);
        const [relation] = await query(sql`SELECT c.relkind='r' AND c.relpersistence='p' AND c.relrowsecurity AND c.relforcerowsecurity
          AND NOT c.relispartition AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid)
          AND pg_catalog.to_regclass('memory_volumes')=c.oid AS safe
          FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname='memory_volumes'`);
        if (relation?.safe !== true) fail('archive-context');
        const [selectedOwner] = await query(sql`SELECT EXISTS(SELECT 1 FROM public.elements
          WHERE id=${proposal.memoryId}::uuid AND user_id=${proposal.userId}::uuid AND element_type='memories') AS present`);
        if (selectedOwner?.present !== true) fail('missing');
        const [archives] = await query(sql`SELECT EXISTS(SELECT 1 FROM public.memory_volumes WHERE memory_id=${proposal.memoryId}::uuid) AS present`);
        if (archives?.present !== false) fail('archive-bearing');
        const [foreignChild] = await query(sql`SELECT EXISTS(SELECT 1 FROM public.memory_entries
          WHERE memory_id=${proposal.memoryId}::uuid AND user_id<>${proposal.userId}::uuid) AS present`);
        if (foreignChild?.present !== false) fail('foreign-child');
        await query(sql`SET LOCAL ROLE ${sql.identifier(this.applicationRole)}`);
        await query(sql`SELECT set_config('app.current_user_id', ${proposal.userId}, true)`);
        await this.proveApplicationContext(query, proposal.userId, fail);
        const locked = await query(sql`SELECT id::text FROM public.elements WHERE id=${proposal.memoryId}::uuid
          AND user_id=${proposal.userId}::uuid AND element_type='memories' FOR UPDATE`);
        if (locked.length !== 1) fail('missing');
        await query(sql`SELECT id FROM public.memory_entries WHERE memory_id=${proposal.memoryId}::uuid
          AND user_id=${proposal.userId}::uuid LIMIT 10001 FOR UPDATE`);
        await query(sql`SELECT element_id FROM public.element_tags WHERE element_id=${proposal.memoryId}::uuid
          AND user_id=${proposal.userId}::uuid LIMIT 10001 FOR UPDATE`);
        const current = await this.inspector.captureEquivalentProjection(tx, proposal, () => {
          if (invocation.abandoned || performance.now() >= invocation.deadline) fail('deadline');
        });
        if (current.inspection.status !== 'equivalent' || !current.projectionSha256) fail(current.inspection.status);
        if (current.inspection.counts.volumes !== 0) fail('archive-bearing');
        if (current.inspection.name !== proposal.name || current.inspection.revision !== proposal.revision ||
          current.inspection.dirty !== proposal.dirty || current.projectionSha256 !== proposal.projectionSha256) fail('stale');
        await this.proveApplicationContext(query, proposal.userId, fail);
        let revision = proposal.revision;
        if (proposal.dirty) {
          const changed = await query(sql`UPDATE public.elements SET memory_entries_out_of_sync=false
            WHERE id=${proposal.memoryId}::uuid AND user_id=${proposal.userId}::uuid AND element_type='memories'
              AND storage_revision=${proposal.revision}::bigint AND memory_entries_out_of_sync=true
            RETURNING storage_revision::text AS revision, memory_entries_out_of_sync AS dirty, name`);
          if (changed.length !== 1 || changed[0].dirty !== false || changed[0].name !== proposal.name ||
            changed[0].revision !== (BigInt(proposal.revision) + 1n).toString()) fail('revision');
          revision = changed[0].revision as string;
        }
        await this.proveApplicationContext(query, proposal.userId, fail);
        return { status: proposal.dirty ? 'qualified' as const : 'already-qualified' as const,
          token: Object.freeze({ backend: 'database' as const, userId: proposal.userId, ownerId: proposal.memoryId,
            locator: proposal.locator, name: proposal.name, revision }) };
        } catch (cause) {
          if (cause instanceof Refusal) throw cause;
          refusal = 'query';
          throw new Refusal('query', cause);
        }
      });
      this.pending = null;
      return candidate;
    } catch (cause) {
      if (cause instanceof Refusal && invocation.acknowledgedAbort) {
        this.pending = null;
        return { status: 'refused', reason: refusal ?? cause.reason };
      }
      return { status: 'unknown', attemptId: request.runId };
    }
  }
  private async proveApplicationContext(query: (statement: SQL) => Promise<Row[]>, userId: string, fail: (reason: string) => never): Promise<void> {
    const [row] = await query(sql`SELECT current_user::text AS actor, NOT r.rolsuper AND NOT r.rolbypassrls AS ordinary,
      pg_catalog.current_setting('app.current_user_id',true)=${userId} AS tenant,
      pg_catalog.current_setting('session_replication_role')='origin' AS origin,
      pg_catalog.row_security_active('public.elements'::regclass) AND pg_catalog.row_security_active('public.element_tags'::regclass)
        AND pg_catalog.row_security_active('public.memory_entries'::regclass) AND pg_catalog.row_security_active('public.memory_volumes'::regclass) AS rls,
      pg_catalog.has_table_privilege(current_user,'public.elements','SELECT') AND pg_catalog.has_table_privilege(current_user,'public.elements','UPDATE') AND
        pg_catalog.has_table_privilege(current_user,'public.element_tags','SELECT') AND pg_catalog.has_table_privilege(current_user,'public.element_tags','UPDATE') AND
        pg_catalog.has_table_privilege(current_user,'public.memory_entries','SELECT') AND pg_catalog.has_table_privilege(current_user,'public.memory_entries','UPDATE') AND
        pg_catalog.has_table_privilege(current_user,'public.memory_volumes','SELECT') AS rights
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    if (row?.actor !== this.applicationRole || ['ordinary', 'tenant', 'origin', 'rls', 'rights'].some(key => row[key] !== true)) fail('application-context');
  }
  /** Explicit lock-qualified refresh; current facts never prove a historical commit. */
  async refreshUnknown(freshConnection: Sql): Promise<MemoryReconciliationInspection> {
    const pending = this.pending;
    if (!pending || this.refreshing || this.getCurrentUserId() !== pending.proposal.userId || !pending.state.drained || !pending.state.settled || freshConnection === this.maintenanceConnection ||
      typeof freshConnection.begin !== 'function' || 'savepoint' in freshConnection) throw new Error('Fresh root connection and settled unknown invocation required');
    this.refreshing = true;
    try {
      const invocation = state();
      const result = await transaction(freshConnection, invocation, async tx => {
        const checkpoint = () => { if (invocation.abandoned || performance.now() >= invocation.deadline) throw new Refusal('deadline'); };
        const query = async (statement: SQL): Promise<Row[]> => {
          checkpoint(); const rows = await tx.execute(statement); checkpoint();
          if (!Array.isArray(rows)) throw new Refusal('query'); return rows as Row[];
        };
        try {
          // The fresh global exclusion barrier waits out any older backend writer.
          // Callback-drained alone is NOT evidence of unknown COMMIT completion.
          await observeCurrentMemoryMaintenance(tx, invocation, pending.request);
          await query(sql`SET LOCAL ROLE ${sql.identifier(this.applicationRole)}`);
          await query(sql`SELECT set_config('app.current_user_id', ${pending.proposal.userId}, true)`);
          await this.proveApplicationContext(query, pending.proposal.userId, () => { throw new Refusal('context'); });
          const current = await this.inspector.inspectInTransaction(tx, pending.proposal, checkpoint);
          await this.proveApplicationContext(query, pending.proposal.userId, () => { throw new Refusal('context'); });
          return current;
        } catch (cause) {
          if (cause instanceof Refusal) throw cause;
          throw new Refusal('query', cause);
        }
      });
      // Only a known-completed fresh lock-qualified transaction can clear poison.
      if (this.pending !== pending) throw new Error('Reconciliation state changed during refresh');
      this.pending = null;
      return result;
    } finally { this.refreshing = false; }
  }
}
