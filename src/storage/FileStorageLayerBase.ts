/** Shared file scan lifecycle; concrete layers retain enumeration and metadata policy. */
import * as path from 'node:path';
import { logger } from '../utils/logger.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { findFileIndexedPath, readFileIndex } from './FileIndexReader.js';
import { DirectoryStateCache } from './DirectoryStateCache.js';
import type { IStorageBackend } from './IStorageBackend.js';
import type { IndexedPathResult, IStorageLayer, StorageScanOptions } from './IStorageLayer.js';
import { mergeManifestDiffResults, type ElementIndexEntry, type ManifestDiffResult } from './types.js';
import { StorageManifest } from './StorageManifest.js';
import { MetadataIndex } from './MetadataIndex.js';

export const EMPTY_DIFF: ManifestDiffResult = { added: [], modified: [], removed: [], unchanged: [] };

/** Independent metadata and in-flight scan state for one resolved directory. */
export interface DirScanState {
  manifest: StorageManifest;
  index: MetadataIndex;
  lastScanTimestamp: number;
  hasScanned: boolean;
  scanInProgress: Promise<ManifestDiffResult> | null;
}

export abstract class FileStorageLayerBase<S extends DirScanState = DirScanState> implements IStorageLayer {
  protected constructor(
    protected readonly backend: IStorageBackend,
    private readonly scanCooldownMs = 1000,
    protected readonly dirStates: DirectoryStateCache<S>,
  ) {}

  /** Subclass-initialized; never read during the base constructor or run hooks during super(). */
  protected abstract get directory(): string;
  /** Add layer-specific fields to freshly initialized shared directory state. */
  protected abstract extendState(dir: string, base: DirScanState): S;

  private createState(dir: string): S {
    return this.extendState(dir, {
      manifest: new StorageManifest(),
      index: new MetadataIndex(),
      lastScanTimestamp: 0,
      hasScanned: false,
      scanInProgress: null,
    });
  }
  /** Subclass-initialized diagnostic prefix; never read during the base constructor or run hooks during super(). */
  protected abstract readonly scanLabel: string;
  /** Enumerate the concrete layer's supported relative file paths. */
  protected abstract enumerate(dir: string): Promise<string[]>;
  /** Extract metadata after the shared read, preserving read-before-stat lookup ordering. */
  protected abstract readIndexEntry(content: string, relPath: string, stats: Map<string, { mtimeMs: number; sizeBytes: number }>): ElementIndexEntry;
  /** Publish concrete-layer persistence only after manifest and timestamp updates. */
  protected afterScan(_state: S, _indexUpdated: boolean): void {
    // Layers without a persisted index have no post-scan work.
  }
  /** Preserve the concrete layer's cooldown message or silence. */
  protected abstract logCooldown(dir: string, remainingMs: number): void;
  /** Preserve the concrete layer's disk-scan message. */
  protected abstract logDiskScan(dir: string, fileCount: number, diff: ManifestDiffResult): void;
  /** Select optional bootstrap work; the base registers it before yielding. */
  protected beforeScan(_dir: string, _state: S, _options: StorageScanOptions): (() => Promise<ManifestDiffResult>) | undefined {
    return undefined;
  }

  protected getState(dir = this.directory): S {
    let state = this.dirStates.get(dir);
    if (!state) {
      state = this.createState(dir);
      this.dirStates.set(dir, state);
    }
    return state;
  }

  abstract listSummaries(options?: { includePublic?: boolean; preserveDuplicates?: boolean; freshMetadata?: boolean }): Promise<ElementIndexEntry[]>;
  abstract getIndexedPaths(): Promise<string[]>;
  abstract notifySaved(relativePath: string, absolutePath: string): Promise<void>;
  abstract notifyDeleted(relativePath: string): void;

  async scan(options: StorageScanOptions = {}): Promise<ManifestDiffResult> {
    const currentDir = this.directory;
    const state = this.getState(currentDir);

    return this.dirStates.use(state, () => this.scanState(currentDir, state, options));
  }

