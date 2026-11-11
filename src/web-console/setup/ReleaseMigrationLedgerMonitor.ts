import type { DatabaseInstance } from '../../database/connection.js';
import { getErrorCode } from '../../database/db-utils.js';
import type { ReleaseMigration } from '../../database/releaseMigrations.js';
import { MigrationLedgerMonitor } from './MigrationLedgerMonitor.js';
import { MIGRATION_LEDGER_UNREADABLE, probeMigrationLedger } from './MigrationLedgerProbe.js';

export interface ReleaseMigrationLedgerLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ReleaseMigrationLedgerMonitorOptions {
  readonly database: DatabaseInstance;
  /** Loads the migrations this release was built against. Called until it succeeds. */
  readonly loadRelease: () => Promise<readonly ReleaseMigration[]>;
  readonly log: ReleaseMigrationLedgerLog;
  readonly recheckMs?: number;
  readonly now?: () => number;
}

/**
 * The monitor the console runs: the ledger probe over the console database,
 * with each change of answer written to the server log once.
 *
 * An unverifiable ledger never fails anything, so the log line is how an
 * operator finds out: it says the schema is unverified, why, and what to grant.
 */
export function createReleaseMigrationLedgerMonitor(options: ReleaseMigrationLedgerMonitorOptions): MigrationLedgerMonitor {
  let release: Promise<readonly ReleaseMigration[]> | null = null;
  let unverifiedBecause = '';
  return new MigrationLedgerMonitor({
    recheckMs: options.recheckMs,
    now: options.now,
    probe: async () => {
      try {
        release ??= options.loadRelease();
        return await probeMigrationLedger(options.database, await release, error => {
          unverifiedBecause = `the applied-migration ledger could not be read (${ledgerReadFailure(error)})`;
        });
      } catch {
        release = null;
        unverifiedBecause = 'this release\'s migration list could not be loaded, which points to an incomplete build';
        return MIGRATION_LEDGER_UNREADABLE;
      }
    },
    onChange: result => {
      if (result.state === 'failed') {
        options.log.error(`[WebConsole] Database is behind this release; reporting not ready. ${result.detail}`);
      } else if (result.state === 'passed') {
        options.log.info(`[WebConsole] ${result.detail}`);
      } else {
        options.log.warn(
          `[WebConsole] Database migrations are NOT verified: ${unverifiedBecause}. ` +
          'The server keeps serving. Grant its database role SELECT on the drizzle schema ' +
          '(GRANT USAGE ON SCHEMA drizzle and GRANT SELECT ON drizzle.__drizzle_migrations) so it can check.',
        );
      }
    },
  });
}

/**
 * Names the failure by its PostgreSQL error class. The driver's own message is
 * left out: it can carry connection details.
 */
function ledgerReadFailure(error: unknown): string {
  const code = getErrorCode(error);
  if (code === '42501') return 'permission denied';
  if (code === '42P01' || code === '3F000') return 'the ledger does not exist in this database';
  return code ? `PostgreSQL error ${code}` : 'the database did not answer';
}
