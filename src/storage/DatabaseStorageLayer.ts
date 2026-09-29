/**
 * Database-Backed Storage Layer
 *
 * Extends AbstractDatabaseStorageLayer for non-memory element types
 * (personas, skills, templates, agents, ensembles). The database
 * IS the persistence mechanism — there are no filesystem operations.
 *
 * Strategy C hybrid: raw_content is source of truth, extracted
 * metadata columns enable efficient queries. Tags are stored in
 * a separate table and managed atomically with the element row.
 *
 * @since v2.2.0 — Phase 4, Step 4.3
 */

import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { DatabaseInstance } from '../database/connection.js';
import { withUserContext } from '../database/rls.js';
import { elements } from '../database/schema/elements.js';
import type { UserIdResolver } from '../database/UserContext.js';
import { getErrorCode, isUniqueViolation, type DrizzleTx } from '../database/db-utils.js';
import { FrontmatterParser, type FrontmatterData } from './FrontmatterParser.js';
import { RelationshipExtractor } from './RelationshipExtractor.js';
import { AbstractDatabaseStorageLayer } from './AbstractDatabaseStorageLayer.js';
import type { ElementWriteMetadata, WriteContentOptions } from './IStorageLayer.js';

// ── Constants ───────────────────────────────────────────────────────

const STORE_NAME = 'DatabaseStorageLayer';

/** Regex to split frontmatter from markdown body. */
const FRONTMATTER_REGEX = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

interface PreparedElementWrite {
  userId: string;
  elementType: string;
  elementName: string;
  content: string;
  contentHash: string;
  byteSize: number;
  bodyContent: string | null;
  frontmatter: FrontmatterData;
}

interface ElementWriteValues {
  userId: string;
  rawContent: string;
  bodyContent: string | null;
  contentHash: string;
  byteSize: number;
  elementType: string;
  name: string;
  description: string;
  version: string;
  author: string;
  elementCreated: string | null;
  metadata: Record<string, unknown>;
  visibility: string;
  memoryType: string | null;
  autoLoad: boolean | null;
  priority: number | null;
}

interface ElementIdRow {
  id: string;
}

// ── Implementation ──────────────────────────────────────────────────

export class DatabaseStorageLayer extends AbstractDatabaseStorageLayer {
  private readonly relationshipExtractor: RelationshipExtractor;

  constructor(db: DatabaseInstance, getCurrentUserId: UserIdResolver, elementType: string) {
    super(db, getCurrentUserId, elementType);
    this.relationshipExtractor = new RelationshipExtractor(db, getCurrentUserId);
  }

  // ── IWritableStorageLayer ─────────────────────────────────────────

  async writeContent(
    elementType: string,
    name: string,
    content: string,
    metadata: ElementWriteMetadata,
    options?: WriteContentOptions,
  ): Promise<string> {
    const frontmatter = FrontmatterParser.extractMetadata(content);
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
    const byteSize = Buffer.byteLength(content, 'utf8');
    const bodyContent = extractBodyContent(content);

    // Use the caller-provided name as authoritative, falling back to frontmatter
    const elementName = name || frontmatter.name;

    const userId = this.userId;
    let elementId: string;
    try {
      elementId = await withUserContext(this.db, userId, tx => this.persistContentInTransaction(
        tx,
        {
          userId,
          elementType,
          elementName,
          content,
          contentHash,
          byteSize,
          bodyContent,
          frontmatter,
        },
        metadata,
        options,
      ));
    } catch (error) {
      if (getErrorCode(error) !== 'ESTALE') throw error;
      if ((error as { code?: unknown }).code === 'ESTALE') throw error;
      throw this.createStaleWriteError(
        elementType,
        elementName,
        options?.expectedIdentity,
        error,
      );
    }

    // Update in-memory index
    this.setIndex(elementName, elementId);

    // Best-effort relationship extraction (soft integrity — runs after core commit)
    this.relationshipExtractor.extractAndPersist(elementId, elementType, frontmatter)
      .catch(() => { /* errors handled inside extractAndPersist */ });

    this.logPersistEvent('ELEMENT_EDITED', 'LOW', `${STORE_NAME}.writeContent`,
      `Element persisted to database: ${elementType}/${elementName}`,
      { elementId, elementType, name: elementName });

    return elementId;
  }

  private async persistContentInTransaction(
    tx: DrizzleTx,
    prepared: PreparedElementWrite,
    metadata: ElementWriteMetadata,
    options?: WriteContentOptions,
  ): Promise<string> {
    const values = this.buildElementWriteValues(prepared, metadata);
    const rows = await this.writeElementRow(tx, values, options);
    const row = rows[0];
    if (!row) {
      throw new Error(
        `[${STORE_NAME}] Upsert returned no row for ${prepared.elementType}/${prepared.elementName}`,
      );
    }

    // Replace tags atomically within the same transaction.
    const tags = metadata.tags.length > 0 ? metadata.tags : prepared.frontmatter.tags;
    await this.replaceTags(tx, row.id, tags);
    return row.id;
  }

