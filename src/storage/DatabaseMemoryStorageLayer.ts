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

import { createHash } from 'node:crypto';
import { eq, and, gt, lt, sql, desc, inArray, arrayOverlaps } from 'drizzle-orm';
import type { DatabaseInstance } from '../database/connection.js';
import { withUserContext, withUserRead } from '../database/rls.js';
import { elements } from '../database/schema/elements.js';
import { memoryEntries } from '../database/schema/memories.js';
import type { UserIdResolver } from '../database/UserContext.js';
import { isSerializationFailure, isUniqueViolation, type DrizzleTx } from '../database/db-utils.js';
import { MemoryMetadataExtractor } from './MemoryMetadataExtractor.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';
import { validateMemoryControlFields } from '../elements/memories/memoryYamlValidation.js';
import { AbstractDatabaseStorageLayer } from './AbstractDatabaseStorageLayer.js';
import { logger } from '../utils/logger.js';
import type { ElementIndexEntry } from './types.js';
import type { ElementWriteMetadata, WriteContentOptions } from './IStorageLayer.js';
import type { IMemoryHeadStore, MemoryHeadSnapshot, MemoryHeadToken } from './IMemoryHeadStore.js';

// ── Constants ───────────────────────────────────────────────────────

const STORE_NAME = 'DatabaseMemoryStorageLayer';
const MAX_STORAGE_REVISION = 9223372036854775807n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface ExpectedHeadWrite {
  readonly token: MemoryHeadToken;
  readonly revision: bigint;
}

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

// ── Implementation ──────────────────────────────────────────────────

