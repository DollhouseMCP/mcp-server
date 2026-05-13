/**
 * Administrative Database Context
 *
 * Privileged operations that bypass Row-Level Security.
 * This module is intentionally separated from rls.ts to make the
 * security boundary structural: application code imports from rls.ts
 * (safe, user-scoped), while only migrations, bootstrap, and admin
 * tasks import from this module.
 *
 * Any import of this file in a code review should prompt the question:
 * "why does this code need to bypass tenant isolation?"
 *
 * @since v2.2.0 — Phase 4, Step 4.2
 */

import { sql } from 'drizzle-orm';
import type { DatabaseInstance } from './connection.js';

interface SystemRoleRow {
  currentUser: string;
  canBypassRls: boolean;
}

/**
 * System context — bypasses RLS for administrative operations.
 * Used for background tasks, migrations, session reaping, and
 * startup operations that need to access data across all users.
 *
 * The caller MUST use a database role that bypasses RLS (e.g. the
 * superuser role used for migrations). This helper verifies that
 * invariant at transaction start so system-internal tables without RLS
 * cannot be operated accidentally through the app role.
 */
export async function withSystemContext<T>(
  db: DatabaseInstance,
  fn: (tx: Parameters<Parameters<DatabaseInstance['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const roleRows = await tx.execute(sql`
      SELECT
        current_user AS "currentUser",
        EXISTS (
          SELECT 1
          FROM pg_roles
          WHERE rolname = current_user
            AND (rolsuper OR rolbypassrls)
        ) AS "canBypassRls"
    `) as unknown as SystemRoleRow[];
    const role = roleRows[0];
    if (!role?.canBypassRls) {
      throw new Error(
        `withSystemContext requires a PostgreSQL role with SUPERUSER or BYPASSRLS; ` +
        `current_user=${role?.currentUser ?? 'unknown'}`,
      );
    }

    // Reset any previously set user context.
    // set_config with empty string + is_local=true clears the setting for this transaction.
    await tx.execute(sql`SELECT set_config('app.current_user_id', '', true)`);
    return fn(tx);
  });
}
