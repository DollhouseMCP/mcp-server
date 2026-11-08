/**
 * Abstract Database Storage Layer
 *
 * Shared base class for DatabaseStorageLayer and DatabaseMemoryStorageLayer.
 * Provides the IStorageLayer implementation (scan, index management,
 * readContent) and common infrastructure. Subclasses implement
 * writeContent and deleteContent for their specific element types.
 *
 * All queries are RLS-scoped via withUserContext/withUserRead.
 *
 * @since v2.2.0 — Phase 4, Step 4.3
 */

import { eq, and, or, gt, inArray, sql } from 'drizzle-orm';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { DatabaseInstance } from '../database/connection.js';
import { withUserRead } from '../database/rls.js';
import { elements, elementTags } from '../database/schema/elements.js';
import type { UserIdResolver } from '../database/UserContext.js';
import { isSerializationFailure, type DrizzleTx } from '../database/db-utils.js';
import type { ElementIndexEntry, ManifestDiffResult } from './types.js';
import {
  firstIndexedPath,
  type CollectionChangeObservation,
  type DatabaseStorageIdentity,
  type IndexedPathResult,
  type IWritableStorageLayer,
  type ElementWriteMetadata,
  type NamedCandidate,
  type StorageCacheVersion,
  type StorageScanOptions,
  type StorageReference,
  type WriteContentOptions,
  type FreshCollectionSnapshot,
} from './IStorageLayer.js';
import { ELEMENT_FILE_EXTENSIONS, databaseNameCandidates, foldedNameKey, namedCandidateTier, resolveNamedCandidateAmong, slugNameKey } from './ElementNameKeys.js';

/**
 * Canonical key for case/format-insensitive name resolution: lowercase, with
 * runs of whitespace/underscores collapsed to a single hyphen and surrounding
 * hyphens trimmed. Mirrors the filename-stem form the web-console addresses
 * elements by, so a stem ("meeting-notes") resolves a raw name ("Meeting-Notes").
 */
function canonicalNameKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_]+/gu, '-')
    .replaceAll(/-+/gu, '-')
    .replaceAll(/^-|-$/gu, '');
}

const DATABASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** A row is addressed by its id: any other reference can name no row (proven absence), never a query error. */
function assertRowReference(reference: string): void {
  if (!DATABASE_UUID_PATTERN.test(reference)) {
    throw Object.assign(new Error(`Element not found: ${reference}`), { code: 'ENOENT' });
  }
}

const SERIALIZABLE_DELETE_ATTEMPTS = 3;
const MAX_INDEX_STATES = 256;

interface DatabaseIndexState {
  nameToIdMap: Map<string, string>;
  idToNameMap: Map<string, string>;
  /** Indexed names by their selection keys, kept beside nameToIdMap so a lookup reads only its candidates. */
  namesByFolded: Map<string, Set<string>>;
  namesBySlug: Map<string, Set<string>>;
  /** Indexed names by the owner hint's canonical key (getPathByName). */
  namesByHintKey: Map<string, Set<string>>;
  /** Insertion order of each indexed name, so candidates keep the index order. */
  nameOrder: Map<string, number>;
  nextNameOrder: number;
  lastScanTimestamp: Date | null;
  scanCompleted: boolean;
  activeOperations: number;
}

// ── Implementation ──────────────────────────────────────────────────

export abstract class AbstractDatabaseStorageLayer implements IWritableStorageLayer {
  protected readonly db: DatabaseInstance;
  protected readonly elementType: string;
  /**
   * Lazily-resolved current-user UUID. Called once per DB operation — reads from
   * ContextTracker's AsyncLocalStorage in production. See UserContext.ts.
   */
  protected readonly getCurrentUserId: UserIdResolver;

  /** Per-user index state for this element-type storage singleton. */
  private readonly indexStates = new Map<string, DatabaseIndexState>();

