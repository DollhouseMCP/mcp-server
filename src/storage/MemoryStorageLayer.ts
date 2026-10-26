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

import { DEFAULT_MEMORY_NAME } from '../elements/memories/constants.js';
import { sanitizeStorageError } from './StorageScanError.js';
import { visitSequentially } from '../utils/visitSequentially.js';
import { FileStorageLayerBase, type DirScanState } from './FileStorageLayerBase.js';
import { DirectoryStateCache, MAX_CACHED_DIRECTORY_STATES } from './DirectoryStateCache.js';
import * as path from 'node:path';
import { logger } from '../utils/logger.js';
import type { UnindexedEntry } from './IStorageLayer.js';
import type { IStorageBackend } from './IStorageBackend.js';
import { type ElementIndexEntry, type ManifestDiffResult } from './types.js';
import { FileStorageBackend } from './FileStorageBackend.js';
import { MemoryMetadataExtractor } from './MemoryMetadataExtractor.js';
import { MemoryIndexFile } from './MemoryIndexFile.js';
import { MemoryIndexPersistence } from './MemoryIndexPersistence.js';
import { FileStateTable } from './FileStateTable.js';
import { type FileOperationsService, isAbsentPathError } from '../services/FileOperationsService.js';

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
  /** Maximum total wait for all final persistence flushes (default: 5000). */
  shutdownFlushTimeoutMs?: number;
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
  persistence: MemoryIndexPersistence;
}

export class MemoryStorageLayer extends FileStorageLayerBase<MemoryDirScanState> {
  private shutdown: Promise<void> | undefined;
  private readonly warnedDirtyStates = new WeakSet<MemoryDirScanState>();
  private readonly retainDirectoryState?: (dir: string) => boolean;
  private readonly staticMemoriesDir: string;
  private readonly memoriesDirResolver?: () => string;
  private readonly indexDebounceMs: number;
  private readonly shutdownFlushTimeoutMs: number;
  private readonly fileFilter?: (filename: string) => boolean;

  constructor(
    private readonly fileOps: FileOperationsService,
    options: MemoryStorageLayerOptions
  ) {
    super(options.storageBackend ?? new FileStorageBackend(fileOps),
      new DirectoryStateCache<MemoryDirScanState>(
        (state, dir) => this.isIdleDirectory(state, dir),
        state => state.persistence.dispose(),
      ), options.scanCooldownMs);
    this.retainDirectoryState = options.retainDirectoryState;
    this.staticMemoriesDir = options.memoriesDir;
    this.memoriesDirResolver = options.memoriesDirResolver;
    this.indexDebounceMs = options.indexDebounceMs ?? 2000;
    this.shutdownFlushTimeoutMs = options.shutdownFlushTimeoutMs ?? 5000;
    this.fileFilter = options.fileFilter;
  }

  private isIdleDirectory(state: MemoryDirScanState, dir: string): boolean {
    if (state.table.hasUnsavedChanges()) {
      if (this.dirStates.size > MAX_CACHED_DIRECTORY_STATES && !this.warnedDirtyStates.has(state)) {
        this.warnedDirtyStates.add(state);
        logger.warn('MemoryStorageLayer: retaining unsaved directory state beyond cache capacity');
      }
      return false;
    }
    return !state.persistence.hasPendingWrite() && !this.retainDirectoryState?.(dir);
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
    return options?.preserveDuplicates ? state.table.entries() : state.table.ownerEntries();
  }

  /** Internal scoped discovery using the injected backend/filter, without index publication. */
  async readFreshSummariesAtDirectory(dir: string, preserveDuplicates = false): Promise<ElementIndexEntry[]> {
    this.assertActive();
    let paths: string[];
    try {
      const subdirs = await this.discoverSubdirectoriesForDir(dir);
      paths = await this.enumerateYamlFiles(dir, subdirs, true);
    } catch (error) { throw sanitizeStorageError(error, dir); }
    const entries: ElementIndexEntry[] = [];
    // Keep each read/stat pair ordered and fail fast before starting later locator I/O.
    await visitSequentially(paths.values(), async filePath => {
      const absolutePath = path.join(dir, filePath);
      try {
        const content = await this.backend.readFile(absolutePath);
        const meta = await this.backend.stat(absolutePath);
        entries.push(this.buildEntry(content, filePath, meta));
      } catch (error) {
        if (!isAbsentPathError(error)) throw sanitizeStorageError(error, dir, absolutePath);
      }
    });
    this.assertActive();
    if (preserveDuplicates) return entries;
    const table = new FileStateTable();
    for (const entry of entries) table.applySaved(entry.filePath, entry.mtimeMs, entry);
    return table.ownerEntries();
  }

