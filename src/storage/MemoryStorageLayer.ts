/**
 * MemoryStorageLayer - IStorageLayer implementation for multi-directory memory scanning.
 *
 * Memories use pure YAML across a multi-directory layout:
 *   system/       — System-provided memories
 *   adapters/     — Adapter-specific memories
 *   YYYY-MM-DD/   — User-created date-folder memories
 *   (root)        — Legacy root-level memories
 *
 * Shares the file scan lifecycle with ElementStorageLayer while retaining
 * multi-directory enumeration and _index.json cold-start persistence.
 */

import { visitSequentially } from '../utils/visitSequentially.js';
import { FileStorageLayerBase, type DirScanState, EMPTY_DIFF } from './FileStorageLayerBase.js';
import { DirectoryStateCache } from './DirectoryStateCache.js';
import * as path from 'node:path';
import { logger } from '../utils/logger.js';
import type { StorageScanOptions } from './IStorageLayer.js';
import type { IStorageBackend } from './IStorageBackend.js';
import { type ElementIndexEntry, type ManifestDiffResult } from './types.js';
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
  retainDirectoryState?: (dir: string) => boolean;
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

const DATE_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Per-directory scan state for multi-user mode. Each user's memories
 * directory gets its own independent manifest, index, cooldown, and
 * index file — no cross-user data leakage.
 */
interface MemoryDirScanState extends DirScanState {
  indexFile: MemoryIndexFile;
  /** Cold start has begun; hasScanned tracks completion for index publication. */
  coldStartDone: boolean;
}

export class MemoryStorageLayer extends FileStorageLayerBase<MemoryDirScanState> {
  private readonly retainDirectoryState?: (dir: string) => boolean;
  private readonly staticMemoriesDir: string;
  private readonly memoriesDirResolver?: () => string;
  private readonly indexDebounceMs: number;
  private readonly fileFilter?: (filename: string) => boolean;

  constructor(
    private readonly fileOps: FileOperationsService,
    options: MemoryStorageLayerOptions
  ) {
    super(options.storageBackend ?? new FileStorageBackend(fileOps), options.scanCooldownMs,
      new DirectoryStateCache<MemoryDirScanState>(
        (state, dir) => !state.indexFile.hasPendingWrite() && !this.retainDirectoryState?.(dir),
        state => state.indexFile.dispose(),
      ));
    this.retainDirectoryState = options.retainDirectoryState;
    this.staticMemoriesDir = options.memoriesDir;
    this.memoriesDirResolver = options.memoriesDirResolver;
    this.indexDebounceMs = options.indexDebounceMs ?? 2000;
    this.fileFilter = options.fileFilter;
  }

  /** The active memories directory — dynamic when a resolver is present. */
  private get memoriesDir(): string {
    return this.memoriesDirResolver ? this.memoriesDirResolver() : this.staticMemoriesDir;
  }

  // ---- IStorageLayer implementation ----

  async listSummaries(options?: { includePublic?: boolean; preserveDuplicates?: boolean; freshMetadata?: boolean }): Promise<ElementIndexEntry[]> {
    if (options?.freshMetadata) return this.readFreshSummariesAtDirectory(this.memoriesDir, options.preserveDuplicates === true);
    // File-mode memories are single-user per installation; includePublic is a
    // no-op here until Step 4.5 delivers the per-user layout + shared/ dir.
    const state = this.getState();
    await this.scan();
    const entries = state.index.getAll();
    return options?.preserveDuplicates ? entries : this.deduplicateByName(entries);
  }

  /** Internal scoped discovery using the injected backend/filter, without index publication. */
  async readFreshSummariesAtDirectory(dir: string, preserveDuplicates = false): Promise<ElementIndexEntry[]> {
    const subdirs = await this.discoverSubdirectoriesForDir(dir, true);
    const paths = await this.enumerateYamlFiles(dir, subdirs, true);
    const entries: ElementIndexEntry[] = [];
    // Keep each read/stat pair ordered and fail fast before starting later locator I/O.
    await visitSequentially(paths.values(), async filePath => {
      const absolutePath = path.join(dir, filePath);
      const content = await this.backend.readFile(absolutePath);
      const meta = await this.backend.stat(absolutePath);
      const extracted = MemoryMetadataExtractor.extractMetadata(content, filePath);
      entries.push({ ...extracted, filePath, name: extracted.name ?? 'unnamed',
        description: extracted.description ?? '', version: extracted.version ?? '1.0.0',
        author: extracted.author ?? '', tags: extracted.tags ?? [],
        mtimeMs: meta.mtimeMs, sizeBytes: meta.sizeBytes });
    });
    return preserveDuplicates ? entries : this.deduplicateByName(entries);
  }

