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
}

const EMPTY_DIFF: ManifestDiffResult = { added: [], modified: [], removed: [], unchanged: [] };
const DATE_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class MemoryStorageLayer implements IStorageLayer {
  private readonly backend: IStorageBackend;
  private readonly manifest = new StorageManifest();
  private readonly index = new MetadataIndex();
  private readonly indexFile: MemoryIndexFile;
  private readonly memoriesDir: string;
  private readonly scanCooldownMs: number;
  private readonly fileFilter?: (filename: string) => boolean;

  private lastScanTimestamp = 0;
  private scanInProgress: Promise<ManifestDiffResult> | null = null;
  private coldStartDone = false;

  constructor(
    private readonly fileOps: FileOperationsService,
    options: MemoryStorageLayerOptions
  ) {
    this.memoriesDir = options.memoriesDir;
    this.scanCooldownMs = options.scanCooldownMs ?? 1000;
    this.fileFilter = options.fileFilter;

    if (options.storageBackend) {
      this.backend = options.storageBackend;
    } else {
      this.backend = new FileStorageBackend(fileOps);
    }

    const indexPath = path.join(this.memoriesDir, '_index.json');
    this.indexFile = new MemoryIndexFile(indexPath, fileOps, {
      debounceMs: options.indexDebounceMs ?? 2000,
    });
  }

  // ---- IStorageLayer implementation ----

  async scan(): Promise<ManifestDiffResult> {
    // Cold start: try loading from _index.json first
    if (!this.coldStartDone) {
      this.coldStartDone = true;
      return this.coldStart();
    }

    const now = Date.now();
    if (now - this.lastScanTimestamp < this.scanCooldownMs) {
      logger.debug(`MemoryStorageLayer.scan: COOLDOWN ACTIVE — skipping disk I/O (${this.scanCooldownMs - (now - this.lastScanTimestamp)}ms remaining)`);
      return EMPTY_DIFF;
    }

    // Deduplicate concurrent scans
    if (this.scanInProgress) {
      return this.scanInProgress;
    }

    this.scanInProgress = this.performScan();
    try {
      return await this.scanInProgress;
    } finally {
      this.scanInProgress = null;
    }
  }

  async listSummaries(): Promise<ElementIndexEntry[]> {
    await this.scan();
    return this.deduplicateByName(this.index.getAll());
  }

  async getIndexedPaths(): Promise<string[]> {
    await this.scan();
    const deduplicated = this.deduplicateByName(this.index.getAll());
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
    return this.index.getPathByName(normalizedName);
  }

  hasCompletedScan(): boolean {
    return this.lastScanTimestamp > 0;
  }

  async notifySaved(relativePath: string, absolutePath: string): Promise<void> {
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

      this.index.set(entry);
      this.manifest.set(relativePath, meta.mtimeMs);
      this.indexFile.scheduleWrite(this.index.getAll());
    } catch (error) {
      logger.debug('MemoryStorageLayer.notifySaved failed, invalidating', {
        relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
      this.invalidate();
    }
  }

  notifyDeleted(relativePath: string): void {
    this.index.remove(relativePath);
    this.manifest.remove(relativePath);
    this.indexFile.scheduleWrite(this.index.getAll());
  }

  invalidate(): void {
    this.lastScanTimestamp = 0;
  }

  clear(): void {
    this.indexFile.dispose();  // Cancel pending debounced write (prevents ENOTEMPTY in tests)
    this.index.clear();
    this.manifest.clear();
    this.lastScanTimestamp = 0;
  }

  // ---- Memory-specific methods ----

  /**
   * Return index entries where autoLoad === true, sorted by priority ascending.
   * Pure in-memory — does NOT trigger a scan.
   */
  getAutoLoadEntries(): ElementIndexEntry[] {
    return this.index.getAll()
      .filter(entry => entry.autoLoad === true)
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  }

  /**
   * Full disk scan of all subdirectories + write _index.json.
   */
  async rebuildIndex(): Promise<void> {
    logger.info('MemoryStorageLayer: rebuilding index from disk...');
    this.index.clear();
    this.manifest.clear();

    await this.performScan();
    await this.indexFile.write(this.index.getAll());

    logger.info(`MemoryStorageLayer: rebuild complete — ${this.index.size} entries indexed`);
  }

  /**
   * Flush pending _index.json write and release resources.
   */
  async dispose(): Promise<void> {
    await this.indexFile.flush();
    this.indexFile.dispose();
  }

  // ---- Private ----

  /**
   * Cold start: try to restore from _index.json, then run incremental scan.
   * Falls back to full rebuild if index is missing/corrupt.
   */
  private async coldStart(): Promise<ManifestDiffResult> {
    try {
      const cached = await this.indexFile.read();

      if (cached) {
        // Populate index and manifest from cached data
        for (const [relPath, entry] of Object.entries(cached.entries)) {
          this.index.set(entry);
          this.manifest.set(relPath, entry.mtimeMs);
        }
        logger.info(`MemoryStorageLayer: cold start — loaded ${Object.keys(cached.entries).length} entries from _index.json`);

        // Run incremental scan to catch changes since _index.json was written
        return this.performScan();
      }
    } catch (error) {
      logger.debug('MemoryStorageLayer: cold start _index.json read failed, rebuilding', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // No valid _index.json — full rebuild
    await this.rebuildIndex();
    return EMPTY_DIFF;
  }

  /**
   * Discover all subdirectories to scan.
   * Returns ['system', 'adapters', ...dateFolders, ''] where '' = root.
   */
  private async discoverSubdirectories(): Promise<string[]> {
    const subdirs: string[] = [];

    try {
      const entries = await this.fileOps.listDirectory(this.memoriesDir);

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

  /**
   * Perform a full incremental scan across all subdirectories.
   */
  private async performScan(): Promise<ManifestDiffResult> {
    try {
      const exists = await this.backend.directoryExists(this.memoriesDir);
      if (!exists) {
        const removedPaths = this.index.getPaths();
        this.index.clear();
        this.manifest.clear();
        this.lastScanTimestamp = Date.now();
        return {
          added: [],
          modified: [],
          removed: removedPaths,
          unchanged: [],
        };
      }

      // 1. Discover subdirectories
      const subdirs = await this.discoverSubdirectories();

      // 2. Enumerate all .yaml files across subdirectories
      const allRelativePaths: string[] = [];

      for (const subdir of subdirs) {
        const absDir = subdir ? path.join(this.memoriesDir, subdir) : this.memoriesDir;

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
      const stats = await this.backend.statMany(this.memoriesDir, allRelativePaths);

      // 4. Diff against manifest
      const diff = this.manifest.diff(stats);

      logger.debug(`MemoryStorageLayer.scan: DISK SCAN — ${allRelativePaths.length} files, ${diff.added.length} added, ${diff.modified.length} modified, ${diff.removed.length} removed, ${diff.unchanged.length} unchanged`);

      // 5. For added/modified: read file, extract metadata, update index
      const toIndex = [...diff.added, ...diff.modified];
      let indexUpdated = false;

      await Promise.all(
        toIndex.map(async (relPath) => {
          try {
            const absPath = path.join(this.memoriesDir, relPath);
            const content = await this.backend.readFile(absPath);
            const extracted = MemoryMetadataExtractor.extractMetadata(content, relPath);
            const meta = stats.get(relPath);

            this.index.set({
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

      // 6. For removed: remove from index
      for (const relPath of diff.removed) {
        this.index.remove(relPath);
        indexUpdated = true;
      }

      // 7. Update manifest and timestamp
      this.manifest.update(stats);
      this.lastScanTimestamp = Date.now();

      // 8. Schedule debounced _index.json write if index changed
      if (indexUpdated) {
        this.indexFile.scheduleWrite(this.index.getAll());
      }

      return diff;
    } catch (error) {
      logger.error('MemoryStorageLayer.performScan failed', error);
      this.lastScanTimestamp = Date.now(); // Prevent retry storms
      return EMPTY_DIFF;
    }
  }
}
