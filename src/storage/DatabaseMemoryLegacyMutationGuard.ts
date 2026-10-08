/** Dormant legacy-DML permission. Absence is never legacy authority. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DatabaseInstance } from '../database/connection.js';
import type { DrizzleTx } from '../database/db-utils.js';
import type { UserIdResolver } from '../database/UserContext.js';
import { validateUserId } from '../state/db-persistence-utils.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { logger } from '../utils/logger.js';
import type { DatabaseMemoryStorageLayer } from './DatabaseMemoryStorageLayer.js';

export const DATABASE_MEMORY_LEGACY_PROFILE = 'legacy-memory-writes-v1';

function refuse(): never {
  throw Object.assign(new Error('Explicit database memory legacy permission required'), { code: 'EMEMORYLEGACYDENIED' });
}

export class DatabaseMemoryLegacyMutationGuard {
  constructor(private readonly db: DatabaseInstance, private readonly resolveTenant: UserIdResolver) {}

  requireContext(store: DatabaseMemoryStorageLayer, tenant: string): void {
    try { validateUserId(tenant); } catch { refuse(); }
    if (this.resolveTenant() !== tenant || !store.matchesAdmissionContext(this.db, tenant)) refuse();
  }

  /** Called only inside the store's actual DML transaction. Never emits observers. */
  async requireLegacyInTransaction(tx: DrizzleTx, store: DatabaseMemoryStorageLayer, tenant: string): Promise<void> {
    this.requireContext(store, tenant);
    const roles = await tx.execute(sql`SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user`);
    if (roles.length !== 1 || roles[0].rolsuper !== false || roles[0].rolbypassrls !== false) refuse();
    this.requireContext(store, tenant);
    const rows = await tx.execute(sql`SELECT protocol_version, profile, mode, generation::text AS generation
      FROM public.memory_backend_modes WHERE user_id=${tenant}::uuid AND backend='database' FOR SHARE`);
    if (rows.length !== 1) refuse();
    const row = rows[0];
    if (row.protocol_version !== 1 || row.profile !== DATABASE_MEMORY_LEGACY_PROFILE || row.mode !== 'legacy') refuse();
    if (typeof row.generation !== 'string' || !/^[1-9]\d*$/u.test(row.generation) ||
      BigInt(row.generation) > 9223372036854775807n) refuse();
    this.requireContext(store, tenant);
  }

  /** Best effort, after outer settlement only; no outcome or delivery guarantee. */
  observeFailure(stage: 'legacy-write' | 'identity-delete'): void {
    try {
      SecurityMonitor.logSecurityEvent({ type: 'OPERATION_FAILED', severity: 'HIGH',
        source: 'DatabaseMemoryLegacyMutationGuard',
        details: `Legacy mutation boundary failed; stage=${stage}; storage-outcome=unclassified; invocation=${randomUUID()}` });
    } catch {
      try { logger.warn('Memory legacy mutation audit observer failed'); } catch { /* Preserve the original cause. */ }
    }
  }
}
