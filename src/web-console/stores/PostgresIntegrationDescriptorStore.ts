import { and, asc, eq, or, sql } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { integrationProviderDescriptors } from '../../database/schema/index.js';
import {
  cloneIntegrationDescriptorRecord,
  type IIntegrationDescriptorStore,
  type IntegrationDescriptorCreateInput,
  type IntegrationDescriptorRecord,
  type IntegrationOAuthDescriptor,
  type IntegrationStaticApiKeyDescriptor,
  validateIntegrationDescriptorInput,
  validateIntegrationDescriptorRecord,
} from './IIntegrationDescriptorStore.js';
import type { UserIntegrationProvider } from './IUserIntegrationStore.js';
import { assertUuid } from './ConsoleStoreValidation.js';

export class PostgresIntegrationDescriptorStore implements IIntegrationDescriptorStore {
  constructor(private readonly db: DatabaseInstance) {}

  async listVisible(userId: string): Promise<readonly IntegrationDescriptorRecord[]> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(integrationProviderDescriptors).where(or(
        eq(integrationProviderDescriptors.ownership, 'curated'),
        eq(integrationProviderDescriptors.ownerUserId, userId),
      )).orderBy(asc(integrationProviderDescriptors.provider)).limit(100),
    );
    return rows.map(fromDescriptorRow);
  }

  async findVisibleByProvider(
    userId: string,
    provider: UserIntegrationProvider,
  ): Promise<IntegrationDescriptorRecord | null> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(integrationProviderDescriptors).where(and(
        eq(integrationProviderDescriptors.provider, provider),
        or(
          eq(integrationProviderDescriptors.ownership, 'curated'),
          eq(integrationProviderDescriptors.ownerUserId, userId),
        ),
      )).limit(2),
    );
    const preferred = rows.find(row => row.ownership === 'byo' && row.ownerUserId === userId)
      ?? rows.find(row => row.ownership === 'curated');
    return preferred ? fromDescriptorRow(preferred) : null;
  }

  async upsert(input: IntegrationDescriptorCreateInput): Promise<IntegrationDescriptorRecord> {
    validateIntegrationDescriptorInput(input);
    const rows = await withSystemContext(this.db, tx => {
      const insert = tx.insert(integrationProviderDescriptors).values(toDescriptorInsertValues(input));
      const set = toDescriptorUpdateValues(input);
      if (input.ownership === 'curated') {
        return insert.onConflictDoUpdate({
          target: integrationProviderDescriptors.provider,
          targetWhere: sql`${integrationProviderDescriptors.ownership} = 'curated'`,
          set,
        }).returning();
      }
      return insert.onConflictDoUpdate({
        target: [integrationProviderDescriptors.ownerUserId, integrationProviderDescriptors.provider],
        targetWhere: sql`${integrationProviderDescriptors.ownership} = 'byo'`,
        set,
      }).returning();
    });
    if (!rows[0]) throw new Error('PostgreSQL did not return integration descriptor row');
    return fromDescriptorRow(rows[0]);
  }
}

function toDescriptorInsertValues(input: IntegrationDescriptorCreateInput) {
  return {
    provider: input.provider,
    ownership: input.ownership,
    ownerUserId: input.ownerUserId,
    displayName: input.displayName,
    category: input.category,
    authStrategy: input.authStrategy,
    apiHosts: [...input.apiHosts],
    oauth: input.oauth ? cloneJsonValue(input.oauth) : null,
    staticApiKey: input.staticApiKey ? cloneJsonValue(input.staticApiKey) : null,
    clientSecretCiphertext: input.clientSecretCiphertext ? Buffer.from(input.clientSecretCiphertext) : null,
    credentialKeyVersion: input.credentialKeyVersion ?? null,
    operationPromotion: cloneJsonValue(input.operationPromotion ?? {}),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function toDescriptorUpdateValues(input: IntegrationDescriptorCreateInput) {
  const values = toDescriptorInsertValues(input);
  return {
    displayName: values.displayName,
    category: values.category,
    authStrategy: values.authStrategy,
    apiHosts: values.apiHosts,
    oauth: values.oauth,
    staticApiKey: values.staticApiKey,
    clientSecretCiphertext: values.clientSecretCiphertext,
    credentialKeyVersion: values.credentialKeyVersion,
    operationPromotion: values.operationPromotion,
    updatedAt: values.updatedAt,
  };
}

function fromDescriptorRow(row: typeof integrationProviderDescriptors.$inferSelect): IntegrationDescriptorRecord {
  const record: IntegrationDescriptorRecord = {
    id: row.id,
    provider: row.provider,
    ownership: row.ownership,
    ownerUserId: row.ownerUserId,
    displayName: row.displayName,
    category: row.category,
    authStrategy: row.authStrategy,
    apiHosts: Array.isArray(row.apiHosts) ? row.apiHosts.filter((item): item is string => typeof item === 'string') : [],
    oauth: asNullableOAuth(row.oauth),
    staticApiKey: asNullableStaticApiKey(row.staticApiKey),
    clientSecretCiphertext: row.clientSecretCiphertext,
    credentialKeyVersion: row.credentialKeyVersion,
    operationPromotion: asJsonRecord(row.operationPromotion),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  validateIntegrationDescriptorRecord(record);
  return cloneIntegrationDescriptorRecord(record);
}

function asNullableOAuth(value: unknown): IntegrationOAuthDescriptor | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as IntegrationOAuthDescriptor
    : null;
}

function asNullableStaticApiKey(value: unknown): IntegrationStaticApiKeyDescriptor | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as IntegrationStaticApiKeyDescriptor
    : null;
}

function asJsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cloneJsonValue(value: unknown): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}
