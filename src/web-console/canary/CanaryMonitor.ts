import { SecurityMonitor } from '../../security/securityMonitor.js';
import type { CanaryCode, CanaryResult } from './CanaryRun.js';

export const CANARY_SCHEDULE_TASK_LABEL = 'webConsole.canary';
/** The shortest schedule: a run is bounded, and leftovers are only swept once they are minutes old. */
export const MIN_CANARY_INTERVAL_MS = 5 * 60_000;
/** A pass older than this says nothing about now. A fault that was found stays reported until a later run clears it. */
export const CANARY_PASS_MAX_AGE_MS = 24 * 60 * 60_000;

/** Who asked for a run: an admin through Operations, or the schedule. */
export type CanaryTrigger = 'admin' | 'schedule';

export interface CanaryRunRecord {
  readonly result: CanaryResult;
  readonly trigger: CanaryTrigger;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

export type CanaryStatusCode = CanaryCode | 'canary_not_run' | 'canary_result_stale';

/** What is known about the check on this server right now. */
export interface CanaryStatus {
  readonly state: CanaryResult['state'];
  readonly code: CanaryStatusCode;
  readonly detail: string;
  /** Null until the canary has run on this server. */
  readonly lastRun: CanaryRunRecord | null;
}

/** True when there is no result to go on: the canary has not run here, or its last pass is too old to count. */
export function hasNoCurrentCanaryResult(status: CanaryStatus): boolean {
  return status.code === 'canary_not_run' || status.code === 'canary_result_stale';
}

export interface CanaryMonitorLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface CanaryScheduleLifecycle {
  registerPeriodicTask(intervalMs: number, task: () => Promise<void>, label: string): unknown;
}

export interface CanaryMonitorOptions {
  /** One canary run. Resolves with a result whatever happens to the run. */
  readonly run: () => Promise<CanaryResult>;
  /** Removes canary records an unfinished run left behind. */
  readonly sweep: (now: Date) => Promise<number>;
  readonly log: CanaryMonitorLog;
  readonly now?: () => Date;
}

/**
 * Runs the canary when asked and remembers the last result.
 *
 * Nothing here runs by itself: a run starts because an admin asked for one or
 * because the schedule, which is off unless configured, came round. The result
 * is held in memory by the server that ran it, so each server reports its own
 * last run and a restart goes back to "not run yet".
 */
export class CanaryMonitor {
  private readonly now: () => Date;
  private inFlight: Promise<CanaryRunRecord> | null = null;
  private last: CanaryRunRecord | null = null;

  constructor(private readonly options: CanaryMonitorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Runs the canary. One run at a time on this server: a request that arrives
   * while a run is in progress gets that run's result, not a second run.
   */
  run(trigger: CanaryTrigger): Promise<CanaryRunRecord> {
    if (this.inFlight) return this.inFlight;
    const run = this.runOnce(trigger).finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  status(): CanaryStatus {
    if (!this.last) {
      return {
        state: 'pending',
        code: 'canary_not_run',
        detail: 'The canary has not run on this server since it started. Run it from Operations, or switch the schedule on.',
        lastRun: null,
      };
    }
    const { result, finishedAt } = this.last;
    if (result.state === 'passed' && this.now().getTime() - finishedAt.getTime() > CANARY_PASS_MAX_AGE_MS) {
      return {
        state: 'pending',
        code: 'canary_result_stale',
        detail: 'The canary last passed more than 24 hours ago, so that result is no longer current. Run it again, or switch the schedule on.',
        lastRun: this.last,
      };
    }
    return { state: result.state, code: result.code, detail: result.detail, lastRun: this.last };
  }

  /** Starts the schedule. Only called when one is configured; there is none by default. */
  register(lifecycle: CanaryScheduleLifecycle, intervalMs: number): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_CANARY_INTERVAL_MS) {
      throw new Error(`Canary schedule interval must be a whole number of milliseconds, at least ${MIN_CANARY_INTERVAL_MS}`);
    }
    lifecycle.registerPeriodicTask(intervalMs, async () => { await this.run('schedule'); }, CANARY_SCHEDULE_TASK_LABEL);
  }

  /**
   * Removes what a run left behind when the server stopped under it. Called
   * once at start-up. A failure is logged and nothing else: every run sweeps
   * again before it starts.
   */
  async sweepLeftovers(): Promise<void> {
    try {
      const removed = await this.options.sweep(this.now());
      if (removed > 0) this.options.log.info(`[WebConsoleCanary] Removed ${removed} canary session(s) left by an unfinished run`);
    } catch {
      // The driver's message can carry connection details, so it is not logged.
      this.options.log.warn('[WebConsoleCanary] Could not sweep canary leftovers at start-up; the next run sweeps again');
    }
  }

  private async runOnce(trigger: CanaryTrigger): Promise<CanaryRunRecord> {
    const startedAt = this.now();
    const result = await this.options.run();
    const record: CanaryRunRecord = { result, trigger, startedAt, finishedAt: this.now() };
    this.last = record;
    const line = `[WebConsoleCanary] ${trigger} run: ${result.code}. ${result.detail}`;
    if (result.state === 'passed') this.options.log.info(line);
    else this.options.log.warn(line);
    // An admin's run is in the admin audit, with the admin as the actor. A
    // scheduled run has no actor, so it is recorded here as a system event.
    if (trigger === 'schedule') recordScheduledRun(record);
    return record;
  }
}

function recordScheduledRun(record: CanaryRunRecord): void {
  const { result, finishedAt } = record;
  SecurityMonitor.logSecurityEvent({
    type: result.state === 'passed' ? 'OPERATION_COMPLETED' : 'OPERATION_FAILED',
    severity: result.state === 'failed' ? 'MEDIUM' : 'LOW',
    source: 'WebConsoleCanary',
    // The time keeps each run a separate event: identical events are otherwise merged.
    details: `Scheduled canary run finished at ${finishedAt.toISOString()}: ${result.code}`,
    additionalData: { check: result.id, trigger: 'schedule', state: result.state, code: result.code },
  });
}