  constructor(db: DatabaseInstance, getCurrentUserId: UserIdResolver, elementType: string) {
    this.db = db;
    this.getCurrentUserId = getCurrentUserId;
    this.elementType = elementType;
  }

  /**
   * Convenience getter — resolves the current userId from the active session
   * context. Throws when called outside any ContextTracker scope (per-call
   * validation in `createUserIdResolver`).
   */
  protected get userId(): string {
    return this.getCurrentUserId();
  }

  // ── IStorageLayer ─────────────────────────────────────────────────

  scan(_options?: StorageScanOptions): Promise<ManifestDiffResult> {
    return this.scanRows(false);
  }

  /**
   * One index scan. `full` reads every row even with a warm watermark, so removals are seen. Every
   * known row a scan returns is reported modified: no updated_at or clock decides that a row is
   * unchanged (the watermark only narrows the incremental scan's query).
   */
  private async scanRows(full: boolean): Promise<ManifestDiffResult> {
    const userId = this.userId;
    const state = this.acquireState(userId);
    const result: ManifestDiffResult = {
      added: [],
      modified: [],
      removed: [],
      unchanged: [],
    };

    // Bind the timestamp locally so the incremental branch narrows it to a
    // non-null Date (the boolean alone can't carry that narrowing across the
    // closure, which previously forced a non-null assertion).
    const lastScan = state.lastScanTimestamp;
    const isFullScan = full || !lastScan;

    // Explicit userId in all queries for defense-in-depth (alongside RLS)
    // and to enable composite index utilization on idx_elements_scan/idx_elements_user_type.
    try {
      const rows = await withUserRead(this.db, userId, async (tx) => {
        if (!isFullScan && lastScan) {
          return tx
            .select({ id: elements.id, name: elements.name, updatedAt: elements.updatedAt })
            .from(elements)
            .where(and(
              eq(elements.userId, userId),
              eq(elements.elementType, this.elementType),
              gt(elements.updatedAt, lastScan),
            ));
        }
        return tx
          .select({ id: elements.id, name: elements.name, updatedAt: elements.updatedAt })
          .from(elements)
          .where(and(
            eq(elements.userId, userId),
            eq(elements.elementType, this.elementType),
          ));
      });

      if (state.scanCompleted) {
        this.processSubsequentScanRows(state, rows, result, isFullScan);
      } else {
        this.processFirstScanRows(state, rows, result);
      }

      state.lastScanTimestamp = new Date();
      state.scanCompleted = true;

      return result;
    } catch (cause) {
      state.lastScanTimestamp = null;
      throw cause;
    } finally {
      this.releaseState(state);
    }
  }

  private processSubsequentScanRows(
    state: DatabaseIndexState,
    rows: Array<{ id: string; name: string; updatedAt: Date }>,
    result: ManifestDiffResult,
    isFullScan: boolean,
  ): void {
    const seenIds = new Set<string>();
    // Every row is classified against the live index before any row is applied, so applying one
    // (a rename that takes another row's old name) never makes a known row look new; the cost is
    // O(rows), not a copy of the index.
    for (const row of rows) {
      if (state.idToNameMap.has(row.id) || state.nameToIdMap.has(row.name)) {
        result.modified.push(row.id);
      } else {
        result.added.push(row.id);
      }
    }
    for (const row of rows) {
      seenIds.add(row.id);
      this.setIndexForState(state, row.name, row.id);
    }

    if (isFullScan) {
      for (const [name, id] of state.nameToIdMap.entries()) {
        if (!seenIds.has(id)) {
          result.removed.push(id);
          this.removeIndexForState(state, name);
        }
      }
    }
  }

  private processFirstScanRows(
    state: DatabaseIndexState,
    rows: Array<{ id: string; name: string; updatedAt: Date }>,
    result: ManifestDiffResult,
  ): void {
    for (const row of rows) {
      this.setIndexForState(state, row.name, row.id);
      result.added.push(row.id);
    }
  }

