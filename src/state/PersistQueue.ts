/**
 * Serialized Persistence Queue
 *
 * Ensures database writes from a single store never overlap. Each
 * enqueue() returns a Promise that resolves when the write completes.
 * If a write is already in flight when enqueue() is called, the new
 * write is coalesced — the in-flight write finishes, then the latest
 * state is written exactly once (not once per enqueue() call).
 *
 * Two usage modes:
 * - **Awaited** (confirmation store): caller awaits enqueue() to
 *   guarantee durability before proceeding.
 * - **Fire-and-forget** (activation/challenge stores): caller calls
 *   enqueue() without awaiting — writes are still serialized and
 *   coalesced, failures are logged via the onError callback.
 *
 * @since v2.2.0 — Phase 4, Step 4.2
 */

import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { withRetry } from './persistence-utils.js';
import { DB_PERSIST_MAX_RETRIES, DB_PERSIST_RETRY_DELAY_MS } from './db-persistence-utils.js';

export interface PersistQueueOptions {
  /** Store name for logging (e.g., 'DatabaseConfirmationStore') */
  storeName: string;
  /** Human-readable state type (e.g., 'confirmation state') */
  stateType: string;
  /** Session ID for log attribution */
  sessionId: string;
}

export class PersistQueue {
  private readonly options: PersistQueueOptions;

  /** The persist function is always the latest one enqueued. */
  private pendingWrite: (() => Promise<void>) | null = null;

  /** Resolvers for all callers waiting on the current or next write. */
  private pendingResolvers: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];

  /** True while a write is executing. */
  private flushing = false;

  /** Resolvers waiting for the queue to drain (used by tests). */
  private drainResolvers: Array<() => void> = [];

  constructor(options: PersistQueueOptions) {
    this.options = options;
  }

  /**
   * Enqueue a persist operation. Returns a Promise that resolves when
   * the data has been durably written (or rejects on failure).
   *
   * If a write is already in flight, the operation is coalesced: the
   * current in-flight write finishes, then this operation runs. If
   * multiple enqueue() calls arrive while a write is in flight, only
   * the last operation runs (it captures the latest state).
   */
  enqueue(operation: () => Promise<void>): Promise<void> {
    // Always replace the pending write with the latest state snapshot
    this.pendingWrite = operation;

    const promise = new Promise<void>((resolve, reject) => {
      this.pendingResolvers.push({ resolve, reject });
    });

    // If not already flushing, start the flush loop
    if (!this.flushing) {
      this.flush();
    }

    return promise;
  }

  /**
   * Fire-and-forget variant. Enqueues the operation but does not
   * propagate errors to the caller — failures are logged via
   * SecurityMonitor instead.
   */
  enqueueFireAndForget(operation: () => Promise<void>): void {
    this.enqueue(operation).catch(error => {
      logger.warn(
        `[${this.options.storeName}] Failed to persist ${this.options.stateType} after retries`,
        { error },
      );

      SecurityMonitor.logSecurityEvent({
        type: 'OPERATION_FAILED',
        severity: 'MEDIUM',
        source: `${this.options.storeName}.persistAsync`,
        details: `Failed to persist ${this.options.stateType} for session '${this.options.sessionId}' after ${DB_PERSIST_MAX_RETRIES + 1} attempts`,
        additionalData: { error: String(error), sessionId: this.options.sessionId },
      });
    });
  }

  /**
   * Wait for all in-flight and pending writes to complete.
   * Returns immediately if the queue is idle.
   */
  awaitPending(): Promise<void> {
    if (!this.flushing) return Promise.resolve();
    return new Promise<void>(resolve => {
      this.drainResolvers.push(resolve);
    });
  }

  /**
   * Flush loop: runs pending writes one at a time until the queue
   * is drained. Each write is retried before being considered failed.
   */
  private async flush(): Promise<void> {
    this.flushing = true;

    while (this.pendingWrite) {
      // Grab the latest operation and all waiting resolvers
      const operation = this.pendingWrite;
      const resolvers = this.pendingResolvers;

      this.pendingWrite = null;
      this.pendingResolvers = [];

      try {
        await withRetry(operation, DB_PERSIST_MAX_RETRIES, DB_PERSIST_RETRY_DELAY_MS);
        for (const r of resolvers) r.resolve();
      } catch (error) {
        for (const r of resolvers) r.reject(error);
      }
    }

    this.flushing = false;

    for (const resolve of this.drainResolvers) resolve();
    this.drainResolvers = [];
  }
}
