import type { DatabaseInstance } from '../../database/connection.js';
import type { ReleaseMigration } from '../../database/releaseMigrations.js';
import { MigrationLedgerMonitor } from './MigrationLedgerMonitor.js';
import { isDatabaseBehindRelease, RELEASE_MIGRATIONS_UNAVAILABLE, probeMigrationLedger } from './MigrationLedgerProbe.js';

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
 * operator finds out: it says the schema is unverified, why, and what to do.
 */
export function createReleaseMigrationLedgerMonitor(options: ReleaseMigrationLedgerMonitorOptions): MigrationLedgerMonitor {
  let release: Promise<readonly ReleaseMigration[]> | null = null;
  return new MigrationLedgerMonitor({
    recheckMs: options.recheckMs,
    now: options.now,
    probe: async () => {
      try {
        release ??= options.loadRelease();
        return await probeMigrationLedger(options.database, await release);
      } catch {
        release = null;
        return RELEASE_MIGRATIONS_UNAVAILABLE;
      }
    },
    onChange: result => {
      if (isDatabaseBehindRelease(result)) {
        options.log.error(`[WebConsole] Database does not have this release's migrations; reporting not ready. ${result.detail}`);
      } else if (result.state === 'failed') {
        options.log.error(`[WebConsole] Applied migrations do not match this release; the server keeps serving. ${result.detail}`);
      } else if (result.state === 'passed') {
        options.log.info(`[WebConsole] ${result.detail}`);
      } else {
        options.log.warn(`[WebConsole] Database migrations are NOT verified; the server keeps serving. ${result.detail}`);
      }
    },
  });
}
