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
  /**
   * Owner user ID — populate whenever the storage layer knows it.
   *
   * Today: populated by database-backed storage layers (the row's `user_id`).
   * Undefined in file mode because the current single-user file layout has
   * no per-user axis, BUT consumers must NOT assume "undefined ⇔ file mode."
   * Step 4.5 lands the per-user file layout (`users/<uuid>/portfolio/`) and
   * file-mode storage will populate this field from the path segment at
   * that point. Treat this as "owner identity if the storage layer can
   * tell, otherwise undefined" — backend-agnostic semantically, even if
   * only DB mode supplies it today.
   *
   * BaseElementManager uses this to avoid caching foreign elements in its
   * per-manager LRU when `includePublic` surfaces cross-user public rows.
   */
  userId?: string;
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

type ManifestDiffCategory = keyof ManifestDiffResult;

const DIFF_CATEGORIES: readonly ManifestDiffCategory[] = [
  'added',
  'modified',
  'removed',
  'unchanged',
];

/**
 * Merge two consecutive manifest diffs into one coherent transition.
 *
 * A path appears in exactly one output category. Transitions preserve cache
 * invalidations across a trailing scan: for example, modified -> unchanged
 * remains modified, while removed -> added becomes modified. A transient
 * added -> removed path is reported as removed so any object loaded between
 * the two scans is evicted.
 */
export function mergeManifestDiffResults(
  first: ManifestDiffResult,
  second: ManifestDiffResult,
): ManifestDiffResult {
  const firstCategories = categorizeDiff(first);
  const secondCategories = categorizeDiff(second);
  const orderedPaths = new Set<string>();

  for (const category of DIFF_CATEGORIES) {
    for (const filePath of first[category]) orderedPaths.add(filePath);
  }
  for (const category of DIFF_CATEGORIES) {
    for (const filePath of second[category]) orderedPaths.add(filePath);
  }

  const merged: ManifestDiffResult = { added: [], modified: [], removed: [], unchanged: [] };
  for (const filePath of orderedPaths) {
    const category = mergeDiffCategory(firstCategories.get(filePath), secondCategories.get(filePath));
    if (category) merged[category].push(filePath);
  }
  return merged;
}

function categorizeDiff(diff: ManifestDiffResult): Map<string, ManifestDiffCategory> {
  const categories = new Map<string, ManifestDiffCategory>();
  for (const category of DIFF_CATEGORIES) {
    for (const filePath of diff[category]) categories.set(filePath, category);
  }
  return categories;
}

function mergeDiffCategory(
  first: ManifestDiffCategory | undefined,
  second: ManifestDiffCategory | undefined,
): ManifestDiffCategory | undefined {
  if (!first) return second;
  if (!second) return first;

  if (second === 'removed') return 'removed';
  if (first === 'added') return 'added';
  if (first === 'unchanged' && second === 'unchanged') return 'unchanged';
  return 'modified';
}
