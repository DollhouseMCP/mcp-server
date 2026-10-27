import { logger } from '../utils/logger.js';
import type { HydratedIndex, PersistableIndex } from './FileStateTable.js';
import { MemoryIndexFile } from './MemoryIndexFile.js';

export interface IndexPersistence {
  read(): Promise<HydratedIndex | null>;
  request(snapshot: () => PersistableIndex | null, onPersisted: (generation: number) => void): void;
  flush(): Promise<boolean>;
  cancelPending(): void;
  dispose(): void;
  hasPendingWrite(): boolean;
}
export interface MemoryIndexPersistenceOptions { debounceMs?: number; onIdle?: () => void }
interface FlushWaiter { resolve: (success: boolean) => void; failed: boolean; remaining: number }

/** Serializes writes, retains failed obligations, and captures snapshots at write time. */
export class MemoryIndexPersistence implements IndexPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;
  private disposed = false;
  private active = false;
  private failed = false;
  private retryDelay = 0;
  private snapshot: (() => PersistableIndex | null) | undefined;
  private onPersisted: ((generation: number) => void) | undefined;
  private readonly waiters = new Set<FlushWaiter>();
  constructor(private readonly file: MemoryIndexFile, private readonly options: MemoryIndexPersistenceOptions = {}) {}
  async read(): Promise<HydratedIndex | null> {
    const data = await this.file.read();
    return data ? { entries: Object.values(data.entries), blocked: data.blocked ?? {} } : null;
  }
  request(snapshot: () => PersistableIndex | null, onPersisted: (generation: number) => void): void {
    if (this.disposed) return;
    this.snapshot = snapshot;
    this.onPersisted = onPersisted;
    this.pending = true;
    if (!this.active) this.schedule(this.options.debounceMs ?? 2000);
  }
  private schedule(delay: number): void {
    this.cancelTimer();
    this.timer = setTimeout(() => { this.timer = null; this.startWrite(); }, delay);
    this.timer.unref?.();
  }
  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  private startWrite(): void {
    if (this.active || this.disposed) return;
    this.pending = false;
    const snapshot = this.snapshot?.();
    const acknowledge = this.onPersisted;
    if (!snapshot) { this.finish(false); return; }
    this.active = true;
    void this.file.write(snapshot.entries, snapshot.blocked).then(() => {
      this.failed = false;
      this.retryDelay = 0;
      if (!this.disposed) acknowledge?.(snapshot.generation);
      this.finish(false);
    }, (error: unknown) => {
      logger[this.failed ? 'warn' : 'error']('MemoryIndexPersistence: index write failed', error);
      this.failed = true;
      this.finish(true);
    });
  }
  private finish(writeFailed: boolean): void {
    this.active = false;
    const trailing = this.pending;
    for (const waiter of this.waiters) {
      waiter.failed ||= writeFailed;
      waiter.remaining--;
      if (!trailing || waiter.remaining === 0) {
        waiter.resolve(!waiter.failed && !this.failed);
        this.waiters.delete(waiter);
      }
    }
    if (this.disposed) return;
    if (trailing) { this.startWrite(); return; }
    if (writeFailed && this.snapshot?.()) {
      this.pending = true;
      this.retryDelay = Math.min(60000, this.retryDelay ? this.retryDelay * 2 : Math.max(1, this.options.debounceMs ?? 2000));
      this.schedule(this.retryDelay);
    } else this.options.onIdle?.();
  }
  flush(): Promise<boolean> {
    this.cancelTimer();
    if (!this.active && !this.pending) return Promise.resolve(!this.failed);
    const result = new Promise<boolean>(resolve => {
      this.waiters.add({ resolve, failed: false, remaining: 2 });
    });
    if (!this.active) this.startWrite();
    return result;
  }
  cancelPending(): void {
    this.cancelTimer(); this.pending = false; this.snapshot = undefined; this.onPersisted = undefined;
    this.failed = false; this.retryDelay = 0;
    if (!this.active) this.options.onIdle?.();
  }
  /** The owner flushes once before shutting down retry resources. */
  dispose(): void { this.disposed = true; this.cancelPending(); }
  hasPendingWrite(): boolean { return this.active || this.pending; }
}
