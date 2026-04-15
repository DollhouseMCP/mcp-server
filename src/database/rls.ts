/**
 * Row-Level Security (RLS) Context Helper
 *
 * Wraps database transactions with `SET LOCAL app.current_user_id`
 * so PostgreSQL RLS policies filter rows to the current user.
 *
 * See DATABASE-STORAGE-REVIEW.md Section 5.3 (RLS Policies)
 * and Section 11.4 (denormalized user_id rationale).
 *
 * @since v2.2.0 — Phase 4, Step 4.1
 */

import { sql } from 'drizzle-orm';
import type { DatabaseInstance } from './connection.js';

/**
 * Execute a function within a database transaction scoped to a specific user.
 *
 * Sets `app.current_user_id` via `SET LOCAL` so all RLS policies within
 * the transaction filter to this user. `SET LOCAL` is automatically
 * rolled back when the transaction ends (commit or rollback).
 *
 * @param db - Drizzle database instance
 * @param userId - UUID of the authenticated user
 * @param fn - Function to execute within the scoped transaction
 * @returns The result of the function
 */
export async function withUserContext<T>(
  db: DatabaseInstance,
  userId: string,
  fn: (tx: Parameters<Parameters<DatabaseInstance['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.current_user_id = ${userId}`);
    return fn(tx);
  });
}

/**
 * Execute a read-only query scoped to a specific user.
 * Convenience wrapper for queries that don't need explicit transaction control.
 *
 * @param db - Drizzle database instance
 * @param userId - UUID of the authenticated user
 * @param fn - Query function to execute
 * @returns The query result
 */
export async function withUserRead<T>(
  db: DatabaseInstance,
  userId: string,
  fn: (tx: Parameters<Parameters<DatabaseInstance['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.current_user_id = ${userId}`);
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    return fn(tx);
  });
}

// withSystemContext lives in ./admin.ts — intentionally separated
// so that RLS bypass requires an explicit, reviewable import.
