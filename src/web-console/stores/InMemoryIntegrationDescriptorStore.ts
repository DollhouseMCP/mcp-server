import { randomUUID } from 'node:crypto';

import {
  cloneIntegrationDescriptorRecord,
  compareDescriptorPageOrder,
  decodeDescriptorPageCursor,
  encodeDescriptorPageCursor,
  IntegrationDescriptorCredentialConflictError,
  isAfterDescriptorPageCursor,
  resolveDescriptorPageLimit,
  type IIntegrationDescriptorStore,
  type IntegrationDescriptorCreateInput,
  type IntegrationDescriptorPage,
  type IntegrationDescriptorPageRequest,
  type IntegrationDescriptorRecord,
  type IntegrationDescriptorUpsertOptions,
  validateIntegrationDescriptorInput,
  validateIntegrationDescriptorRecord,
} from './IIntegrationDescriptorStore.js';
import type { UserIntegrationProvider } from './IUserIntegrationStore.js';
import { assertUuid } from './ConsoleStoreValidation.js';
import {
  integrationDescriptorCredentialBindingFingerprint,
  integrationDescriptorRoutingFingerprint,
} from '../modules/integrations/IntegrationDescriptorRoutingFingerprint.js';
import { InMemoryIntegrationMutationCoordinator } from './InMemoryIntegrationMutationCoordinator.js';

export interface InMemoryIntegrationDescriptorStoreOptions {
  readonly mutationCoordinator?: InMemoryIntegrationMutationCoordinator;
  readonly hasBlockingCredentialMaterialByDescriptor?: (descriptorId: string) => Promise<boolean>;
}

export class InMemoryIntegrationDescriptorStore implements IIntegrationDescriptorStore {
  private readonly records = new Map<string, IntegrationDescriptorRecord>();
  private readonly mutationCoordinator = new InMemoryIntegrationMutationCoordinator();

  constructor(
    records: readonly IntegrationDescriptorRecord[] = [],
    private readonly options: InMemoryIntegrationDescriptorStoreOptions = {},
  ) {
    if (options.mutationCoordinator) this.mutationCoordinator = options.mutationCoordinator;
    for (const record of records) {
      this.set(record);
    }
  }

