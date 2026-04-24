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
import { isUniqueViolation, type DrizzleTx } from '../database/db-utils.js';
import { MemoryMetadataExtractor } from './MemoryMetadataExtractor.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { AbstractDatabaseStorageLayer } from './AbstractDatabaseStorageLayer.js';
import { logger } from '../utils/logger.js';
import type { ElementIndexEntry } from './types.js';
import type { ElementWriteMetadata, WriteContentOptions } from './IStorageLayer.js';

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

// ── Implementation ──────────────────────────────────────────────────

export class DatabaseMemoryStorageLayer extends AbstractDatabaseStorageLayer {
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
            throw new Error(`${label} '${elementName}' already exists`);
          }
          throw err;
        }
      } else {
        rows = await tx
          .insert(elements)
          .values(values)
          .onConflictDoUpdate({
            target: [elements.userId, elements.elementType, elements.name],
            set: buildUpdateSet(),
          })
          .returning({ id: elements.id });
      }

      const row = rows[0];
      if (!row) {
        throw new Error(`[${STORE_NAME}] Upsert returned no row for memories/${elementName}`);
      }

      // Replace tags
      const tags = metadata.tags.length > 0 ? metadata.tags : (extracted.tags ?? []);
      await this.replaceTags(tx, row.id, tags);

      // Sync entries within the same transaction — no race window
      await this.syncEntriesInTx(tx, row.id, content);

      return row.id;
    });

    this.setIndex(elementName, elementId);

    this.logPersistEvent('ELEMENT_EDITED', 'LOW', `${STORE_NAME}.writeContent`,
      `Memory persisted to database: ${elementName}`,
      { elementId, name: elementName });

    return elementId;
  }

  async deleteContent(_elementType: string, name: string): Promise<void> {
    await withUserContext(this.db, this.userId, async (tx) => {
      await tx
        .delete(elements)
        .where(and(
          eq(elements.userId, this.userId),
          eq(elements.elementType, 'memories'),
          eq(elements.name, name),
        ));
      // Cascade handles memory_entries deletion
    });

    this.removeIndex(name);

    this.logPersistEvent('ELEMENT_DELETED', 'MEDIUM', `${STORE_NAME}.deleteContent`,
      `Memory deleted from database: ${name}`,
      { name });
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
  ): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      parsed = SecureYamlParser.parseRawYaml(yamlContent, 64 * 1024);
    } catch (err) {
      // Parse failure drops entries silently — element row still persists.
      // Log so operators see skipped entry sync and can investigate corrupted YAML.
      logger.warn(
        `[${STORE_NAME}] syncEntriesInTx: YAML parse failed for memory ${memoryElementId}, entries not synced`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      return;
    }

    const entries = parsed.entries;
    if (!Array.isArray(entries)) return;

    // Defense-in-depth: include userId alongside the RLS context. Every other
    // DELETE in this module does the same — syncEntriesInTx is the last one
    // that needed to be brought in line.
    await tx.delete(memoryEntries).where(and(
      eq(memoryEntries.userId, this.userId),
      eq(memoryEntries.memoryId, memoryElementId),
    ));

    if (entries.length === 0) return;

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
      tags: (Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === 'string') : []) as string[],
      entryMetadata: DatabaseMemoryStorageLayer.objectOrEmpty(e.metadata),
      privacyLevel: DatabaseMemoryStorageLayer.stringOrNull(e.privacyLevel),
      trustLevel: DatabaseMemoryStorageLayer.stringOrNull(e.trustLevel),
      source: typeof e.source === 'string' ? e.source : null,
      expiresAt: DatabaseMemoryStorageLayer.parseExpiresAt(e.expiresAt),
    };
  }

  private extractMemoryMetadata(content: string): Record<string, unknown> {
    try {
      const parsed = SecureYamlParser.parseRawYaml(content, 64 * 1024);
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
