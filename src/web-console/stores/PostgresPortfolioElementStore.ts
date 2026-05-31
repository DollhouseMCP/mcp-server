import { and, asc, eq, sql } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { portfolioElements } from '../../database/schema/index.js';
import {
  canonicalizePortfolioElementName,
  clonePortfolioElementDetailRecord,
  clonePortfolioElementSummaryRecord,
  PortfolioElementAlreadyExistsError,
  PortfolioElementVersionConflictError,
  type ConsolePortfolioElementCreateInput,
  type ConsolePortfolioElementDeleteInput,
  type ConsolePortfolioElementDetailRecord,
  type ConsolePortfolioElementSummaryRecord,
  type ConsolePortfolioElementType,
  type ConsolePortfolioElementUpdateInput,
  type ConsolePortfolioListFilters,
  type IPortfolioElementStore,
  validatePortfolioElementDetailRecord,
} from './IPortfolioElementStore.js';
import { assertUuid, isUniqueViolation } from './ConsoleStoreValidation.js';

export class PostgresPortfolioElementStore implements IPortfolioElementStore {
  constructor(private readonly db: DatabaseInstance) {}

  async summarizeByUser(userId: string): Promise<readonly ConsolePortfolioElementSummaryRecord[]> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(portfolioElements)
        .where(eq(portfolioElements.userId, userId))
        .orderBy(asc(portfolioElements.type), asc(portfolioElements.name)),
    );
    return rows.map(row => clonePortfolioElementSummaryRecord(fromRow(row)));
  }

  async listByUser(
    userId: string,
    filters: ConsolePortfolioListFilters = {},
  ): Promise<readonly ConsolePortfolioElementSummaryRecord[]> {
    assertUuid(userId, 'userId');
    const predicates = [eq(portfolioElements.userId, userId)];
    if (filters.type) predicates.push(eq(portfolioElements.type, filters.type));
    if (filters.tag) {
      predicates.push(sql`lower(${filters.tag}) = ANY(SELECT lower(unnest(${portfolioElements.tags})))`);
    }
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(portfolioElements)
        .where(and(...predicates))
        .orderBy(asc(portfolioElements.type), asc(portfolioElements.name)),
    );
    return rows.map(row => clonePortfolioElementSummaryRecord(fromRow(row)));
  }

  async findByName(
    userId: string,
    type: ConsolePortfolioElementType,
    canonicalName: string,
  ): Promise<ConsolePortfolioElementDetailRecord | null> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(portfolioElements)
        .where(elementIdentity(userId, type, canonicalName))
        .limit(1),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async create(input: ConsolePortfolioElementCreateInput): Promise<ConsolePortfolioElementDetailRecord> {
    const canonicalName = canonicalizePortfolioElementName(input.name);
    const record: ConsolePortfolioElementDetailRecord = {
      userId: input.userId,
      type: input.type,
      name: canonicalName,
      canonicalName,
      displayName: input.displayName,
      version: 1,
      updatedAt: input.now,
      validationStatus: 'valid',
      tags: [...input.tags],
      metadata: input.metadata,
      content: input.content,
    };
    validatePortfolioElementDetailRecord(record);
    try {
      const rows = await withSystemContext(this.db, tx =>
        tx.insert(portfolioElements).values({
          userId: record.userId,
          type: record.type,
          name: record.name,
          canonicalName: record.canonicalName,
          displayName: record.displayName,
          version: record.version,
          updatedAt: record.updatedAt,
          validationStatus: record.validationStatus,
          tags: [...record.tags],
          metadata: record.metadata,
          content: record.content,
        }).returning(),
      );
      if (!rows[0]) throw new Error('PostgreSQL did not return inserted portfolio element row');
      return fromRow(rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new PortfolioElementAlreadyExistsError();
      throw error;
    }
  }

  async update(input: ConsolePortfolioElementUpdateInput): Promise<ConsolePortfolioElementDetailRecord | null> {
    assertUuid(input.userId, 'userId');
    const patch: Partial<typeof portfolioElements.$inferInsert> = {
      version: input.expectedVersion + 1,
      updatedAt: input.now,
      validationStatus: 'valid',
    };
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.metadata !== undefined) patch.metadata = input.metadata;
    if (input.content !== undefined) patch.content = input.content;
    if (input.tags !== undefined) patch.tags = [...input.tags];
    const rows = await withSystemContext(this.db, tx =>
      tx.update(portfolioElements)
        .set(patch)
        .where(and(
          elementIdentity(input.userId, input.type, input.canonicalName),
          eq(portfolioElements.version, input.expectedVersion),
        ))
        .returning(),
    );
    if (rows[0]) return fromRow(rows[0]);
    if (await this.findByName(input.userId, input.type, input.canonicalName)) {
      throw new PortfolioElementVersionConflictError();
    }
    return null;
  }

  async delete(input: ConsolePortfolioElementDeleteInput): Promise<ConsolePortfolioElementDetailRecord | null> {
    assertUuid(input.userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.delete(portfolioElements)
        .where(and(
          elementIdentity(input.userId, input.type, input.canonicalName),
          eq(portfolioElements.version, input.expectedVersion),
        ))
        .returning(),
    );
    if (rows[0]) {
      return clonePortfolioElementDetailRecord({
        ...fromRow(rows[0]),
        version: rows[0].version + 1,
        updatedAt: input.now,
      });
    }
    if (await this.findByName(input.userId, input.type, input.canonicalName)) {
      throw new PortfolioElementVersionConflictError();
    }
    return null;
  }
}

function elementIdentity(
  userId: string,
  type: ConsolePortfolioElementType,
  canonicalName: string,
) {
  return and(
    eq(portfolioElements.userId, userId),
    eq(portfolioElements.type, type),
    eq(portfolioElements.canonicalName, canonicalName),
  );
}

function fromRow(row: typeof portfolioElements.$inferSelect): ConsolePortfolioElementDetailRecord {
  const record: ConsolePortfolioElementDetailRecord = {
    userId: row.userId,
    type: row.type,
    name: row.name,
    canonicalName: row.canonicalName,
    displayName: row.displayName,
    version: row.version,
    updatedAt: row.updatedAt,
    validationStatus: row.validationStatus,
    tags: [...row.tags],
    metadata: asJsonRecord(row.metadata),
    content: row.content,
  };
  validatePortfolioElementDetailRecord(record);
  return clonePortfolioElementDetailRecord(record);
}

function asJsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
