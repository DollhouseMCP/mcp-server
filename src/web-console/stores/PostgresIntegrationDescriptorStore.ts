import { and, asc, desc, eq, gt, isNull, or } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { integrationProviderDescriptors } from '../../database/schema/index.js';
import {
  cloneIntegrationDescriptorRecord,
  decodeDescriptorPageCursor,
  encodeDescriptorPageCursor,
  resolveDescriptorPageLimit,
  type IIntegrationDescriptorStore,
  type IntegrationDescriptorCreateInput,
  type IntegrationDescriptorPage,
  type IntegrationDescriptorPageRequest,
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
    const all: IntegrationDescriptorRecord[] = [];
    let cursor: string | null = null;
    do {
      const page: IntegrationDescriptorPage = await this.listVisiblePage(userId, { cursor });
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  }

  async listVisiblePage(
    userId: string,
    page: IntegrationDescriptorPageRequest = {},
  ): Promise<IntegrationDescriptorPage> {
    assertUuid(userId, 'userId');
    const limit = resolveDescriptorPageLimit(page.limit);
    const cursor = page.cursor ? decodeDescriptorPageCursor(page.cursor) : null;
    const visibility = or(
      eq(integrationProviderDescriptors.ownership, 'curated'),
      eq(integrationProviderDescriptors.ownerUserId, userId),
    );
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(integrationProviderDescriptors).where(cursor
        ? and(visibility, or(
          gt(integrationProviderDescriptors.provider, cursor.provider),
          and(
            eq(integrationProviderDescriptors.provider, cursor.provider),
            gt(integrationProviderDescriptors.id, cursor.id),
          ),
        ))
        : visibility)
        .orderBy(asc(integrationProviderDescriptors.provider), asc(integrationProviderDescriptors.id))
        .limit(limit + 1),
    );
    const items = rows.slice(0, limit).map(fromDescriptorRow);
    const lastItem = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && lastItem ? encodeDescriptorPageCursor(lastItem) : null,
    };
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
      ))
        // Curated strictly wins over a same-id BYO descriptor ('byo' < 'curated'
        // lexically, so descending order puts curated first) — deterministic
        // resolution prevents a BYO descriptor shadowing a curated provider.
        .orderBy(desc(integrationProviderDescriptors.ownership))
        .limit(1),
    );
    return rows[0] ? fromDescriptorRow(rows[0]) : null;
  }

  async findCuratedByProvider(
    provider: UserIntegrationProvider,
  ): Promise<IntegrationDescriptorRecord | null> {
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(integrationProviderDescriptors).where(and(
        eq(integrationProviderDescriptors.provider, provider),
        eq(integrationProviderDescriptors.ownership, 'curated'),
        isNull(integrationProviderDescriptors.ownerUserId),
      )).limit(1),
    );
    return rows[0] ? fromDescriptorRow(rows[0]) : null;
  }

  async findById(id: string, userId: string): Promise<IntegrationDescriptorRecord | null> {
    assertUuid(id, 'id');
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(integrationProviderDescriptors).where(and(
        eq(integrationProviderDescriptors.id, id),
        eq(integrationProviderDescriptors.ownership, 'byo'),
        eq(integrationProviderDescriptors.ownerUserId, userId),
      )).limit(1),
    );
    return rows[0] ? fromDescriptorRow(rows[0]) : null;
  }

  async delete(id: string, ownerUserId: string): Promise<boolean> {
    assertUuid(id, 'id');
    assertUuid(ownerUserId, 'ownerUserId');
    const rows = await withSystemContext(this.db, tx =>
      tx.delete(integrationProviderDescriptors).where(and(
        eq(integrationProviderDescriptors.id, id),
        eq(integrationProviderDescriptors.ownership, 'byo'),
        eq(integrationProviderDescriptors.ownerUserId, ownerUserId),
      )).returning({ id: integrationProviderDescriptors.id }),
    );
    return rows.length > 0;
  }

  async deleteCurated(provider: UserIntegrationProvider): Promise<boolean> {
    const rows = await withSystemContext(this.db, tx =>
      tx.delete(integrationProviderDescriptors).where(and(
        eq(integrationProviderDescriptors.provider, provider),
        eq(integrationProviderDescriptors.ownership, 'curated'),
        isNull(integrationProviderDescriptors.ownerUserId),
      )).returning({ id: integrationProviderDescriptors.id }),
    );
    return rows.length > 0;
  }

  async upsert(input: IntegrationDescriptorCreateInput): Promise<IntegrationDescriptorRecord> {
    validateIntegrationDescriptorInput(input);
    const rows = await withSystemContext(this.db, async tx => {
      const existing = await tx.select().from(integrationProviderDescriptors).where(descriptorIdentity(input)).limit(1);
      const values = toDescriptorValues(input, existing[0]?.createdAt ?? input.createdAt);
      if (existing[0]) {
        return tx.update(integrationProviderDescriptors)
          .set(values)
          .where(eq(integrationProviderDescriptors.id, existing[0].id))
          .returning();
      }
      return tx.insert(integrationProviderDescriptors).values(values).returning();
    });
    if (!rows[0]) throw new Error('PostgreSQL did not return integration descriptor row');
    return fromDescriptorRow(rows[0]);
  }
}

function descriptorIdentity(input: IntegrationDescriptorCreateInput) {
  if (input.ownership === 'curated') {
    return and(
      eq(integrationProviderDescriptors.provider, input.provider),
      eq(integrationProviderDescriptors.ownership, 'curated'),
      isNull(integrationProviderDescriptors.ownerUserId),
    );
  }
  if (!input.ownerUserId) throw new Error('validated BYO descriptor missing ownerUserId');
  return and(
    eq(integrationProviderDescriptors.provider, input.provider),
    eq(integrationProviderDescriptors.ownership, 'byo'),
    eq(integrationProviderDescriptors.ownerUserId, input.ownerUserId),
  );
}

function toDescriptorValues(input: IntegrationDescriptorCreateInput, createdAt: Date) {
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
    createdAt,
    updatedAt: input.updatedAt,
  };
}

function fromDescriptorRow(row: typeof integrationProviderDescriptors.$inferSelect): IntegrationDescriptorRecord {
  const record: IntegrationDescriptorRecord = {
    id: row.id,
    provider: row.provider as UserIntegrationProvider,
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
