/**
 * Interface for storage layer implementations.
 *
 * Decouples BaseElementManager from a concrete storage strategy,
 * allowing ElementStorageLayer (Phase 1, .md files) and
 * MemoryStorageLayer (Phase 2, .yaml memories) to share the same contract.
 */

import type { ElementIndexEntry, ManifestDiffResult } from './types.js';

export interface IStorageLayer {
  /**
   * Scan the filesystem for changes relative to the last snapshot.
   * Implementations should enforce cooldown and deduplicate concurrent calls.
   */
  scan(): Promise<ManifestDiffResult>;

  /**
   * Trigger scan and return all indexed entries.
   */
  listSummaries(): Promise<ElementIndexEntry[]>;

  /**
   * Trigger scan and return all indexed file paths.
   */
  getIndexedPaths(): Promise<string[]>;

  /**
   * O(1) name-to-path lookup from the index. Does not trigger a scan.
   */
  getPathByName(name: string): string | undefined;

  /**
   * Returns true if at least one scan has completed, meaning the index
   * is populated and name lookups are authoritative (a miss means the
   * element genuinely does not exist on disk).
   */
  hasCompletedScan(): boolean;

  /**
   * Notify the storage layer that a file was saved.
   * Re-stats and re-parses the file to update index/manifest.
   */
  notifySaved(relativePath: string, absolutePath: string): Promise<void>;

  /**
   * Notify the storage layer that a file was deleted.
   * Removes the entry from index and manifest.
   */
  notifyDeleted(relativePath: string): void;

  /**
   * Force the next scan() to hit disk by resetting the cooldown timer.
   */
  invalidate(): void;

  /**
   * Reset all state (index, manifest, cooldown).
   */
  clear(): void;
}