  protected async scanState(currentDir: string, state: S, options: StorageScanOptions): Promise<ManifestDiffResult> {
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

    const preliminary = this.beforeScan(currentDir, state, options);
    if (preliminary !== undefined) return this.startScan(currentDir, state, preliminary);

    const now = Date.now();
    if (now - state.lastScanTimestamp < this.scanCooldownMs) {
      this.logCooldown(currentDir, this.scanCooldownMs - (now - state.lastScanTimestamp));
      return EMPTY_DIFF;
    }

    return this.startScan(currentDir, state);
  }

  protected async startScan(currentDir: string, state: S, operation = () => this.performScanForDir(currentDir, state)): Promise<ManifestDiffResult> {
    const diff = await this.dirStates.runScan(state, operation);
    state.hasScanned = true;
    return diff;
  }

  findIndexedPath(names: readonly string[]): Promise<string | undefined> {
    const dir = this.directory;
    const state = this.getState(dir);
    // Cold bootstrap has no completed live manifest to invalidate; persisted index hydration is discovery.
    // Warm reads must leave modified/removed diffs for scanAndEvict, even after invalidate().
    return findFileIndexedPath(this.dirStates, state, names, () => this.scanState(dir, state, {}));
  }

  readIndexedPath(names: readonly string[]): Promise<IndexedPathResult> {
    return readFileIndex(this.dirStates, this.getState(), names);
  }

  getPathByName(name: string): string | undefined {
    const normalizedName = UnicodeValidator.normalize(name).normalizedContent;
    return this.getState().index.getPathByName(normalizedName);
  }

  hasCompletedScan(): boolean {
    return this.dirStates.hasCompletedScan(this.directory);
  }

  invalidate(): void {
    // Only invalidate the CURRENT dir's state — a save/parse failure for
    // one user should not force a re-scan for every other user.
    this.getState().lastScanTimestamp = 0;
  }

  clear(): void {
    for (const state of this.dirStates.values()) {
      state.index.clear();
      state.manifest.clear();
      state.lastScanTimestamp = 0;
      state.hasScanned = false;
    }
  }

  private async indexChangedFiles(
    dir: string,
    toIndex: string[],
    removed: string[],
    stats: Map<string, { mtimeMs: number; sizeBytes: number }>,
    state: S,
  ): Promise<boolean> {
    let indexUpdated = false;

    await Promise.all(
      toIndex.map(async (relPath) => {
        try {
          const absPath = path.join(dir, relPath);
          const content = await this.backend.readFile(absPath);
          state.index.set(this.readIndexEntry(content, relPath, stats));
          indexUpdated = true;
        } catch (error) {
          logger.debug(`${this.scanLabel}: failed to index ${relPath}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );

    for (const relPath of removed) {
      state.index.remove(relPath);
      indexUpdated = true;
    }

    return indexUpdated;
  }

  protected async performScanForDir(dir: string, state: S): Promise<ManifestDiffResult> {
    try {
      const exists = await this.backend.directoryExists(dir);
      if (!exists) {
        return this.handleMissingDirectory(state);
      }
      return await this.scanExistingDirectory(dir, state);
    } catch (error) {
      logger.error(`${this.scanLabel}.performScan failed`, error);
      state.lastScanTimestamp = Date.now();
      return EMPTY_DIFF;
    }
  }

  private handleMissingDirectory(state: S): ManifestDiffResult {
    const removedPaths = state.index.getPaths();
    state.index.clear();
    state.manifest.clear();
    state.lastScanTimestamp = Date.now();
    return { added: [], modified: [], removed: removedPaths, unchanged: [] };
  }

  private async scanExistingDirectory(dir: string, state: S): Promise<ManifestDiffResult> {
    const allRelativePaths = await this.enumerate(dir);
    const stats = await this.backend.statMany(dir, allRelativePaths);
    const diff = state.manifest.diff(stats);

    const hasChanges = diff.added.length > 0 || diff.modified.length > 0 || diff.removed.length > 0;
    if (hasChanges) {
      this.logDiskScan(dir, allRelativePaths.length, diff);
    }

    const toIndex = [...diff.added, ...diff.modified];
    const indexUpdated = await this.indexChangedFiles(dir, toIndex, diff.removed, stats, state);

    state.manifest.update(stats);
    state.lastScanTimestamp = Date.now();

    this.afterScan(state, indexUpdated);

    return diff;
  }
}
