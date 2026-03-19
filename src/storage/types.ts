/**
 * Storage layer types for cache-aware element listing.
 *
 * Phase 1: Provides lightweight metadata indexing to avoid
 * full file reads during list() operations.
 */

/**
 * Filesystem metadata for a single storage item.
 * Returned by stat operations on the storage backend.
 */
export interface StorageItemMetadata {
  /** Path relative to the element directory */
  relativePath: string;
  /** Fully resolved absolute path */
  absolutePath: string;
  /** Last modification time in milliseconds since epoch */
  mtimeMs: number;
  /** File size in bytes */
  sizeBytes: number;
}

/**
 * Indexed metadata for a single element.
 * Extracted from frontmatter without loading full element content.
 */
export interface ElementIndexEntry {
  /** Relative path within the element directory */
  filePath: string;
  /** Element name from frontmatter */
  name: string;
  /** Element description from frontmatter */
  description: string;
  /** Semantic version string */
  version: string;
  /** Author name */
  author: string;
  /** Classification tags */
  tags: string[];
  /** Last modification time in milliseconds (mirrors StorageItemMetadata.mtimeMs) */
  mtimeMs: number;
  /** File size in bytes (mirrors StorageItemMetadata.sizeBytes) */
  sizeBytes: number;

  // Phase 2: memory-specific optional fields
  /** Whether this memory should be auto-loaded on server startup */
  autoLoad?: boolean;
  /** Load priority (lower = higher priority) */
  priority?: number;
  /** Memory type classification (system, adapter, user) */
  memoryType?: string;
  /** Number of entries in the memory */
  totalEntries?: number;
}

/**
 * Result of diffing current filesystem state against a stored manifest.
 * Each array contains relative paths.
 */
export interface ManifestDiffResult {
  /** Files present on disk but not in manifest (new files) */
  added: string[];
  /** Files whose mtime changed since last manifest snapshot */
  modified: string[];
  /** Files in manifest but no longer on disk */
  removed: string[];
  /** Files whose mtime matches the manifest (no change) */
  unchanged: string[];
}
