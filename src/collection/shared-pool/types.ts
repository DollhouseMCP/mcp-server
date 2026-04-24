/**
 * Shared Pool — Types and Interfaces
 *
 * Defines the data model for the shared public element pool: provenance
 * records, origin classification, and decision types used by the hook
 * points in BaseElementManager.
 *
 * These types are backend-agnostic — both file and DB implementations
 * use the same shapes. The storage format differs; the domain model
 * does not.
 *
 * @module collection/shared-pool/types
 */

/**
 * How a shared-pool element arrived in the deployment.
 *
 * - `collection`: Installed from the upstream DollhouseMCP collection
 *   (or a custom collection URL).
 * - `deployment_seed`: Loaded from the operator's seed directory at
 *   server bootstrap.
 * - `fork`: User-initiated copy of a shared element, created by
 *   fork-on-edit when a user modifies a shared element.
 */
export type SharedPoolOrigin = 'collection' | 'deployment_seed' | 'fork';

/**
 * Provenance record for a shared-pool element.
 *
 * Stored in `element_provenance` (DB mode) or
 * `shared/.provenance/<name>.json` (file mode). The canonical identity
 * within a deployment is `(origin, sourceUrl, sourceVersion)`.
 *
 * User-created-from-scratch elements have NO provenance record — its
 * presence is what distinguishes shared-pool content from regular
 * user content.
 */
export interface ProvenanceRecord {
  /** UUID of the element this record describes. In file mode, the
   *  relative path under `shared/` (e.g. `personas/code-reviewer.md`). */
  elementId: string;

  /** How this element entered the shared pool. */
  origin: SharedPoolOrigin;

  /** Canonical source location (e.g. `github://DollhouseMCP/collection/library/personas/...`).
   *  Null for deployment seeds loaded from local files when no URL applies. */
  sourceUrl: string | null;

  /** Version tag from the collection index, semver, or commit hash.
   *  Null when the source has no versioning scheme. */
  sourceVersion: string | null;

  /** SHA-256 hex digest of the raw content at install time. */
  contentHash: string;

  /** For forks: the element ID (DB) or path (file) of the shared
   *  original this was forked from. Null for non-fork origins. */
  forkedFrom: string | null;

  /** ISO-8601 timestamp of when this provenance record was created. */
  installedAt: string;
}

/**
 * Result of a provenance lookup against the canonical identity tuple.
 */
export type ProvenanceLookupResult =
  | { status: 'match'; record: ProvenanceRecord }
  | { status: 'hash_mismatch'; record: ProvenanceRecord; actualHash: string }
  | { status: 'not_found' };

/**
 * Metadata supplied when installing content into the shared pool.
 */
export interface SharedPoolInstallRequest {
  /** Raw element content (markdown/YAML frontmatter). */
  content: string;

  /** Parsed element type. */
  elementType: string;

  /** Element name (derived from filename or frontmatter). */
  name: string;

  /** Origin classification. */
  origin: SharedPoolOrigin;

  /** Source URL for collection installs; file:// URI for seeds. */
  sourceUrl: string | null;

  /** Version from collection index or seed frontmatter. */
  sourceVersion: string | null;
}

/**
 * Result returned by SharedPoolInstaller after a write attempt.
 *
 * Discriminated union on `action` — `reason` is required for
 * `skipped` and `rejected` outcomes so callers always have an
 * explanation for non-install results.
 */
export type SharedPoolInstallResult =
  | {
      action: 'installed';
      elementId: string;
      provenance: ProvenanceRecord;
    }
  | {
      action: 'skipped';
      elementId: string;
      provenance: ProvenanceRecord;
      reason: string;
    }
  | {
      action: 'rejected';
      elementId: string;
      provenance: ProvenanceRecord;
      reason: string;
    };

// ---------------------------------------------------------------------------
// Hook decision types — used by BaseElementManager extension points
// ---------------------------------------------------------------------------

/**
 * Returned by a preEdit hook to redirect the edit to a different target.
 * When non-null, the edit flow operates on the redirected element instead
 * of the original.
 */
export interface EditRedirect {
  /** The forked element to apply the edit to. */
  forkedElementId: string;

  /** Path or UUID of the fork target (for cache/event purposes). */
  forkedPath: string;
}

/**
 * Returned by a preWrite hook to override the default write destination.
 * When non-null, save() uses the redirected path/target instead of the
 * caller-supplied one.
 */
export interface WriteRedirect {
  /** Overridden write target (absolute path or element UUID). */
  targetPath: string;

  /** When true, the write should go through the admin-elevated path
   *  (SYSTEM ownership in DB, shared/ directory in file mode). */
  adminElevated: boolean;
}
