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
import type { NamedCandidate } from './ElementNameKeys.js';

export type { NamedCandidate } from './ElementNameKeys.js';

export type StorageReference =
  | { kind: 'identity'; storageIdentity: string; requested: string }
  | { kind: 'name'; name: string };

/** A per-file failure retained without losing its diagnostic identity. */
export interface UnindexedEntry {
  reason: string;
  /** Last known indexed name; absent when the record has never been parsed. */
  elementName?: string;
  /** Names this record could hold, including retained and filename-derived evidence. */
  candidateNames: readonly string[];
  /** Its current identity cannot support an absence answer. */
  unattributed: boolean;
  /**
   * The layer's verdict that this record may stand in for a listed name, so a survivor it could
   * hold is not shown as current. Set on collection snapshots by the layer that owns the naming
   * rule; absent means it may (the conservative reading).
   */
  shadowsSurvivors?: boolean;
  code?: string;
  name: string;
  /** Process-local proof that unchanged bytes will be refused again. */
  contentRejected?: true;
}

/** A stored file's observed (mtime, size): the version a cached instance was built from. */
export interface StorageCacheVersion {
  mtimeMs: number;
  sizeBytes: number;
}

export interface StorageScanOptions {
  /**
   * If this call joins an already-running scan, perform one serialized
   * trailing scan before returning. This is used by freshness-critical reads
   * so a change made after the joined scan began cannot be hidden by cooldown.
   */
  freshAfterInFlight?: boolean;
}

