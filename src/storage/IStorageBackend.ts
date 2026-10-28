/**
 * Interface for storage backend operations.
 *
 * Abstracts filesystem access so the storage layer can be tested
 * with mocks and potentially swapped for alternative backends.
 */

import type { StorageItemMetadata } from './types.js';

export interface StorageStatResult {
  stats: Map<string, StorageItemMetadata>;
  failures: Map<string, Error>;
}

export interface IStorageBackend {
  /**
   * List files in a directory filtered by extension.
   * @param directory - Absolute path to the directory
   * @param extension - File extension to filter by (e.g. '.md')
   * @returns Array of filenames (not full paths) matching the extension
   */
  listFiles(directory: string, extension: string): Promise<string[]>;

  /** List directory names, following symlink targets and retaining uncertain targets for later I/O. */
  listDirectories(directory: string): Promise<string[]>;

  /**
   * Get metadata for a single file.
   * @param absolutePath - Absolute path to the file
   * @returns Storage item metadata
   * @throws If the file does not exist or cannot be stat'd
   */
  stat(absolutePath: string): Promise<StorageItemMetadata>;

  /**
   * Get metadata for multiple files in parallel.
   * Absent paths are omitted. Other per-file errors are returned for indexing diagnostics.
   *
   * @param directory - Absolute path to the base directory
   * @param relativePaths - Array of relative paths within the directory
   * @returns Successful metadata and failures, both keyed by relative path.
   */
  statMany(directory: string, relativePaths: string[]): Promise<StorageStatResult>;

  /**
   * Read the full contents of a file.
   * @param absolutePath - Absolute path to the file
   * @returns File contents as a UTF-8 string
   */
  readFile(absolutePath: string): Promise<string>;

  /**
   * Check whether a directory exists. ENOENT, ENOTDIR, and non-directories
   * return false; all other stat errors reject.
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
