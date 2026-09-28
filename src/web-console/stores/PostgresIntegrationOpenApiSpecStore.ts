import { and, eq } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { integrationOpenApiSpecs } from '../../database/schema/index.js';
import { assertUuid } from './ConsoleStoreValidation.js';
import {
  IntegrationSpecWriteError,
  cloneIntegrationOpenApiSpecRecord,
  type IIntegrationOpenApiSpecStore,
  type IntegrationOpenApiSpecRecord,
  type IntegrationOpenApiSpecUpsertInput,
  validateIntegrationOpenApiSpecInput,
  validateIntegrationOpenApiSpecRecord,
} from './IIntegrationOpenApiSpecStore.js';

export class PostgresIntegrationOpenApiSpecStore implements IIntegrationOpenApiSpecStore {
  constructor(private readonly db: DatabaseInstance) {}

  async findByDescriptorId(descriptorId: string): Promise<IntegrationOpenApiSpecRecord | null> {
    assertUuid(descriptorId, 'descriptorId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(integrationOpenApiSpecs).where(
        eq(integrationOpenApiSpecs.descriptorId, descriptorId),
      ).limit(1),
    );
    return rows[0] ? fromSpecRow(rows[0]) : null;
  }

  async deleteByDescriptorId(descriptorId: string): Promise<boolean> {
    assertUuid(descriptorId, 'descriptorId');
    const rows = await withSystemContext(this.db, tx =>
      tx.delete(integrationOpenApiSpecs).where(
        eq(integrationOpenApiSpecs.descriptorId, descriptorId),
      ).returning({ id: integrationOpenApiSpecs.id }),
    );
    return rows.length > 0;
  }

  async upsert(input: IntegrationOpenApiSpecUpsertInput): Promise<IntegrationOpenApiSpecRecord> {
    validateIntegrationOpenApiSpecInput(input);
    const rows = await withSystemContext(this.db, tx => {
      const insertValues = {
        descriptorId: input.descriptorId,
        spec: structuredClone(input.spec) as Record<string, unknown>,
        sourceUrl: input.sourceUrl ?? null,
        specHash: input.specHash,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };
      return tx.insert(integrationOpenApiSpecs).values(insertValues).onConflictDoUpdate({
        target: integrationOpenApiSpecs.descriptorId,
        set: {
          spec: insertValues.spec,
          sourceUrl: insertValues.sourceUrl,
          specHash: insertValues.specHash,
          updatedAt: insertValues.updatedAt,
        },
      }).returning();
    });
    if (!rows[0]) throw new Error('PostgreSQL did not return integration OpenAPI spec row');
    return fromSpecRow(rows[0]);
  }

  async create(input: IntegrationOpenApiSpecUpsertInput): Promise<IntegrationOpenApiSpecRecord> {
    validateIntegrationOpenApiSpecInput(input);
    const rows = await withSystemContext(this.db, tx => tx.insert(integrationOpenApiSpecs)
      .values({ ...input, spec: structuredClone(input.spec), sourceUrl: input.sourceUrl ?? null })
      .onConflictDoNothing({ target: integrationOpenApiSpecs.descriptorId }).returning());
    if (!rows[0]) throw new IntegrationSpecWriteError('exists');
    return fromSpecRow(rows[0]);
  }

  async update(input: IntegrationOpenApiSpecUpsertInput, expectedSpecHash?: string): Promise<IntegrationOpenApiSpecRecord> {
    validateIntegrationOpenApiSpecInput(input);
    const rows = await withSystemContext(this.db, tx => tx.update(integrationOpenApiSpecs).set({
      spec: structuredClone(input.spec), sourceUrl: input.sourceUrl ?? null,
      specHash: input.specHash, updatedAt: input.updatedAt,
    }).where(and(
      eq(integrationOpenApiSpecs.descriptorId, input.descriptorId),
      expectedSpecHash === undefined ? undefined : eq(integrationOpenApiSpecs.specHash, expectedSpecHash),
    )).returning());
    if (!rows[0]) {
      // Classify the failed write itself; a later lookup can observe a different row.
      throw new IntegrationSpecWriteError(expectedSpecHash === undefined ? 'missing' : 'conflict');
    }
    return fromSpecRow(rows[0]);
  }
}

function fromSpecRow(row: typeof integrationOpenApiSpecs.$inferSelect): IntegrationOpenApiSpecRecord {
  const record: IntegrationOpenApiSpecRecord = {
    id: row.id,
    descriptorId: row.descriptorId,
    spec: asJsonRecord(row.spec),
    sourceUrl: row.sourceUrl,
    specHash: row.specHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  validateIntegrationOpenApiSpecRecord(record);
  return cloneIntegrationOpenApiSpecRecord(record);
}

function asJsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
