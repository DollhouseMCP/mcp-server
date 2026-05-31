import type {
  IPortfolioSyncJobStore,
  PortfolioSyncJobRecord,
} from '../../stores/IPortfolioSyncJobStore.js';
import { PORTFOLIO_SYNC_WORKER_ID_MAX_LENGTH } from '../../stores/IPortfolioSyncJobStore.js';

export const DEFAULT_PORTFOLIO_SYNC_WORKER_INTERVAL_MS = 15_000;
export const DEFAULT_PORTFOLIO_SYNC_WORKER_LEASE_DURATION_MS = 60_000;
export const DEFAULT_PORTFOLIO_SYNC_WORKER_BATCH_SIZE = 1;
export const PORTFOLIO_SYNC_WORKER_TASK_LABEL = 'webConsole.portfolioSyncWorker';

export interface ConsolePortfolioSyncWorkerLifecycle {
  registerPeriodicTask(intervalMs: number, task: () => Promise<void>, label: string): unknown;
}

export type PortfolioSyncWorkerOutcome =
  | {
      readonly status: 'succeeded';
      readonly resultSummary: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: 'failed';
      readonly operationalErrorCode: string;
      readonly resultSummary: Readonly<Record<string, unknown>> | null;
    };

export interface IPortfolioSyncJobExecutor {
  execute(job: PortfolioSyncJobRecord): Promise<PortfolioSyncWorkerOutcome>;
}

export interface ConsolePortfolioSyncWorkerOptions {
  readonly store: IPortfolioSyncJobStore;
  readonly workerId: string;
  readonly executor?: IPortfolioSyncJobExecutor;
  readonly intervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly batchSize?: number;
  readonly now?: () => Date;
  readonly reportError?: (error: unknown) => void;
}

export interface ConsolePortfolioSyncWorkerRunResult {
  readonly workerId: string;
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly staleCompletions: number;
}

export interface IConsolePortfolioSyncWorker {
  isRunning(): boolean;
  register(lifecycle: ConsolePortfolioSyncWorkerLifecycle): void;
  runOnce(): Promise<ConsolePortfolioSyncWorkerRunResult | null>;
}

export class ConsolePortfolioSyncWorker implements IConsolePortfolioSyncWorker {
  private readonly executor: IPortfolioSyncJobExecutor;
  private readonly intervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private registered = false;
  private running = false;

  constructor(private readonly options: ConsolePortfolioSyncWorkerOptions) {
    validateWorkerId(options.workerId);
    this.executor = options.executor ? options.executor : new ProviderUnavailablePortfolioSyncExecutor();
    this.intervalMs = validatePositiveInteger(
      options.intervalMs ?? DEFAULT_PORTFOLIO_SYNC_WORKER_INTERVAL_MS,
      'portfolio sync worker interval',
    );
    this.leaseDurationMs = validatePositiveInteger(
      options.leaseDurationMs ?? DEFAULT_PORTFOLIO_SYNC_WORKER_LEASE_DURATION_MS,
      'portfolio sync worker lease duration',
    );
    this.batchSize = validatePositiveInteger(
      options.batchSize ?? DEFAULT_PORTFOLIO_SYNC_WORKER_BATCH_SIZE,
      'portfolio sync worker batch size',
    );
    this.now = options.now ?? (() => new Date());
  }

  isRunning(): boolean {
    return this.registered;
  }

  register(lifecycle: ConsolePortfolioSyncWorkerLifecycle): void {
    if (this.registered) return;
    this.registered = true;
    lifecycle.registerPeriodicTask(
      this.intervalMs,
      async () => { await this.runOnce(); },
      PORTFOLIO_SYNC_WORKER_TASK_LABEL,
    );
  }

  async runOnce(): Promise<ConsolePortfolioSyncWorkerRunResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.drainOnce();
    } catch (error) {
      this.options.reportError?.(error);
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async drainOnce(): Promise<ConsolePortfolioSyncWorkerRunResult> {
    const result: ConsolePortfolioSyncWorkerRunResultMutable = {
      workerId: this.options.workerId,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      staleCompletions: 0,
    };
    for (let index = 0; index < this.batchSize; index += 1) {
      const now = this.now();
      const job = await this.options.store.claimNext({
        workerId: this.options.workerId,
        now,
        leaseUntil: new Date(now.getTime() + this.leaseDurationMs),
      });
      if (!job) break;
      result.claimed += 1;
      await this.executeClaimedJob(job, result);
    }
    return result;
  }

  private async executeClaimedJob(
    job: PortfolioSyncJobRecord,
    result: ConsolePortfolioSyncWorkerRunResultMutable,
  ): Promise<void> {
    try {
      const outcome = await this.executor.execute(job);
      if (outcome.status === 'succeeded') {
        const completed = await this.options.store.complete({
          jobId: job.id,
          claimVersion: job.claimVersion,
          resultSummary: outcome.resultSummary,
          completedAt: this.now(),
        });
        if (completed) result.succeeded += 1;
        else result.staleCompletions += 1;
        return;
      }
      await this.failClaimedJob(job, outcome.operationalErrorCode, outcome.resultSummary, result);
    } catch (error) {
      this.options.reportError?.(error);
      await this.failClaimedJob(job, 'portfolio_sync_worker_failed', null, result);
    }
  }

  private async failClaimedJob(
    job: PortfolioSyncJobRecord,
    operationalErrorCode: string,
    resultSummary: Readonly<Record<string, unknown>> | null,
    result: ConsolePortfolioSyncWorkerRunResultMutable,
  ): Promise<void> {
    const failed = await this.options.store.fail({
      jobId: job.id,
      claimVersion: job.claimVersion,
      operationalErrorCode,
      resultSummary,
      completedAt: this.now(),
    });
    if (failed) result.failed += 1;
    else result.staleCompletions += 1;
  }
}

class ProviderUnavailablePortfolioSyncExecutor implements IPortfolioSyncJobExecutor {
  execute(): Promise<PortfolioSyncWorkerOutcome> {
    return Promise.resolve({
      status: 'failed',
      operationalErrorCode: 'portfolio_sync_provider_unavailable',
      resultSummary: { provider_available: false },
    });
  }
}

interface ConsolePortfolioSyncWorkerRunResultMutable extends ConsolePortfolioSyncWorkerRunResult {
  claimed: number;
  succeeded: number;
  failed: number;
  staleCompletions: number;
}

function validateWorkerId(value: string): void {
  if (value.trim() === '' || value.length > PORTFOLIO_SYNC_WORKER_ID_MAX_LENGTH) {
    throw new Error(`portfolio sync worker ID must be non-empty and at most ${PORTFOLIO_SYNC_WORKER_ID_MAX_LENGTH} characters`);
  }
}

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}
