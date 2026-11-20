/**
 * ElementStorageLayer - Coordinates index, manifest, and backend for cache-aware listing.
 *
 * Owns the scan lifecycle: cooldown enforcement, concurrent call deduplication,
 * diff-based incremental index updates, and notifications from save/delete.
 */

import { FileStorageLayerBase, type DirScanState } from './FileStorageLayerBase.js';
import { DirectoryStateCache } from './DirectoryStateCache.js';
import * as path from 'node:path';
import { logger } from '../utils/logger.js';
import type { IStorageBackend } from './IStorageBackend.js';
import { type ElementIndexEntry, type ManifestDiffResult } from './types.js';
import { FrontmatterParser } from './FrontmatterParser.js';
import { FileStorageBackend } from './FileStorageBackend.js';
import type { FileOperationsService } from '../services/FileOperationsService.js';

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

export class ElementStorageLayer extends FileStorageLayerBase<DirScanState> {
  private readonly retainDirectoryState?: (dir: string) => boolean;
  private readonly staticElementDir: string;
  private readonly elementDirResolver?: () => string;
  private readonly fileExtension: string;

  constructor(
    fileOperationsService: FileOperationsService,
    options: ElementStorageLayerOptions
  ) {
    super(options.storageBackend ?? new FileStorageBackend(fileOperationsService),
      new DirectoryStateCache<DirScanState>(
        (_state, dir) => !this.retainDirectoryState?.(dir),
      ), options.scanCooldownMs);
    this.retainDirectoryState = options.retainDirectoryState;
    this.staticElementDir = options.elementDir;
    this.elementDirResolver = options.elementDirResolver;
    this.fileExtension = options.fileExtension;
  }

  /** The active element directory — dynamic when a resolver is present. */
  private get elementDir(): string {
    return this.elementDirResolver ? this.elementDirResolver() : this.staticElementDir;
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
    return state.table.entries();
  }

  async getIndexedPaths(): Promise<string[]> {
    const state = this.getState();
    await this.scan();
    return state.table.entries().map(entry => entry.filePath);
  }

  // ---- scan hooks (FileStorageLayerBase) ----

  /** Elements need only the shared directory state. */
  protected extendState(_dir: string, base: DirScanState): DirScanState {
    return base;
  }

  protected readonly scanLabel = 'ElementStorageLayer';

  protected get directory(): string { return this.elementDir; }

  protected enumerate(dir: string): Promise<string[]> {
    return this.backend.listFiles(dir, this.fileExtension);
  }

  protected logCooldown(dir: string, remainingMs: number): void {
    logger.debug(`ElementStorageLayer.scan: COOLDOWN ACTIVE for ${path.basename(dir)} — skipping disk I/O (${remainingMs}ms remaining)`);
  }

  protected logDiskScan(dir: string, fileCount: number, diff: ManifestDiffResult): void {
    logger.debug(`ElementStorageLayer.scan: DISK SCAN for ${path.basename(dir)} — ${fileCount} files, ${diff.added.length} added, ${diff.modified.length} modified, ${diff.removed.length} removed`);
  }

  protected readIndexEntry(content: string, relPath: string, stats: Map<string, { mtimeMs: number; sizeBytes: number }>): ElementIndexEntry {
    const fm = FrontmatterParser.extractMetadata(content);
    const meta = stats.get(relPath);

    return {
      filePath: relPath,
      name: fm.name,
      description: fm.description,
      version: fm.version,
      author: fm.author,
      tags: fm.tags,
      mtimeMs: meta?.mtimeMs ?? 0,
      sizeBytes: meta?.sizeBytes ?? 0,
    };
  }
}
