/**
 * IStorageLayerFactory — backend-agnostic storage layer construction.
 *
 * Element managers depend on this interface to obtain their storage
 * layer. The factory decides which backend (file, database, or any
 * future backend) to create based on its own configuration — callers
 * pass only what they know (element type + file-mode layout options)
 * and never import or reference a specific backend.
 *
 * Two implementations ship today:
 *   - FileStorageLayerFactory   (file-mode default)
 *   - DatabaseStorageLayerFactory (DB-mode override, drizzle-lazy)
 *
 * Adding a new backend:
 *   1. Implement IStorageLayerFactory
 *   2. Create a registrar that registers it as 'StorageLayerFactory'
 *   3. Done — zero changes to element managers.
 *
 * @since Step 4.5 Commit 2.5
 */

import type { IStorageLayer } from './IStorageLayer.js';

export interface FileStorageOptions {
  elementDir: string;
  fileExtension: string;
  scanCooldownMs: number;
}

export interface IStorageLayerFactory {
  createForElement(elementType: string, fileOptions: FileStorageOptions): IStorageLayer;
}
