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
  /** Absolute path to the element directory (static; used when no resolver is provided) */
  elementDir: string;
  /** File extension to filter (e.g. '.md') */
  fileExtension: string;
  /** Minimum milliseconds between full scans (default: 1000) */
  scanCooldownMs?: number;
  /** Override the storage backend (useful for testing) */
  storageBackend?: IStorageBackend;
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
  scanInProgress: Promise<ManifestDiffResult> | null;
}

export class ElementStorageLayer implements IStorageLayer {
  private readonly backend: IStorageBackend;
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
   * Growth: bounded by unique users who have connected (not sessions).
   * Each entry holds ~1-2KB of metadata per file in the dir. For the
   * target deployment scale (10-50 users), total footprint is small.
   * purgeDirState(dir) exists for future eviction if scale demands it.
   */
  private readonly dirStates = new Map<string, DirScanState>();

  constructor(
    fileOperationsService: FileOperationsService,
    options: ElementStorageLayerOptions
  ) {
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

  /** Get or create the scan state for the current directory. */
  private getState(): DirScanState {
    const dir = this.elementDir;
    let state = this.dirStates.get(dir);
    if (!state) {
      state = {
        manifest: new StorageManifest(),
        index: new MetadataIndex(),
        lastScanTimestamp: 0,
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
  async scan(): Promise<ManifestDiffResult> {
    const state = this.getState();
    const currentDir = this.elementDir;

    const now = Date.now();
    if (now - state.lastScanTimestamp < this.scanCooldownMs) {
      logger.debug(`ElementStorageLayer.scan: COOLDOWN ACTIVE for ${path.basename(currentDir)} — skipping disk I/O (${this.scanCooldownMs - (now - state.lastScanTimestamp)}ms remaining)`);
      return EMPTY_DIFF;
    }

    // Deduplicate concurrent scans FOR THE SAME DIRECTORY.
    // Each user's dir has its own scanInProgress promise — no cross-user leakage.
    if (state.scanInProgress) {
      return state.scanInProgress;
    }

    state.scanInProgress = this.performScanForDir(currentDir, state);
    try {
      return await state.scanInProgress;
    } finally {
      state.scanInProgress = null;
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
    return this.getState().index.getAll();
  }

  async getIndexedPaths(): Promise<string[]> {
    await this.scan();
    return this.getState().index.getPaths();
  }

  getPathByName(name: string): string | undefined {
    const normalizedName = UnicodeValidator.normalize(name).normalizedContent;
    return this.getState().index.getPathByName(normalizedName);
  }

  hasCompletedScan(): boolean {
    return this.getState().lastScanTimestamp > 0;
  }

  async notifySaved(relativePath: string, absolutePath: string): Promise<void> {
    const state = this.getState();
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
      this.invalidate();
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
    }
  }

  /**
   * Remove cached scan state for a specific directory. Called during
   * session cleanup to prevent unbounded growth of the per-dir cache
   * in long-running multi-user deployments.
   */
  purgeDirState(dir: string): void {
    this.dirStates.delete(dir);
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
