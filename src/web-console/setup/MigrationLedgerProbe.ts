import { sql } from 'drizzle-orm';

import type { DatabaseInstance } from '../../database/connection.js';
import { getErrorCode } from '../../database/db-utils.js';
import type { ReleaseMigration } from '../../database/releaseMigrations.js';
import type { WebConsoleSetupCheckResult, WebConsoleSetupCheckState } from './WebConsoleSetupStatus.js';

const CHECK_ID = 'production_database_migrations';

export type MigrationLedgerCode =
  | 'migrations_applied'
  | 'migrations_incomplete'
  | 'migrations_mismatch'
  | 'migration_ledger_unreadable'
  | 'migration_ledger_missing'
  | 'release_migrations_unavailable';

export interface MigrationLedgerResult extends WebConsoleSetupCheckResult {
  readonly id: typeof CHECK_ID;
  /** A deployment always has a schema to check, so this is never not-applicable. */
  readonly state: Exclude<WebConsoleSetupCheckState, 'not_applicable'>;
  /** Stable code for surfaces that show codes, not prose. */
  readonly code: MigrationLedgerCode;
  readonly detail: string;
}

export interface AppliedMigration {
  readonly hash: string;
  /** Ledger `created_at`, as text: PostgreSQL returns bigint as a string. */
  readonly createdAt: string;
}

/** There is nothing to compare the ledger with: this release's own migration list did not load. */
export const RELEASE_MIGRATIONS_UNAVAILABLE: MigrationLedgerResult = Object.freeze({
  id: CHECK_ID,
  state: 'pending',
  code: 'release_migrations_unavailable',
  detail: 'This release\'s migration list could not be loaded, so the schema is not verified. ' +
    'The build is incomplete: reinstall or rebuild the server.',
});

/** The ledger read was still outstanding when the caller's wait ran out. */
export const MIGRATION_LEDGER_PROBE_TIMED_OUT: MigrationLedgerResult = Object.freeze({
  id: CHECK_ID,
  state: 'pending',
  code: 'migration_ledger_unreadable',
  detail: 'The applied-migration ledger did not answer in time, so the schema is not verified. The check is tried again.',
});

const PG_INSUFFICIENT_PRIVILEGE = '42501';
const PG_UNDEFINED_TABLE = '42P01';
const PG_INVALID_SCHEMA_NAME = '3F000';

/**
 * Says why the ledger could not be read and what to do about it, from the
 * PostgreSQL error class. The driver's own message is left out: it can carry
 * connection details, and this text is shown to operators.
 */
function unverifiedLedger(error: unknown): MigrationLedgerResult {
  const pgCode = getErrorCode(error);
  if (pgCode === PG_INSUFFICIENT_PRIVILEGE) {
    return {
      id: CHECK_ID,
      state: 'pending',
      code: 'migration_ledger_unreadable',
      detail: 'The server\'s database role is not permitted to read the applied-migration ledger, so the schema is not verified. ' +
        'Grant it USAGE on schema drizzle and SELECT on drizzle.__drizzle_migrations.',
    };
  }
  if (pgCode === PG_UNDEFINED_TABLE || pgCode === PG_INVALID_SCHEMA_NAME) {
    return {
      id: CHECK_ID,
      state: 'pending',
      code: 'migration_ledger_missing',
      detail: 'This database has no applied-migration ledger (drizzle.__drizzle_migrations), so the schema is not verified. ' +
        'The ledger is written when this release\'s migrations are applied; a schema created any other way has none.',
    };
  }
  const reason = pgCode ? `PostgreSQL error ${pgCode}` : 'the database did not answer';
  return {
    id: CHECK_ID,
    state: 'pending',
    code: 'migration_ledger_unreadable',
    detail: `The applied-migration ledger could not be read (${reason}), so the schema is not verified.`,
  };
}

/** The newest applied timestamp, or -Infinity for an empty ledger. Rows that are not numbers are left to the entry check. */
function newestAppliedAt(applied: readonly AppliedMigration[]): number {
  return applied.reduce(
    (newest, entry) => (/^\d+$/.test(entry.createdAt) ? Math.max(newest, Number(entry.createdAt)) : newest),
    Number.NEGATIVE_INFINITY,
  );
}

/**
 * Compares the migrations this release was built against with the ledger of
 * migrations already applied. It answers two different questions.
 *
 * **Is the database behind this release?** This is the migrator's own rule: it
 * applies every migration newer than the newest one in the ledger. So the
 * database is behind exactly when this release has a migration newer than
 * that. A database that is behind has not had this release's schema changes,
 * and that is the one result that takes a replica out of service.
 *
 * **Does the ledger match this release, entry for entry?** By content hash
 * and timestamp, with a longer ledger allowed, since a newer release may have
 * migrated the database while this replica was still running. A mismatch
 * means the ledger cannot prove the schema is the one this release expects.
 * It does not mean the schema is wrong: a migration file that was reworded
 * after it was applied leaves the old hash in the ledger for ever, because
 * the migrator never re-applies. So a mismatch is reported for a person to
 * look at, and the replica keeps serving.
 */
export function compareMigrationLedger(
  release: readonly ReleaseMigration[],
  applied: readonly AppliedMigration[],
): MigrationLedgerResult {
  const newest = newestAppliedAt(applied);
  const firstUnapplied = release.findIndex(migration => migration.when > newest);
  if (firstUnapplied !== -1) {
    return {
      id: CHECK_ID,
      state: 'failed',
      code: 'migrations_incomplete',
      detail: `${firstUnapplied} of ${release.length} migrations in this release are applied. ` +
        `First missing: ${release[firstUnapplied].tag}.`,
    };
  }
  for (const [index, expected] of release.entries()) {
    const actual = applied.at(index);
    // The ledger's created_at is the journal timestamp itself, read back as text.
    if (actual?.hash !== expected.hash || actual.createdAt !== String(expected.when)) {
      return {
        id: CHECK_ID,
        state: 'failed',
        code: 'migrations_mismatch',
        detail: `Applied migration ${index + 1} does not match ${expected.tag} in this release. ` +
          'Every migration in this release has been applied, but the ledger does not match it entry for entry: ' +
          'a migration file changed after it was applied, or the ledger was edited. Compare the schema before relying on it.',
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

/** True only when the database has not had this release's migrations applied. Nothing else drains a replica. */
export function isDatabaseBehindRelease(result: MigrationLedgerResult): boolean {
  return result.code === 'migrations_incomplete';
}

/**
 * Reads the ledger and compares it. Read-only.
 *
 * The ledger is read in the order the migrator applied it: by timestamp, then
 * by insertion. The release list is strictly increasing by timestamp, so the
 * two line up position by position.
 *
 * A ledger that cannot be read is reported as pending, not failed: the server
 * has learned nothing about the schema, and the usual cause is a role without
 * SELECT on the `drizzle` schema, which is not a schema fault. The result says
 * which it was, so the reason reaches whoever reads the status.
 */
export async function probeMigrationLedger(
  database: DatabaseInstance,
  release: readonly ReleaseMigration[],
): Promise<MigrationLedgerResult> {
  let applied: readonly AppliedMigration[];
  try {
    applied = await database.execute(sql`
      SELECT hash, created_at::text AS "createdAt"
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at, id
    `) as unknown as AppliedMigration[];
  } catch (error) {
    return unverifiedLedger(error);
  }
  return compareMigrationLedger(release, applied);
}
