/**
 * FileStorageBackend - IStorageBackend implementation wrapping FileOperationsService.
 *
 * Delegates all I/O to the existing security-audited FileOperationsService,
 * ensuring path validation, atomic reads, and audit logging are preserved.
 */

import { mapStorageItems } from './mapStorageItems.js';
import * as path from 'node:path';
import type { IStorageBackend, StorageStatResult } from './IStorageBackend.js';
import type { StorageItemMetadata } from './types.js';
import { type FileOperationsService, isAbsentPathError } from '../services/FileOperationsService.js';

export class FileStorageBackend implements IStorageBackend {
  constructor(private readonly fileOps: FileOperationsService) {}

  listFiles(directory: string, extension: string): Promise<string[]> {
    return this.listEntriesOfType(directory, 'isFile', extension);
  }

  listDirectories(directory: string): Promise<string[]> {
    return this.listEntriesOfType(directory, 'isDirectory');
  }

  private async listEntriesOfType(directory: string, type: 'isFile' | 'isDirectory', extension = ''): Promise<string[]> {
    const entries = await this.fileOps.listDirectoryWithTypes(directory);
    const candidates = entries.filter(entry => entry.name.endsWith(extension));
    const matches = await mapStorageItems(candidates, entry => this.matchesEntryType(directory, entry, type));
    return candidates.filter((_entry, index) => matches[index]).map(entry => entry.name);
  }

  private async matchesEntryType(directory: string, entry: { name: string; isFile: boolean; isDirectory: boolean },
    type: 'isFile' | 'isDirectory'): Promise<boolean> {
    if (entry.isFile || entry.isDirectory) return entry[type];
    // Dirents do not follow symlinks; preserve the existing stat/read target policy.
    try { return (await this.fileOps.stat(path.join(directory, entry.name)))[type](); }
    catch (error) {
      // Keep uncertain targets so the subsequent file stat or directory listing reports them.
      return !isAbsentPathError(error);
    }
  }

  async stat(absolutePath: string): Promise<StorageItemMetadata> {
    const stats = await this.fileOps.stat(absolutePath);
    return {
      relativePath: path.basename(absolutePath),
      absolutePath,
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
    };
  }

  async statMany(directory: string, relativePaths: string[]): Promise<StorageStatResult> {
    const results = new Map<string, StorageItemMetadata>();

    const settled = await mapStorageItems(relativePaths, async relPath => {
      try {
        return { status: 'fulfilled', value: await this.stat(path.join(directory, relPath)) } as const;
      } catch (reason) { return { status: 'rejected', reason } as const; }
    });

    const failures = new Map<string, Error>();
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === 'fulfilled') {
        results.set(relativePaths[i], { ...result.value, relativePath: relativePaths[i] });
      } else if (!isAbsentPathError(result.reason)) {
        failures.set(relativePaths[i], result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
      }
      // An absent path disappeared between enumeration and stat.
    }

    return { stats: results, failures };
  }

  async readFile(absolutePath: string): Promise<string> {
    return this.fileOps.readFile(absolutePath);
  }

  async directoryExists(directory: string): Promise<boolean> {
    return this.fileOps.directoryExists(directory);
  }
}
