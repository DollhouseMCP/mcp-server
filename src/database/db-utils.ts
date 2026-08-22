/**
 * Shared database utilities.
 *
 * Keep this module thin — only types and pure helpers that belong to
 * multiple storage layers. Anything that carries state belongs in the
 * storage layer itself or in its own service module.
 *
 * @since v2.2.0 — Phase 4, Step 4.3
 */

import type { DatabaseInstance } from './connection.js';

/**
 * Transaction handle type passed to Drizzle's `db.transaction(tx => ...)`.
 *
 * Extracted here because the inline form
 * `Parameters<Parameters<DatabaseInstance['transaction']>[0]>[0]` is verbose
 * and duplicated across storage layers. A named alias removes the noise and
 * keeps one place to change if the Drizzle signature evolves.
 */
export type DrizzleTx = Parameters<Parameters<DatabaseInstance['transaction']>[0]>[0];

/**
 * PostgreSQL SQLSTATE code for a unique-constraint violation.
 * Used by storage layers to translate a failed atomic-create insert into
 * a user-facing "already exists" error.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Returns true when the given error is a PostgreSQL unique-constraint
 * violation (SQLSTATE 23505). Drizzle may wrap the original PostgresError
 * under `cause`, so inspect a short, cycle-safe cause chain.
 */
export function isUniqueViolation(err: unknown): boolean {
  const seen = new WeakSet<object>();
  let current = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if ('code' in current && current.code === PG_UNIQUE_VIOLATION) return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}