  async getIndexedPaths(): Promise<string[]> {
    const state = this.getState();
    await this.scan();
    return state.table.ownerEntries().map(entry => entry.filePath);
  }

  /** Scan and capture metadata plus failures from one pinned directory state. */
  async scanMemorySnapshot(autoLoad = false): Promise<{ entries: ElementIndexEntry[]; unindexed: ReadonlyMap<string, UnindexedEntry> }> {
    const dir = this.memoriesDir;
    const state = this.getState(dir);
    return this.dirStates.scanAndRead(state, () => this.scanState(dir, state, {}), () => ({
      entries: autoLoad ? this.autoLoadEntriesOf(state) : state.table.ownerEntries(),
      unindexed: state.table.unindexed(),
    }));
  }

  private autoLoadEntriesOf(state: MemoryDirScanState): ElementIndexEntry[] {
    return state.table.ownerEntries()
      .filter(entry => entry.autoLoad === true)
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  }

  /** Fence scans immediately, then flush all directories under one deadline. */
  override dispose(): Promise<void> {
    this.shutdown ??= super.dispose().then(() => this.flushForShutdown([...this.dirStates.values()]));
    return this.shutdown;
  }

  private async flushForShutdown(states: MemoryDirScanState[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), this.shutdownFlushTimeoutMs);
    });
    try {
      const flushes = Promise.allSettled(states.map(state => state.persistence.flush()));
      const result = await Promise.race([flushes, timeout]);
      if (result === 'timeout') logger.error('MemoryStorageLayer: index persistence flush timed out');
      else if (result.some(item => item.status === 'rejected' || !item.value)) {
        logger.error('MemoryStorageLayer: index persistence flush failed');
      }
    } finally {
      clearTimeout(timer);
      for (const state of states) state.persistence.dispose();
    }
  }

  /**
   * Discover all subdirectories to scan.
   * Returns ['system', 'adapters', ...dateFolders, ''] where '' = root.
   */
  private async discoverSubdirectoriesForDir(dir: string): Promise<string[]> {
    const entries = await this.backend.listDirectories(dir);
    const subdirs = ['system', 'adapters'].filter(name => entries.includes(name));
    const dateFolders: string[] = [];
    for (const entry of entries) {
      if (DATE_FOLDER_PATTERN.test(entry)) dateFolders.push(entry);
    }
    // Keep discovery order stable; name ownership is determined by file mtime.
    dateFolders.sort((a, b) => a.localeCompare(b));
    return [...subdirs, ...dateFolders, ''];
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
      // Only a discovered subdirectory may vanish; strict inventory and root failures reject.
      if (strict || !subdir || !isAbsentPathError(error)) throw error;
    }
  }

  // ---- scan hooks (FileStorageLayerBase) ----

  /** Extend shared directory state with memory index persistence. */
  protected extendState(dir: string, base: DirScanState): MemoryDirScanState {
    const indexPath = path.join(dir, '_index.json');
    return {
      ...base,
      persistence: new MemoryIndexPersistence(new MemoryIndexFile(indexPath, this.fileOps), { debounceMs: this.indexDebounceMs, onIdle: () => this.dirStates.trim() }),
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

  protected readIndexEntry(content: string, relPath: string, stats: Map<string, { mtimeMs: number; sizeBytes: number }>): ElementIndexEntry {
    return this.buildEntry(content, relPath, stats.get(relPath));
  }

  private buildEntry(content: string, filePath: string, meta?: { mtimeMs: number; sizeBytes: number }): ElementIndexEntry {
    const extracted = MemoryMetadataExtractor.extractMetadata(content, filePath);
    return {
      ...extracted,
      filePath,
      name: extracted.name ?? DEFAULT_MEMORY_NAME,
      description: extracted.description ?? '',
      version: extracted.version ?? '1.0.0',
      author: extracted.author ?? '',
      tags: extracted.tags ?? [],
      mtimeMs: meta?.mtimeMs ?? 0,
      sizeBytes: meta?.sizeBytes ?? 0,
    };
  }
}
