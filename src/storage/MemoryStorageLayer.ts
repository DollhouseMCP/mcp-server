/**
 * MemoryStorageLayer - IStorageLayer implementation for multi-directory memory scanning.
 *
 * Memories use pure YAML across a multi-directory layout:
 *   system/       — System-provided memories
 *   adapters/     — Adapter-specific memories
 *   YYYY-MM-DD/   — User-created date-folder memories
 *   (root)        — Legacy root-level memories
 *
 * Reuses the same internal components as ElementStorageLayer (MetadataIndex,
 * StorageManifest, FileStorageBackend) but with fundamentally different scan
 * logic: multi-directory enumeration + _index.json cold-start persistence.
 */

import * as path from 'path';
import { logger } from '../utils/logger.js';
import type { IStorageLayer } from './IStorageLayer.js';
import type { IStorageBackend } from './IStorageBackend.js';
import type { ElementIndexEntry, ManifestDiffResult } from './types.js';
import { StorageManifest } from './StorageManifest.js';
import { MetadataIndex } from './MetadataIndex.js';
import { FileStorageBackend } from './FileStorageBackend.js';
import { MemoryMetadataExtractor } from './MemoryMetadataExtractor.js';
import { MemoryIndexFile } from './MemoryIndexFile.js';
import type { FileOperationsService } from '../services/FileOperationsService.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

export interface MemoryStorageLayerOptions {
  /** Absolute path to the memories directory */
  memoriesDir: string;
  /** Minimum milliseconds between full scans (default: 1000) */
  scanCooldownMs?: number;
  /** Override the storage backend (useful for testing) */
  storageBackend?: IStorageBackend;
  /** Debounce interval for _index.json writes (default: 2000) */
  indexDebounceMs?: number;
  /** File filter predicate (e.g., exclude backup files) */
  fileFilter?: (filename: string) => boolean;
  /**
   * Dynamic per-user directory resolver. Same pattern as
   * ElementStorageLayer.elementDirResolver — when present, overrides the
   * static `memoriesDir` at call time for multi-user HTTP mode.
   */
  memoriesDirResolver?: () => string;
}

const EMPTY_DIFF: ManifestDiffResult = { added: [], modified: [], removed: [], unchanged: [] };
const DATE_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Per-directory scan state for multi-user mode. Each user's memories
 * directory gets its own independent manifest, index, cooldown, and
 * index file — no cross-user data leakage.
 */
interface MemoryDirScanState {
  manifest: StorageManifest;
  index: MetadataIndex;
  indexFile: MemoryIndexFile;
  lastScanTimestamp: number;
  scanInProgress: Promise<ManifestDiffResult> | null;
  coldStartDone: boolean;
}

export class MemoryStorageLayer implements IStorageLayer {
  private readonly backend: IStorageBackend;
  private readonly staticMemoriesDir: string;
  private readonly memoriesDirResolver?: () => string;
  private readonly scanCooldownMs: number;
  private readonly indexDebounceMs: number;
  private readonly fileFilter?: (filename: string) => boolean;

  private readonly dirStates = new Map<string, MemoryDirScanState>();

  constructor(
    private readonly fileOps: FileOperationsService,
    options: MemoryStorageLayerOptions
  ) {
    this.staticMemoriesDir = options.memoriesDir;
    this.memoriesDirResolver = options.memoriesDirResolver;
    this.scanCooldownMs = options.scanCooldownMs ?? 1000;
    this.indexDebounceMs = options.indexDebounceMs ?? 2000;
    this.fileFilter = options.fileFilter;

    if (options.storageBackend) {
      this.backend = options.storageBackend;
    } else {
      this.backend = new FileStorageBackend(fileOps);
    }
  }

  /** The active memories directory — dynamic when a resolver is present. */
  private get memoriesDir(): string {
    return this.memoriesDirResolver ? this.memoriesDirResolver() : this.staticMemoriesDir;
  }

