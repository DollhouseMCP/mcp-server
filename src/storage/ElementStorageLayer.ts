/**
 * ElementStorageLayer - Coordinates index, manifest, and backend for cache-aware listing.
 *
 * Owns the scan lifecycle: cooldown enforcement, concurrent call deduplication,
 * diff-based incremental index updates, and notifications from save/delete.
 */

import { findFileIndexedPath, readFileIndex } from './FileIndexReader.js';
import { DirectoryStateCache } from './DirectoryStateCache.js';
import * as path from 'node:path';
import { logger } from '../utils/logger.js';
import type { IStorageBackend } from './IStorageBackend.js';
import { type IndexedPathResult, type IStorageLayer, type StorageScanOptions } from './IStorageLayer.js';
import { mergeManifestDiffResults, type ElementIndexEntry, type ManifestDiffResult } from './types.js';
import { StorageManifest } from './StorageManifest.js';
import { MetadataIndex } from './MetadataIndex.js';
import { FrontmatterParser } from './FrontmatterParser.js';
import { FileStorageBackend } from './FileStorageBackend.js';
import type { FileOperationsService } from '../services/FileOperationsService.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

export interface ElementStorageLayerOptions {
  /** Absolute path to the element directory (static; used when no resolver is provided) */
  elementDir: string;
  /** File extension to filter (e.g. '.md') */
  fileExtension: string;
  /** Minimum milliseconds between full scans (default: 1000) */
  scanCooldownMs?: number;
  /** Override the storage backend (useful for testing) */
  storageBackend?: IStorageBackend;
  retainDirectoryState?: (dir: string) => boolean;
  /**
   * Dynamic per-user directory resolver. When present, overrides the static
   * `elementDir` at call time. Used in HTTP multi-user mode where each
   * session resolves to a different user's portfolio directory. The
   * resolver reads userId from ContextTracker's active session scope.
   *
   * Scan results are keyed by the resolved dir so different users get
   * independent caches.
   */
  elementDirResolver?: () => string;
}

const EMPTY_DIFF: ManifestDiffResult = { added: [], modified: [], removed: [], unchanged: [] };

/**
 * Per-directory scan state. In multi-user mode, each user's directory
 * gets its own independent cache entry — no thrashing or cross-user
 * data leakage when concurrent requests hit the same root-scoped
 * ElementStorageLayer instance.
 */
interface DirScanState {
  manifest: StorageManifest;
  index: MetadataIndex;
  lastScanTimestamp: number;
  /** Completion survives cooldown invalidation; only clear/new state makes it cold. */
  hasScanned: boolean;
  scanInProgress: Promise<ManifestDiffResult> | null;
}

export class ElementStorageLayer implements IStorageLayer {
  private readonly backend: IStorageBackend;
  private readonly retainDirectoryState?: (dir: string) => boolean;
  private readonly staticElementDir: string;
  private readonly elementDirResolver?: () => string;
  private readonly fileExtension: string;
  private readonly scanCooldownMs: number;

  /**
   * Per-directory scan state. In single-user mode this map has one
   * entry. In multi-user mode each user's resolved dir gets its own
   * manifest, index, cooldown, and in-flight scan promise — fully
   * independent, no race conditions across users.
   *
   * Idle states are bounded by DirectoryStateCache; active operations are pinned.
   */
  private readonly dirStates = new DirectoryStateCache<DirScanState>(
    (_state, dir) => !this.retainDirectoryState?.(dir),
  );

  constructor(
    fileOperationsService: FileOperationsService,
    options: ElementStorageLayerOptions
  ) {
    this.retainDirectoryState = options.retainDirectoryState;
    this.staticElementDir = options.elementDir;
    this.elementDirResolver = options.elementDirResolver;
    this.fileExtension = options.fileExtension;
    this.scanCooldownMs = options.scanCooldownMs ?? 1000;

    if (options.storageBackend) {
      this.backend = options.storageBackend;
    } else {
      this.backend = new FileStorageBackend(fileOperationsService);
    }
  }

  /** The active element directory — dynamic when a resolver is present. */
  private get elementDir(): string {
    return this.elementDirResolver ? this.elementDirResolver() : this.staticElementDir;
  }

  /** Get or create the scan state for a pinned directory. */
  private getState(dir = this.elementDir): DirScanState {
    let state = this.dirStates.get(dir);
    if (!state) {
      state = {
        manifest: new StorageManifest(),
        index: new MetadataIndex(),
        lastScanTimestamp: 0,
        hasScanned: false,
        scanInProgress: null,
      };
      this.dirStates.set(dir, state);
    }
    return state;
  }

  /**
   * Scan the element directory for changes.
   * - No-op if within cooldown period (returns empty diff)
   * - Deduplicates concurrent calls (returns same promise)
   * - Updates index and manifest based on diff
   */
  async scan(options: StorageScanOptions = {}): Promise<ManifestDiffResult> {
    const currentDir = this.elementDir;
    const state = this.getState(currentDir);

    return this.dirStates.use(state, () => this.scanState(currentDir, state, options));
  }

