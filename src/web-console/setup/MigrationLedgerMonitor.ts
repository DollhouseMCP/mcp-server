import { MIGRATION_LEDGER_PROBE_TIMED_OUT, type MigrationLedgerResult } from './MigrationLedgerProbe.js';

export const DEFAULT_MIGRATION_LEDGER_RECHECK_MS = 15_000;
export const DEFAULT_MIGRATION_LEDGER_PROBE_TIMEOUT_MS = 2_000;

export interface MigrationLedgerMonitorOptions {
  /** Runs the probe. Must not throw; an unreadable ledger is a `pending` result. */
  readonly probe: () => Promise<MigrationLedgerResult>;
  /** Minimum time between probes while the ledger has not passed. */
  readonly recheckMs?: number;
  /** How long a caller waits for a probe before being told the ledger is unverified. */
  readonly probeTimeoutMs?: number;
  readonly now?: () => number;
  /** Called when the reported state changes, including the first result. */
  readonly onChange?: (result: MigrationLedgerResult) => void;
}

/**
 * Keeps the migration ledger answer cheap and prompt enough for a readiness
 * endpoint that load balancers poll every few seconds.
 *
 * A pass is final for the life of the process: the release's migrations do not
 * change and a ledger does not lose entries. Until then the probe is re-run at
 * most once per interval, and concurrent callers share one run.
 *
 * No caller waits longer than the probe timeout. A probe that overruns, for
 * instance behind a lock on the ledger, is answered as unverified, which does
 * not take the replica out of service. It is left to finish and its answer is
 * used when it arrives; no second probe is started while it is outstanding, so
 * a stalled database does not collect blocked queries.
 */
export class MigrationLedgerMonitor {
  private readonly probe: () => Promise<MigrationLedgerResult>;
  private readonly recheckMs: number;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;
  private readonly onChange?: (result: MigrationLedgerResult) => void;
  private last: MigrationLedgerResult | null = null;
  private lastCheckedAt = Number.NEGATIVE_INFINITY;
  /** The probe itself, until it settles, however long that takes. */
  private running: Promise<void> | null = null;
  /** The probe raced against the timeout, shared by callers that arrive together. */
  private waiting: Promise<MigrationLedgerResult> | null = null;

  constructor(options: MigrationLedgerMonitorOptions) {
    this.probe = options.probe;
    this.recheckMs = options.recheckMs ?? DEFAULT_MIGRATION_LEDGER_RECHECK_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_MIGRATION_LEDGER_PROBE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
  }

  current(): Promise<MigrationLedgerResult> {
    if (this.last?.state === 'passed') return Promise.resolve(this.last);
    if (this.last && this.now() - this.lastCheckedAt < this.recheckMs) return Promise.resolve(this.last);
    if (this.waiting) return this.waiting;
    // An earlier probe overran and is still out. Its timeout answer stands
    // until it returns; asking again would only queue another query behind it.
    if (this.running && this.last) return Promise.resolve(this.last);
    this.waiting = this.start().finally(() => { this.waiting = null; });
    return this.waiting;
  }

  /**
   * False only when the server has looked and found the schema behind this
   * release. An unverifiable ledger does not take the replica out of service.
   */
  async isSafeToServe(): Promise<boolean> {
    return (await this.current()).state !== 'failed';
  }

  private start(): Promise<MigrationLedgerResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = this.probe().then(result => this.record(result));
    this.running = run.then(() => undefined, () => undefined).finally(() => { this.running = null; });
    const deadline = new Promise<MigrationLedgerResult>(resolve => {
      timer = setTimeout(() => resolve(this.recordTimeout()), this.probeTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([run, deadline]).finally(() => clearTimeout(timer));
  }

  /**
   * A slow re-check does not overturn a fault the server has already verified:
   * a database known to be behind stays reported as behind until a probe
   * actually says otherwise.
   */
  private recordTimeout(): MigrationLedgerResult {
    return this.record(this.last?.state === 'failed' ? this.last : MIGRATION_LEDGER_PROBE_TIMED_OUT);
  }

  private record(result: MigrationLedgerResult): MigrationLedgerResult {
    const changed = this.last?.code !== result.code || this.last.detail !== result.detail;
    this.last = result;
    this.lastCheckedAt = this.now();
    if (changed) this.onChange?.(result);
    return result;
  }
}