  private buildElementWriteValues(
    prepared: PreparedElementWrite,
    metadata: ElementWriteMetadata,
  ): ElementWriteValues {
    const { frontmatter } = prepared;
    return {
      userId: prepared.userId,
      rawContent: prepared.content,
      bodyContent: prepared.bodyContent,
      contentHash: prepared.contentHash,
      byteSize: prepared.byteSize,
      elementType: prepared.elementType,
      name: prepared.elementName,
      description: metadata.description || frontmatter.description,
      version: metadata.version || frontmatter.version,
      author: metadata.author || frontmatter.author,
      elementCreated: typeof frontmatter.created === 'string' ? frontmatter.created : null,
      metadata: extractTypeSpecificMetadata(frontmatter),
      visibility: metadata.visibility ?? 'private',
      memoryType: typeof frontmatter.memoryType === 'string' ? frontmatter.memoryType : null,
      autoLoad: typeof frontmatter.autoLoad === 'boolean' ? frontmatter.autoLoad : null,
      priority: typeof frontmatter.priority === 'number' ? frontmatter.priority : null,
    };
  }

  private writeElementRow(
    tx: DrizzleTx,
    values: ElementWriteValues,
    options?: WriteContentOptions,
  ): Promise<ElementIdRow[]> {
    if (options?.expectedIdentity) {
      return this.updateExpectedElementRow(tx, values, options.expectedIdentity);
    }
    if (options?.exclusive) {
      return this.insertElementRowExclusive(tx, values, options.elementLabel);
    }
    return tx
      .insert(elements)
      .values(values)
      .onConflictDoUpdate({
        target: [elements.userId, elements.elementType, elements.name],
        set: this.buildElementUpdateSet(values),
      })
      .returning({ id: elements.id });
  }

  private async updateExpectedElementRow(
    tx: DrizzleTx,
    values: ElementWriteValues,
    expected: NonNullable<WriteContentOptions['expectedIdentity']>,
  ): Promise<ElementIdRow[]> {
    if (expected.name !== values.name) {
      throw this.createStaleWriteError(values.elementType, values.name, expected);
    }
    const rows = await tx
      .update(elements)
      .set(this.buildElementUpdateSet(values))
      .where(and(
        eq(elements.userId, values.userId),
        eq(elements.elementType, values.elementType),
        eq(elements.id, expected.id),
        eq(elements.name, expected.name),
      ))
      .returning({ id: elements.id });
    if (rows.length !== 1) {
      throw this.createStaleWriteError(values.elementType, values.name, expected);
    }
    return rows;
  }

  private async insertElementRowExclusive(
    tx: DrizzleTx,
    values: ElementWriteValues,
    elementLabel?: string,
  ): Promise<ElementIdRow[]> {
    // Atomic create-or-fail — mirrors file-mode createFileExclusive semantics.
    // Unique index on (user_id, element_type, name) raises 23505 on duplicate.
    try {
      return await tx.insert(elements).values(values).returning({ id: elements.id });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const label = elementLabel ?? capitalize(values.elementType);
        throw new Error(`${label} '${values.name}' already exists`);
      }
      throw error;
    }
  }

  private buildElementUpdateSet(values: ElementWriteValues) {
    const { userId: _u, elementType: _et, name: _n, ...rest } = values;
    return { ...rest, updatedAt: sql`NOW()` };
  }

  private createStaleWriteError(
    elementType: string,
    name: string,
    expectedIdentity?: { id: string },
    cause?: unknown,
  ): NodeJS.ErrnoException {
    const expected = expectedIdentity ? `; expected row ${expectedIdentity.id}` : '';
    const error = new Error(
      `Element not found or identity changed during save: ${elementType}/${name}${expected}`,
      { cause: cause instanceof Error ? cause : undefined },
    ) as NodeJS.ErrnoException;
    error.code = 'ESTALE';
    return error;
  }

  async deleteContent(elementType: string, name: string): Promise<void> {
    try {
      await this.deleteContentByIdentity(elementType, name);
    } catch (error) {
      // Preserve the legacy best-effort contract: a row hidden by RLS is
      // indistinguishable from a missing row and must remain a silent no-op.
      // Lifecycle callers use deleteContentByIdentity directly when ENOENT is
      // required to detect a stale or missing authorized target.
      if (getErrorCode(error) === 'ENOENT') return;
      throw error;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Capitalize the first character of a string. Used to match the pre-refactor
 * error-message format ("Agent 'x' already exists", not "agents 'x'...").
 */
function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * Extract the body content (everything after YAML frontmatter).
 * Returns null for files without frontmatter.
 */
function extractBodyContent(rawContent: string): string | null {
  const match = FRONTMATTER_REGEX.exec(rawContent);
  if (!match) return null;
  const body = rawContent.slice(match[0].length).trim();
  return body.length > 0 ? body : null;
}

/**
 * Extract type-specific metadata fields into the JSONB metadata column.
 * Standard fields go into dedicated columns; everything else → metadata.
 */
function extractTypeSpecificMetadata(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const { name, description, version, author, tags, created, ...rest } = frontmatter;
  return rest;
}
