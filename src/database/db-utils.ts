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
export const PG_SERIALIZATION_FAILURE = '40001';
export const PG_DEADLOCK_DETECTED = '40P01';

export function getErrorCode(err: unknown): string | undefined {
  let current = err;
  const seen = new Set<object>();
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) return undefined;
    seen.add(current);
    if ('code' in current) {
      const code = (current as { code: unknown }).code;
      if (typeof code === 'string') return code;
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }
  return undefined;
}

/**
 * Returns true when the given error is a PostgreSQL unique-constraint
 * violation (SQLSTATE 23505). postgres.js attaches the `code` property
 * on PostgresError objects; Drizzle may expose that error through `cause`.
 */
export function isUniqueViolation(err: unknown): boolean {
  return getErrorCode(err) === PG_UNIQUE_VIOLATION;
}

/** Return true for PostgreSQL transaction failures that are safe to retry. */
export function isSerializationFailure(err: unknown): boolean {
  const code = getErrorCode(err);
  return code === PG_SERIALIZATION_FAILURE || code === PG_DEADLOCK_DETECTED;
}
