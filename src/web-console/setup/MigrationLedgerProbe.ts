import { sql } from 'drizzle-orm';

import type { DatabaseInstance } from '../../database/connection.js';
import type { ReleaseMigration } from '../../database/releaseMigrations.js';
import type { WebConsoleSetupCheckResult } from './WebConsoleSetupStatus.js';

const CHECK_ID = 'production_database_migrations';

export type MigrationLedgerCode =
  | 'migrations_applied'
  | 'migrations_incomplete'
  | 'migrations_mismatch'
  | 'migration_ledger_unreadable';

export interface MigrationLedgerResult extends WebConsoleSetupCheckResult {
  readonly id: typeof CHECK_ID;
  /** Stable code for surfaces that show codes, not prose. */
  readonly code: MigrationLedgerCode;
  readonly detail: string;
}

export interface AppliedMigration {
  readonly hash: string;
  /** Ledger `created_at`, as text: PostgreSQL returns bigint as a string. */
  readonly createdAt: string;
}

export const MIGRATION_LEDGER_UNREADABLE: MigrationLedgerResult = Object.freeze({
  id: CHECK_ID,
  state: 'pending',
  code: 'migration_ledger_unreadable',
  detail: 'The applied-migration ledger could not be read, so the schema is not verified. ' +
    'Grant the server\'s database role SELECT on the drizzle schema.',
});

/**
 * Compares the migrations this release was built against with the ledger of
 * migrations already applied.
 *
 * The release list must be the start of the ledger, entry for entry, matched
 * by content hash and timestamp. A longer ledger passes: a newer release may
 * already have migrated the database while this replica is still running,
 * which is what a rolling upgrade looks like.
 */
export function compareMigrationLedger(
  release: readonly ReleaseMigration[],
  applied: readonly AppliedMigration[],
): MigrationLedgerResult {
  for (const [index, expected] of release.entries()) {
    const actual = applied.at(index);
    if (!actual) {
      return {
        id: CHECK_ID,
        state: 'failed',
        code: 'migrations_incomplete',
        detail: `${index} of ${release.length} migrations in this release are applied. First missing: ${expected.tag}.`,
      };
    }
    if (actual.hash !== expected.hash || actual.createdAt !== String(expected.when)) {
      return {
        id: CHECK_ID,
        state: 'failed',
        code: 'migrations_mismatch',
        detail: `Applied migration ${index + 1} does not match ${expected.tag} in this release.`,
      };
    }
  }
  const newer = applied.length - release.length;
  return {
    id: CHECK_ID,
    state: 'passed',
    code: 'migrations_applied',
    detail: newer > 0
      ? `All ${release.length} migrations in this release are applied, with ${newer} newer applied by a later release.`
      : `All ${release.length} migrations in this release are applied.`,
  };
}

/**
 * Reads the ledger and compares it. Read-only.
 *
 * A ledger that cannot be read is reported as pending, not failed: the server
 * has learned nothing about the schema, and the usual cause is a role without
 * SELECT on the `drizzle` schema, which is not a schema fault.
 */
export async function probeMigrationLedger(
  database: DatabaseInstance,
  release: readonly ReleaseMigration[],
  onUnreadable?: (error: unknown) => void,
): Promise<MigrationLedgerResult> {
  let applied: readonly AppliedMigration[];
  try {
    applied = await database.execute(sql`
      SELECT hash, created_at::text AS "createdAt"
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at, id
    `) as unknown as AppliedMigration[];
  } catch (error) {
    onUnreadable?.(error);
    return MIGRATION_LEDGER_UNREADABLE;
  }
  return compareMigrationLedger(release, applied);
}
