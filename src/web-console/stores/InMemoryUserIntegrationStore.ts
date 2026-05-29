import {
  cloneUserIntegrationRecord,
  type IUserIntegrationStore,
  type UserIntegrationProvider,
  type UserIntegrationRecord,
  validateUserIntegrationRecord,
} from './IUserIntegrationStore.js';
import { assertUuid } from './ConsoleStoreValidation.js';

export class InMemoryUserIntegrationStore implements IUserIntegrationStore {
  private readonly records = new Map<string, UserIntegrationRecord>();
  private readonly activeProviderIndex = new Map<string, string>();

  constructor(records: readonly UserIntegrationRecord[] = []) {
    for (const record of records) {
      this.set(record);
    }
  }

  async listByUser(userId: string): Promise<readonly UserIntegrationRecord[]> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    return [...this.records.values()]
      .filter(record => record.userId === userId && record.revokedAt === null)
      .map(cloneUserIntegrationRecord);
  }

  async findByProvider(userId: string, provider: UserIntegrationProvider): Promise<UserIntegrationRecord | null> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const recordId = this.activeProviderIndex.get(activeProviderKey(userId, provider));
    const record = recordId ? this.records.get(recordId) : null;
    return record ? cloneUserIntegrationRecord(record) : null;
  }

  set(record: UserIntegrationRecord): void {
    validateUserIntegrationRecord(record);
    const cloned = cloneUserIntegrationRecord(record);
    this.records.set(record.id, cloned);
    if (cloned.revokedAt === null) {
      this.activeProviderIndex.set(activeProviderKey(cloned.userId, cloned.provider), cloned.id);
    }
  }
}

function activeProviderKey(userId: string, provider: UserIntegrationProvider): string {
  return `${userId}:${provider}`;
}
