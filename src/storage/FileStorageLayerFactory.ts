/**
 * FileStorageLayerFactory — file-backed storage layer creation.
 *
 * Creates ElementStorageLayer for most element types and
 * MemoryStorageLayer for memories (which needs extra config like
 * index debounce and file filtering). The memory-specific config is
 * injected at factory-construction time from DI, not per-call — the
 * element manager never knows about it.
 *
 * This is the default 'StorageLayerFactory' registration. In DB mode,
 * DatabaseServiceRegistrar overrides it with DatabaseStorageLayerFactory.
 *
 * @since Step 4.5 Commit 2.5
 */

import { FileOperationsService } from '../services/FileOperationsService.js';
import { ElementStorageLayer } from './ElementStorageLayer.js';
import { MemoryStorageLayer } from './MemoryStorageLayer.js';
import type { IStorageLayer } from './IStorageLayer.js';
import type { IStorageLayerFactory, FileStorageOptions } from './IStorageLayerFactory.js';

export interface MemoryStorageConfig {
  indexDebounceMs: number;
  fileFilter: (filename: string) => boolean;
}

/**
 * Default fileFilter for memory storage — excludes backup files.
 * Shared between Container.ts and test helpers to avoid duplication.
 */
export function defaultMemoryFileFilter(filename: string): boolean {
  return !filename.includes('.backup-') && !filename.toLowerCase().includes('backup');
}

export class FileStorageLayerFactory implements IStorageLayerFactory {
  constructor(
    private readonly fileOps: FileOperationsService,
    private readonly memoryConfig: MemoryStorageConfig,
  ) {}

  createForElement(elementType: string, options: FileStorageOptions): IStorageLayer {
    if (elementType === 'memories') {
      return new MemoryStorageLayer(this.fileOps, {
        memoriesDir: options.elementDir,
        scanCooldownMs: options.scanCooldownMs,
        indexDebounceMs: this.memoryConfig.indexDebounceMs,
        fileFilter: this.memoryConfig.fileFilter,
      });
    }
    return new ElementStorageLayer(this.fileOps, options);
  }
}