  async listSummaries(options?: { includePublic?: boolean }): Promise<ElementIndexEntry[]> {
    const userId = this.userId;
    if (!this.getState(userId).scanCompleted) {
      await this.scan();
    }

    // includePublic expands the owner filter to also match any row with
    // visibility='public'. RLS's elements_select policy already permits the
    // caller to read public rows owned by other users (migration 0005), so
    // the database will happily return them once the predicate lets them
    // through. Default (flag off) keeps the query per-user-scoped, preserving
    // today's discovery surface.
    const ownerPredicate = options?.includePublic
      ? or(eq(elements.userId, userId), eq(elements.visibility, 'public'))
      : eq(elements.userId, userId);

    return withUserRead(this.db, userId, async (tx) => {
      const rows = await tx
        .select({
          id: elements.id,
          name: elements.name,
          description: elements.description,
          version: elements.version,
          author: elements.author,
          updatedAt: elements.updatedAt,
          byteSize: elements.byteSize,
          autoLoad: elements.autoLoad,
          priority: elements.priority,
          memoryType: elements.memoryType,
          userId: elements.userId,
        })
        .from(elements)
        .where(and(
          ownerPredicate,
          eq(elements.elementType, this.elementType),
        ));

      // Batch-load tags for all elements. When includePublic is set, pass a
      // hint so foreign (cross-user public) IDs go through a separate loader
      // that honors element_tags RLS — which is strict owner-only and would
      // otherwise silently return empty tag arrays for public rows authored
      // by other users.
      const tagsByElementId = await this.batchLoadTags(tx, rows.map(r => r.id));

      return this.mapRowsToSummaries(rows, tagsByElementId, tx);
    });
  }

  async getIndexedPaths(): Promise<string[]> {
    const state = this.getState();
    if (!state.scanCompleted) {
      await this.scan();
    }
    return Array.from(state.nameToIdMap.values());
  }

  readIndexedPath(names: readonly string[], options: { candidates?: boolean } = {}): Promise<IndexedPathResult> {
    const state = this.getState();
    // Every row a name could select is a candidate; a collision is the selector's ambiguity, never
    // absence. Preferred names are alternatives: the first name with any candidate answers.
    let candidates: NamedCandidate[] = [];
    for (const identifier of options.candidates === false ? [] : names) {
      // Every row any of the text's names could select, ranked together by the caller's selector.
      const offered = new Map(this.callerNames(identifier).flatMap(name => this.candidatesIn(state, name))
        .map(candidate => [candidate.reference, candidate]));
      candidates = [...offered.values()];
      if (candidates.length) break;
    }
    return Promise.resolve({
      path: firstIndexedPath(names, name => this.getPathByNameInState(state, name)),
      indexComplete: state.scanCompleted,
      authoritative: state.scanCompleted && state.lastScanTimestamp !== null,
      unindexed: [],
      failures: new Map(),
      candidates,
    });
  }

  /** The rows one identifier could select, read from the precomputed key maps, never the whole index. */
  private candidatesIn(state: DatabaseIndexState, identifier: string): NamedCandidate[] {
    const names = new Set<string>([...state.namesByFolded.get(foldedNameKey(identifier)) ?? [],
      ...state.namesBySlug.get(slugNameKey(identifier)) ?? []]);
    const exact = state.idToNameMap.get(identifier);
    if (exact !== undefined) names.add(exact);
    return [...names]
      .sort((left, right) => (state.nameOrder.get(left) ?? 0) - (state.nameOrder.get(right) ?? 0))
      .flatMap(name => {
        const id = state.nameToIdMap.get(name);
        return id !== undefined && namedCandidateTier(identifier, { reference: id, name }) !== undefined ? [{ reference: id, name }] : [];
      });
  }

  /** Rows are read from the database now; a row is never unreadable at the inventory level. */
  async readFreshCollection(_options?: { preserveDuplicates?: boolean }): Promise<FreshCollectionSnapshot> {
    return { entries: await this.listSummaries({ includePublic: false }), unindexed: new Map() };
  }

