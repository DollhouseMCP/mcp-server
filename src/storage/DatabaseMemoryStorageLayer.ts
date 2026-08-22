/**
 * Database-Backed Memory Storage Layer
 *
 * Extends AbstractDatabaseStorageLayer for memory elements. Memories differ
 * from other elements:
 * - Pure YAML (not markdown with frontmatter)
 * - Uses SecureYamlParser + MemoryMetadataExtractor (not FrontmatterParser)
 * - Entries are stored in a separate memory_entries table (split-source)
 * - Memory-specific fields: autoLoad, priority, memoryType, totalEntries
 *
 * @since v2.2.0 — Phase 4, Step 4.3
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { eq, and, gt, lt, sql, desc, inArray, arrayOverlaps } from 'drizzle-orm';
import type { DatabaseInstance } from '../database/connection.js';
import { withUserContext, withUserRead } from '../database/rls.js';
import { elements } from '../database/schema/elements.js';
import { memoryEntries } from '../database/schema/memories.js';
import type { UserIdResolver } from '../database/UserContext.js';
import { isUniqueViolation, type DrizzleTx } from '../database/db-utils.js';
import { MemoryMetadataExtractor } from './MemoryMetadataExtractor.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';
import { validateMemoryControlFields } from '../elements/memories/memoryYamlValidation.js';
import { AbstractDatabaseStorageLayer } from './AbstractDatabaseStorageLayer.js';
import { logger } from '../utils/logger.js';
import type { ElementIndexEntry } from './types.js';
import {
  StorageAlreadyExistsError,
  type ElementWriteMetadata,
  type WriteContentOptions,
} from './IStorageLayer.js';

// ── Constants ───────────────────────────────────────────────────────

const STORE_NAME = 'DatabaseMemoryStorageLayer';

/**
 * Default row cap for {@link DatabaseMemoryStorageLayer.getEntries} when the
 * caller does not specify `limit`. Hot-path queries should pass an explicit
 * limit when they know they only need a small window; this cap exists so a
 * memory that has grown past a few thousand entries does not ship the entire
 * history on every read.
 */
const DEFAULT_ENTRY_QUERY_LIMIT = 1000;

// ── Entry Types ─────────────────────────────────────────────────────

export interface MemoryEntryData {
  entryId: string;
  timestamp: Date;
  content: string;
  sanitizedContent?: string;
  sanitizedPatterns?: Record<string, unknown>;
  tags?: string[];
  entryMetadata?: Record<string, unknown>;
  privacyLevel?: string;
  trustLevel?: string;
  source?: string;
  expiresAt?: Date;
}

export interface MemoryEntryQueryOptions {
  since?: Date;
  until?: Date;
  privacyLevel?: string;
  tags?: string[];
  limit?: number;
}

export class MemoryPersistenceConflictError extends Error {
  readonly code = 'MEMORY_PERSISTENCE_CONFLICT';

  constructor(name: string) {
    super(`Memory '${name}' changed or was deleted in another session; reload it before saving again`);
    this.name = 'MemoryPersistenceConflictError';
  }
}

export interface MemoryStorageRevision {
  readonly userId: string;
  readonly elementId: string;
  readonly name: string;
  readonly contentHash: string;
}

interface MemoryRevisionScope {
  readonly expected?: MemoryStorageRevision;
  observed?: MemoryStorageRevision;
  persisted?: MemoryStorageRevision;
}

interface LockedMemoryParent {
  readonly id: string;
  readonly name: string;
  readonly rawContent: string;
}

interface NormalizedMemoryEntryRow {
  readonly entryId: string;
  readonly timestamp: Date;
  readonly content: string;
  readonly sanitizedContent: string | null;
  readonly sanitizedPatterns: unknown;
  readonly tags: unknown;
  readonly entryMetadata: unknown;
  readonly privacyLevel: string | null;
  readonly trustLevel: string | null;
  readonly source: string | null;
  readonly expiresAt: Date | null;
}