export class DatabaseMemoryStorageLayer extends AbstractDatabaseStorageLayer implements IMemoryHeadStore {
  constructor(db: DatabaseInstance, getCurrentUserId: UserIdResolver) {
    super(db, getCurrentUserId, 'memories');
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

  async readHeadSnapshot(storageLocator: string): Promise<MemoryHeadSnapshot> {
    const userId = this.userId;
    if (!UUID_PATTERN.test(storageLocator)) {
      const error = new Error('Memory head not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    // Content and token come from one row in one RLS-scoped SELECT. A later
    // identity probe would allow the content and revision to describe different
    // writes, which is unsafe for a conditional whole-head save.
    const rows = await withUserRead(this.db, userId, tx => tx
      .select({
        id: elements.id,
        name: elements.name,
        content: elements.rawContent,
        revision: elements.storageRevision,
        outOfSync: elements.memoryEntriesOutOfSync,
      })
      .from(elements)
      .where(and(
        eq(elements.userId, userId),
        eq(elements.elementType, 'memories'),
        eq(elements.id, storageLocator),
      ))
      .limit(1));
    const row = rows[0];
    if (!row) {
      const error = new Error('Memory head not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    if (row.outOfSync) throw this.createOutOfSyncError(row.name, row.id);
    return {
      content: row.content,
      token: {
        backend: 'database', userId, ownerId: row.id, locator: row.id,
        name: row.name, revision: row.revision.toString(),
      },
    };
  }

  async writeHeadIfCurrent(
    expected: MemoryHeadToken,
    nextName: string,
    content: string,
    metadata: ElementWriteMetadata,
  ): Promise<MemoryHeadToken> {
    const userId = this.userId;
    const token = { ...expected };
    const revision = this.parseExpectedRevision(token, userId);
    if (typeof nextName !== 'string' || !nextName) {
      throw new TypeError('Memory head name must be a non-empty string');
    }
    const inputMetadata = { ...metadata, tags: [...metadata.tags] };
    let result: { id: string; revision?: bigint };
    try {
      result = await this.persistMemoryContent(userId, nextName, content, inputMetadata, undefined, {
        token, revision,
      });
    } catch (cause) {
      if (!isSerializationFailure(cause)) throw cause;
      // PostgreSQL rolled back the whole transaction. The caller must retain
      // its unsaved head and reread before deciding whether to retry.
      const error = new Error('Memory head save conflicted; keep the pending changes and reload before retrying',
        { cause }) as NodeJS.ErrnoException;
      error.code = 'EHEADCONFLICT';
      throw error;
    }
    return {
      backend: 'database', userId, ownerId: result.id, locator: result.id,
      name: nextName, revision: result.revision!.toString(),
    };
  }

  async writeContent(
    _elementType: string,
    name: string,
    content: string,
    metadata: ElementWriteMetadata,
    options?: WriteContentOptions,
  ): Promise<string> {
    const userId = this.userId;
    const inputMetadata = { ...metadata, tags: [...metadata.tags] };
    const writeOptions = options && {
      ...options,
      expectedIdentity: options.expectedIdentity && { ...options.expectedIdentity },
    };
    const result = await this.persistMemoryContent(userId, name, content, inputMetadata, writeOptions);
    return result.id;
  }

  private async persistMemoryContent(
    userId: string,
    name: string,
    content: string,
    metadata: ElementWriteMetadata,
    options?: WriteContentOptions,
    expectedHead?: ExpectedHeadWrite,
  ): Promise<{ id: string; revision?: bigint }> {
    const extracted = MemoryMetadataExtractor.extractMetadata(content, name);
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
    const byteSize = Buffer.byteLength(content, 'utf8');

    // Use the caller-provided name as authoritative, falling back to extracted
    const elementName = name || extracted.name || 'unnamed';

    const saved = await withUserContext(this.db, userId, async (tx) => {
      // Build the column values once; both insert and upsert-SET reuse the
      // same object so adding a column is a one-line change, not two.
      const values = {
        userId,
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
      const rows = await this.writeElementRow(tx, values, options, userId, expectedHead);

      const row = rows.at(0);
      if (!row) {
        throw new Error(`[${STORE_NAME}] Upsert returned no row for memories/${elementName}`);
      }

      // Replace tags
      const tags = metadata.tags.length > 0 ? metadata.tags : (extracted.tags ?? []);
      await this.replaceTags(tx, row.id, tags, userId);

      // Qualify the raw head against its child projection in this transaction.
      // A malformed/unsynchronized head cannot receive a trusted new token.
      const synchronized = await this.syncEntriesInTx(tx, row.id, content, userId, !!expectedHead);
      if (expectedHead && !synchronized) {
        throw this.createOutOfSyncError(elementName, row.id);
      }
      if (synchronized) {
        await tx.update(elements)
          .set({ memoryEntriesOutOfSync: false })
          .where(and(eq(elements.userId, userId), eq(elements.id, row.id)));
      }

      if (!expectedHead) return { id: row.id };
      // Child-entry triggers can advance the revision after the parent UPDATE.
      // Read the final value inside this transaction, then return it only once
      // withUserContext has committed the whole head, tags, and entries.
      const revisionRows = await tx
        .select({ revision: elements.storageRevision })
        .from(elements)
        .where(and(eq(elements.userId, userId), eq(elements.id, row.id)))
        .limit(1);
      const revision = revisionRows[0]?.revision;
      if (revision === undefined) {
        throw this.createStaleWriteError(elementName, row.id);
      }
      return { id: row.id, revision };
    });

    if (expectedHead && expectedHead.token.name !== elementName) {
      this.removeIndexById(saved.id, userId);
    }
    this.setIndex(elementName, saved.id, userId);

    this.logPersistEvent('ELEMENT_EDITED', 'LOW', `${STORE_NAME}.writeContent`,
      `Memory persisted to database: ${elementName}`,
      { elementId: saved.id, name: elementName });

    return saved;
  }

  private async writeElementRow(
    tx: DrizzleTx,
    values: typeof elements.$inferInsert,
    options: WriteContentOptions | undefined,
    userId: string,
    expectedHead?: ExpectedHeadWrite,
  ): Promise<Array<{ id: string }>> {
    // SET derives from the inserted values, without identity columns. The
    // guarded path mirrors DatabaseStorageLayer's exact-row lifecycle update.
    const { userId: _u, elementType: _et, name: _n, ...rest } = values;
    const updateSet = { ...rest, updatedAt: sql`NOW()` };

    if (expectedHead) {
      const { token, revision } = expectedHead;
      const rows = await tx
        .update(elements)
        .set({ ...updateSet, name: values.name })
        .where(and(
          eq(elements.userId, userId),
          eq(elements.elementType, 'memories'),
          eq(elements.id, token.ownerId),
          eq(elements.name, token.name),
          eq(elements.storageRevision, revision),
          eq(elements.memoryEntriesOutOfSync, false),
        ))
        .returning({ id: elements.id });
      if (rows.length !== 1) {
        throw this.createStaleWriteError(token.name, token.ownerId);
      }
      return rows;
    }

    if (options?.expectedIdentity) {
      const expected = options.expectedIdentity;
      if (expected.name !== values.name) {
        throw this.createStaleWriteError(values.name, expected.id);
      }
      const rows = await tx
        .update(elements)
        .set(updateSet)
        .where(and(
          eq(elements.userId, userId),
          eq(elements.elementType, 'memories'),
          eq(elements.id, expected.id),
          eq(elements.name, expected.name),
        ))
        .returning({ id: elements.id });
      if (rows.length !== 1) {
        throw this.createStaleWriteError(values.name, expected.id);
      }
      return rows;
    }

    if (options?.exclusive) {
      // Atomic create-or-fail — mirrors file-mode createFileExclusive semantics.
      try {
        return await tx.insert(elements).values(values).returning({ id: elements.id });
      } catch (err) {
        if (isUniqueViolation(err)) {
          const label = options.elementLabel ?? 'Memory';
          throw new Error(`${label} '${values.name}' already exists`);
        }
        throw err;
      }
    }

    return tx
      .insert(elements)
      .values(values)
      .onConflictDoUpdate({
        target: [elements.userId, elements.elementType, elements.name],
        set: updateSet,
      })
      .returning({ id: elements.id });
  }

  private createStaleWriteError(name: string, expectedId: string): NodeJS.ErrnoException {
    const error = new Error(
      `Memory not found or identity changed during save: ${name}; expected row ${expectedId}`,
    ) as NodeJS.ErrnoException;
    error.code = 'ESTALE';
    return error;
  }

  private createOutOfSyncError(name: string, ownerId: string): NodeJS.ErrnoException {
    const error = new Error(
      `Memory head and entry projection require reconciliation: ${name}; row ${ownerId}`,
    ) as NodeJS.ErrnoException;
    error.code = 'EHEADOUTOFSYNC';
    return error;
  }

  private parseExpectedRevision(token: MemoryHeadToken, userId: string): bigint {
    if (
      token.backend !== 'database' || token.userId !== userId ||
      typeof token.ownerId !== 'string' || typeof token.locator !== 'string' ||
      token.locator !== token.ownerId || !UUID_PATTERN.test(token.ownerId) ||
      typeof token.name !== 'string' || !token.name ||
      typeof token.revision !== 'string' || token.revision.length > 19 ||
      !/^[1-9][0-9]*$/u.test(token.revision)
    ) {
      throw this.createStaleWriteError(token.name, token.ownerId);
    }
    const revision = BigInt(token.revision);
    if (revision > MAX_STORAGE_REVISION) {
      throw this.createStaleWriteError(token.name, token.ownerId);
    }
    return revision;
  }

  async deleteContent(_elementType: string, name: string): Promise<void> {
    await this.deleteContentByIdentity('memories', name);
  }

  // ── Entry-Level Operations ────────────────────────────────────────

  async addEntry(memoryElementId: string, entry: MemoryEntryData): Promise<void> {
    await withUserContext(this.db, this.userId, async (tx) => {
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
        .orderBy(desc(memoryEntries.timestamp))
        .limit(options?.limit ?? DEFAULT_ENTRY_QUERY_LIMIT);

      return rows.map(row => ({
        entryId: row.entryId,
        timestamp: row.timestamp,
        content: row.content,
        sanitizedContent: row.sanitizedContent ?? undefined,
        sanitizedPatterns: (row.sanitizedPatterns && typeof row.sanitizedPatterns === 'object')
          ? row.sanitizedPatterns as Record<string, unknown> : undefined,
        tags: (Array.isArray(row.tags)) ? row.tags : undefined,
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
      // Defense-in-depth: include userId even though RLS enforces it.
      await tx
        .delete(memoryEntries)
        .where(and(
          eq(memoryEntries.userId, this.userId),
          eq(memoryEntries.memoryId, memoryElementId),
          eq(memoryEntries.entryId, entryId),
        ));
    });
  }

  async purgeExpiredEntries(): Promise<number> {
    return withUserContext(this.db, this.userId, async (tx) => {
      const deleted = await tx
        .delete(memoryEntries)
        .where(and(
          eq(memoryEntries.userId, this.userId),
          sql`${memoryEntries.expiresAt} IS NOT NULL AND ${memoryEntries.expiresAt} < NOW()`,
        ))
        .returning({ id: memoryEntries.id });
      return deleted.length;
    });
  }

  // ── Private ───────────────────────────────────────────────────────

  /**
   * Sync entries from YAML content into memory_entries table.
   * Runs inside the caller's transaction for atomicity — element upsert,
   * tag replacement, and entry sync all commit or rollback together.
   */
  private async syncEntriesInTx(
    tx: DrizzleTx,
    memoryElementId: string,
    yamlContent: string,
    userId: string,
    strict: boolean,
  ): Promise<boolean> {
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
      // Parse failure drops entries silently — element row still persists.
      // Log so operators see skipped entry sync and can investigate corrupted YAML.
      logger.warn(
        `[${STORE_NAME}] syncEntriesInTx: YAML parse failed for memory ${memoryElementId}, entries not synced`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      return false;
    }

    const entries = parsed.entries;
    if (entries === undefined) {
      const existing = await tx.select({ id: memoryEntries.id }).from(memoryEntries).where(and(
        eq(memoryEntries.userId, userId), eq(memoryEntries.memoryId, memoryElementId),
      )).limit(1);
      return existing.length === 0;
    }
    if (!Array.isArray(entries)) return false;
    if (strict && entries.some(entry => !entry || typeof entry !== 'object' ||
      typeof (entry as Record<string, unknown>).id !== 'string' ||
      typeof (entry as Record<string, unknown>).content !== 'string' ||
      !(entry as Record<string, unknown>).content)) return false;

    // Defense-in-depth: include userId alongside the RLS context. Every other
    // DELETE in this module does the same — syncEntriesInTx is the last one
    // that needed to be brought in line.
    await tx.delete(memoryEntries).where(and(
      eq(memoryEntries.userId, userId),
      eq(memoryEntries.memoryId, memoryElementId),
    ));

    if (entries.length === 0) return true;

    const rows = entries.flatMap((entry, idx) => {
      if (!entry || typeof entry !== 'object') return [];
      const e = entry as Record<string, unknown>;
      const content = typeof e.content === 'string' ? e.content : '';
      if (!content) return [];
      return [this.buildEntryRow(e, idx, memoryElementId, content, userId)];
    });

    if (strict && rows.length !== entries.length) return false;

    if (rows.length > 0) {
      await tx.insert(memoryEntries).values(rows);
    }
    return rows.length === entries.length;
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
    userId: string,
  ) {
    return {
      userId,
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