  /**
   * The index's freshness without the summary query. The incremental (updated_at) scan cannot see
   * a row another process deleted, so a refresh runs the full id scan: one query that reports
   * removed rows, so their cached instances are evicted and an active reference to one fails closed.
   * Every known row is reported modified, so every cached instance of the type is evicted before
   * each policy check.
   */
  refreshCollection(_options?: StorageScanOptions): Promise<ManifestDiffResult> {
    return this.scanRows(true);
  }

  async readCollection(options?: { includePublic?: boolean }) {
    const diff = await this.scan();
    const entries = await this.listSummaries(options);
    return { entries, unindexed: new Map(), authoritative: true, complete: true, includesPublic: true, diff };
  }

  getPathByName(name: string): string | undefined {
    return this.getPathByNameInState(this.getState(), name);
  }

  /** O(1) hint: an exact row, else the one canonical row. PostgreSQL's unique index permits
   * case/canonical variants (`Agent_Name` and `agent-name`), and a hint cannot choose between
   * them; readIndexedPath exposes both as candidates and the resolver's selector refuses the name. */
  private getPathByNameInState(state: DatabaseIndexState, name: string): string | undefined {
    const direct = state.nameToIdMap.get(name);
    if (direct !== undefined) return direct;
    let match: string | undefined;
    for (const key of state.namesByHintKey.get(canonicalNameKey(name)) ?? []) {
      const id = state.nameToIdMap.get(key);
      if (match !== undefined && match !== id) {
        return undefined;
      }
      match = id;
    }
    return match;
  }

  /**
   * Reverse lookup: get element name by UUID.
   * Used by BaseElementManager.delete() to resolve name from path in DB mode.
   */
  getNameById(id: string): string | undefined {
    return this.getState().idToNameMap.get(id);
  }

  hasCompletedScan(): boolean {
    return this.getState().scanCompleted;
  }

  async notifySaved(): Promise<void> {
    // No-op in database mode — writeContent() handles persistence and index update.
  }

  notifyDeleted(): void {
    // No-op in database mode — deleteContent() handles removal and index update.
  }

  invalidate(): void {
    this.getState().lastScanTimestamp = null;
  }

  clear(): void {
    // Lifecycle-level cache flush: one database storage singleton serves many
    // users, so manager clear/dispose intentionally discards every tenant's
    // derived index state. Persisted rows are never affected.
    this.indexStates.clear();
  }

  // ── IWritableStorageLayer (abstract — subclasses implement) ───────

  abstract writeContent(
    elementType: string,
    name: string,
    content: string,
    metadata: ElementWriteMetadata,
    options?: WriteContentOptions,
  ): Promise<string>;

  abstract deleteContent(elementType: string, name: string): Promise<void>;

  /** Memory-specific dormant enforcement; generic element persistence is unchanged. */
  protected beforeLegacyIdentityDelete(_tx: DrizzleTx, _userId: string, _elementType: string): void | Promise<void> { return; }
  protected afterLegacyIdentityDelete(_userId: string): void { return; }
  protected observeLegacyIdentityDeleteFailure(): void { return; }

  private notifyLegacyIdentityDeleteFailure(): void {
    try { this.observeLegacyIdentityDeleteFailure(); } catch { /* Observers cannot replace storage causes. */ }
  }