export interface MemoryRevisionResult<T> {
  readonly result: T;
  readonly revision?: MemoryStorageRevision;
}

// ── Implementation ──────────────────────────────────────────────────

export class DatabaseMemoryStorageLayer extends AbstractDatabaseStorageLayer {
  private readonly revisionScope = new AsyncLocalStorage<MemoryRevisionScope>();

  constructor(db: DatabaseInstance, getCurrentUserId: UserIdResolver) {
    super(db, getCurrentUserId, 'memories');
  }

  /**
   * Bind a database load/save/delete pipeline to one loaded revision. The scope
   * is async-local so concurrent requests using this singleton storage layer do
   * not overwrite each other's optimistic-concurrency token.
   */
  async runWithRevisionTracking<T>(
    operation: () => Promise<T>,
    expected?: MemoryStorageRevision,
  ): Promise<MemoryRevisionResult<T>> {
    const scope: MemoryRevisionScope = { expected };
    const result = await this.revisionScope.run(scope, operation);
    return { result, revision: scope.persisted ?? scope.observed ?? expected };
  }

  /**
   * Override to add totalEntries count from memory_entries table.
   */
  protected override async mapRowsToSummaries(
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
    }>,
    tagsByElementId: Map<string, string[]>,
    tx: DrizzleTx,
  ): Promise<ElementIndexEntry[]> {
    // Count entries per memory
    const elementIds = rows.map(r => r.id);
    const entryCounts = elementIds.length > 0
      ? await tx
          .select({
            memoryId: memoryEntries.memoryId,
            count: sql<number>`count(*)::int`,
          })
          .from(memoryEntries)
          .where(inArray(memoryEntries.memoryId, elementIds))
          .groupBy(memoryEntries.memoryId)
      : [];

    const countByMemoryId = new Map<string, number>();
    for (const c of entryCounts) {
      countByMemoryId.set(c.memoryId, c.count);
    }

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
      totalEntries: countByMemoryId.get(row.id) ?? 0,
    }));
  }

  // ── IWritableStorageLayer ─────────────────────────────────────────

  async writeContent(
    _elementType: string,
    name: string,
    content: string,
    metadata: ElementWriteMetadata,
    options?: WriteContentOptions,
  ): Promise<string> {
    const extracted = MemoryMetadataExtractor.extractMetadata(content, name);
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
    const byteSize = Buffer.byteLength(content, 'utf8');

    // Use the caller-provided name as authoritative, falling back to extracted
    const elementName = name || extracted.name || 'unnamed';

    const elementId = await withUserContext(this.db, this.userId, async (tx) => {
      // Build the column values once; both insert and upsert-SET reuse the
      // same object so adding a column is a one-line change, not two.
      const values = {
        userId: this.userId,
        rawContent: content,
        bodyContent: null,
        contentHash,
        byteSize,
        elementType: 'memories',
        name: elementName,
        description: metadata.description || extracted.description || '',
        version: metadata.version || extracted.version || '1.0.0',
        author: metadata.author || extracted.author || '',
        metadata: this.extractMemoryMetadata(content),
        visibility: metadata.visibility ?? 'private',
        memoryType: extracted.memoryType ?? null,
        autoLoad: extracted.autoLoad ?? null,
        priority: extracted.priority ?? null,
      };
      // SET clause derives from values — strip identity columns (conflict target)
      // and force updatedAt to NOW(). Single source of truth for everything else.
      const buildUpdateSet = () => {
        const { userId: _u, elementType: _et, name: _n, ...rest } = values;
        return { ...rest, updatedAt: sql`NOW()` };
      };

      let rows;
      if (options?.exclusive) {
        // Atomic create-or-fail — mirrors file-mode createFileExclusive semantics.
        try {
          rows = await tx.insert(elements).values(values).returning({ id: elements.id });
        } catch (err) {
          if (isUniqueViolation(err)) {
            const label = options?.elementLabel ?? 'Memory';
            throw new StorageAlreadyExistsError(label, elementName);
          }
          throw err;
        }
      } else {
        const expected = this.revisionScope.getStore()?.expected;
        if (expected) {
          if (expected.userId !== this.userId) {
            throw new MemoryPersistenceConflictError(elementName);
          }
          rows = await tx
            .update(elements)
            .set({ ...buildUpdateSet(), name: elementName })
            .where(and(
              eq(elements.userId, this.userId),
              eq(elements.id, expected.elementId),
              eq(elements.elementType, 'memories'),
              eq(elements.contentHash, expected.contentHash),
            ))
            .returning({ id: elements.id });
          if (!rows[0]) throw new MemoryPersistenceConflictError(elementName);
        } else {
          // Callers that did not load this row are imports/synchronizers. Keep
          // their intentional upsert behavior; loaded interactive sessions use
          // the hash-fenced update above and cannot resurrect a deleted row.
          rows = await tx
            .insert(elements)
            .values(values)
            .onConflictDoUpdate({
              target: [elements.userId, elements.elementType, elements.name],
              set: buildUpdateSet(),
            })
            .returning({ id: elements.id });
        }
      }

      const row = rows[0];
      if (!row) {
        throw new Error(`[${STORE_NAME}] Upsert returned no row for memories/${elementName}`);
      }

      // Serialize full-document replacement with entry-level writes. The
      // element row is the shared lock for every mutation of its normalized
      // memory_entries children.
      await tx.select({ id: elements.id }).from(elements).where(and(
        eq(elements.id, row.id),
        eq(elements.userId, this.userId),
      )).for('update');

      // Replace tags
      const tags = metadata.tags.length > 0 ? metadata.tags : (extracted.tags ?? []);
      await this.replaceTags(tx, row.id, tags);

      // Sync entries within the same transaction — no race window
      await this.syncEntriesInTx(tx, row.id, content);

      return row.id;
    });

    this.markDurableMutation();
    this.setIndex(elementName, elementId);
    const scope = this.revisionScope.getStore();
    if (scope) {
      scope.persisted = {
        userId: this.userId,
        elementId,
        name: elementName,
        contentHash,
      };
    }

    this.logPersistEvent('ELEMENT_EDITED', 'LOW', `${STORE_NAME}.writeContent`,
      `Memory persisted to database: ${elementName}`,
      { elementId, name: elementName });

    return elementId;
  }

  async deleteContent(_elementType: string, name: string): Promise<void> {
    await withUserContext(this.db, this.userId, async (tx) => {
      const scope = this.revisionScope.getStore();
      const expected = scope?.expected ?? scope?.observed;
      if (expected && expected.userId !== this.userId) {
        throw new MemoryPersistenceConflictError(name);
      }
      const conditions = [
        eq(elements.userId, this.userId),
        eq(elements.elementType, 'memories'),
        eq(elements.name, name),
      ];
      if (expected) {
        conditions.push(eq(elements.id, expected.elementId));
        conditions.push(eq(elements.contentHash, expected.contentHash));
      }
      const deleted = await tx
        .delete(elements)
        .where(and(...conditions))
        .returning({ id: elements.id });
      if (expected && !deleted[0]) throw new MemoryPersistenceConflictError(name);
      // Cascade handles memory_entries deletion
    });

    this.markDurableMutation();
    this.removeIndex(name);

    this.logPersistEvent('ELEMENT_DELETED', 'MEDIUM', `${STORE_NAME}.deleteContent`,
      `Memory deleted from database: ${name}`,
      { name });
  }

  override async readContent(relativePath: string): Promise<string> {
    const row = await withUserRead(this.db, this.userId, async (tx) => {
      const rows = await tx
        .select({
          rawContent: elements.rawContent,
          contentHash: elements.contentHash,
          name: elements.name,
          userId: elements.userId,
        })
        .from(elements)
        .where(eq(elements.id, relativePath))
        .limit(1);
      return rows.at(0) ?? null;
    });

    if (!row) {
      const error = new Error(`Element not found: ${relativePath}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    if (row.userId === this.userId) {
      const scope = this.revisionScope.getStore();
      if (scope) {
        scope.observed = {
          userId: row.userId,
          elementId: relativePath,
          name: row.name,
          contentHash: row.contentHash,
        };
      }
      this.setIndex(row.name, relativePath);
    }
    return row.rawContent;
  }

  // ── Entry-Level Operations ────────────────────────────────────────

  async addEntry(memoryElementId: string, entry: MemoryEntryData): Promise<void> {
    await withUserContext(this.db, this.userId, async (tx) => {
      const parent = await this.lockMemoryParent(tx, memoryElementId);
      // Single source of truth for the column values — both the insert values
      // and the upsert SET reuse it. Identity columns (memoryId, entryId) are
      // stripped from the SET via the buildUpdateSet closure pattern (same
      // approach as writeContent), so adding a column to `values` is a one-
      // line change rather than two.
      const values = {
        userId: this.userId,
        memoryId: memoryElementId,
        entryId: entry.entryId,
        timestamp: entry.timestamp,
        content: entry.content,
        sanitizedContent: entry.sanitizedContent ?? null,
        sanitizedPatterns: entry.sanitizedPatterns ?? {},
        tags: entry.tags ?? [],
        entryMetadata: entry.entryMetadata ?? {},
        privacyLevel: entry.privacyLevel ?? null,
        trustLevel: entry.trustLevel ?? null,
        source: entry.source ?? null,
        expiresAt: entry.expiresAt ?? null,
      };
      const buildUpdateSet = () => {
        const { userId: _u, memoryId: _m, entryId: _e, ...rest } = values;
        return rest;
      };
      await tx.insert(memoryEntries).values(values).onConflictDoUpdate({
        target: [memoryEntries.memoryId, memoryEntries.entryId],
        set: buildUpdateSet(),
      });
      await this.rewriteParentFromNormalizedEntries(tx, parent);
    });
  }

  async getEntries(
    memoryElementId: string,
    options?: MemoryEntryQueryOptions,
  ): Promise<MemoryEntryData[]> {
    return withUserRead(this.db, this.userId, async (tx) => {
      // Defense-in-depth: include userId in WHERE even though RLS enforces it,
      // so the query is correct under any misconfigured session context.
      const conditions = [
        eq(memoryEntries.userId, this.userId),
        eq(memoryEntries.memoryId, memoryElementId),
      ];

      if (options?.since) {
        conditions.push(gt(memoryEntries.timestamp, options.since));
      }
      if (options?.until) {
        conditions.push(lt(memoryEntries.timestamp, options.until));
      }
      if (options?.privacyLevel) {
        conditions.push(eq(memoryEntries.privacyLevel, options.privacyLevel));
      }
      if (options?.tags && options.tags.length > 0) {
        // Postgres text[] overlap operator (&&): returns rows whose tags share
        // at least one element with the query tags. Matches the interface
        // contract: "entries tagged with ANY of these".
        conditions.push(arrayOverlaps(memoryEntries.tags, options.tags));
      }

      // Explicit column list — avoids shipping sanitized_content/sanitized_patterns/
      // entry_metadata unless callers actually need them (hot-path consideration).
      const rows = await tx
        .select({
          entryId: memoryEntries.entryId,
          timestamp: memoryEntries.timestamp,
          content: memoryEntries.content,
          sanitizedContent: memoryEntries.sanitizedContent,
          sanitizedPatterns: memoryEntries.sanitizedPatterns,
          tags: memoryEntries.tags,
          entryMetadata: memoryEntries.entryMetadata,
          privacyLevel: memoryEntries.privacyLevel,
          trustLevel: memoryEntries.trustLevel,
          source: memoryEntries.source,
          expiresAt: memoryEntries.expiresAt,
        })
        .from(memoryEntries)
        .where(and(...conditions))
        .orderBy(desc(memoryEntries.timestamp), desc(memoryEntries.entryId))
        .limit(options?.limit ?? DEFAULT_ENTRY_QUERY_LIMIT);

      return rows.map(row => ({
        entryId: row.entryId,
        timestamp: row.timestamp,
        content: row.content,
        sanitizedContent: row.sanitizedContent ?? undefined,
        sanitizedPatterns: (row.sanitizedPatterns && typeof row.sanitizedPatterns === 'object')
          ? row.sanitizedPatterns as Record<string, unknown> : undefined,
        tags: (Array.isArray(row.tags)) ? row.tags as string[] : undefined,
        entryMetadata: (row.entryMetadata && typeof row.entryMetadata === 'object')
          ? row.entryMetadata as Record<string, unknown> : undefined,
        privacyLevel: row.privacyLevel ?? undefined,
        trustLevel: row.trustLevel ?? undefined,
        source: row.source ?? undefined,
        expiresAt: row.expiresAt ?? undefined,
      }));
    });
  }

  async removeEntry(memoryElementId: string, entryId: string): Promise<void> {
    await withUserContext(this.db, this.userId, async (tx) => {
      const parent = await this.lockMemoryParent(tx, memoryElementId);
      // Defense-in-depth: include userId even though RLS enforces it.
      await tx
        .delete(memoryEntries)
        .where(and(
          eq(memoryEntries.userId, this.userId),
          eq(memoryEntries.memoryId, memoryElementId),
          eq(memoryEntries.entryId, entryId),
        ));
      await this.rewriteParentFromNormalizedEntries(tx, parent);
    });
  }

  async purgeExpiredEntries(): Promise<number> {
    return withUserContext(this.db, this.userId, async (tx) => {
      const affected = await tx
        .select({ memoryId: memoryEntries.memoryId })
        .from(memoryEntries)
        .where(and(
          eq(memoryEntries.userId, this.userId),
          sql`${memoryEntries.expiresAt} IS NOT NULL AND ${memoryEntries.expiresAt} < NOW()`,
        ))
        .groupBy(memoryEntries.memoryId)
        .orderBy(memoryEntries.memoryId);
      let deletedCount = 0;
      for (const { memoryId } of affected) {
        const parent = await this.lockMemoryParent(tx, memoryId);
        const deleted = await tx
          .delete(memoryEntries)
          .where(and(
            eq(memoryEntries.userId, this.userId),
            eq(memoryEntries.memoryId, memoryId),
            sql`${memoryEntries.expiresAt} IS NOT NULL AND ${memoryEntries.expiresAt} < NOW()`,
          ))
          .returning({ id: memoryEntries.id });
        deletedCount += deleted.length;
        await this.rewriteParentFromNormalizedEntries(tx, parent);
      }
      return deletedCount;
    });
  }

  // ── Private ───────────────────────────────────────────────────────

  private async lockMemoryParent(
    tx: DrizzleTx,
    memoryElementId: string,
  ): Promise<LockedMemoryParent> {
    const rows = await tx.select({
      id: elements.id,
      name: elements.name,
      rawContent: elements.rawContent,
    }).from(elements).where(and(
      eq(elements.id, memoryElementId),
      eq(elements.userId, this.userId),
      eq(elements.elementType, 'memories'),
    )).for('update').limit(1);
    const parent = rows[0];
    if (!parent) {
      throw new Error(`[${STORE_NAME}] Memory element ${memoryElementId} was not found`);
    }
    return parent;
  }

  private async readNormalizedEntriesInTx(
    tx: DrizzleTx,
    memoryElementId: string,
  ): Promise<NormalizedMemoryEntryRow[]> {
    return tx.select({
      entryId: memoryEntries.entryId,
      timestamp: memoryEntries.timestamp,
      content: memoryEntries.content,
      sanitizedContent: memoryEntries.sanitizedContent,
      sanitizedPatterns: memoryEntries.sanitizedPatterns,
      tags: memoryEntries.tags,
      entryMetadata: memoryEntries.entryMetadata,
      privacyLevel: memoryEntries.privacyLevel,
      trustLevel: memoryEntries.trustLevel,
      source: memoryEntries.source,
      expiresAt: memoryEntries.expiresAt,
    }).from(memoryEntries).where(and(
      eq(memoryEntries.userId, this.userId),
      eq(memoryEntries.memoryId, memoryElementId),
    )).orderBy(memoryEntries.timestamp, memoryEntries.entryId);
  }

  private async rewriteParentFromNormalizedEntries(
    tx: DrizzleTx,
    parent: LockedMemoryParent,
  ): Promise<void> {
    const parsed = SecureYamlParser.parseRawYaml(parent.rawContent, {
      maxSize: MEMORY_CONSTANTS.MAX_YAML_SIZE,
      contentPolicy: 'structure-only',
    });
    if (!validateMemoryControlFields(parsed)) {
      throw new Error('Malicious memory control content detected');
    }
    const rows = await this.readNormalizedEntriesInTx(tx, parent.id);
    const serializedEntries = rows.map(row => ({
      id: row.entryId,
      timestamp: row.timestamp.toISOString(),
      content: row.content,
      ...(row.sanitizedContent ? { sanitizedContent: row.sanitizedContent } : {}),
      ...(row.sanitizedPatterns && typeof row.sanitizedPatterns === 'object'
        ? { sanitizedPatterns: row.sanitizedPatterns } : {}),
      tags: Array.isArray(row.tags) ? row.tags : [],
      metadata: row.entryMetadata && typeof row.entryMetadata === 'object'
        ? row.entryMetadata : {},
      ...(row.privacyLevel ? { privacyLevel: row.privacyLevel } : {}),
      ...(row.trustLevel ? { trustLevel: row.trustLevel } : {}),
      ...(row.source ? { source: row.source } : {}),
      ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
    }));
    parsed.entries = serializedEntries;
    const timestamps = rows.map(row => row.timestamp.getTime());
    const stats = parsed.stats && typeof parsed.stats === 'object' && !Array.isArray(parsed.stats)
      ? parsed.stats as Record<string, unknown>
      : {};
    stats.totalEntries = rows.length;
    stats.totalSize = rows.reduce((total, row) => total + Buffer.byteLength(row.content, 'utf8'), 0);
    stats.oldestEntry = timestamps.length > 0
      ? new Date(Math.min(...timestamps)).toISOString()
      : undefined;
    stats.newestEntry = timestamps.length > 0
      ? new Date(Math.max(...timestamps)).toISOString()
      : undefined;
    parsed.stats = stats;
    const rawContent = yaml.dump(parsed, {
      schema: yaml.JSON_SCHEMA,
      noRefs: true,
      skipInvalid: false,
      sortKeys: true,
    });
    const byteSize = Buffer.byteLength(rawContent, 'utf8');
    if (byteSize > MEMORY_CONSTANTS.MAX_YAML_SIZE) {
      throw new Error(
        `[${STORE_NAME}] Memory '${parent.name}' exceeds maximum YAML size ` +
        `of ${MEMORY_CONSTANTS.MAX_YAML_SIZE} bytes`,
      );
    }
    const contentHash = createHash('sha256').update(rawContent, 'utf8').digest('hex');
    const updated = await tx.update(elements).set({
      rawContent,
      contentHash,
      byteSize,
      updatedAt: sql`NOW()`,
    }).where(and(
      eq(elements.id, parent.id),
      eq(elements.userId, this.userId),
      eq(elements.elementType, 'memories'),
    )).returning({ id: elements.id });
    if (!updated[0]) {
      throw new MemoryPersistenceConflictError(parent.name);
    }
  }

  /**
   * Sync entries from YAML content into memory_entries table.
   * Runs inside the caller's transaction for atomicity — element upsert,
   * tag replacement, and entry sync all commit or rollback together.
   */
  private async syncEntriesInTx(
    tx: DrizzleTx,
    memoryElementId: string,
    yamlContent: string,
  ): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      parsed = SecureYamlParser.parseRawYaml(yamlContent, {
        maxSize: MEMORY_CONSTANTS.MAX_YAML_SIZE,
        contentPolicy: 'structure-only',
      });
      if (!validateMemoryControlFields(parsed)) {
        throw new Error('Malicious memory control content detected');
      }
    } catch (err) {
      // Throw so the surrounding transaction rolls back the element, tags, and
      // normalized entries together. Committing only the canonical row would
      // leave entry queries serving stale data from the previous revision.
      logger.warn(
        `[${STORE_NAME}] syncEntriesInTx: YAML parse failed for memory ${memoryElementId}; rolling back`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      throw err;
    }

    const entries = parsed.entries;
    if (entries !== undefined && !Array.isArray(entries)) {
      throw new Error(`[${STORE_NAME}] Memory entries must be an array`);
    }

    // Defense-in-depth: include userId alongside the RLS context. Every other
    // DELETE in this module does the same — syncEntriesInTx is the last one
    // that needed to be brought in line.
    await tx.delete(memoryEntries).where(and(
      eq(memoryEntries.userId, this.userId),
      eq(memoryEntries.memoryId, memoryElementId),
    ));

    if (!entries || entries.length === 0) return;

    const rows = entries.flatMap((entry, idx) => {
      if (!entry || typeof entry !== 'object') return [];
      const e = entry as Record<string, unknown>;
      const content = typeof e.content === 'string' ? e.content : '';
      if (!content) return [];
      return [this.buildEntryRow(e, idx, memoryElementId, content)];
    });

    if (rows.length > 0) {
      await tx.insert(memoryEntries).values(rows);
    }
  }

  private static parseTimestamp(value: unknown): Date {
    if (value instanceof Date) return value;
    return new Date(typeof value === 'string' ? value : Date.now());
  }

  private static parseExpiresAt(value: unknown): Date | null {
    if (value instanceof Date) return value;
    return typeof value === 'string' ? new Date(value) : null;
  }

  private static stringOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private static objectOrEmpty(value: unknown): Record<string, unknown> {
    return (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  }

  private buildEntryRow(
    e: Record<string, unknown>,
    idx: number,
    memoryElementId: string,
    content: string,
  ) {
    return {
      userId: this.userId,
      memoryId: memoryElementId,
      entryId: typeof e.id === 'string' ? e.id : `entry-${idx}`,
      timestamp: DatabaseMemoryStorageLayer.parseTimestamp(e.timestamp),
      content,
      sanitizedContent: DatabaseMemoryStorageLayer.stringOrNull(e.sanitizedContent),
      sanitizedPatterns: DatabaseMemoryStorageLayer.objectOrEmpty(e.sanitizedPatterns),
      tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === 'string') : [],
      entryMetadata: DatabaseMemoryStorageLayer.objectOrEmpty(e.metadata),
      privacyLevel: DatabaseMemoryStorageLayer.stringOrNull(e.privacyLevel),
      trustLevel: DatabaseMemoryStorageLayer.stringOrNull(e.trustLevel),
      source: typeof e.source === 'string' ? e.source : null,
      expiresAt: DatabaseMemoryStorageLayer.parseExpiresAt(e.expiresAt),
    };
  }

  private extractMemoryMetadata(content: string): Record<string, unknown> {
    try {
      const parsed = SecureYamlParser.parseRawYaml(content, {
        maxSize: MEMORY_CONSTANTS.MAX_YAML_SIZE,
        contentPolicy: 'structure-only',
      });
      if (!validateMemoryControlFields(parsed)) {
        return {};
      }
      const { name, description, version, author, tags, entries, stats, ...rest } = parsed;
      const metadataObj = (rest.metadata && typeof rest.metadata === 'object' && !Array.isArray(rest.metadata))
        ? rest.metadata as Record<string, unknown>
        : rest;
      return metadataObj;
    } catch {
      return {};
    }
  }
}