/** First matching name, preserving caller preference and short-circuit behavior. */
export function firstIndexedPath(names: readonly string[], lookup: (name: string) => string | undefined): string | undefined {
  for (const name of names) {
    const found = lookup(name);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Lookup, candidate and completion evidence from the same captured index state. */
export interface IndexedPathResult {
  /** O(1) owner hint for the first matching name; it never certifies presence, absence or uniqueness. */
  path: string | undefined;
  /** A scan has completed historically; warm file lookups must not consume new diffs. */
  indexComplete: boolean;
  /** The completed index has not been invalidated; a miss can skip the list fallback. */
  authoritative: boolean;
  /** Paths whose metadata could not be read during the completed scan. */
  unindexed: readonly string[];
  /** Failure details from the same captured state, for actionable read refusals. */
  failures: ReadonlyMap<string, UnindexedEntry>;
  /**
   * Every healthy entry the requested names could be selected from, with the layer's own
   * ownership rule already applied: element files offer every indexed entry whose reference,
   * folded metadata name or metadata slug matches; memories offer only the newest owner of each
   * name, exactly as their collection snapshot does; database rows offer every row matching the
   * exact or folded name. The caller's shared selector decides among them, on the warm path with
   * the same rule it applies to a collection snapshot, so one name has one answer on every path.
   */
  candidates: readonly NamedCandidate[];
}

/** What observeCollectionChange saw: whether the collection differs from the index, and any rows it applied. */
export interface CollectionChangeObservation {
  changed: boolean;
  diff?: ManifestDiffResult;
}

/** How a storage layer's cached instances are known to be current (IStorageLayer.cachedInstanceCurrency). */
export type CachedInstanceCurrency = 'currency-check' | 'unverifiable';

export interface IStorageLayer {
  /** Capture collection contents and completeness from one storage scan. */
  readCollection(options?: { includePublic?: boolean }): Promise<StorageCollectionSnapshot>;
  /**
   * Scan the filesystem for changes relative to the last snapshot.
   * Implementations should enforce cooldown and deduplicate concurrent calls.
   * File paths retained as unindexed report modified on each retry or repair,
   * even if an earlier reader discarded a diff. Only previously unseen paths
   * report added; disappearance of an unindexed path is not an indexed removal.
   */
  scan(options?: StorageScanOptions): Promise<ManifestDiffResult>;

  /**
   * The collection-read freshness without returning entries: the changes since the last
   * observation, so a caller can evict stale cached instances. The file layer applies the same
   * membership and scan rule as readCollection; the database layer runs its full id scan, which
   * also sees rows another process deleted.
   */
  refreshCollection(options?: StorageScanOptions): Promise<ManifestDiffResult>;

  /**
   * Trigger scan and return all indexed entries.
   *
   * @param options.includePublic - When true, the returned set also includes
   *   elements owned by other users that have visibility='public'. When false
   *   (default), results are scoped to the current user. Implementations that
   *   don't support public content (e.g. legacy file-mode layouts with no
   *   shared directory) ignore the flag and return only own content.
   * preserveDuplicates keeps every locator instead of normal name deduplication.
   * freshMetadata rereads current file names without relying on cached mtimes;
   * discovery/read failures refuse. Database implementations already query fresh rows.
   * These summaries discover locators, not atomic ownership or write authority.
   */
  listSummaries(options?: { includePublic?: boolean; preserveDuplicates?: boolean; freshMetadata?: boolean }): Promise<ElementIndexEntry[]>;

  /**
   * A fresh inventory read from storage now (not the index), as a typed snapshot: every readable
   * entry, and every file that could not be read with its evidence. Per-file failures never throw;
   * only a failure to inventory the collection itself does. `preserveDuplicates` keeps entries that
   * share a name instead of only their owners.
   */
  readFreshCollection(options?: { preserveDuplicates?: boolean }): Promise<FreshCollectionSnapshot>;

  /**
   * Trigger scan and return all indexed file paths.
   */
  getIndexedPaths(): Promise<string[]>;

  /**
   * O(1) name-to-path hint from the index. Does not trigger a scan and never certifies presence,
   * absence or uniqueness: callers that answer a name lookup select from readIndexedPath candidates.
   */
  getPathByName(name: string): string | undefined;

  /**
   * Read without scanning; preserve cold resolver fallbacks and pending invalidations. The
   * result carries the healthy candidates for the names so the caller selects on the warm path.
   * An exact-reference read passes `candidates: false`: it selects nothing by name, so none are computed.
   */
  readIndexedPath(names: readonly string[], options?: { candidates?: boolean }): Promise<IndexedPathResult>;

  /**
   * Raw definition bytes of one storage reference (a relative file path or a database identifier),
   * read under the same reference policy the scan applies, so a reference the index refuses is
   * never served. ENOENT means proven absence; every other failure propagates typed.
   */
  readContent(reference: string): Promise<string>;

  /** Syntax qualification only; the manager still validates and reads this exact reference. */
  isExactStorageReference(reference: string, fileExtension: string): boolean;

  /**
   * The names one caller text addresses in this layer, ranked together by the shared selector
   * (resolveNamedCandidateAmong): the text as written, then any the layer adds. The database adds a
   * plain filename's extension-stripped name ('readme.md' also names 'readme'). A layer without
   * one addresses only the text.
   */
  callerNames?(text: string): readonly string[];

  /**
   * How a cached instance is known to be current, read by the element loader for every consumer:
   * - 'currency-check': isCachedReferenceCurrent vouches (the file layer: a file's size and mtime).
   *   A cached instance is served, by a load or a lookup by storage reference alike, only while it
   *   vouches; otherwise the definition is read.
   * - 'unverifiable': nothing can vouch (the database: a row is current only as read). A load always
   *   reads; a lookup by exact storage reference keeps the instance it resolved (a row id names one
   *   row, and enforcement refreshes through scanAndEvict), as beta did.
   */
  readonly cachedInstanceCurrency: CachedInstanceCurrency;

  /**
   * A best-effort observation of the collection before a name lookup is answered absent, as a
   * listing would have made: `changed` when it saw the collection differ from the index, so the
   * lookup certifies once more from a fresh read; `diff`, when it applied rows to the index, for the
   * caller to evict through the one eviction rule. It never certifies absence: an incremental
   * (updated_at) observation can miss a late commit or a delete, and is never a correctness cursor.
   * A layer without one answers misses from its index.
   */
  observeCollectionChange?(): Promise<CollectionChangeObservation>;

  /**
   * Whether the layer has a record of this exact reference, of any status: a file it indexed, saw
   * fail or holds for a recheck; a row id it read. False when its index is settled and holds no
   * record of it; undefined while the index is cold or invalidated, when it cannot say.
   */
  holdsReference(reference: string): boolean | undefined;

  /**
   * The version a cached instance is later checked against, observed before its bytes are read:
   * the file's (mtime, size) on the file layer; none on the database, which never vouches.
   */
  readCacheVersion(reference: string): Promise<StorageCacheVersion | undefined>;

  /**
   * Whether a cached instance built at `version` may be served without reading storage again. The
   * file layer vouches only while its record is settled and the file still has that version's size
   * and mtime (one stat, so an edit inside the scan cooldown is read again, whatever a later scan
   * recorded); the database layer cannot observe other processes, so it never vouches for a cached
   * row and the row is read by id again.
   */
  isCachedReferenceCurrent(reference: string, version: StorageCacheVersion | undefined): Promise<boolean>;

  /** Resolve backend-owned aliases without granting names exact-reference repair authority. */
  resolveReference(reference: string): Promise<StorageReference>;

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

  /** Reset all cached and indexed state owned by this storage-layer instance (index, manifest, cooldown). */
  clear(): void;

  /** Release resources at manager shutdown; persist what can be persisted; must not hang. */
  dispose?(): Promise<void>;

  /**
   * Reverse lookup: element ID (UUID in DB mode) → element name.
   * Optional — only implemented by database-backed layers where
   * paths are UUIDs rather than human-readable filenames. File-mode
   * layers return undefined (the name is derivable from the path).
   */
  getNameById?(id: string): string | undefined;
}

/** What a fresh inventory read: the readable entries and each unreadable file's evidence. */
export interface FreshCollectionSnapshot {
  readonly entries: readonly ElementIndexEntry[];
  readonly unindexed: ReadonlyMap<string, UnindexedEntry>;
}

export interface StorageCollectionSnapshot {
  readonly entries: ElementIndexEntry[];
  readonly unindexed: ReadonlyMap<string, UnindexedEntry>;
  readonly complete: boolean;
  /** Collection discovery succeeded independently of individual record failures. */
  readonly authoritative: boolean;
  readonly includesPublic: boolean;
  readonly diff: ManifestDiffResult;
  /**
   * References whose own state is still pending (the layer observed them change and will recheck).
   * When a layer reports it, an exact-reference read refuses only for these, not for the collection.
   */
  readonly unsettled?: ReadonlySet<string>;
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
  /**
   * Optional optimistic identity guard for lifecycle writes. When present,
   * update only this exact database row and fail with ESTALE if it was
   * deleted, renamed, or replaced after the caller validated it.
   */
  expectedIdentity?: DatabaseStorageIdentity;
  /** Same-read monotonic row revision; requires expectedIdentity. */
  expectedStorageRevision?: string;
}

/** Options shared by manager and persister save paths. */
export interface ElementSaveOptions {
  exclusive?: boolean;
  expectedIdentity?: DatabaseStorageIdentity;
  expectedStorageRevision?: string;
  /** Compared under the cooperating process-local element lock before writing. */
  expectedFileSnapshot?: { readonly sha256: string; readonly dev: number; readonly ino: number };
  /**
   * File updates never insert after deletion under the process-local element lock.
   * Alone, existence cannot detect same-path recreation. expectedFileSnapshot
   * additionally protects content and inode identity under the cooperating
   * process-local lock. External file writers are not coordinated.
   */
  updateOnly?: boolean;
}

/** Authoritative database identity for a persisted element row. */
export interface DatabaseStorageIdentity {
  id: string;
  name: string;
}

/**
 * Extended storage layer for database-backed persistence.
 *
 * In file mode, BaseElementManager writes to disk first, then calls
 * notifySaved() to update the storage layer's index. In database mode,
 * there IS no file — the storage layer is the persistence mechanism.
 * IWritableStorageLayer adds writeContent/deleteContent so the manager can
 * delegate persistence directly; readContent is part of the read contract
 * every layer implements.
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
   * Resolve a UUID, exact raw name, or unambiguous canonical name against the
   * current database contents. Unlike the in-memory scan index, this is safe
   * for authorization and other freshness-critical identity decisions.
   */
  resolveContentIdentity(
    elementType: string,
    identifier: string,
  ): Promise<DatabaseStorageIdentity | undefined>;

  /**
   * Re-resolve an identity and delete the resulting UUID in one transaction.
   * `expectedIdentity` binds the mutation to the same row ID and raw name that
   * passed the caller's authorization check. Content changes are outside this
   * identity guard and remain governed by the caller's authorization policy.
   */
  deleteContentByIdentity(
    elementType: string,
    identifier: string,
    expectedIdentity?: DatabaseStorageIdentity,
  ): Promise<DatabaseStorageIdentity>;

  /** Owner-only content, identity and mutation revision from the same SELECT. */
  readContentForUpdate?(relativePath: string): Promise<{
    content: string; identity: DatabaseStorageIdentity; revision: string;
  }>;
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
