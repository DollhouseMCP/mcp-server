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

import { eq, and, or, gt, inArray } from 'drizzle-orm';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { DatabaseInstance } from '../database/connection.js';
import { withUserRead } from '../database/rls.js';
import { elements, elementTags } from '../database/schema/elements.js';
import type { UserIdResolver } from '../database/UserContext.js';
import type { DrizzleTx } from '../database/db-utils.js';
import type { ElementIndexEntry, ManifestDiffResult } from './types.js';
import type { IWritableStorageLayer, ElementWriteMetadata, WriteContentOptions } from './IStorageLayer.js';

// ── Implementation ──────────────────────────────────────────────────

export abstract class AbstractDatabaseStorageLayer implements IWritableStorageLayer {
  protected readonly db: DatabaseInstance;
  protected readonly elementType: string;
  /**
   * Lazily-resolved current-user UUID. Called once per DB operation — reads from
   * ContextTracker's AsyncLocalStorage in production. See UserContext.ts.
   */
  protected readonly getCurrentUserId: UserIdResolver;

  /** In-memory cache: element name → element UUID */
  protected readonly nameToIdMap = new Map<string, string>();
  /** Reverse lookup: element UUID → element name */
  protected readonly idToNameMap = new Map<string, string>();
  private lastScanTimestamp: Date | null = null;
  private scanCompleted = false;

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

  async scan(): Promise<ManifestDiffResult> {
    const result: ManifestDiffResult = {
      added: [],
      modified: [],
      removed: [],
      unchanged: [],
    };

    // Determine whether to do a full or incremental scan
    const isFullScan = !this.lastScanTimestamp;

    // Explicit userId in all queries for defense-in-depth (alongside RLS)
    // and to enable composite index utilization on idx_elements_scan/idx_elements_user_type.
    const rows = await withUserRead(this.db, this.userId, async (tx) => {
      if (!isFullScan) {
        return tx
          .select({ id: elements.id, name: elements.name, updatedAt: elements.updatedAt })
          .from(elements)
          .where(and(
            eq(elements.userId, this.userId),
            eq(elements.elementType, this.elementType),
            gt(elements.updatedAt, this.lastScanTimestamp!),
          ));
      }
      return tx
        .select({ id: elements.id, name: elements.name, updatedAt: elements.updatedAt })
        .from(elements)
        .where(and(
          eq(elements.userId, this.userId),
          eq(elements.elementType, this.elementType),
        ));
    });

    if (!this.scanCompleted) {
      // First scan: everything is "added"
      for (const row of rows) {
        this.setIndex(row.name, row.id);
        result.added.push(row.id);
      }
    } else {
      // Subsequent scans
      const seenIds = new Set<string>();

      for (const row of rows) {
        seenIds.add(row.id);
        if (this.nameToIdMap.has(row.name)) {
          result.modified.push(row.id);
        } else {
          result.added.push(row.id);
        }
        this.setIndex(row.name, row.id);
      }

      // Detect removals on full scans (no timestamp filter)
      if (isFullScan) {
        for (const [name, id] of this.nameToIdMap.entries()) {
          if (!seenIds.has(id)) {
            result.removed.push(id);
            this.removeIndex(name);
          }
        }
      }
    }

    this.lastScanTimestamp = new Date();
    this.scanCompleted = true;

    return result;
  }

  async listSummaries(options?: { includePublic?: boolean }): Promise<ElementIndexEntry[]> {
    if (!this.scanCompleted) {
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
    if (!this.scanCompleted) {
      await this.scan();
    }
    return Array.from(this.nameToIdMap.values());
  }

  getPathByName(name: string): string | undefined {
    return this.nameToIdMap.get(name);
  }

  /**
   * Reverse lookup: get element name by UUID.
   * Used by BaseElementManager.delete() to resolve name from path in DB mode.
   */
  getNameById(id: string): string | undefined {
    return this.idToNameMap.get(id);
  }

  hasCompletedScan(): boolean {
    return this.scanCompleted;
  }

  async notifySaved(): Promise<void> {
    // No-op in database mode — writeContent() handles persistence and index update.
  }

  notifyDeleted(): void {
    // No-op in database mode — deleteContent() handles removal and index update.
  }

  invalidate(): void {
    this.lastScanTimestamp = null;
  }

  clear(): void {
    this.nameToIdMap.clear();
    this.idToNameMap.clear();
    this.lastScanTimestamp = null;
    this.scanCompleted = false;
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
      return rows[0] ?? null;
    });

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
    // Remove old reverse mapping if name changed
    const oldId = this.nameToIdMap.get(name);
    if (oldId && oldId !== id) {
      this.idToNameMap.delete(oldId);
    }
    this.nameToIdMap.set(name, id);
    this.idToNameMap.set(id, name);
  }

  /** Remove from both forward and reverse index maps. */
  protected removeIndex(name: string): void {
    const id = this.nameToIdMap.get(name);
    if (id) this.idToNameMap.delete(id);
    this.nameToIdMap.delete(name);
  }

  /** Remove from index by ID (reverse lookup). */
  protected removeIndexById(id: string): void {
    const name = this.idToNameMap.get(id);
    if (name) this.nameToIdMap.delete(name);
    this.idToNameMap.delete(id);
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
