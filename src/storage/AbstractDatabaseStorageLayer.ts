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

import { eq, and, or, inArray } from 'drizzle-orm';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { DatabaseInstance } from '../database/connection.js';
import { withUserRead } from '../database/rls.js';
import { elements, elementTags } from '../database/schema/elements.js';
import type { UserIdResolver } from '../database/UserContext.js';
import type { DrizzleTx } from '../database/db-utils.js';
import type { ElementIndexEntry, ManifestDiffResult } from './types.js';
import type { IWritableStorageLayer, ElementWriteMetadata, WriteContentOptions } from './IStorageLayer.js';
import { withAgentReplacementTransactionOr } from './AgentReplacementTransactionContext.js';

/**
 * Canonical key for case/format-insensitive name resolution: lowercase, with
 * runs of whitespace/underscores collapsed to a single hyphen and surrounding
 * hyphens trimmed. Mirrors the filename-stem form the web-console addresses
 * elements by, so a stem ("meeting-notes") resolves a raw name ("Meeting-Notes").
 */
export function canonicalNameKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_]+/gu, '-')
    .replaceAll(/-+/gu, '-')
    .replaceAll(/^-|-$/gu, '');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface DatabaseIndexState {
  readonly nameToIdMap: Map<string, string>;
  readonly idToNameMap: Map<string, string>;
  readonly rowVersions: Map<string, string>;
  scanCompleted: boolean;
  generation: number;
  lastAccess: number;
  scanPromise?: Promise<ManifestDiffResult>;
  discarded: boolean;
}

const DEFAULT_MAX_INDEX_USERS = 256;
const MAX_SCAN_GENERATION_ATTEMPTS = 4;

function emptyManifestDiff(): ManifestDiffResult {
  return { added: [], modified: [], removed: [], unchanged: [] };
}

interface InFlightDatabaseScan {
  readonly state: DatabaseIndexState;
  readonly promise: Promise<ManifestDiffResult>;
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

  /** Per-user indexes; managers are shared across concurrent HTTP sessions. */
  private readonly indexStates = new Map<string, DatabaseIndexState>();
  /** Active scans remain addressable even when their cached LRU entry is evicted. */
  private readonly inFlightScans = new Map<string, InFlightDatabaseScan>();
  private accessSequence = 0;

