/**
 * MemoryIndexFile - Validated _index.json file format and I/O.
 *
 * On server restart the MemoryStorageLayer can load cached metadata from
 * _index.json instead of re-scanning every memory file on disk.  This class
 * handles reading, validation, and writing. Scheduling belongs to MemoryIndexPersistence.
 */

import * as path from 'node:path';
import { logger } from '../utils/logger.js';
import type { FileOperationsService } from '../services/FileOperationsService.js';
import type { BlockedFile } from './FileStateTable.js';
import type { ElementIndexEntry } from './types.js';

export interface MemoryIndexData {
  version: 2;
  generatedAt: string;
  entryCount: number;
  entries: Record<string, ElementIndexEntry>;
  blocked?: Record<string, BlockedFile>;
}

export class MemoryIndexFile {
  constructor(private readonly indexPath: string, private readonly fileOps: FileOperationsService,
    private readonly platform: NodeJS.Platform = process.platform) {}

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

      if (parsed.version !== 2) {
        logger.warn(`MemoryIndexFile: unsupported version ${(parsed as any).version}, ignoring`);
        return null;
      }

      if (typeof parsed.entries !== 'object' || parsed.entries === null || Array.isArray(parsed.entries)) {
        return this.handleCorruptIndex('entries field is not a Record');
      }

      const { validEntries, skippedCount } = this.validateEntries(parsed.entries);
      const blocked = this.validateBlocked(parsed.blocked);

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
      return { ...parsed, entries: validEntries, blocked, entryCount: actualCount };
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

  private isRelativeIndexPath(value: string): boolean {
    const validPlatformPath = this.platform !== 'win32' || (!value.includes('\\') && !value.includes(':'));
    return value.length > 0 && validPlatformPath && !value.includes('\0') &&
      !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) &&
      value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..') &&
      path.posix.normalize(value) === value;
  }

  private validateBlocked(value: unknown): Record<string, BlockedFile> {
    const blocked: Record<string, BlockedFile> = {};
    if (value === undefined) return blocked;
    let skipped = 0;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) skipped++;
    else for (const [path, item] of Object.entries(value)) {
      if (this.isRelativeIndexPath(path) && typeof item?.nameKey === 'string' && item.nameKey.trim().length &&
          typeof item.mtimeMs === 'number' && Number.isFinite(item.mtimeMs)) {
        blocked[path] = { nameKey: item.nameKey, mtimeMs: item.mtimeMs };
      } else skipped++;
    }
    if (skipped) logger.warn(`MemoryIndexFile: skipped ${skipped} malformed blocked entries during load`);
    return blocked;
  }

  private validateEntries(entries: Record<string, ElementIndexEntry>) {
    const validEntries: Record<string, ElementIndexEntry> = {};
    let skippedCount = 0;
    for (const [key, entry] of Object.entries(entries)) {
      if (
        typeof entry === 'object' && entry !== null &&
        typeof entry.filePath === 'string' && this.isRelativeIndexPath(key) && key === entry.filePath &&
        typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs) &&
        typeof entry.name === 'string' && entry.name.length > 0
      ) {
        validEntries[key] = entry;
      } else {
        skippedCount++;
      }
    }

    return { validEntries, skippedCount };
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

  /** Write a complete index; failures must reach the persistence owner. */
  async write(entries: ElementIndexEntry[], blocked: Record<string, BlockedFile> = {}): Promise<void> {
    await this.writeEntries(entries, blocked);
  }

  private async writeEntries(entries: ElementIndexEntry[], blocked: Record<string, BlockedFile>): Promise<void> {
    const entriesRecord: Record<string, ElementIndexEntry> = {};
    for (const entry of entries) {
      entriesRecord[entry.filePath] = entry;
    }

    const data: MemoryIndexData = {
      version: 2,
      generatedAt: new Date().toISOString(),
      entryCount: entries.length,
      entries: entriesRecord,
      blocked,
    };

    await this.fileOps.writeFile(this.indexPath, JSON.stringify(data, null, 2));
  }
}
