/**
 * StorageManifest - Tracks file modification times for change detection.
 *
 * Compares current filesystem state against stored mtimes to produce
 * a diff of added, modified, removed, and unchanged files.
 */

import type { StorageItemMetadata, ManifestDiffResult } from './types.js';

export class StorageManifest {
  private entries = new Map<string, number>();

  /**
   * Diff current filesystem stats against the stored manifest.
   *
   * @param currentStats - Map of relativePath → StorageItemMetadata from a fresh scan
   * @returns Categorized diff result
   */
  diff(currentStats: Map<string, StorageItemMetadata>): ManifestDiffResult {
    const added: string[] = [];
    const modified: string[] = [];
    const unchanged: string[] = [];
    const removed: string[] = [];

    // Check current files against manifest
    for (const [relPath, meta] of currentStats) {
      const storedMtime = this.entries.get(relPath);
      if (storedMtime === undefined) {
        added.push(relPath);
      } else if (storedMtime !== meta.mtimeMs) {
        modified.push(relPath);
      } else {
        unchanged.push(relPath);
      }
    }

    // Check manifest entries that no longer exist on disk
    for (const relPath of this.entries.keys()) {
      if (!currentStats.has(relPath)) {
        removed.push(relPath);
      }
    }

    return { added, modified, removed, unchanged };
  }

  /**
   * Replace all manifest entries from fresh stats.
   * Typically called after a full scan completes.
   */
  update(stats: Map<string, StorageItemMetadata>): void {
    this.entries.clear();
    for (const [relPath, meta] of stats) {
      this.entries.set(relPath, meta.mtimeMs);
    }
  }

  /**
   * Update a single entry (e.g. after save).
   */
  set(relativePath: string, mtimeMs: number): void {
    this.entries.set(relativePath, mtimeMs);
  }

  /**
   * Remove a single entry (e.g. after delete).
   */
  remove(relativePath: string): void {
    this.entries.delete(relativePath);
  }

  /**
   * Reset manifest to empty state (cold-start).
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Number of tracked entries.
   */
  get size(): number {
    return this.entries.size;
  }
}