  async listVisible(userId: string): Promise<readonly IntegrationDescriptorRecord[]> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    return this.visibleSorted(userId).map(cloneIntegrationDescriptorRecord);
  }

  async listVisiblePage(
    userId: string,
    page: IntegrationDescriptorPageRequest = {},
  ): Promise<IntegrationDescriptorPage> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const limit = resolveDescriptorPageLimit(page.limit);
    const cursor = page.cursor ? decodeDescriptorPageCursor(page.cursor) : null;
    const visible = this.visibleSorted(userId)
      .filter(record => !cursor || isAfterDescriptorPageCursor(record, cursor));
    const items = visible.slice(0, limit).map(cloneIntegrationDescriptorRecord);
    const lastItem = items.at(-1);
    return {
      items,
      nextCursor: visible.length > limit && lastItem ? encodeDescriptorPageCursor(lastItem) : null,
    };
  }

  private visibleSorted(userId: string): IntegrationDescriptorRecord[] {
    return [...this.records.values()]
      .filter(record => record.ownership === 'curated' || record.ownerUserId === userId)
      .sort(compareDescriptorPageOrder);
  }

  async findVisibleByProvider(
    userId: string,
    provider: UserIntegrationProvider,
  ): Promise<IntegrationDescriptorRecord | null> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const candidates = [...this.records.values()].filter(record =>
      record.provider === provider && (record.ownership === 'curated' || record.ownerUserId === userId));
    // Curated strictly wins over a same-provider BYO descriptor so a user cannot
    // shadow a curated provider's credential/routing by authoring their own.
    // `.at(0)` (not `[0]`) keeps the type honest that the array may be empty.
    const visible = candidates.find(record => record.ownership === 'curated') ?? candidates.at(0);
    return visible ? cloneIntegrationDescriptorRecord(visible) : null;
  }

  async findCuratedByProvider(
    provider: UserIntegrationProvider,
  ): Promise<IntegrationDescriptorRecord | null> {
    await Promise.resolve();
    const record = [...this.records.values()].find(candidate =>
      candidate.provider === provider &&
      candidate.ownership === 'curated' &&
      candidate.ownerUserId === null);
    return record ? cloneIntegrationDescriptorRecord(record) : null;
  }

  async findById(id: string, userId: string): Promise<IntegrationDescriptorRecord | null> {
    await Promise.resolve();
    assertUuid(id, 'id');
    assertUuid(userId, 'userId');
    const record = this.records.get(id);
    return record?.ownership === 'byo' && record.ownerUserId === userId
      ? cloneIntegrationDescriptorRecord(record)
      : null;
  }

  routingFingerprint(id: string): string | null {
    const record = this.records.get(id);
    return record ? integrationDescriptorRoutingFingerprint(record) : null;
  }

  async delete(id: string, ownerUserId: string): Promise<boolean> {
    assertUuid(id, 'id');
    assertUuid(ownerUserId, 'ownerUserId');
    return this.mutationCoordinator.runExclusive(async () => {
      const record = this.records.get(id);
      if (record?.ownership !== 'byo' || record.ownerUserId !== ownerUserId) return false;
      await this.assertDescriptorMutationAllowed(id);
      this.records.delete(id);
      return true;
    });
  }

  async deleteCurated(provider: UserIntegrationProvider): Promise<boolean> {
    return this.mutationCoordinator.runExclusive(async () => {
      const record = [...this.records.values()].find(candidate =>
        candidate.provider === provider && candidate.ownership === 'curated');
      if (!record) return false;
      await this.assertDescriptorMutationAllowed(record.id);
      this.records.delete(record.id);
      return true;
    });
  }

  async upsert(
    input: IntegrationDescriptorCreateInput,
    _options: IntegrationDescriptorUpsertOptions = {},
  ): Promise<IntegrationDescriptorRecord> {
    validateIntegrationDescriptorInput(input);
    return this.mutationCoordinator.runExclusive(async () => {
      const existing = [...this.records.values()].find(record =>
        record.provider === input.provider &&
        record.ownership === input.ownership &&
        record.ownerUserId === input.ownerUserId);
      const record: IntegrationDescriptorRecord = {
        id: existing?.id ?? randomUUID(),
        provider: input.provider,
        ownership: input.ownership,
        ownerUserId: input.ownerUserId,
        displayName: input.displayName,
        category: input.category,
        authStrategy: input.authStrategy,
        apiHosts: [...input.apiHosts],
        oauth: input.oauth ?? null,
        staticApiKey: input.staticApiKey ?? null,
        clientSecretCiphertext: input.clientSecretCiphertext ?? null,
        clientSecretRevision: input.clientSecretRevision ?? null,
        credentialKeyVersion: input.credentialKeyVersion ?? null,
        operationPromotion: input.operationPromotion ?? {},
        createdAt: existing?.createdAt ?? input.createdAt,
        updatedAt: input.updatedAt,
      };
      if (existing && integrationDescriptorCredentialBindingFingerprint(existing) !==
          integrationDescriptorCredentialBindingFingerprint(record)) {
        await this.assertDescriptorMutationAllowed(existing.id);
      }
      this.set(record);
      return cloneIntegrationDescriptorRecord(record);
    });
  }

  private async assertDescriptorMutationAllowed(descriptorId: string): Promise<void> {
    if (await this.options.hasBlockingCredentialMaterialByDescriptor?.(descriptorId)) {
      throw new IntegrationDescriptorCredentialConflictError();
    }
  }

  set(record: IntegrationDescriptorRecord): void {
    validateIntegrationDescriptorRecord(record);
    this.records.set(record.id, cloneIntegrationDescriptorRecord(record));
  }
}