  constructor(
    db: DatabaseInstance,
    getCurrentUserId: UserIdResolver,
    elementType: string,
    private readonly maxIndexUsers = DEFAULT_MAX_INDEX_USERS,
  ) {
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

  async scan(): Promise<ManifestDiffResult> {
    const userId = this.userId;
    const existingScan = this.inFlightScans.get(userId);
    if (existingScan) return existingScan.promise;

    const state = this.indexState(userId);
    if (state.scanPromise) return state.scanPromise;

    const scanPromise = this.scanUntilCurrent(userId, state);
    state.scanPromise = scanPromise;
    this.inFlightScans.set(userId, { state, promise: scanPromise });
    try {
      return await scanPromise;
    } finally {
      if (state.scanPromise === scanPromise) state.scanPromise = undefined;
      if (this.inFlightScans.get(userId)?.promise === scanPromise) {
        this.inFlightScans.delete(userId);
      }
      this.retainIndexState(userId, state);
      this.pruneIndexStates(userId, false);
    }
  }

  private async scanUntilCurrent(
    userId: string,
    state: DatabaseIndexState,
  ): Promise<ManifestDiffResult> {
    for (let attempt = 1; attempt <= MAX_SCAN_GENERATION_ATTEMPTS; attempt += 1) {
      if (state.discarded) return emptyManifestDiff();
      const generation = state.generation;
      const result = await this.scanGeneration(userId, state, generation);
      if (state.discarded) return emptyManifestDiff();
      if (state.generation === generation) return result;
    }
    throw new Error(
      `Database manifest for '${this.elementType}' changed during ` +
      `${MAX_SCAN_GENERATION_ATTEMPTS} consecutive scan attempts`,
    );
  }

  private async scanGeneration(
    userId: string,
    state: DatabaseIndexState,
    generation: number,
  ): Promise<ManifestDiffResult> {
    const result: ManifestDiffResult = {
      added: [],
      modified: [],
      removed: [],
      unchanged: [],
    };

    // A timestamp cursor cannot be commit-ordered in PostgreSQL: NOW() is the
    // transaction start time, so a late commit can land behind an advanced
    // watermark. Compare the bounded per-user manifest on every scan instead.
    const rows = await withUserRead(this.db, userId, async (tx) =>
      tx
        .select({
          id: elements.id,
          name: elements.name,
          updatedAt: elements.updatedAt,
          contentHash: elements.contentHash,
        })
        .from(elements)
        .where(and(
          eq(elements.userId, userId),
          eq(elements.elementType, this.elementType),
        )),
    );
    const currentIds = new Set(rows.map(row => row.id));
    const nextVersions = new Map<string, string>();
    const nextNames = new Map<string, string>();
    const nextIds = new Map<string, string>();

    for (const row of rows) {
      const version = `${row.name}\0${row.contentHash}\0${row.updatedAt.getTime()}`;
      nextVersions.set(row.id, version);
      const previousVersion = state.rowVersions.get(row.id);
      if (!state.scanCompleted || previousVersion === undefined) {
        result.added.push(row.id);
      } else if (previousVersion !== version) {
        result.modified.push(row.id);
      } else {
        result.unchanged.push(row.id);
      }
      nextNames.set(row.name, row.id);
      nextIds.set(row.id, row.name);
    }

    for (const id of state.rowVersions.keys()) {
      if (!currentIds.has(id)) {
        result.removed.push(id);
      }
    }
    if (state.generation !== generation) {
      return { added: [], modified: [], removed: [], unchanged: [] };
    }
    state.nameToIdMap.clear();
    state.idToNameMap.clear();
    for (const [name, id] of nextNames) state.nameToIdMap.set(name, id);
    for (const [id, name] of nextIds) state.idToNameMap.set(id, name);
    state.rowVersions.clear();
    for (const [id, version] of nextVersions) state.rowVersions.set(id, version);
    state.scanCompleted = true;

    return result;
  }

  async listSummaries(options?: { includePublic?: boolean }): Promise<ElementIndexEntry[]> {
    if (!this.currentIndexState.scanCompleted) {
      await this.scan();
    }

    // includePublic expands the owner filter to also match any row with
    // visibility='public'. RLS's elements_select policy already permits the
    // caller to read public rows owned by other users (migration 0005), so
    // the database will happily return them once the predicate lets them
    // through. Default (flag off) keeps the query per-user-scoped, preserving
    // today's discovery surface.
    const ownerPredicate = options?.includePublic
      ? or(eq(elements.userId, this.userId), eq(elements.visibility, 'public'))
      : eq(elements.userId, this.userId);

    return withUserRead(this.db, this.userId, async (tx) => {
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
    // Retain this state across the await. Another user's access can evict its
    // LRU entry while the query is active, but the completed result still
    // belongs to this request and must not be replaced with a fresh empty map.
    const state = this.currentIndexState;
    if (!state.scanCompleted) {
      await this.scan();
    }
    return Array.from(state.nameToIdMap.values());
  }

  getPathByName(name: string): string | undefined {
    const { nameToIdMap } = this.currentIndexState;
    const direct = nameToIdMap.get(name);
    if (direct !== undefined) return direct;
    // The web-console addresses elements by their filename stem (lowercased, with
    // spaces/underscores hyphenated), which won't match a raw mixed-case index
    // key like "Meeting-Notes". Fall back to a canonical comparison so resolve
    // and delete work for any-cased name (only scans on a direct miss).
    const target = canonicalNameKey(name);
    let canonicalMatch: string | undefined;
    for (const [key, id] of nameToIdMap) {
      if (canonicalNameKey(key) !== target) continue;
      if (canonicalMatch !== undefined && canonicalMatch !== id) return undefined;
      canonicalMatch = id;
    }
    return canonicalMatch;
  }

  /**
   * Reverse lookup: get element name by UUID.
   * Used by BaseElementManager.delete() to resolve name from path in DB mode.
   */
  getNameById(id: string): string | undefined {
    return this.currentIndexState.idToNameMap.get(id);
  }

  async resolveNameById(id: string): Promise<string | undefined> {
    const indexed = this.getNameById(id);
    if (indexed !== undefined) return indexed;
    if (!UUID_RE.test(id)) return undefined;

    const userId = this.userId;
    const row = await withUserRead(this.db, userId, async (tx) => {
      const rows = await tx
        .select({ id: elements.id, name: elements.name })
        .from(elements)
        .where(and(
          eq(elements.id, id),
          eq(elements.userId, userId),
          eq(elements.elementType, this.elementType),
        ))
        .limit(1);
      return rows.at(0);
    });
    if (!row) return undefined;
    this.setIndex(row.name, row.id);
    return row.name;
  }

  hasCompletedScan(): boolean {
    return this.currentIndexState.scanCompleted;
  }

  async notifySaved(): Promise<void> {
    // No-op in database mode — writeContent() handles persistence and index update.
  }

  notifyDeleted(): void {
    // No-op in database mode — deleteContent() handles removal and index update.
  }

  invalidate(): void {
    const state = this.currentIndexState;
    state.generation += 1;
    state.scanCompleted = false;
  }

  clear(): void {
    for (const state of this.indexStates.values()) this.discardIndexState(state);
    for (const active of this.inFlightScans.values()) this.discardIndexState(active.state);
    this.indexStates.clear();
    this.inFlightScans.clear();
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

  async readContent(relativePath: string): Promise<string> {
    const userId = this.userId;
    const row = await withAgentReplacementTransactionOr<{ rawContent: string } | null>(
      userId,
      operation => withUserRead(this.db, userId, operation),
      async (tx) => {
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
      },
    );

    if (!row) {
      const err = new Error(`Element not found: ${relativePath}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }

    return row.rawContent;
  }

  // ── Protected helpers for subclasses ──────────────────────────────

  /** Update both forward and reverse index maps. */
  protected setIndex(name: string, id: string): void {
    const { nameToIdMap, idToNameMap } = this.currentIndexState;
    const previousName = idToNameMap.get(id);
    if (previousName && previousName !== name) {
      nameToIdMap.delete(previousName);
    }
    // Remove old reverse mapping if name changed
    const oldId = nameToIdMap.get(name);
    if (oldId && oldId !== id) {
      idToNameMap.delete(oldId);
    }
    nameToIdMap.set(name, id);
    idToNameMap.set(id, name);
  }

  /** Fence an in-flight manifest query before publishing a committed mutation. */
  protected markDurableMutation(): void {
    this.currentIndexState.generation += 1;
  }

  /** Remove from both forward and reverse index maps. */
  protected removeIndex(name: string): void {
    const { nameToIdMap, idToNameMap } = this.currentIndexState;
    const id = nameToIdMap.get(name);
    if (id) idToNameMap.delete(id);
    nameToIdMap.delete(name);
  }

  /** Remove from index by ID (reverse lookup). */
  protected removeIndexById(id: string): void {
    const { nameToIdMap, idToNameMap } = this.currentIndexState;
    const name = idToNameMap.get(id);
    if (name) nameToIdMap.delete(name);
    idToNameMap.delete(id);
  }

  private get currentIndexState(): DatabaseIndexState {
    return this.indexState(this.userId);
  }

  private indexState(userId: string): DatabaseIndexState {
    const active = this.inFlightScans.get(userId);
    if (active) {
      active.state.lastAccess = ++this.accessSequence;
      return active.state;
    }

    let state = this.indexStates.get(userId);
    if (!state) {
      this.pruneIndexStates(userId, true);
      state = {
        nameToIdMap: new Map(),
        idToNameMap: new Map(),
        rowVersions: new Map(),
        scanCompleted: false,
        generation: 0,
        lastAccess: ++this.accessSequence,
        discarded: false,
      };
      this.indexStates.set(userId, state);
    } else {
      state.lastAccess = ++this.accessSequence;
    }
    return state;
  }

  private retainIndexState(userId: string, state: DatabaseIndexState): void {
    if (state.discarded) return;
    if (this.indexStates.get(userId) === state) return;
    this.pruneIndexStates(userId, true);
    state.lastAccess = ++this.accessSequence;
    this.indexStates.set(userId, state);
  }

  private discardIndexState(state: DatabaseIndexState): void {
    state.discarded = true;
    state.generation += 1;
    state.scanCompleted = false;
    state.nameToIdMap.clear();
    state.idToNameMap.clear();
    state.rowVersions.clear();
  }

  private pruneIndexStates(currentUserId: string, reserveSlot: boolean): void {
    const targetSize = Math.max(0, this.maxIndexUsers - (reserveSlot ? 1 : 0));
    while (this.indexStates.size > targetSize) {
      let candidate: [string, DatabaseIndexState] | undefined;
      for (const entry of this.indexStates) {
        if (entry[0] === currentUserId) continue;
        if (!candidate || entry[1].lastAccess < candidate[1].lastAccess) candidate = entry;
      }
      if (!candidate) return;
      this.indexStates.delete(candidate[0]);
    }
  }

  /** @internal Focused assertion for bounded multi-user manager state. */
  indexStateCountForTesting(): number {
    return this.indexStates.size;
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
