/**
 * MetadataIndex - In-memory index of element metadata for fast lookups.
 *
 * Primary map: relativePath → ElementIndexEntry
 * Secondary map: normalizedName → relativePath (case-insensitive name lookup)
 */

import type { ElementIndexEntry } from './types.js';

export class MetadataIndex {
  private byPath = new Map<string, ElementIndexEntry>();
  private nameToPath = new Map<string, string>();

  /**
   * Add or update an entry in the index.
   * Updates both primary and secondary maps.
   */
  set(entry: ElementIndexEntry): void {
    // If this path already existed, clean up old name mapping
    const existing = this.byPath.get(entry.filePath);
    if (existing) {
      const oldNorm = this.normalizeName(existing.name);
      // Only remove if it still points to this path
      if (this.nameToPath.get(oldNorm) === entry.filePath) {
        this.nameToPath.delete(oldNorm);
      }
    }

    this.byPath.set(entry.filePath, entry);
    this.nameToPath.set(this.normalizeName(entry.name), entry.filePath);
  }

  /**
   * Get an entry by file path.
   */
  get(filePath: string): ElementIndexEntry | undefined {
    return this.byPath.get(filePath);
  }

  /**
   * Remove an entry by file path.
   * Cleans up both primary and secondary maps.
   */
  remove(filePath: string): void {
    const entry = this.byPath.get(filePath);
    if (entry) {
      const normName = this.normalizeName(entry.name);
      // Only remove name mapping if it points to the path being removed
      if (this.nameToPath.get(normName) === filePath) {
        this.nameToPath.delete(normName);
      }
      this.byPath.delete(filePath);
    }
  }

  /**
   * O(1) case-insensitive name → path lookup.
   */
  getPathByName(name: string): string | undefined {
    return this.nameToPath.get(this.normalizeName(name));
  }

  /**
   * Get all index entries.
   */
  getAll(): ElementIndexEntry[] {
    return [...this.byPath.values()];
  }

  /**
   * Get all indexed file paths.
   */
  getPaths(): string[] {
    return [...this.byPath.keys()];
  }

  /**
   * Reset index to empty state.
   */
  clear(): void {
    this.byPath.clear();
    this.nameToPath.clear();
  }

  /**
   * Number of indexed entries.
   */
  get size(): number {
    return this.byPath.size;
  }

  private normalizeName(name: string): string {
    return name.toLowerCase().trim();
  }
}
