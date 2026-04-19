/**
 * Storage Layer Interfaces
 *
 * Decouples BaseElementManager from a concrete storage strategy.
 *
 * IStorageLayer — read-only contract for cache-aware element listing.
 * Implemented by ElementStorageLayer (Phase 1, .md files) and
 * MemoryStorageLayer (Phase 2, .yaml memories).
 *
 * IWritableStorageLayer — extends IStorageLayer with direct write/read/delete.
 * Implemented by DatabaseStorageLayer and DatabaseMemoryStorageLayer
 * (Phase 4) where the storage layer IS the persistence mechanism.
 *
 * @since v2.0.0 (IStorageLayer), v2.2.0 (IWritableStorageLayer — Phase 4)
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
   *
   * @param options.includePublic - When true, the returned set also includes
   *   elements owned by other users that have visibility='public'. When false
   *   (default), results are scoped to the current user. Implementations that
   *   don't support public content (e.g. legacy file-mode layouts with no
   *   shared directory) ignore the flag and return only own content.
   */
  listSummaries(options?: { includePublic?: boolean }): Promise<ElementIndexEntry[]>;

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

// ── Database Storage Extension ──────────────────────────────────────

/**
 * Metadata passed alongside content during a database write.
 * Extracted from the element's frontmatter by the caller (BaseElementManager).
 */
export interface ElementWriteMetadata {
  author: string;
  version: string;
  description: string;
  tags: string[];
  visibility?: string;
}

/**
 * Options for {@link IWritableStorageLayer.writeContent}.
 */
export interface WriteContentOptions {
  /**
   * When true, fail with "already exists" if an element with the same
   * (userType, elementType, name) tuple already exists. Used to mirror the
   * file-mode `createFileExclusive` flag for atomic create-or-fail semantics.
   *
   * Default (false) upserts on the unique index.
   */
  exclusive?: boolean;
  /**
   * Singular, capitalized human-readable label for the element type
   * (e.g. "Agent", "Memory", "Skill"). Used in "already exists" errors so
   * DB-mode messages match file-mode format. BaseElementManager supplies
   * this via `getElementLabelCapitalized()`. Falls back to capitalize(plural)
   * when omitted, which is acceptable for internal callers.
   */
  elementLabel?: string;
}

/**
 * Extended storage layer for database-backed persistence.
 *
 * In file mode, BaseElementManager writes to disk first, then calls
 * notifySaved() to update the storage layer's index. In database mode,
 * there IS no file — the storage layer is the persistence mechanism.
 * IWritableStorageLayer adds writeContent/deleteContent/readContent
 * so the manager can delegate persistence directly.
 *
 * File-backed layers (ElementStorageLayer, MemoryStorageLayer) do NOT
 * implement this. Detection uses the isWritableStorageLayer() type guard.
 */
export interface IWritableStorageLayer extends IStorageLayer {
  /**
   * Persist element content directly to the database.
   * Parses frontmatter, extracts metadata, upserts the element row
   * and tags atomically. Returns the element's storage identifier
   * (UUID in database mode).
   */
  writeContent(
    elementType: string,
    name: string,
    content: string,
    metadata: ElementWriteMetadata,
    options?: WriteContentOptions,
  ): Promise<string>;

  /**
   * Delete element content from the database.
   * Cascading deletes handle tags, relationships, and child records.
   */
  deleteContent(elementType: string, name: string): Promise<void>;

  /**
   * Read raw element content by storage identifier.
   * In database mode, relativePath is the element UUID.
   * Returns the full raw_content (YAML frontmatter + body).
   */
  readContent(relativePath: string): Promise<string>;
}

/**
 * Type guard for detecting database-backed storage layers.
 * Used by BaseElementManager to branch between file and database
 * save/load/delete paths.
 */
export function isWritableStorageLayer(layer: IStorageLayer): layer is IWritableStorageLayer {
  return 'writeContent' in layer
    && typeof (layer as IWritableStorageLayer).writeContent === 'function';
}
