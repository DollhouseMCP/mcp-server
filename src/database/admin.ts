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

/**
 * System context — bypasses RLS for administrative operations.
 * Used for background tasks, migrations, session reaping, and
 * startup operations that need to access data across all users.
 *
 * The caller must have a database role that bypasses RLS
 * (e.g., the migration user or superuser). If the application
 * pool role does not have BYPASSRLS, queries inside this context
 * will return empty results rather than failing visibly.
 */
export async function withSystemContext<T>(
  db: DatabaseInstance,
  fn: (tx: Parameters<Parameters<DatabaseInstance['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Reset any previously set user context
    await tx.execute(sql`RESET app.current_user_id`);
    return fn(tx);
  });
}
