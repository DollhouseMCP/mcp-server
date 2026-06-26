import { eq } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { integrationOpenApiSpecs } from '../../database/schema/index.js';
import { assertUuid } from './ConsoleStoreValidation.js';
import {
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

  async upsert(input: IntegrationOpenApiSpecUpsertInput): Promise<IntegrationOpenApiSpecRecord> {
    validateIntegrationOpenApiSpecInput(input);
    const rows = await withSystemContext(this.db, async tx => {
      const existing = await tx.select().from(integrationOpenApiSpecs).where(
        eq(integrationOpenApiSpecs.descriptorId, input.descriptorId),
      ).limit(1);
      const values = {
        descriptorId: input.descriptorId,
        spec: structuredClone(input.spec) as Record<string, unknown>,
        sourceUrl: input.sourceUrl ?? null,
        specHash: input.specHash,
        createdAt: existing[0]?.createdAt ?? input.createdAt,
        updatedAt: input.updatedAt,
      };
      if (existing[0]) {
        return tx.update(integrationOpenApiSpecs)
          .set(values)
          .where(eq(integrationOpenApiSpecs.id, existing[0].id))
          .returning();
      }
      return tx.insert(integrationOpenApiSpecs).values(values).returning();
    });
    if (!rows[0]) throw new Error('PostgreSQL did not return integration OpenAPI spec row');
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
