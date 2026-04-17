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
import { eq, and, sql } from 'drizzle-orm';
import type { DatabaseInstance } from '../database/connection.js';
import { withUserContext } from '../database/rls.js';
import { elements } from '../database/schema/elements.js';
import type { UserIdResolver } from '../database/UserContext.js';
import { isUniqueViolation } from '../database/db-utils.js';
import { FrontmatterParser } from './FrontmatterParser.js';
import { RelationshipExtractor } from './RelationshipExtractor.js';
import { AbstractDatabaseStorageLayer } from './AbstractDatabaseStorageLayer.js';
import type { ElementWriteMetadata, WriteContentOptions } from './IStorageLayer.js';

// ── Constants ───────────────────────────────────────────────────────

const STORE_NAME = 'DatabaseStorageLayer';

/** Regex to split frontmatter from markdown body. */
const FRONTMATTER_REGEX = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

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

    const elementId = await withUserContext(this.db, this.userId, async (tx) => {
      // Build the column values once — both the insert and the upsert SET
      // reuse the same object so adding a column requires one change, not two.
      const values = {
        userId: this.userId,
        rawContent: content,
        bodyContent,
        contentHash,
        byteSize,
        elementType,
        name: elementName,
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
      // Build the SET clause from `values` but strip identity columns
      // (userId, elementType, name) — those are the conflict target — and
      // force updatedAt to NOW(). Extracting here keeps one source of truth
      // for all other fields.
      const buildUpdateSet = () => {
        const { userId: _u, elementType: _et, name: _n, ...rest } = values;
        return { ...rest, updatedAt: sql`NOW()` };
      };

      let rows;
      if (options?.exclusive) {
        // Atomic create-or-fail — mirrors file-mode createFileExclusive semantics.
        // Unique index on (user_id, element_type, name) raises 23505 on duplicate.
        try {
          rows = await tx.insert(elements).values(values).returning({ id: elements.id });
        } catch (err) {
          if (isUniqueViolation(err)) {
            // Use the caller-provided singular label (e.g. "Agent") so the
            // error matches the file-mode format. Fall back to capitalizing
            // the plural `elementType` only if no label was passed.
            const label = options?.elementLabel ?? capitalize(elementType);
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
        throw new Error(`[${STORE_NAME}] Upsert returned no row for ${elementType}/${elementName}`);
      }

      // Replace tags atomically within the same transaction
      const tags = metadata.tags.length > 0 ? metadata.tags : frontmatter.tags;
      await this.replaceTags(tx, row.id, tags);

      return row.id;
    });

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

  async deleteContent(elementType: string, name: string): Promise<void> {
    await withUserContext(this.db, this.userId, async (tx) => {
      await tx
        .delete(elements)
        .where(and(
          eq(elements.userId, this.userId),
          eq(elements.elementType, elementType),
          eq(elements.name, name),
        ));
    });

    this.removeIndex(name);

    this.logPersistEvent('ELEMENT_DELETED', 'MEDIUM', `${STORE_NAME}.deleteContent`,
      `Element deleted from database: ${elementType}/${name}`,
      { elementType, name });
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
  const match = rawContent.match(FRONTMATTER_REGEX);
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
