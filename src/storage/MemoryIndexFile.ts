/**
 * MemoryIndexFile - Persistent _index.json manager with debounced writes.
 *
 * On server restart the MemoryStorageLayer can load cached metadata from
 * _index.json instead of re-scanning every memory file on disk.  This class
 * handles reading, writing (with validation), and debounced scheduling of
 * index persistence to avoid excessive I/O during rapid mutations.
 */

import { logger } from '../utils/logger.js';
import type { FileOperationsService } from '../services/FileOperationsService.js';
import type { ElementIndexEntry } from './types.js';

export interface MemoryIndexData {
  version: 1;
  generatedAt: string;
  entryCount: number;
  entries: Record<string, ElementIndexEntry>;
}

export interface MemoryIndexFileOptions {
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 2000;

export class MemoryIndexFile {
  private readonly indexPath: string;
  private readonly fileOps: FileOperationsService;
  private readonly debounceMs: number;

  private pendingEntries: ElementIndexEntry[] | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    indexPath: string,
    fileOps: FileOperationsService,
    options?: MemoryIndexFileOptions,
  ) {
    this.indexPath = indexPath;
    this.fileOps = fileOps;
    this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Read the index from disk.
   * Returns null when the file is missing, corrupt, has a version mismatch,
   * or the entryCount doesn't match the actual number of entries.
   */
  async read(): Promise<MemoryIndexData | null> {
    try {
      const raw = await this.fileOps.readFile(this.indexPath);
      const parsed = JSON.parse(raw) as MemoryIndexData;

      // Schema validation: verify top-level structure
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return this.handleCorruptIndex('top-level value is not an object');
      }

      if (parsed.version !== 1) {
        logger.warn(`MemoryIndexFile: unsupported version ${(parsed as any).version}, ignoring`);
        return null;
      }

      if (typeof parsed.entries !== 'object' || parsed.entries === null || Array.isArray(parsed.entries)) {
        return this.handleCorruptIndex('entries field is not a Record');
      }

      // Entry-level validation: every entry must have filePath and name
      const validEntries: Record<string, ElementIndexEntry> = {};
      let skippedCount = 0;
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (
          typeof entry === 'object' && entry !== null &&
          typeof entry.filePath === 'string' && entry.filePath.length > 0 &&
          typeof entry.name === 'string' && entry.name.length > 0
        ) {
          validEntries[key] = entry;
        } else {
          skippedCount++;
        }
      }

      if (skippedCount > 0) {
        logger.warn(
          `MemoryIndexFile: skipped ${skippedCount} malformed entries during load`,
        );
      }

      const actualCount = Object.keys(validEntries).length;
      if (parsed.entryCount !== actualCount && skippedCount === 0) {
        logger.warn(
          `MemoryIndexFile: entryCount mismatch (header=${parsed.entryCount}, actual=${actualCount}), ignoring`,
        );
        return null;
      }

      // Return with validated entries and corrected count
      return { ...parsed, entries: validEntries, entryCount: actualCount };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return null;
      }
      if (err instanceof SyntaxError) {
        return this.handleCorruptIndex('invalid JSON');
      }
      // Re-throw unexpected errors
      throw err;
    }
  }

  /**
   * Handle a corrupt or malformed index file: log a warning and delete it
   * so the next scan builds a clean index from disk.
   */
  private async handleCorruptIndex(reason: string): Promise<null> {
    logger.warn(`MemoryIndexFile: corrupt _index.json (${reason}), deleting for rebuild`);
    try {
      await this.fileOps.deleteFile(this.indexPath, 'memories' as any, {
        source: 'MemoryIndexFile.handleCorruptIndex',
      });
    } catch {
      // Best-effort deletion — if it fails, the next read() will try again
    }
    return null;
  }

  /**
   * Write the index to disk immediately.
   * Converts the entries array to a Record keyed by `entry.filePath`.
   * Catches ENOSPC gracefully (logs warning, does not throw).
   */
  async write(entries: ElementIndexEntry[]): Promise<void> {
    const entriesRecord: Record<string, ElementIndexEntry> = {};
    for (const entry of entries) {
      entriesRecord[entry.filePath] = entry;
    }

    const data: MemoryIndexData = {
      version: 1,
      generatedAt: new Date().toISOString(),
      entryCount: entries.length,
      entries: entriesRecord,
    };

    try {
      await this.fileOps.writeFile(this.indexPath, JSON.stringify(data, null, 2));
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC') {
        logger.warn('MemoryIndexFile: disk full (ENOSPC), skipping index write');
        return;
      }
      throw err;
    }
  }

  /**
   * Schedule a debounced write.  Multiple calls within the debounce window
   * coalesce into a single write using the most recent entries.
   */
  scheduleWrite(entries: ElementIndexEntry[]): void {
    this.pendingEntries = entries;

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const toWrite = this.pendingEntries;
      this.pendingEntries = null;
      if (toWrite) {
        this.write(toWrite).catch((err) => {
          logger.error('MemoryIndexFile: scheduled write failed', err);
        });
      }
    }, this.debounceMs);
  }

  /**
   * If there are pending entries, write immediately and clear the timer.
   */
  async flush(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.pendingEntries !== null) {
      const toWrite = this.pendingEntries;
      this.pendingEntries = null;
      await this.write(toWrite);
    }
  }

  /**
   * Cancel any pending timer.  Does NOT flush (fire-and-forget cleanup).
   */
  dispose(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingEntries = null;
  }
}