  async deleteContentByIdentity(
    elementType: string,
    identifier: string,
    expectedIdentity?: DatabaseStorageIdentity,
  ): Promise<DatabaseStorageIdentity> {
    const userId = this.userId;
    let attempt = 0;
    while (attempt < SERIALIZABLE_DELETE_ATTEMPTS) {
      attempt += 1;
      try {
        const deleted = await this.db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
          await this.beforeLegacyIdentityDelete(tx, userId, elementType);
          const identity = await this.resolveIdentityInTransaction(tx, userId, elementType, identifier);
          if (!identity) throw this.createNotFoundError(elementType, identifier);
          if (expectedIdentity !== undefined && (
            identity.id !== expectedIdentity.id || identity.name !== expectedIdentity.name
          )) {
            const error = new Error(
              `Element not found or identity changed during deletion: ${identifier}`,
            ) as NodeJS.ErrnoException;
            error.code = 'ESTALE';
            throw error;
          }

          const rows = await tx
            .delete(elements)
            .where(and(
              eq(elements.userId, userId),
              eq(elements.elementType, elementType),
              eq(elements.id, identity.id),
            ))
            .returning({ id: elements.id });
          if (rows.length !== 1) throw this.createNotFoundError(elementType, identifier);
          this.afterLegacyIdentityDelete(userId);
          return identity;
        }, { isolationLevel: 'serializable' });

        this.removeIndexById(deleted.id, userId);
        this.logPersistEvent(
          'ELEMENT_DELETED',
          'MEDIUM',
          `${this.constructor.name}.deleteContentByIdentity`,
          `Element deleted from database: ${elementType}/${deleted.name}`,
          { elementId: deleted.id, elementType, name: deleted.name },
        );
        return deleted;
      } catch (error) {
        if (!isSerializationFailure(error)) {
          this.notifyLegacyIdentityDeleteFailure();
          throw error;
        }
        if (attempt < SERIALIZABLE_DELETE_ATTEMPTS) continue;
        const retryableError = new Error(
          `Concurrent database update prevented deletion of ${elementType}/${identifier}; retry the operation`,
          { cause: error },
        ) as NodeJS.ErrnoException & { retryable: true };
        retryableError.code = 'EAGAIN';
        retryableError.retryable = true;
        this.notifyLegacyIdentityDeleteFailure();
        throw retryableError;
      }
    }
    throw new Error('Unreachable serialization retry state');
  }

  async resolveContentIdentity(
    elementType: string,
    identifier: string,
  ): Promise<DatabaseStorageIdentity | undefined> {
    const userId = this.userId;
    return withUserRead(this.db, userId, tx =>
      this.resolveIdentityInTransaction(tx, userId, elementType, identifier));
  }

  /**
   * The incremental scan a listing makes (rows written since the last scan), run before a warm miss
   * is answered, so a row another process created is found. Best effort: it can miss a late commit
   * or a delete, so it never certifies absence. The rows it applied are returned for the caller to
   * evict. A cold index is read by the caller's own collection read instead.
   */
  async observeCollectionChange(): Promise<CollectionChangeObservation> {
    const state = this.getState();
    if (!state.scanCompleted || state.lastScanTimestamp === null) return { changed: false };
    const diff = await this.scanRows(false);
    return { changed: diff.added.length > 0 || diff.modified.length > 0, diff };
  }

  /**
   * A caller text names a row as written, and a plain filename ('readme.md') also by its
   * extension-stripped name ('readme'); the shared selector ranks the candidates of both together.
   */
  callerNames(text: string): readonly string[] {
    const extension = ELEMENT_FILE_EXTENSIONS[this.elementType as keyof typeof ELEMENT_FILE_EXTENSIONS] ?? '';
    return databaseNameCandidates(text, extension);
  }

  holdsReference(reference: string): boolean | undefined {
    const state = this.getState();
    if (state.idToNameMap.has(reference)) return true;
    return state.scanCompleted && state.lastScanTimestamp !== null ? false : undefined;
  }

  isExactStorageReference(reference: string, _fileExtension: string): boolean {
    return DATABASE_UUID_PATTERN.test(reference);
  }

  readonly cachedInstanceCurrency = 'unverifiable' as const;

  /** Another process may have edited or deleted the row; only a read by id answers. */
  isCachedReferenceCurrent(_reference: string, _version: StorageCacheVersion | undefined): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** A row has no cache version: the database never vouches for a cached row. */
  readCacheVersion(_reference: string): Promise<StorageCacheVersion | undefined> {
    return Promise.resolve(undefined);
  }

  /**
   * A caller reference on the database is a row id; any other text is a name, which the manager
   * selects through the shared name rule over its callerNames, exactly as a read
   * of the same text does. Path syntax never reaches here: the shared caller-text classifier
   * refuses it first.
   */
  resolveReference(reference: string): Promise<StorageReference> {
    return Promise.resolve(DATABASE_UUID_PATTERN.test(reference)
      ? { kind: 'identity', storageIdentity: reference, requested: reference }
      : { kind: 'name', name: reference });
  }

  async readContent(relativePath: string): Promise<string> {
    assertRowReference(relativePath);
    const row = await withUserRead(this.db, this.userId, async (tx) => {
      // RLS is authoritative for cross-user visibility: the elements_select
      // policy (migration 0005) returns rows where user_id matches the caller
      // OR visibility = 'public'. Adding an explicit user_id filter here would
      // re-block public reads and defeat the whole point of the policy — so
      // RLS enforces visibility while the element-type predicate confines reads
      // to this typed layer. The primary-key lookup still uses the id index.
      const rows = await tx
        .select({ rawContent: elements.rawContent })
        .from(elements)
        .where(and(eq(elements.id, relativePath), eq(elements.elementType, this.elementType)))
        .limit(1);
      // `.at(0)` (vs `rows[0]`) keeps `undefined` in the type so the
      // not-found guard below stays meaningful without noUncheckedIndexedAccess.
      return rows.at(0) ?? null;
    });

    if (!row) {
      const err = new Error(`Element not found: ${relativePath}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }

    return row.rawContent;
  }

  async readContentForUpdate(relativePath: string): Promise<{
    content: string; identity: DatabaseStorageIdentity; revision: string;
  }> {
    assertRowReference(relativePath);
    const userId = this.userId;
    const rows = await withUserRead(this.db, userId, tx => tx.select({
      id: elements.id, name: elements.name, content: elements.rawContent,
      revision: elements.storageRevision,
    }).from(elements).where(and(eq(elements.id, relativePath),
      eq(elements.userId, userId), eq(elements.elementType, this.elementType))).limit(1));
    const row = rows[0];
    if (!row) throw Object.assign(new Error('Update target not found'), { code: 'ENOENT' });
    return { content: row.content, identity: { id: row.id, name: row.name }, revision: row.revision.toString() };
  }

  // ── Protected helpers for subclasses ──────────────────────────────

  /**
   * Resolve a mutation target inside its transaction with the one name rule every read uses: the
   * shared selector runs over the caller's rows of this type (a row id is its exact reference,
   * tier 0), and a same-tier collision is ambiguity (EAMBIGUOUS, naming the competing rows),
   * never an arbitrary row. The rows are fetched whole: no SQL filter is byte-identical to the
   * folded and slug keys, and the set is one user's rows of one type, which the scan reads anyway.
   */
  protected async resolveIdentityInTransaction(
    tx: DrizzleTx,
    userId: string,
    elementType: string,
    identifier: string,
  ): Promise<DatabaseStorageIdentity | undefined> {
    const rows = await tx
      .select({ id: elements.id, name: elements.name })
      .from(elements)
      .where(and(eq(elements.userId, userId), eq(elements.elementType, elementType)));
    const { selected, competitors } = resolveNamedCandidateAmong(this.callerNames(identifier),
      rows.map(row => ({ reference: row.id, name: row.name })));
    if (competitors.length) {
      const ids = competitors.map(candidate => candidate.reference);
      const error = new Error(`Ambiguous element identity: ${identifier} (rows ${ids.join(', ')})`) as NodeJS.ErrnoException & { competitors: string[] };
      error.code = 'EAMBIGUOUS';
      error.competitors = ids;
      throw error;
    }
    return selected ? { id: selected.reference, name: selected.name } : undefined;
  }

  /** Update both forward and reverse index maps. */
  protected setIndex(name: string, id: string, userId = this.userId): void {
    this.setIndexForState(this.getState(userId), name, id);
  }

  private setIndexForState(state: DatabaseIndexState, name: string, id: string): void {
    // Remove old reverse mapping if name changed
    const oldId = state.nameToIdMap.get(name);
    if (oldId && oldId !== id) {
      state.idToNameMap.delete(oldId);
    }
    // A renamed row no longer holds its previous name, in any name or key map.
    const previousName = state.idToNameMap.get(id);
    if (previousName !== undefined && previousName !== name && state.nameToIdMap.get(previousName) === id) {
      this.unindexName(state, previousName);
    }
    if (!state.nameToIdMap.has(name)) this.indexNameKeys(state, name);
    state.nameToIdMap.set(name, id);
    state.idToNameMap.set(id, name);
  }

  private indexNameKeys(state: DatabaseIndexState, name: string): void {
    state.nameOrder.set(name, state.nextNameOrder++);
    for (const [keys, key] of this.nameKeyIndexes(state, name)) {
      if (key === '') continue;
      const names = keys.get(key) ?? new Set<string>();
      names.add(name);
      keys.set(key, names);
    }
  }

  private nameKeyIndexes(state: DatabaseIndexState, name: string): ReadonlyArray<readonly [Map<string, Set<string>>, string]> {
    return [[state.namesByFolded, foldedNameKey(name)], [state.namesBySlug, slugNameKey(name)], [state.namesByHintKey, canonicalNameKey(name)]];
  }

  private unindexName(state: DatabaseIndexState, name: string): void {
    if (!state.nameToIdMap.delete(name)) return;
    state.nameOrder.delete(name);
    for (const [keys, key] of this.nameKeyIndexes(state, name)) {
      const names = keys.get(key);
      names?.delete(name);
      if (names?.size === 0) keys.delete(key);
    }
  }

  /** Remove from both forward and reverse index maps. */
  protected removeIndex(name: string): void {
    this.removeIndexForState(this.getState(), name);
  }

  private removeIndexForState(state: DatabaseIndexState, name: string): void {
    const id = state.nameToIdMap.get(name);
    if (id) state.idToNameMap.delete(id);
    this.unindexName(state, name);
  }

  /** Remove from index by ID (reverse lookup). */
  protected removeIndexById(id: string, userId = this.userId): void {
    const state = this.getState(userId);
    const name = state.idToNameMap.get(id);
    if (name) this.unindexName(state, name);
    state.idToNameMap.delete(id);
  }

  private getState(userId = this.userId): DatabaseIndexState {
    let state = this.indexStates.get(userId);
    if (!state) {
      state = {
        nameToIdMap: new Map<string, string>(),
        idToNameMap: new Map<string, string>(),
        namesByFolded: new Map<string, Set<string>>(),
        namesBySlug: new Map<string, Set<string>>(),
        namesByHintKey: new Map<string, Set<string>>(),
        nameOrder: new Map<string, number>(),
        nextNameOrder: 0,
        lastScanTimestamp: null,
        scanCompleted: false,
        activeOperations: 0,
      };
      this.indexStates.set(userId, state);
    } else {
      // Map insertion order is the LRU order: oldest first.
      this.indexStates.delete(userId);
      this.indexStates.set(userId, state);
    }
    this.pruneIndexStates(userId);
    return state;
  }

  private acquireState(userId: string): DatabaseIndexState {
    const state = this.getState(userId);
    state.activeOperations += 1;
    this.pruneIndexStates(userId);
    return state;
  }

  private releaseState(state: DatabaseIndexState): void {
    state.activeOperations = Math.max(0, state.activeOperations - 1);
    this.pruneIndexStates();
  }

  private pruneIndexStates(protectedUserId?: string): void {
    while (this.indexStates.size > MAX_INDEX_STATES) {
      let evicted = false;
      for (const [userId, state] of this.indexStates) {
        if (userId === protectedUserId || state.activeOperations > 0) continue;
        // The four index fields live in this single state object, so deleting
        // the entry drops them atomically.
        this.indexStates.delete(userId);
        evicted = true;
        break;
      }
      if (!evicted) break;
    }
  }

  private createNotFoundError(elementType: string, identifier: string): NodeJS.ErrnoException {
    const error = new Error(`Element not found: ${elementType}/${identifier}`) as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    return error;
  }

  /**
   * Batch-load tags for a set of element IDs within an existing transaction.
   *
   * CONTRACT: callers MUST invoke inside a `withUserRead` /
   * `withUserContext` block. There is no defense-in-depth `user_id = :me`
   * filter here — RLS on `element_tags` (migrations 0004 + 0006) is the sole
   * visibility gate. The filter was removed in Phase 4.4 Piece 2 so tags
   * attached to cross-user public elements come through when discovery is
   * requested; re-adding it would silently strip those tags and regress
   * include_public behavior. Without an active user context, the RLS
   * predicate fails closed (missing `app.current_user_id` → NULL → no rows
   * match owner branch, only public-attached rows match the EXISTS branch).
   */
  protected async batchLoadTags(
    tx: DrizzleTx,
    elementIds: string[],
  ): Promise<Map<string, string[]>> {
    const tagsByElementId = new Map<string, string[]>();
    if (elementIds.length === 0) return tagsByElementId;

    const tagRows = await tx
      .select({ elementId: elementTags.elementId, tag: elementTags.tag })
      .from(elementTags)
      .where(inArray(elementTags.elementId, elementIds));

    for (const t of tagRows) {
      const existing = tagsByElementId.get(t.elementId) ?? [];
      existing.push(t.tag);
      tagsByElementId.set(t.elementId, existing);
    }

    return tagsByElementId;
  }

  /** Replace tags atomically within a transaction. */
  protected async replaceTags(
    tx: DrizzleTx,
    elementId: string,
    tags: string[],
    userId = this.userId,
  ): Promise<void> {
    await tx.delete(elementTags).where(eq(elementTags.elementId, elementId));
    if (tags.length > 0) {
      await tx.insert(elementTags).values(
        tags.map(tag => ({ elementId, userId, tag })),
      );
    }
  }

  /**
   * Map DB rows to ElementIndexEntry[].
   * Subclasses can override to add extra fields (e.g., totalEntries for memories).
   */
  protected mapRowsToSummaries(
    rows: Array<{
      id: string;
      name: string;
      description: string | null;
      version: string | null;
      author: string | null;
      updatedAt: Date;
      byteSize: number;
      autoLoad: boolean | null;
      priority: number | null;
      memoryType: string | null;
      userId?: string;
    }>,
    tagsByElementId: Map<string, string[]>,
    _tx: DrizzleTx,
  ): ElementIndexEntry[] | Promise<ElementIndexEntry[]> {
    return rows.map((row): ElementIndexEntry => ({
      filePath: row.id,
      name: row.name,
      description: row.description ?? '',
      version: row.version ?? '1.0.0',
      author: row.author ?? '',
      tags: tagsByElementId.get(row.id) ?? [],
      mtimeMs: row.updatedAt.getTime(),
      sizeBytes: row.byteSize,
      autoLoad: row.autoLoad ?? undefined,
      priority: row.priority ?? undefined,
      memoryType: row.memoryType ?? undefined,
      userId: row.userId,
    }));
  }

  /** Log a security event for element persistence. */
  protected logPersistEvent(
    type: 'ELEMENT_EDITED' | 'ELEMENT_DELETED',
    severity: 'LOW' | 'MEDIUM',
    source: string,
    details: string,
    additionalData: Record<string, unknown>,
  ): void {
    SecurityMonitor.logSecurityEvent({ type, severity, source, details, additionalData });
  }
}