  /** Get or create per-dir scan state. */
  private getState(): MemoryDirScanState {
    const dir = this.memoriesDir;
    let state = this.dirStates.get(dir);
    if (!state) {
      const indexPath = path.join(dir, '_index.json');
      state = {
        manifest: new StorageManifest(),
        index: new MetadataIndex(),
        indexFile: new MemoryIndexFile(indexPath, this.fileOps, { debounceMs: this.indexDebounceMs }),
        lastScanTimestamp: 0,
        scanInProgress: null,
        coldStartDone: false,
      };
      this.dirStates.set(dir, state);
    }
    return state;
  }

  // ---- IStorageLayer implementation ----

  async scan(): Promise<ManifestDiffResult> {
    // Pin dir + state at the start — all async work below uses these
    // pinned references, not the resolver. This prevents cross-user
    // contamination when concurrent requests from different users hit
    // the same root-scoped MemoryStorageLayer.
    const dir = this.memoriesDir;
    const state = this.getState();

    if (!state.coldStartDone) {
      state.coldStartDone = true;
      return this.coldStartForDir(dir, state);
    }

    const now = Date.now();
    if (now - state.lastScanTimestamp < this.scanCooldownMs) {
      return EMPTY_DIFF;
    }

    if (state.scanInProgress) {
      return state.scanInProgress;
    }

    state.scanInProgress = this.performScanForDir(dir, state);
    try {
      return await state.scanInProgress;
    } finally {
      state.scanInProgress = null;
    }
  }

  async listSummaries(_options?: { includePublic?: boolean }): Promise<ElementIndexEntry[]> {
    // File-mode memories are single-user per installation; includePublic is a
    // no-op here until Step 4.5 delivers the per-user layout + shared/ dir.
    await this.scan();
    return this.deduplicateByName(this.getState().index.getAll());
  }

  async getIndexedPaths(): Promise<string[]> {
    await this.scan();
    const deduplicated = this.deduplicateByName(this.getState().index.getAll());
    return deduplicated.map(entry => entry.filePath);
  }

  /**
   * Deduplicate index entries by normalized name.
   * When the same memory appears in multiple date folders, keep the one
   * with the highest mtimeMs (most recently modified).
   *
   * Issue #654: Same memory files duplicated across ~150 date folders
   * inflated counts from ~750 unique to ~3,100+ loaded memories.
   */
  private deduplicateByName(entries: ElementIndexEntry[]): ElementIndexEntry[] {
    const byName = new Map<string, ElementIndexEntry>();
    for (const entry of entries) {
      const key = UnicodeValidator.normalize(entry.name).normalizedContent.toLowerCase();
      const existing = byName.get(key);
      if (!existing || entry.mtimeMs > existing.mtimeMs) {
        byName.set(key, entry);
      }
    }
    return [...byName.values()];
  }

  getPathByName(name: string): string | undefined {
    const normalizedName = UnicodeValidator.normalize(name).normalizedContent;
    return this.getState().index.getPathByName(normalizedName);
  }

  hasCompletedScan(): boolean {
    return this.getState().lastScanTimestamp > 0;
  }