  private async scanState(currentDir: string, state: DirScanState, options: StorageScanOptions): Promise<ManifestDiffResult> {
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

    const now = Date.now();
    if (now - state.lastScanTimestamp < this.scanCooldownMs) {
      logger.debug(`ElementStorageLayer.scan: COOLDOWN ACTIVE for ${path.basename(currentDir)} — skipping disk I/O (${this.scanCooldownMs - (now - state.lastScanTimestamp)}ms remaining)`);
      return EMPTY_DIFF;
    }

    return this.startScan(currentDir, state);
  }

  private async startScan(currentDir: string, state: DirScanState): Promise<ManifestDiffResult> {
    const diff = await this.dirStates.runScan(state, () => this.performScanForDir(currentDir, state));
    state.hasScanned = true;
    return diff;
  }

  /**
   * Trigger scan and return all index entries.
   *
   * File mode today is single-user per installation with no shared/
   * directory, so the includePublic flag is a no-op. Once Step 4.5 lands the
   * per-user file layout and `shared/` sibling, this implementation will
   * grow a union-enumeration of the current user's subtree plus `shared/`.
   */
  async listSummaries(_options?: { includePublic?: boolean }): Promise<ElementIndexEntry[]> {
    const state = this.getState();
    await this.scan();
    return state.index.getAll();
  }

  async getIndexedPaths(): Promise<string[]> {
    const state = this.getState();
    await this.scan();
    return state.index.getPaths();
  }

  findIndexedPath(names: readonly string[]): Promise<string | undefined> {
    const dir = this.elementDir;
    const state = this.getState(dir);
    // A cold manifest is empty, so its diff is only additions; no cached invalidations are lost.
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
    return this.dirStates.hasCompletedScan(this.elementDir);
  }

  async notifySaved(relativePath: string, absolutePath: string): Promise<void> {
    const state = this.getState();
    return this.dirStates.use(state, () => this.indexSavedFile(state, relativePath, absolutePath));
  }

  private async indexSavedFile(state: DirScanState, relativePath: string, absolutePath: string): Promise<void> {
    try {
      const meta = await this.backend.stat(absolutePath);
      const content = await this.backend.readFile(absolutePath);
      const fm = FrontmatterParser.extractMetadata(content);

      state.index.set({
        filePath: relativePath,
        name: fm.name,
        description: fm.description,
        version: fm.version,
        author: fm.author,
        tags: fm.tags,
        mtimeMs: meta.mtimeMs,
        sizeBytes: meta.sizeBytes,
      });
      state.manifest.set(relativePath, meta.mtimeMs);
    } catch (error) {
      logger.debug('ElementStorageLayer.notifySaved failed, invalidating', {
        relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
      state.lastScanTimestamp = 0;
    }
  }

  notifyDeleted(relativePath: string): void {
    const state = this.getState();
    state.index.remove(relativePath);
    state.manifest.remove(relativePath);
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

  // ---- private ----

  private async performScanForDir(dir: string, state: DirScanState): Promise<ManifestDiffResult> {
    try {
      const exists = await this.backend.directoryExists(dir);
      if (!exists) {
        const removedPaths = state.index.getPaths();
        state.index.clear();
        state.manifest.clear();
        state.lastScanTimestamp = Date.now();
        return {
          added: [],
          modified: [],
          removed: removedPaths,
          unchanged: [],
        };
      }

      // 1. List + stat
      const files = await this.backend.listFiles(dir, this.fileExtension);
      const stats = await this.backend.statMany(dir, files);

      // 2. Diff against manifest
      const diff = state.manifest.diff(stats);

      const hasChanges = diff.added.length > 0 || diff.modified.length > 0 || diff.removed.length > 0;
      if (hasChanges) {
        logger.debug(`ElementStorageLayer.scan: DISK SCAN for ${path.basename(dir)} — ${files.length} files, ${diff.added.length} added, ${diff.modified.length} modified, ${diff.removed.length} removed`);
      }

      // 3. For added/modified: read frontmatter, update index
      const toIndex = [...diff.added, ...diff.modified];
      await Promise.all(
        toIndex.map(async (relPath) => {
          try {
            const absPath = path.join(dir, relPath);
            const content = await this.backend.readFile(absPath);
            const fm = FrontmatterParser.extractMetadata(content);
            const meta = stats.get(relPath);

            state.index.set({
              filePath: relPath,
              name: fm.name,
              description: fm.description,
              version: fm.version,
              author: fm.author,
              tags: fm.tags,
              mtimeMs: meta?.mtimeMs ?? 0,
              sizeBytes: meta?.sizeBytes ?? 0,
            });
          } catch (error) {
            logger.debug(`ElementStorageLayer: failed to index ${relPath}`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })
      );

      // 4. For removed: remove from index
      for (const relPath of diff.removed) {
        state.index.remove(relPath);
      }

      // 5. Update manifest and timestamp
      state.manifest.update(stats);
      state.lastScanTimestamp = Date.now();

      return diff;
    } catch (error) {
      logger.error('ElementStorageLayer.performScan failed', error);
      state.lastScanTimestamp = Date.now();
      return EMPTY_DIFF;
    }
  }
}
