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
    // The ledger's created_at is the journal timestamp itself, read back as text.
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
