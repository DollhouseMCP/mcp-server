/** Shared file I/O lifecycle; FileStateTable owns every record and publication rule. */
import { sanitizeStorageError } from './StorageScanError.js';
import { mapStorageItems } from './mapStorageItems.js';
import * as path from 'node:path';
import { isAbsentPathError } from '../services/FileOperationsService.js';
import { logger } from '../utils/logger.js';
import { findFileIndexedPath, readFileIndex } from './FileIndexReader.js';
import { DirectoryStateCache } from './DirectoryStateCache.js';
import { FileStateTable, type ScanOutcome, type ScanPublication, type ScanToken } from './FileStateTable.js';
import type { IndexPersistence } from './MemoryIndexPersistence.js';
import type { IStorageBackend } from './IStorageBackend.js';
import type { IndexedPathResult, IStorageLayer, StorageScanOptions, UnindexedEntry } from './IStorageLayer.js';
import { mergeManifestDiffResults, type ElementIndexEntry, type ManifestDiffResult } from './types.js';
export const EMPTY_DIFF = (): ManifestDiffResult => ({ added: [], modified: [], removed: [], unchanged: [] });
export interface DirScanState {
  table: FileStateTable;
  lastScanAt: number;
  scanError?: unknown;
  scanInProgress: Promise<ManifestDiffResult> | null;
  persistence?: IndexPersistence;
  hydrationStarted: boolean;
}
function failureOf(error: unknown, root: string, relativePath: string): UnindexedEntry {
  const code = (error as NodeJS.ErrnoException)?.code;
  const safe = sanitizeStorageError(error, root, path.join(root, relativePath));
  return { reason: safe instanceof Error ? safe.message : String(safe),
    name: error instanceof Error ? error.name : typeof error,
    ...(code === undefined ? {} : { code }) };
}
export abstract class FileStorageLayerBase<S extends DirScanState = DirScanState> implements IStorageLayer {
  protected disposed = false;
  dispose(): Promise<void> { this.disposed = true; return Promise.resolve(); }
  protected assertActive(): void {
    if (this.disposed) throw new Error('Storage layer disposed');
  }
  protected constructor(protected readonly backend: IStorageBackend, protected readonly dirStates: DirectoryStateCache<S>,
    private readonly scanCooldownMs = 1000) {}
  protected abstract get directory(): string;
  protected abstract extendState(dir: string, base: DirScanState): S;
  protected abstract readonly scanLabel: string;
  protected abstract enumerate(dir: string): Promise<string[]>;
  /** Extract metadata from content using the already observed file stat. */
  protected abstract readIndexEntry(content: string, relPath: string, stats: Map<string, { mtimeMs: number; sizeBytes: number }>): ElementIndexEntry;
  protected abstract logCooldown(dir: string, remainingMs: number): void;
  protected abstract logDiskScan(dir: string, fileCount: number, diff: ManifestDiffResult): void;
  protected getState(dir = this.directory): S {
    this.assertActive();
    let state = this.dirStates.get(dir);
    if (!state) {
      state = this.extendState(dir, { table: new FileStateTable(), lastScanAt: 0, scanInProgress: null, hydrationStarted: false });
      this.dirStates.set(dir, state);
    }
    return state;
  }
  abstract listSummaries(options?: { includePublic?: boolean; preserveDuplicates?: boolean; freshMetadata?: boolean }): Promise<ElementIndexEntry[]>;
  abstract getIndexedPaths(): Promise<string[]>;
  async notifySaved(relativePath: string, absolutePath: string): Promise<void> {
    if (this.disposed) return;
    const state = this.getState();
    return this.dirStates.use(state, async () => {
      let observedMtime: number | undefined;
      try {
        const meta = await this.backend.stat(absolutePath);
        observedMtime = meta.mtimeMs;
        const content = await this.backend.readFile(absolutePath);
        if (this.disposed) return;
        state.table.applySaved(relativePath, meta.mtimeMs, this.readIndexEntry(content, relativePath, new Map([[relativePath, meta]])));
      } catch (error) {
        if (this.disposed) return;
        if (isAbsentPathError(error)) state.table.applyAbsent(relativePath);
        else {
          const failure = failureOf(error, this.directory, relativePath);
          this.logFailure(relativePath, failure, state.table.applyFailure(relativePath, failure, observedMtime));
        }
      }
      this.requestPersistence(state);
    });
  }
  notifyDeleted(relativePath: string): void {
    if (this.disposed) return;
    const state = this.getState();
    state.table.applyDeleted(relativePath);
    this.requestPersistence(state);
  }
  protected requestPersistence(state: S): void {
    if (this.disposed) return;
    if ((state.table.hasUnsavedChanges() || state.table.needsInitialWrite()) && state.table.everSucceeded) {
      state.persistence?.request(() => state.table.persistableSnapshot(), generation => state.table.markPersisted(generation));
    }
  }
  async scan(options: StorageScanOptions = {}): Promise<ManifestDiffResult> {
    const dir = this.directory;
    const state = this.getState(dir);
    return this.dirStates.use(state, () => this.scanState(dir, state, options));
  }
  protected async scanState(currentDir: string, state: S, options: StorageScanOptions): Promise<ManifestDiffResult> {
    this.assertActive();
    const existingScan = state.scanInProgress;
    if (existingScan) {
      if (!options.freshAfterInFlight) return existingScan;

      let initialDiff: ManifestDiffResult | undefined;
      try {
        initialDiff = await existingScan;
      } catch {
        // Give the trailing scan an independent chance to recover.
      }

      const successor = state.scanInProgress;
      const trailingDiff = successor && successor !== existingScan
        ? await successor
        : await this.startScan(currentDir, state);
      return initialDiff ? mergeManifestDiffResults(initialDiff, trailingDiff) : trailingDiff;
    }

    const elapsed = Date.now() - state.lastScanAt;
    if (elapsed < this.scanCooldownMs && !state.table.needsScan()) {
      if (state.table.lastScan === 'failed') throw state.scanError;
      this.logCooldown(currentDir, this.scanCooldownMs - elapsed);
      return EMPTY_DIFF();
    }
    return this.startScan(currentDir, state);
  }
  protected startScan(dir: string, state: S): Promise<ManifestDiffResult> {
    return this.dirStates.runScan(state, () => this.performScanForDir(dir, state));
  }
  findIndexedPath(names: readonly string[]): Promise<string | undefined> {
    const dir = this.directory;
    const state = this.getState(dir);
    return findFileIndexedPath(this.dirStates, state, names, () => this.scanState(dir, state, {}));
  }
  readIndexedPath(names: readonly string[]): Promise<IndexedPathResult> { return readFileIndex(this.dirStates, this.getState(), names); }
  getPathByName(name: string): string | undefined { return this.getState().table.getPathByName(name); }
  hasCompletedScan(): boolean {
    const table = this.getState().table;
    return table.everSucceeded && !table.pendingInvalidation;
  }
  invalidate(): void { this.getState().table.invalidate(); }
  clear(): void {
    if (this.disposed) return;
    for (const state of this.dirStates.values()) {
      const snapshot = state.table.hasUnsavedChanges() ? state.table.persistableSnapshot() : null;
      if (snapshot) state.persistence?.request(() => snapshot, () => {});
      state.table.clear(); state.lastScanAt = 0; state.scanError = undefined;
    }
  }
  private hydrate(state: S, token: ScanToken): Promise<void> | undefined {
    if (!state.persistence || state.hydrationStarted) return undefined;
    state.hydrationStarted = true;
    return state.persistence.read().then(entries => {
      if (!this.disposed && entries && state.table.isCurrent(token)) state.table.hydrate(entries.entries, entries.blocked);
    }).catch((error: unknown) => {
      logger.debug(`${this.scanLabel}: cannot read persisted index; rebuilding from disk`, {
        error: error instanceof Error ? error.name : typeof error,
      });
    });
  }
  protected async performScanForDir(dir: string, state: S): Promise<ManifestDiffResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.assertActive();
      const result = await this.scanCurrentEpoch(dir, state);
      this.assertActive();
      if (result) return result;
    }
    throw new Error('Storage scan repeatedly invalidated by cache clearing');
  }
  private async scanCurrentEpoch(dir: string, state: S): Promise<ManifestDiffResult | undefined> {
    const token = state.table.beginScan();
    try {
      const hydration = this.hydrate(state, token);
      if (hydration) await hydration;
      if (!await this.backend.directoryExists(dir)) {
        this.assertActive();
        if (!state.table.isCurrent(token)) return undefined;
        const result = state.table.publishMissingDirectory(token);
        state.persistence?.cancelPending();
        return this.finishScan(dir, state, result, 0);
      }
      const paths = await this.enumerate(dir);
      const { stats, failures } = await this.backend.statMany(dir, paths);
      const outcomes = new Map<string, ScanOutcome>(paths.map(relativePath => [relativePath, { status: 'absent' }]));
      for (const [relativePath, error] of failures) outcomes.set(relativePath, { status: 'statFailed', failure: failureOf(error, dir, relativePath) });
      await mapStorageItems([...stats], async ([relativePath, meta]) => {
        if (state.table.canReuseUnchanged(relativePath, meta.mtimeMs, meta.sizeBytes)) {
          outcomes.set(relativePath, { status: 'unchanged', mtimeMs: meta.mtimeMs, sizeBytes: meta.sizeBytes });
          return;
        }
        try {
          const content = await this.backend.readFile(path.join(dir, relativePath));
          outcomes.set(relativePath, { status: 'indexed', mtimeMs: meta.mtimeMs, entry: this.readIndexEntry(content, relativePath, stats) });
        } catch (error) {
          const outcome: ScanOutcome = isAbsentPathError(error) ? { status: 'absent' }
            : { status: 'failed', mtimeMs: meta.mtimeMs, sizeBytes: meta.sizeBytes, failure: failureOf(error, dir, relativePath) };
          outcomes.set(relativePath, outcome);
        }
      });
      this.assertActive();
      if (!state.table.isCurrent(token)) return undefined;
      const result = state.table.publishScan(token, outcomes);
      return this.finishScan(dir, state, result, paths.length);
    } catch (error) {
      this.assertActive();
      if (!state.table.isCurrent(token)) return undefined;
      state.table.failScan(token);
      const failure = sanitizeStorageError(error, dir);
      state.lastScanAt = Date.now(); state.scanError = failure;
      throw failure;
    }
  }
  private finishScan(dir: string, state: S, result: ScanPublication, count: number): ManifestDiffResult {
    this.assertActive();
    for (const change of result.ownershipChanges) {
      logger.warn(`${this.scanLabel}: duplicate name ${JSON.stringify(change.name)}; using ${JSON.stringify(change.winner)} over ${change.losers.map(loser => JSON.stringify(loser)).join(', ')}`);
    }
    const unindexed = state.table.unindexed();
    const changedFailures = new Set(result.changedFailures);
    for (const [relativePath, failure] of unindexed) {
      this.logFailure(relativePath, failure, !changedFailures.has(relativePath));
    }
    const changes = [...result.diff.added, ...result.diff.modified];
    if (result.diff.removed.length || changes.some(relativePath => !unindexed.has(relativePath) || changedFailures.has(relativePath))) {
      this.logDiskScan(dir, count, result.diff);
    }
    state.lastScanAt = Date.now(); state.scanError = undefined;
    this.requestPersistence(state);
    return result.diff;
  }
  private logFailure(relativePath: string, failure: UnindexedEntry, repeated: boolean): void {
    logger[repeated ? 'debug' : 'warn'](`${this.scanLabel}: failed to index ${relativePath}`, {
      error: failure.name, ...(failure.code === undefined ? {} : { code: failure.code }),
    });
  }
}
