/** Trusted read-only boot census. No provisioning, repair, replay or maintenance authority. */
import { sql } from 'drizzle-orm';
import type { DatabaseInstance } from '../database/connection.js';
import type { DrizzleTx } from '../database/db-utils.js';
import type { MemoryManager } from '../elements/memories/MemoryManager.js';
import { validateUserId } from '../state/db-persistence-utils.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE } from './DatabaseMemoryAdmissionGate.js';
import { DatabaseMemoryReconciliationInspector } from './DatabaseMemoryReconciliationInspector.js';
import { verifyDatabaseMemoryInvalidationCatalog } from './DatabaseMemoryInvalidationCatalogVerifier.js';
import { verifyDatabaseMemoryInvalidationStructure } from './DatabaseMemoryInvalidationStructureVerifier.js';
import { readMemoryDatabaseIdentity, assertSameMemoryDatabaseIdentity } from './DatabaseMemoryStartupAdmission.js';
import { requireGuardedMemoryBootCatalog } from './GuardedMemoryBootCatalog.js';

const PAGE_SIZE = 100; // Query page, never a supported-owner product limit.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
async function checked<T>(checkpoint: () => void, read: () => PromiseLike<T>): Promise<T> {
  checkpoint(); const value = await read(); checkpoint(); return value;
}

function requireCensusKey(row: Record<string, unknown>, last: string | null): string {
  if (typeof row.id !== 'string' || !UUID.test(row.id) || last !== null && row.id <= last) {
    throw new Error('Invalid memory census order');
  }
  return row.id;
}
function requireReadObservation(observed: Awaited<ReturnType<DatabaseMemoryReconciliationInspector['inspectGuardedReadInTransaction']>>): void {
  if (observed.inspection.status !== 'equivalent' || observed.inspection.diagnosticsTruncated ||
      typeof observed.rawContent !== 'string') throw new Error('Memory owner read qualification refused');
}

export interface GuardedMemoryTenantQualification {
  readonly appDb: DatabaseInstance;
  readonly systemDb: DatabaseInstance;
  readonly tenant: string;
  readonly manager: MemoryManager;
  readonly checkpoint: () => void;
}

export async function qualifyDatabaseMemoryTenant(deps: GuardedMemoryTenantQualification): Promise<Readonly<{ owners: number }>> {
  validateUserId(deps.tenant);
  const application = await checked(deps.checkpoint, () => deps.appDb.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    return readMemoryDatabaseIdentity(tx);
  }));
  const census = await deps.systemDb.transaction(async tx => {
    // These precede every SELECT, including the system-role proof, so the
    // owner census, counters and comparisons share one read-only snapshot.
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    const role = await checked(deps.checkpoint, () => tx.execute(sql`SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) AS privileged`));
    if (role.length !== 1 || role[0].privileged !== true) throw new Error('Privileged boot observation required');
    const system = await checked(deps.checkpoint, () => readMemoryDatabaseIdentity(tx));
    assertSameMemoryDatabaseIdentity(application, system);
    const catalog = await checked(deps.checkpoint, () => verifyDatabaseMemoryInvalidationCatalog(tx));
    const structure = await checked(deps.checkpoint, () => verifyDatabaseMemoryInvalidationStructure(tx));
    // These existing proofs remain partial and do not grant execution-resolution
    // or maintenance authority. Separate new-table contracts are checked too.
    if (catalog.status !== 'verified' || structure.status !== 'verified') throw new Error('Memory invalidation catalog refused');
    await checked(deps.checkpoint, () => requireGuardedMemoryBootCatalog(tx));
    await requireTenantState(tx, deps);
    await requireNoForeignOrOrphanRows(tx, deps);
    const inspector = new DatabaseMemoryReconciliationInspector(deps.appDb, () => deps.tenant);
    let last: string | null = null;
    let owners = 0;
    for (;;) {
      const page = await checked(deps.checkpoint, () => tx.execute(sql`SELECT id::text AS id FROM public.elements
        WHERE user_id=${deps.tenant}::uuid AND element_type='memories'
          AND (${last}::uuid IS NULL OR id > ${last}::uuid) ORDER BY id LIMIT ${PAGE_SIZE}`));
      if (!page.length) break; // Explicit EOF in this same snapshot, not a short-page assumption.
      if (page.length > PAGE_SIZE) throw new Error('Invalid memory census page');
      for (const row of page) {
        const ownerId = requireCensusKey(row, last);
        const observed = await checked(deps.checkpoint, () => inspector.inspectGuardedReadInTransaction(tx,
          { userId: deps.tenant, memoryId: ownerId }, deps.checkpoint));
        requireReadObservation(observed);
        await checked(deps.checkpoint, () => deps.manager.assertGuardedReadFidelity(observed.rawContent!,
          ownerId, observed.inspection.name));
        last = ownerId;
        owners += 1;
        if (!Number.isSafeInteger(owners)) throw new Error('Memory census count is unrepresentable');
        // No payload/Memory escapes this iteration; only count and key remain.
      }
    }
    deps.checkpoint();
    return { owners, system };
  });
  // No census connection remains held while another pool is acquired. Recheck
  // actual pair facts after the full snapshot completes, before boot authority.
  const finalApplication = await checked(deps.checkpoint, () => deps.appDb.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    return readMemoryDatabaseIdentity(tx);
  }));
  const finalSystem = await checked(deps.checkpoint, () => deps.systemDb.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    return readMemoryDatabaseIdentity(tx);
  }));
  assertSameMemoryDatabaseIdentity(census.system, finalApplication);
  assertSameMemoryDatabaseIdentity(census.system, finalSystem);
  deps.checkpoint();
  return Object.freeze({ owners: census.owners });
}

