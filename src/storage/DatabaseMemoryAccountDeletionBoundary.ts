/** Dormant account-cascade refusal; released early inspection is not hot-promotion authority. */
import { withSystemContext } from '../database/admin.js';
import type { DatabaseInstance } from '../database/connection.js';
import type { DrizzleTx } from '../database/db-utils.js';
import { requireDatabaseMemoryLegacyMode } from './DatabaseMemoryLegacyMutationGuard.js';

export class DatabaseMemoryAccountDeletionBoundary {
  constructor(private readonly db: DatabaseInstance) {}

  requireDatabase(db: DatabaseInstance): void {
    if (db !== this.db) throw new Error('Account deletion boundary requires its original database');
  }

  /** Completes before revocation helpers acquire connections; cold promotion must exclude in-flight deletion. */
  async checkBeforeAuthMutation(targetUserId: string): Promise<void> {
    await withSystemContext(this.db, tx => requireDatabaseMemoryLegacyMode(tx, targetUserId));
  }

  /** Bound store/runner supplies its actual system tx; arbitrary tx provenance is not established here. */
  async requireLegacyBeforeDelete(tx: DrizzleTx, targetUserId: string): Promise<void> {
    await requireDatabaseMemoryLegacyMode(tx, targetUserId);
  }
}
