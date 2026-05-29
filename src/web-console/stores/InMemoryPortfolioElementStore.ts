import {
  canonicalizePortfolioElementName,
  clonePortfolioElementDetailRecord,
  clonePortfolioElementSummaryRecord,
  type ConsolePortfolioElementDetailRecord,
  type ConsolePortfolioElementSummaryRecord,
  type ConsolePortfolioElementType,
  type ConsolePortfolioListFilters,
  type IPortfolioElementStore,
  validatePortfolioElementDetailRecord,
} from './IPortfolioElementStore.js';
import { assertUuid } from './ConsoleStoreValidation.js';

export class InMemoryPortfolioElementStore implements IPortfolioElementStore {
  private readonly records = new Map<string, ConsolePortfolioElementDetailRecord>();

  constructor(records: readonly ConsolePortfolioElementDetailRecord[] = []) {
    for (const record of records) {
      this.set(record);
    }
  }

  async summarizeByUser(userId: string): Promise<readonly ConsolePortfolioElementSummaryRecord[]> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    return this.sortedRecords()
      .filter(record => record.userId === userId)
      .map(clonePortfolioElementSummaryRecord);
  }

  async listByUser(
    userId: string,
    filters: ConsolePortfolioListFilters = {},
  ): Promise<readonly ConsolePortfolioElementSummaryRecord[]> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const tag = filters.tag?.toLowerCase();
    return this.sortedRecords()
      .filter(record => record.userId === userId)
      .filter(record => !filters.type || record.type === filters.type)
      .filter(record => !tag || record.tags.some(candidate => candidate.toLowerCase() === tag))
      .map(clonePortfolioElementSummaryRecord);
  }

  async findByName(
    userId: string,
    type: ConsolePortfolioElementType,
    canonicalName: string,
  ): Promise<ConsolePortfolioElementDetailRecord | null> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const record = this.records.get(key(userId, type, canonicalName));
    return record ? clonePortfolioElementDetailRecord(record) : null;
  }

  set(record: ConsolePortfolioElementDetailRecord): void {
    const normalized: ConsolePortfolioElementDetailRecord = {
      ...record,
      canonicalName: canonicalizePortfolioElementName(record.name),
    };
    validatePortfolioElementDetailRecord(normalized);
    this.records.set(key(normalized.userId, normalized.type, normalized.canonicalName), clonePortfolioElementDetailRecord(normalized));
  }

  private sortedRecords(): ConsolePortfolioElementDetailRecord[] {
    return [...this.records.values()].sort((left, right) =>
      left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
  }
}

function key(userId: string, type: ConsolePortfolioElementType, canonicalName: string): string {
  return `${userId}:${type}:${canonicalName}`;
}