async function requireTenantState(tx: DrizzleTx, deps: GuardedMemoryTenantQualification): Promise<void> {
  const mode = await checked(deps.checkpoint, () => tx.execute(sql`SELECT protocol_version, profile, mode,
    generation::text AS generation FROM public.memory_backend_modes WHERE user_id=${deps.tenant}::uuid AND backend='database'`));
  if (mode.length !== 1 || mode[0].protocol_version !== 1 || mode[0].profile !== DATABASE_MEMORY_ADMISSION_PROFILE ||
      !['guarded', 'read_only'].includes(mode[0].mode as string) || typeof mode[0].generation !== 'string' ||
      !/^[1-9]\d*$/u.test(mode[0].generation) || BigInt(mode[0].generation) > 9223372036854775807n) {
    throw new Error('Known protected tenant mode required');
  }
  const rows = await checked(deps.checkpoint, () => tx.execute(sql`SELECT q.retained_rows::text AS rows,
    q.retained_bytes::text AS bytes,
    (SELECT count(*)::text FROM public.memory_candidate_handoffs h WHERE h.user_id=q.user_id) AS actual_rows,
    (SELECT coalesce(sum(octet_length(h.envelope) + coalesce(octet_length(h.committed_token::text),0)),0)::text
      FROM public.memory_candidate_handoffs h WHERE h.user_id=q.user_id) AS actual_bytes,
    EXISTS (SELECT 1 FROM public.users u WHERE u.id=q.user_id) AS tenant_exists
    FROM public.memory_candidate_quotas q WHERE q.user_id=${deps.tenant}::uuid`));
  // Every retained status refuses, including published cleanup ambiguity.
  // No envelope transfer, cleanup, quota provision or reset occurs here.
  if (rows.length !== 1 || rows[0].tenant_exists !== true ||
      !['rows', 'bytes', 'actual_rows', 'actual_bytes'].every(key => rows[0][key] === '0')) {
    throw new Error('Provisioned consistent empty candidate quota required');
  }
}

async function requireNoForeignOrOrphanRows(tx: DrizzleTx, deps: GuardedMemoryTenantQualification): Promise<void> {
  const rows = await checked(deps.checkpoint, () => tx.execute(sql`SELECT
    EXISTS (SELECT 1 FROM public.memory_entries c LEFT JOIN public.elements e ON e.id=c.memory_id
      WHERE (c.user_id=${deps.tenant}::uuid AND (e.id IS NULL OR e.user_id<>c.user_id OR e.element_type<>'memories'))
        OR (e.user_id=${deps.tenant}::uuid AND e.element_type='memories' AND c.user_id<>e.user_id)) AS children,
    EXISTS (SELECT 1 FROM public.element_tags t LEFT JOIN public.elements e ON e.id=t.element_id
      WHERE (t.user_id=${deps.tenant}::uuid AND e.id IS NULL)
        OR (e.user_id=${deps.tenant}::uuid AND e.element_type='memories' AND t.user_id<>e.user_id)
        OR (t.user_id=${deps.tenant}::uuid AND e.element_type='memories' AND e.user_id<>t.user_id)) AS tags,
    EXISTS (SELECT 1 FROM public.memory_volumes v LEFT JOIN public.elements e ON e.id=v.memory_id
      WHERE v.user_id=${deps.tenant}::uuid OR (e.user_id=${deps.tenant}::uuid AND e.element_type='memories')) AS archives`));
  if (rows.length !== 1 || ['children', 'tags', 'archives'].some(key => rows[0][key] !== false)) {
    throw new Error('Unsupported foreign, orphan or archive memory state');
  }
}
