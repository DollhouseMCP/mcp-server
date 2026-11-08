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
  /**
   * The caller's own directory authority. A manager passes its current element directory here so
   * the layer it owns follows the same directory on every read, write and scan; without it the
   * factory's process-wide resolver (or the static elementDir) applies.
   */
  elementDirResolver?: () => string;
  /** Keep a directory manifest while cached objects or loads depend on it. */
  retainDirectoryState?: (dir: string) => boolean;
  /** A failed record was repaired or deleted by a targeted storage recheck. */
  onFailedRecordRecovered?: (reference: string) => void;
  fileExtension: string;
  scanCooldownMs: number;
}

export interface IStorageLayerFactory {
  createForElement(elementType: string, fileOptions: FileStorageOptions): IStorageLayer;
}
