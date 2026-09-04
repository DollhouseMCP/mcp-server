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
import type {
  DatabaseStorageIdentity,
  IWritableStorageLayer,
  ElementWriteMetadata,
  StorageScanOptions,
  WriteContentOptions,
} from './IStorageLayer.js';

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
const SERIALIZABLE_DELETE_ATTEMPTS = 3;
const MAX_INDEX_STATES = 256;

interface DatabaseIndexState {
  nameToIdMap: Map<string, string>;
  idToNameMap: Map<string, string>;
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

  async scan(_options?: StorageScanOptions): Promise<ManifestDiffResult> {
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
    const isFullScan = !lastScan;

    // Explicit userId in all queries for defense-in-depth (alongside RLS)
    // and to enable composite index utilization on idx_elements_scan/idx_elements_user_type.
    try {
      const rows = await withUserRead(this.db, userId, async (tx) => {
        if (lastScan) {
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

    for (const row of rows) {
      seenIds.add(row.id);
      if (state.nameToIdMap.has(row.name)) {
        result.modified.push(row.id);
      } else {
        result.added.push(row.id);
      }
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

  getPathByName(name: string): string | undefined {
    const state = this.getState();
    // Preserve exact, case-sensitive row identity first. PostgreSQL's unique
    // index permits case/canonical variants (for example `Agent_Name` and
    // `agent-name`), so a folded lookup must never choose one arbitrarily.
    const direct = state.nameToIdMap.get(name);
    if (direct !== undefined) return direct;
    // The web-console addresses elements by their filename stem (lowercased, with
    // spaces/underscores hyphenated), which won't match a raw mixed-case index
    // key like "Meeting-Notes". Fall back to a canonical comparison so resolve
    // and delete work for any-cased name (only scans on a direct miss).
    const target = canonicalNameKey(name);
    let match: string | undefined;
    for (const [key, id] of state.nameToIdMap) {
      if (canonicalNameKey(key) !== target) continue;
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
        if (!isSerializationFailure(error)) throw error;
        if (attempt < SERIALIZABLE_DELETE_ATTEMPTS) continue;
        const retryableError = new Error(
          `Concurrent database update prevented deletion of ${elementType}/${identifier}; retry the operation`,
          { cause: error },
        ) as NodeJS.ErrnoException & { retryable: true };
        retryableError.code = 'EAGAIN';
        retryableError.retryable = true;
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

  async readContent(relativePath: string): Promise<string> {
    const row = await withUserRead(this.db, this.userId, async (tx) => {
      // RLS is authoritative for cross-user visibility: the elements_select
      // policy (migration 0005) returns rows where user_id matches the caller
      // OR visibility = 'public'. Adding an explicit user_id filter here would
      // re-block public reads and defeat the whole point of the policy — so
      // the only predicate is the primary-key lookup. RLS enforces the
      // visibility rule; the pk lookup stays O(1) via the id index.
      const rows = await tx
        .select({ rawContent: elements.rawContent })
        .from(elements)
        .where(eq(elements.id, relativePath))
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

  // ── Protected helpers for subclasses ──────────────────────────────

  /** Resolve exact identities first, then require a unique canonical match. */
  protected async resolveIdentityInTransaction(
    tx: DrizzleTx,
    userId: string,
    elementType: string,
    identifier: string,
  ): Promise<DatabaseStorageIdentity | undefined> {
    const identifierIsUuid = DATABASE_UUID_PATTERN.test(identifier);
    const exactPredicate = identifierIsUuid
      ? or(eq(elements.id, identifier), eq(elements.name, identifier))
      : eq(elements.name, identifier);
    const exactRows = await tx
      .select({ id: elements.id, name: elements.name })
      .from(elements)
      .where(and(
        eq(elements.userId, userId),
        eq(elements.elementType, elementType),
        exactPredicate,
      ))
      .limit(2);
    if (exactRows.length > 1) {
      const error = new Error(`Ambiguous element identity: ${identifier}`) as NodeJS.ErrnoException;
      error.code = 'EAMBIGUOUS';
      throw error;
    }
    const exact = exactRows.at(0);
    if (exact) return exact;
    if (identifierIsUuid) return undefined;

    const canonicalIdentifier = canonicalNameKey(identifier);
    const canonicalRows = await tx
      .select({ id: elements.id, name: elements.name })
      .from(elements)
      .where(and(
        eq(elements.userId, userId),
        eq(elements.elementType, elementType),
        sql<boolean>`btrim(regexp_replace(regexp_replace(lower(btrim(${elements.name})), '[[:space:]_]+', '-', 'g'), '-+', '-', 'g'), '-') = ${canonicalIdentifier}`,
      ))
      .limit(2);

    if (canonicalRows.length > 1) {
      const error = new Error(`Ambiguous element identity: ${identifier}`) as NodeJS.ErrnoException;
      error.code = 'EAMBIGUOUS';
      throw error;
    }
    return canonicalRows.at(0);
  }

  /** Update both forward and reverse index maps. */
  protected setIndex(name: string, id: string): void {
    this.setIndexForState(this.getState(), name, id);
  }

  private setIndexForState(state: DatabaseIndexState, name: string, id: string): void {
    // Remove old reverse mapping if name changed
    const oldId = state.nameToIdMap.get(name);
    if (oldId && oldId !== id) {
      state.idToNameMap.delete(oldId);
    }
    state.nameToIdMap.set(name, id);
    state.idToNameMap.set(id, name);
  }

  /** Remove from both forward and reverse index maps. */
  protected removeIndex(name: string): void {
    this.removeIndexForState(this.getState(), name);
  }

  private removeIndexForState(state: DatabaseIndexState, name: string): void {
    const id = state.nameToIdMap.get(name);
    if (id) state.idToNameMap.delete(id);
    state.nameToIdMap.delete(name);
  }

  /** Remove from index by ID (reverse lookup). */
  protected removeIndexById(id: string, userId = this.userId): void {
    const state = this.getState(userId);
    const name = state.idToNameMap.get(id);
    if (name) state.nameToIdMap.delete(name);
    state.idToNameMap.delete(id);
  }

  private getState(userId = this.userId): DatabaseIndexState {
    let state = this.indexStates.get(userId);
    if (!state) {
      state = {
        nameToIdMap: new Map<string, string>(),
        idToNameMap: new Map<string, string>(),
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
  ): Promise<void> {
    await tx.delete(elementTags).where(eq(elementTags.elementId, elementId));
    if (tags.length > 0) {
      await tx.insert(elementTags).values(
        tags.map(tag => ({ elementId, userId: this.userId, tag })),
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
