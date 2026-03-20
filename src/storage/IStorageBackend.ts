/**
 * Interface for storage backend operations.
 *
 * Abstracts filesystem access so the storage layer can be tested
 * with mocks and potentially swapped for alternative backends.
 */

import type { StorageItemMetadata } from './types.js';

export interface IStorageBackend {
  /**
   * List files in a directory filtered by extension.
   * @param directory - Absolute path to the directory
   * @param extension - File extension to filter by (e.g. '.md')
   * @returns Array of filenames (not full paths) matching the extension
   */
  listFiles(directory: string, extension: string): Promise<string[]>;

  /**
   * Get metadata for a single file.
   * @param absolutePath - Absolute path to the file
   * @returns Storage item metadata
   * @throws If the file does not exist or cannot be stat'd
   */
  stat(absolutePath: string): Promise<StorageItemMetadata>;

  /**
   * Get metadata for multiple files in parallel.
   * Files that cannot be stat'd (e.g. deleted between list and stat)
   * are silently omitted from the result.
   *
   * @param directory - Absolute path to the base directory
   * @param relativePaths - Array of relative paths within the directory
   * @returns Map of relativePath → StorageItemMetadata for files that were stat'd successfully
   */
  statMany(directory: string, relativePaths: string[]): Promise<Map<string, StorageItemMetadata>>;

  /**
   * Read the full contents of a file.
   * @param absolutePath - Absolute path to the file
   * @returns File contents as a UTF-8 string
   */
  readFile(absolutePath: string): Promise<string>;

  /**
   * Check whether a directory exists.
   * @param directory - Absolute path to check
   * @returns true if the directory exists
   */
  directoryExists(directory: string): Promise<boolean>;

  /**
   * (Optional) Read only the frontmatter portion of a file.
   * Not implemented in Phase 1 — reserved for Phase 2 partial-read optimization.
   *
   * @param absolutePath - Absolute path to the file
   * @returns The raw frontmatter string, or null if no frontmatter found
   */
  loadFrontmatter?(absolutePath: string): Promise<string | null>;
}
