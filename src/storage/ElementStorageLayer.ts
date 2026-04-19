/**
 * ElementStorageLayer - Coordinates index, manifest, and backend for cache-aware listing.
 *
 * Owns the scan lifecycle: cooldown enforcement, concurrent call deduplication,
 * diff-based incremental index updates, and notifications from save/delete.
 */

import * as path from 'path';
import { logger } from '../utils/logger.js';
import type { IStorageBackend } from './IStorageBackend.js';
import type { IStorageLayer } from './IStorageLayer.js';
import type { ElementIndexEntry, ManifestDiffResult } from './types.js';
import { StorageManifest } from './StorageManifest.js';
import { MetadataIndex } from './MetadataIndex.js';
import { FrontmatterParser } from './FrontmatterParser.js';
import { FileStorageBackend } from './FileStorageBackend.js';
import type { FileOperationsService } from '../services/FileOperationsService.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

export interface ElementStorageLayerOptions {
  /** Absolute path to the element directory */
  elementDir: string;
  /** File extension to filter (e.g. '.md') */
  fileExtension: string;
  /** Minimum milliseconds between full scans (default: 1000) */
  scanCooldownMs?: number;
  /** Override the storage backend (useful for testing) */
  storageBackend?: IStorageBackend;
}

const EMPTY_DIFF: ManifestDiffResult = { added: [], modified: [], removed: [], unchanged: [] };

export class ElementStorageLayer implements IStorageLayer {
  private readonly backend: IStorageBackend;
  private readonly manifest = new StorageManifest();
  private readonly index = new MetadataIndex();
  private readonly elementDir: string;
  private readonly fileExtension: string;
  private readonly scanCooldownMs: number;

  private lastScanTimestamp = 0;
  private scanInProgress: Promise<ManifestDiffResult> | null = null;

  constructor(
    fileOperationsService: FileOperationsService,
    options: ElementStorageLayerOptions
  ) {
    this.elementDir = options.elementDir;
    this.fileExtension = options.fileExtension;
    this.scanCooldownMs = options.scanCooldownMs ?? 1000;

    if (options.storageBackend) {
      this.backend = options.storageBackend;
    } else {
      this.backend = new FileStorageBackend(fileOperationsService);
    }
  }

  /**
   * Scan the element directory for changes.
   * - No-op if within cooldown period (returns empty diff)
   * - Deduplicates concurrent calls (returns same promise)
   * - Updates index and manifest based on diff
   */
  async scan(): Promise<ManifestDiffResult> {
    const now = Date.now();
    if (now - this.lastScanTimestamp < this.scanCooldownMs) {
      logger.debug(`ElementStorageLayer.scan: COOLDOWN ACTIVE for ${path.basename(this.elementDir)} — skipping disk I/O (${this.scanCooldownMs - (now - this.lastScanTimestamp)}ms remaining)`);
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

  /**
   * Trigger scan and return all index entries.
   *
   * File mode today is single-user per installation with no shared/
   * directory, so the includePublic flag is a no-op. Once Step 4.5 lands the
   * per-user file layout and `shared/` sibling, this implementation will
   * grow a union-enumeration of the current user's subtree plus `shared/`.
   */
  async listSummaries(_options?: { includePublic?: boolean }): Promise<ElementIndexEntry[]> {
    await this.scan();
    return this.index.getAll();
  }

  /**
   * Trigger scan and return all indexed file paths.
   */
  async getIndexedPaths(): Promise<string[]> {
    await this.scan();
    return this.index.getPaths();
  }

  /**
   * O(1) name-to-path lookup from the index. Does not trigger a scan.
   */
  getPathByName(name: string): string | undefined {
    const normalizedName = UnicodeValidator.normalize(name).normalizedContent;
    return this.index.getPathByName(normalizedName);
  }

  /**
   * Returns true if at least one scan has completed (index is authoritative).
   */
  hasCompletedScan(): boolean {
    return this.lastScanTimestamp > 0;
  }

  /**
   * Notify the storage layer that a file was saved.
   * Re-stats and re-parses the file to update index/manifest.
   */
  async notifySaved(relativePath: string, absolutePath: string): Promise<void> {
    try {
      const meta = await this.backend.stat(absolutePath);
      const content = await this.backend.readFile(absolutePath);
      const fm = FrontmatterParser.extractMetadata(content);

      this.index.set({
        filePath: relativePath,
        name: fm.name,
        description: fm.description,
        version: fm.version,
        author: fm.author,
        tags: fm.tags,
        mtimeMs: meta.mtimeMs,
        sizeBytes: meta.sizeBytes,
      });
      this.manifest.set(relativePath, meta.mtimeMs);
    } catch (error) {
      logger.debug('ElementStorageLayer.notifySaved failed, invalidating', {
        relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
      this.invalidate();
    }
  }

  /**
   * Notify the storage layer that a file was deleted.
   * Removes the entry from index and manifest.
   */
  notifyDeleted(relativePath: string): void {
    this.index.remove(relativePath);
    this.manifest.remove(relativePath);
  }

  /**
   * Force the next scan() to hit disk by resetting the cooldown timer.
   */
  invalidate(): void {
    this.lastScanTimestamp = 0;
  }

  /**
   * Reset all state (index, manifest, cooldown).
   */
  clear(): void {
    this.index.clear();
    this.manifest.clear();
    this.lastScanTimestamp = 0;
  }

  // ---- private ----

  private async performScan(): Promise<ManifestDiffResult> {
    try {
      const exists = await this.backend.directoryExists(this.elementDir);
      if (!exists) {
        // Directory doesn't exist — clear everything and return
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

      // 1. List + stat
      const files = await this.backend.listFiles(this.elementDir, this.fileExtension);
      const stats = await this.backend.statMany(this.elementDir, files);

      // 2. Diff against manifest
      const diff = this.manifest.diff(stats);

      const hasChanges = diff.added.length > 0 || diff.modified.length > 0 || diff.removed.length > 0;
      if (hasChanges) {
        logger.debug(`ElementStorageLayer.scan: DISK SCAN for ${path.basename(this.elementDir)} — ${files.length} files, ${diff.added.length} added, ${diff.modified.length} modified, ${diff.removed.length} removed`);
      }

      // 3. For added/modified: read frontmatter, update index
      const toIndex = [...diff.added, ...diff.modified];
      await Promise.all(
        toIndex.map(async (relPath) => {
          try {
            const absPath = path.join(this.elementDir, relPath);
            const content = await this.backend.readFile(absPath);
            const fm = FrontmatterParser.extractMetadata(content);
            const meta = stats.get(relPath);

            this.index.set({
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
            // Parse failure is non-fatal — skip this entry
            logger.debug(`ElementStorageLayer: failed to index ${relPath}`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })
      );

      // 4. For removed: remove from index
      for (const relPath of diff.removed) {
        this.index.remove(relPath);
      }

      // 5. Update manifest and timestamp
      this.manifest.update(stats);
      this.lastScanTimestamp = Date.now();

      return diff;
    } catch (error) {
      logger.error('ElementStorageLayer.performScan failed', error);
      this.lastScanTimestamp = Date.now(); // Prevent retry storms
      return EMPTY_DIFF;
    }
  }
}