  async getIndexedPaths(): Promise<string[]> {
    const state = this.getState();
    await this.scan();
    const deduplicated = this.deduplicateByName(state.index.getAll());
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

  async notifySaved(relativePath: string, absolutePath: string): Promise<void> {
    // Pin state before any await — prevents ContextTracker-driven resolver
    // from returning a different user's state if the async context shifts.
    const state = this.getState();
    return this.dirStates.use(state, () => this.indexSavedFile(state, relativePath, absolutePath));
  }

  private async indexSavedFile(state: MemoryDirScanState, relativePath: string, absolutePath: string): Promise<void> {
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
      this.scheduleCompleteIndex(state);
    } catch (error) {
      logger.debug('MemoryStorageLayer.notifySaved failed, invalidating', {
        relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
      state.lastScanTimestamp = 0;
    }
  }

  /** Cold notifications update metadata in memory without truncating the persisted index. */
  private scheduleCompleteIndex(state: MemoryDirScanState): void {
    if (state.hasScanned) state.indexFile.scheduleWrite(state.index.getAll());
  }

  notifyDeleted(relativePath: string): void {
    const state = this.getState();
    state.index.remove(relativePath);
    state.manifest.remove(relativePath);
    this.scheduleCompleteIndex(state);
  }

  override clear(): void {
    for (const state of this.dirStates.values()) {
      state.indexFile.dispose();
      state.index.clear();
      state.manifest.clear();
      state.lastScanTimestamp = 0;
      state.hasScanned = false;
    }
  }

  // ---- Memory-specific methods ----

  /**
   * Return index entries where autoLoad === true, sorted by priority ascending.
   * Pure in-memory — does NOT trigger a scan.
   */
  getAutoLoadEntries(): ElementIndexEntry[] {
    return this.autoLoadEntriesOf(this.getState());
  }

  /** Scan, then read auto-load entries from the same state while it is still in use. */
  async scanAutoLoadEntries(): Promise<ElementIndexEntry[]> {
    const dir = this.memoriesDir;
    const state = this.getState(dir);
    return this.dirStates.scanAndRead(state, () => this.scanState(dir, state, {}),
      () => this.autoLoadEntriesOf(state));
  }

  private autoLoadEntriesOf(state: MemoryDirScanState): ElementIndexEntry[] {
    return state.index.getAll()
      .filter(entry => entry.autoLoad === true)
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  }

  /**
   * Full disk scan of all subdirectories + write _index.json.
   */
  async rebuildIndex(): Promise<void> {
    const dir = this.memoriesDir;
    const state = this.getState();
    return this.dirStates.use(state, async () => {
      logger.info('MemoryStorageLayer: rebuilding index from disk...');
      state.index.clear();
      state.manifest.clear();

      await this.performScanForDir(dir, state);
      await state.indexFile.write(state.index.getAll());

      logger.info(`MemoryStorageLayer: rebuild complete — ${state.index.size} entries indexed`);
    });
  }

  /**
   * Flush pending _index.json write and release resources.
   */
  async dispose(): Promise<void> {
    await visitSequentially(this.dirStates.values(), async state => {
      await state.indexFile.flush();
      state.indexFile.dispose();
    });
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
  private async discoverSubdirectoriesForDir(dir: string, strict = false): Promise<string[]> {
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
      if (strict) throw error;
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

  private async enumerateYamlFiles(dir: string, subdirs: string[], strict = false): Promise<string[]> {
    const allRelativePaths: string[] = [];
    // Collection order and first-error behavior also serve the legacy inventory path.
    await visitSequentially(subdirs.values(), subdir =>
      this.collectYamlFilesFromSubdir(dir, subdir, allRelativePaths, strict));
    return allRelativePaths;
  }

  private async collectYamlFilesFromSubdir(dir: string, subdir: string, out: string[], strict = false): Promise<void> {
    const absDir = subdir ? path.join(dir, subdir) : dir;
    try {
      const files = await this.backend.listFiles(absDir, '.yaml');
      for (const file of files) {
        if (this.fileFilter && !this.fileFilter(file)) continue;
        out.push(subdir ? `${subdir}/${file}` : file);
      }
    } catch (error) {
      if (strict) throw error;
      if ((error as any).code !== 'ENOENT') {
        logger.debug(`MemoryStorageLayer: failed to list ${absDir}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // ---- scan hooks (FileStorageLayerBase) ----

  /** Extend shared directory state with memory index persistence. */
  protected extendState(dir: string, base: DirScanState): MemoryDirScanState {
    const indexPath = path.join(dir, '_index.json');
    return {
      ...base,
      indexFile: new MemoryIndexFile(indexPath, this.fileOps, { debounceMs: this.indexDebounceMs, onIdle: () => this.dirStates.trim() }),
      coldStartDone: false,
    };
  }

  protected readonly scanLabel = 'MemoryStorageLayer';

  protected get directory(): string { return this.memoriesDir; }

  protected async enumerate(dir: string): Promise<string[]> {
    const subdirs = await this.discoverSubdirectoriesForDir(dir);
    return this.enumerateYamlFiles(dir, subdirs);
  }

  protected logCooldown(_dir: string, _remainingMs: number): void {
    // Memory scans retain their silent cooldown behavior.
  }

  protected logDiskScan(_dir: string, fileCount: number, diff: ManifestDiffResult): void {
    logger.debug(`MemoryStorageLayer.scan: DISK SCAN — ${fileCount} files, ${diff.added.length} added, ${diff.modified.length} modified, ${diff.removed.length} removed`);
  }

  protected override beforeScan(dir: string, state: MemoryDirScanState, _options: StorageScanOptions): (() => Promise<ManifestDiffResult>) | undefined {
    if (!state.coldStartDone) {
      state.coldStartDone = true;
      return () => this.coldStartForDir(dir, state);
    }
    return undefined;
  }

  protected override afterScan(state: MemoryDirScanState, indexUpdated: boolean): void {
    if (indexUpdated) {
      state.indexFile.scheduleWrite(state.index.getAll());
    }
  }

  protected readIndexEntry(content: string, relPath: string, stats: Map<string, { mtimeMs: number; sizeBytes: number }>): ElementIndexEntry {
    const extracted = MemoryMetadataExtractor.extractMetadata(content, relPath);
    const meta = stats.get(relPath);

    return {
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
    };
  }
}
