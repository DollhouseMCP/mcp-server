import type { ManifestDiffResult } from './types.js';

export interface ScanState {
  lastScanAt: number;
  scanInProgress: Promise<ManifestDiffResult> | null;
}

/** Idle directory metadata is reconstructible; active I/O must retain its state. */
export const MAX_CACHED_DIRECTORY_STATES = 128;

/**
 * LRU cache for directory indexes/manifests. Busy states may temporarily exceed
 * the cap; callers trim again when their work settles. No session-lifecycle ties.
 */
export class DirectoryStateCache<T extends ScanState> {
  private readonly activeUses = new WeakMap<T, number>();
  private readonly states = new Map<string, T>();

  constructor(
    private readonly isIdle: (state: T, dir: string) => boolean = () => true,
    private readonly dispose: (state: T) => void = () => {},
  ) {}

  get size(): number { return this.states.size; }

  get(dir: string): T | undefined {
    const state = this.states.get(dir);
    if (state !== undefined) {
      this.states.delete(dir);
      this.states.set(dir, state);
    }
    return state;
  }

  set(dir: string, state: T): void {
    this.states.delete(dir);
    this.states.set(dir, state);
    // The caller has not yet marked newly acquired state busy.
    this.trim(dir);
  }

  async use<R>(state: T, operation: () => Promise<R>): Promise<R> {
    this.activeUses.set(state, (this.activeUses.get(state) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      this.activeUses.set(state, this.activeUses.get(state)! - 1);
      this.trim();
    }
  }

  /** Hold the scanned state until its result is read, including under overflow pressure. */
  scanAndRead<R>(state: T, scan: () => Promise<ManifestDiffResult>, read: () => R): Promise<R> {
    return this.use(state, async () => {
      await scan();
      return read();
    });
  }

  async runScan(state: T, operation: () => Promise<ManifestDiffResult>): Promise<ManifestDiffResult> {
    const pending = operation();
    state.scanInProgress = pending;
    try {
      return await pending;
    } finally {
      if (state.scanInProgress === pending) state.scanInProgress = null;
      this.trim();
    }
  }

  values(): IterableIterator<T> { return this.states.values(); }

  trim(protectedDir?: string): void {
    for (const [dir, state] of this.states) {
      if (this.states.size <= MAX_CACHED_DIRECTORY_STATES) break;
      if (dir === protectedDir || state.scanInProgress || this.activeUses.get(state) || !this.isIdle(state, dir)) continue;
      this.states.delete(dir);
      this.dispose(state);
    }
  }
}
