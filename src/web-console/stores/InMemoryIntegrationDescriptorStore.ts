import { randomUUID } from 'node:crypto';

import {
  cloneIntegrationDescriptorRecord,
  type IIntegrationDescriptorStore,
  type IntegrationDescriptorCreateInput,
  type IntegrationDescriptorRecord,
  validateIntegrationDescriptorInput,
  validateIntegrationDescriptorRecord,
} from './IIntegrationDescriptorStore.js';
import type { UserIntegrationProvider } from './IUserIntegrationStore.js';
import { assertUuid } from './ConsoleStoreValidation.js';

export class InMemoryIntegrationDescriptorStore implements IIntegrationDescriptorStore {
  private readonly records = new Map<string, IntegrationDescriptorRecord>();

  constructor(records: readonly IntegrationDescriptorRecord[] = []) {
    for (const record of records) {
      this.set(record);
    }
  }

  async listVisible(userId: string): Promise<readonly IntegrationDescriptorRecord[]> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    return [...this.records.values()]
      .filter(record => record.ownership === 'curated' || record.ownerUserId === userId)
      .sort((left, right) => left.provider.localeCompare(right.provider))
      .map(cloneIntegrationDescriptorRecord);
  }

  async findVisibleByProvider(
    userId: string,
    provider: UserIntegrationProvider,
  ): Promise<IntegrationDescriptorRecord | null> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const visible = [...this.records.values()].find(record =>
      record.provider === provider && (record.ownership === 'curated' || record.ownerUserId === userId));
    return visible ? cloneIntegrationDescriptorRecord(visible) : null;
  }

  async upsert(input: IntegrationDescriptorCreateInput): Promise<IntegrationDescriptorRecord> {
    await Promise.resolve();
    validateIntegrationDescriptorInput(input);
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
      credentialKeyVersion: input.credentialKeyVersion ?? null,
      operationPromotion: input.operationPromotion ?? {},
      createdAt: existing?.createdAt ?? input.createdAt,
      updatedAt: input.updatedAt,
    };
    this.set(record);
    return cloneIntegrationDescriptorRecord(record);
  }

  set(record: IntegrationDescriptorRecord): void {
    validateIntegrationDescriptorRecord(record);
    this.records.set(record.id, cloneIntegrationDescriptorRecord(record));
  }
}
