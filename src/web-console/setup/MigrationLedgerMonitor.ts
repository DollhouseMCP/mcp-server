import type { MigrationLedgerResult } from './MigrationLedgerProbe.js';

export const DEFAULT_MIGRATION_LEDGER_RECHECK_MS = 15_000;

export interface MigrationLedgerMonitorOptions {
  /** Runs the probe. Must not throw; an unreadable ledger is a `pending` result. */
  readonly probe: () => Promise<MigrationLedgerResult>;
  /** Minimum time between probes while the ledger has not passed. */
  readonly recheckMs?: number;
  readonly now?: () => number;
  /** Called when the reported state changes, including the first result. */
  readonly onChange?: (result: MigrationLedgerResult) => void;
}

/**
 * Keeps the migration ledger answer cheap enough for a readiness endpoint that
 * load balancers poll every few seconds.
 *
 * A pass is final for the life of the process: the release's migrations do not
 * change and a ledger does not lose entries. Until then the probe is re-run at
 * most once per interval, and concurrent callers share one run.
 */
export class MigrationLedgerMonitor {
  private readonly probe: () => Promise<MigrationLedgerResult>;
  private readonly recheckMs: number;
  private readonly now: () => number;
  private readonly onChange?: (result: MigrationLedgerResult) => void;
  private last: MigrationLedgerResult | null = null;
  private lastCheckedAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<MigrationLedgerResult> | null = null;

  constructor(options: MigrationLedgerMonitorOptions) {
    this.probe = options.probe;
    this.recheckMs = options.recheckMs ?? DEFAULT_MIGRATION_LEDGER_RECHECK_MS;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
  }

  current(): Promise<MigrationLedgerResult> {
    if (this.last?.state === 'passed') return Promise.resolve(this.last);
    if (this.last && this.now() - this.lastCheckedAt < this.recheckMs) return Promise.resolve(this.last);
    this.inFlight ??= this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /**
   * False only when the server has looked and found the schema behind this
   * release. An unverifiable ledger does not take the replica out of service.
   */
  async isSafeToServe(): Promise<boolean> {
    return (await this.current()).state !== 'failed';
  }

  private async run(): Promise<MigrationLedgerResult> {
    const result = await this.probe();
    const changed = this.last?.code !== result.code || this.last.detail !== result.detail;
    this.last = result;
    this.lastCheckedAt = this.now();
    if (changed) this.onChange?.(result);
    return result;
  }
}
