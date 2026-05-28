import type { IConsoleSessionStore } from '../stores/IConsoleSessionStore.js';
import type { IIdempotencyStore } from '../stores/IIdempotencyStore.js';
import type { ILoginTransactionStore } from '../stores/ILoginTransactionStore.js';
import type { IRuntimeSessionControlStore } from '../services/runtime/IRuntimeSessionControlStore.js';

export const DEFAULT_CONSOLE_STORE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const CONSOLE_STORE_CLEANUP_TASK_LABEL = 'webConsole.storeCleanup';

export interface ConsoleStoreCleanupStores {
  readonly sessionStore: Pick<IConsoleSessionStore, 'sweepExpired'>;
  readonly loginTransactionStore: Pick<ILoginTransactionStore, 'sweepExpired'>;
  readonly idempotencyStore: Pick<IIdempotencyStore, 'sweepExpired'>;
  readonly runtimeSessionControlStore?: Pick<IRuntimeSessionControlStore, 'sweepStalePresence'>;
  // account_factors is intentionally excluded; disabled factor rows remain for status history and audit context.
}

export interface ConsoleStoreCleanupLifecycle {
  registerPeriodicTask(intervalMs: number, task: () => Promise<void>, label: string): unknown;
}

export interface ConsoleStoreCleanupError {
  readonly store: ConsoleStoreCleanupStoreName;
  readonly error: unknown;
}

export interface ConsoleStoreCleanupResult {
  readonly before: Date;
  readonly removed: Readonly<Record<ConsoleStoreCleanupStoreName, number>>;
  readonly errors: readonly ConsoleStoreCleanupError[];
}

export interface ConsoleStoreCleanupSchedulerOptions {
  readonly stores: ConsoleStoreCleanupStores;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly reportError?: (error: ConsoleStoreCleanupError) => void;
}

type ConsoleStoreCleanupStoreName =
  | 'consoleSessions'
  | 'loginTransactions'
  | 'idempotencyRecords'
  | 'runtimeSessionPresence';

type SweepStore = Pick<IConsoleSessionStore, 'sweepExpired'>;
type RuntimePresenceSweepStore = Pick<IRuntimeSessionControlStore, 'sweepStalePresence'>;

export class ConsoleStoreCleanupScheduler {
  private readonly stores: ConsoleStoreCleanupStores;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly reportError?: (error: ConsoleStoreCleanupError) => void;
  private running = false;

  constructor(options: ConsoleStoreCleanupSchedulerOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_CONSOLE_STORE_CLEANUP_INTERVAL_MS;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error('Console store cleanup interval must be a positive integer number of milliseconds');
    }
    this.stores = options.stores;
    this.now = options.now ?? (() => new Date());
    this.reportError = options.reportError;
  }

  register(lifecycle: ConsoleStoreCleanupLifecycle): void {
    if (!this.reportError) {
      throw new Error('Console store cleanup scheduled registration requires reportError');
    }
    lifecycle.registerPeriodicTask(
      this.intervalMs,
      async () => { await this.runOnce(); },
      CONSOLE_STORE_CLEANUP_TASK_LABEL,
    );
  }

  async runOnce(): Promise<ConsoleStoreCleanupResult | null> {
    if (this.running) return null;
    this.running = true;
    const before = this.now();
    const removed: Record<ConsoleStoreCleanupStoreName, number> = {
      consoleSessions: 0,
      loginTransactions: 0,
      idempotencyRecords: 0,
      runtimeSessionPresence: 0,
    };
    const errors: ConsoleStoreCleanupError[] = [];

    try {
      removed.consoleSessions = await this.sweep('consoleSessions', this.stores.sessionStore, before, errors);
      removed.loginTransactions = await this.sweep('loginTransactions', this.stores.loginTransactionStore, before, errors);
      removed.idempotencyRecords = await this.sweep('idempotencyRecords', this.stores.idempotencyStore, before, errors);
      if (this.stores.runtimeSessionControlStore) {
        removed.runtimeSessionPresence = await this.sweepRuntimePresence(
          this.stores.runtimeSessionControlStore,
          before,
          errors,
        );
      }
      return { before: new Date(before.getTime()), removed, errors };
    } finally {
      this.running = false;
    }
  }

  private async sweep(
    storeName: ConsoleStoreCleanupStoreName,
    store: SweepStore,
    before: Date,
    errors: ConsoleStoreCleanupError[],
  ): Promise<number> {
    try {
      return await store.sweepExpired(before);
    } catch (error) {
      const cleanupError = { store: storeName, error };
      errors.push(cleanupError);
      this.reportError?.(cleanupError);
      return 0;
    }
  }

  private async sweepRuntimePresence(
    store: RuntimePresenceSweepStore,
    before: Date,
    errors: ConsoleStoreCleanupError[],
  ): Promise<number> {
    try {
      return await store.sweepStalePresence(before);
    } catch (error) {
      const cleanupError = { store: 'runtimeSessionPresence' as const, error };
      errors.push(cleanupError);
      this.reportError?.(cleanupError);
      return 0;
    }
  }
}
