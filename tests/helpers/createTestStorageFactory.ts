/**
 * Test helper: creates a FileStorageLayerFactory with sensible defaults.
 *
 * Tests that construct element managers directly (outside DI) use this
 * to satisfy the required `storageLayerFactory` field. Production code
 * always receives the factory via DI container.
 */

import { FileStorageLayerFactory, defaultMemoryFileFilter } from '../../src/storage/FileStorageLayerFactory.js';
import { FileOperationsService } from '../../src/services/FileOperationsService.js';
import { FileLockManager } from '../../src/security/fileLockManager.js';
import type { IStorageLayerFactory } from '../../src/storage/IStorageLayerFactory.js';

export function createTestStorageFactory(fileOps?: FileOperationsService): IStorageLayerFactory {
  const ops = fileOps ?? new FileOperationsService(new FileLockManager());
  return new FileStorageLayerFactory(ops, {
    indexDebounceMs: 2000,
    fileFilter: defaultMemoryFileFilter,
  });
}
