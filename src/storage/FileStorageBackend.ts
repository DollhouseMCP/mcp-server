/**
 * FileStorageBackend - IStorageBackend implementation wrapping FileOperationsService.
 *
 * Delegates all I/O to the existing security-audited FileOperationsService,
 * ensuring path validation, atomic reads, and audit logging are preserved.
 */

import * as path from 'path';
import type { IStorageBackend } from './IStorageBackend.js';
import type { StorageItemMetadata } from './types.js';
import type { FileOperationsService } from '../services/FileOperationsService.js';

export class FileStorageBackend implements IStorageBackend {
  constructor(private readonly fileOps: FileOperationsService) {}

  async listFiles(directory: string, extension: string): Promise<string[]> {
    const entries = await this.fileOps.listDirectory(directory);
    return entries.filter(name => name.endsWith(extension));
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

  async statMany(directory: string, relativePaths: string[]): Promise<Map<string, StorageItemMetadata>> {
    const results = new Map<string, StorageItemMetadata>();

    const settled = await Promise.allSettled(
      relativePaths.map(async (relPath) => {
        const absPath = path.join(directory, relPath);
        const stats = await this.fileOps.stat(absPath);
        return {
          relativePath: relPath,
          absolutePath: absPath,
          mtimeMs: stats.mtimeMs,
          sizeBytes: stats.size,
        } satisfies StorageItemMetadata;
      })
    );

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === 'fulfilled') {
        results.set(relativePaths[i], result.value);
      }
      // Rejected entries (e.g. file deleted between list and stat) are silently skipped
    }

    return results;
  }

  async readFile(absolutePath: string): Promise<string> {
    return this.fileOps.readFile(absolutePath);
  }

  async directoryExists(directory: string): Promise<boolean> {
    return this.fileOps.exists(directory);
  }
}