  async notifySaved(relativePath: string, absolutePath: string): Promise<void> {
    // Pin state before any await — prevents ContextTracker-driven resolver
    // from returning a different user's state if the async context shifts.
    const state = this.getState();
    try {
      const content = await this.backend.readFile(absolutePath);
      const meta = await this.backend.stat(absolutePath);
      const extracted = MemoryMetadataExtractor.extractMetadata(content, relativePath);

      const entry: ElementIndexEntry = {
        filePath: relativePath,
        name: extracted.name ?? 'unnamed',
        description: extracted.description ?? '',
        version: extracted.version ?? '1.0.0',
        author: extracted.author ?? '',
        tags: extracted.tags ?? [],
        mtimeMs: meta.mtimeMs,
        sizeBytes: meta.sizeBytes,
        autoLoad: extracted.autoLoad,
        priority: extracted.priority,
        memoryType: extracted.memoryType,
        totalEntries: extracted.totalEntries,
      };

      state.index.set(entry);
      state.manifest.set(relativePath, meta.mtimeMs);
      state.indexFile.scheduleWrite(state.index.getAll());
    } catch (error) {
      logger.debug('MemoryStorageLayer.notifySaved failed, invalidating', {
        relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
      this.invalidate();
    }
  }

  notifyDeleted(relativePath: string): void {
    this.getState().index.remove(relativePath);
    this.getState().manifest.remove(relativePath);
    this.getState().indexFile.scheduleWrite(this.getState().index.getAll());
  }

  invalidate(): void {
    // Only invalidate the CURRENT dir's state — a save/parse failure for
    // one user should not force a re-scan for every other user.
    this.getState().lastScanTimestamp = 0;
  }

  clear(): void {
    for (const state of this.dirStates.values()) {
      state.indexFile.dispose();
      state.index.clear();
      state.manifest.clear();
      state.lastScanTimestamp = 0;
    }
  }

  // ---- Memory-specific methods ----

  /**
   * Return index entries where autoLoad === true, sorted by priority ascending.
   * Pure in-memory — does NOT trigger a scan.
   */
  getAutoLoadEntries(): ElementIndexEntry[] {
    return this.getState().index.getAll()
      .filter(entry => entry.autoLoad === true)
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  }

  /**
   * Full disk scan of all subdirectories + write _index.json.
   */
  async rebuildIndex(): Promise<void> {
    const dir = this.memoriesDir;
    const state = this.getState();
    logger.info('MemoryStorageLayer: rebuilding index from disk...');
    state.index.clear();
    state.manifest.clear();

    await this.performScanForDir(dir, state);
    await state.indexFile.write(state.index.getAll());

    logger.info(`MemoryStorageLayer: rebuild complete — ${state.index.size} entries indexed`);
  }

  /**
   * Flush pending _index.json write and release resources.
   */
  async dispose(): Promise<void> {
    for (const state of this.dirStates.values()) {
      await state.indexFile.flush();
      state.indexFile.dispose();
    }
  }

  /**
   * Remove cached scan state for a specific directory. Disposes the
   * MemoryIndexFile (cancels debounce timer) to prevent resource leaks.
   * Called during session cleanup.
   */
  purgeDirState(dir: string): void {
    const state = this.dirStates.get(dir);
    if (state) {
      state.indexFile.dispose();
      this.dirStates.delete(dir);
    }
  }

  // ---- Private ----

  /**
   * Cold start: try to restore from _index.json, then run incremental scan.
   * Falls back to full rebuild if index is missing/corrupt.
   */
  private async coldStartForDir(dir: string, state: MemoryDirScanState): Promise<ManifestDiffResult> {
    try {
      const cached = await state.indexFile.read();

      if (cached) {
        // Populate index and manifest from cached data
        for (const [relPath, entry] of Object.entries(cached.entries)) {
          state.index.set(entry);
          state.manifest.set(relPath, entry.mtimeMs);
        }
        logger.info(`MemoryStorageLayer: cold start — loaded ${Object.keys(cached.entries).length} entries from _index.json`);

        // Run incremental scan to catch changes since _index.json was written
        return this.performScanForDir(dir, state);
      }
    } catch (error) {
      logger.debug('MemoryStorageLayer: cold start _index.json read failed, rebuilding', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // No valid _index.json — full rebuild. rebuildIndex() re-resolves
    // dir via the getter, which is safe because ContextTracker uses
    // AsyncLocalStorage — the userId context flows through await
    // boundaries within the same request scope.
    await this.rebuildIndex();
    return EMPTY_DIFF;
  }

  /**
   * Discover all subdirectories to scan.
   * Returns ['system', 'adapters', ...dateFolders, ''] where '' = root.
   */
  private async discoverSubdirectoriesForDir(dir: string): Promise<string[]> {
    const subdirs: string[] = [];

    try {
      const entries = await this.fileOps.listDirectory(dir);

      const dateFolders: string[] = [];
      for (const entry of entries) {
        // Include known fixed directories
        if (entry === 'system' || entry === 'adapters') {
          subdirs.push(entry);
        } else if (DATE_FOLDER_PATTERN.test(entry)) {
          dateFolders.push(entry);
        }
        // Skip backups/, _index.json, and other non-memory directories
      }
      // Sort date folders chronologically (oldest first → newest last)
      // so that nameToPath in MetadataIndex ends up pointing to the newest copy
      dateFolders.sort((a, b) => a.localeCompare(b));
      subdirs.push(...dateFolders);
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        logger.debug('MemoryStorageLayer: failed to list subdirectories', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Always include root (empty string = root directory)
    subdirs.push('');

    return subdirs;
  }

  private async indexChangedFiles(
    dir: string,
    toIndex: string[],
    removed: string[],
    stats: Map<string, { mtimeMs: number; sizeBytes: number }>,
    state: MemoryDirScanState,
  ): Promise<boolean> {
    let indexUpdated = false;

    await Promise.all(
      toIndex.map(async (relPath) => {
        try {
          const absPath = path.join(dir, relPath);
          const content = await this.backend.readFile(absPath);
          const extracted = MemoryMetadataExtractor.extractMetadata(content, relPath);
          const meta = stats.get(relPath);

          state.index.set({
            filePath: relPath,
            name: extracted.name ?? 'unnamed',
            description: extracted.description ?? '',
            version: extracted.version ?? '1.0.0',
            author: extracted.author ?? '',
            tags: extracted.tags ?? [],
            mtimeMs: meta?.mtimeMs ?? 0,
            sizeBytes: meta?.sizeBytes ?? 0,
            autoLoad: extracted.autoLoad,
            priority: extracted.priority,
            memoryType: extracted.memoryType,
            totalEntries: extracted.totalEntries,
          });
          indexUpdated = true;
        } catch (error) {
          logger.debug(`MemoryStorageLayer: failed to index ${relPath}`, {
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

  /**
   * Perform a full incremental scan across all subdirectories.
   */
  private async performScanForDir(dir: string, state: MemoryDirScanState): Promise<ManifestDiffResult> {
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

      // 1. Discover subdirectories
      const subdirs = await this.discoverSubdirectoriesForDir(dir);

      // 2. Enumerate all .yaml files across subdirectories
      const allRelativePaths: string[] = [];

      for (const subdir of subdirs) {
        const absDir = subdir ? path.join(dir, subdir) : dir;

        try {
          const files = await this.backend.listFiles(absDir, '.yaml');

          for (const file of files) {
            // Apply file filter (e.g., exclude backup files)
            if (this.fileFilter && !this.fileFilter(file)) {
              continue;
            }

            // Prefix with subdir for relative path
            const relPath = subdir ? `${subdir}/${file}` : file;
            allRelativePaths.push(relPath);
          }
        } catch (error) {
          // Directory might not exist (e.g., no system/ folder yet)
          if ((error as any).code !== 'ENOENT') {
            logger.debug(`MemoryStorageLayer: failed to list ${absDir}`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // 3. Stat all files
      const stats = await this.backend.statMany(dir, allRelativePaths);

      // 4. Diff against manifest
      const diff = state.manifest.diff(stats);

      const hasChanges = diff.added.length > 0 || diff.modified.length > 0 || diff.removed.length > 0;
      if (hasChanges) {
        logger.debug(`MemoryStorageLayer.scan: DISK SCAN — ${allRelativePaths.length} files, ${diff.added.length} added, ${diff.modified.length} modified, ${diff.removed.length} removed`);
      }

      // 5. For added/modified: read file, extract metadata, update index
      const toIndex = [...diff.added, ...diff.modified];
      const indexUpdated = await this.indexChangedFiles(dir, toIndex, diff.removed, stats, state);

      // 7. Update manifest and timestamp
      state.manifest.update(stats);
      state.lastScanTimestamp = Date.now();

      // 8. Schedule debounced _index.json write if index changed
      if (indexUpdated) {
        state.indexFile.scheduleWrite(state.index.getAll());
      }

      return diff;
    } catch (error) {
      logger.error('MemoryStorageLayer.performScan failed', error);
      state.lastScanTimestamp = Date.now(); // Prevent retry storms
      return EMPTY_DIFF;
    }
  }
}
