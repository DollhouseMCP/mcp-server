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

  async create(input: ConsolePortfolioElementCreateInput): Promise<ConsolePortfolioElementDetailRecord> {
    await Promise.resolve();
    assertUuid(input.userId, 'userId');
    const canonicalName = canonicalizePortfolioElementName(input.name);
    const recordKey = key(input.userId, input.type, canonicalName);
    if (this.records.has(recordKey)) {
      throw new PortfolioElementAlreadyExistsError();
    }
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
    this.set(record);
    return clonePortfolioElementDetailRecord(record);
  }

  async update(input: ConsolePortfolioElementUpdateInput): Promise<ConsolePortfolioElementDetailRecord | null> {
    await Promise.resolve();
    assertUuid(input.userId, 'userId');
    const recordKey = key(input.userId, input.type, input.canonicalName);
    const existing = this.records.get(recordKey);
    if (!existing) return null;
    if (existing.version !== input.expectedVersion) {
      throw new PortfolioElementVersionConflictError();
    }
    let displayName = existing.displayName;
    if (input.displayName !== undefined) displayName = input.displayName;
    let metadata = existing.metadata;
    if (input.metadata !== undefined) metadata = input.metadata;
    let content = existing.content;
    if (input.content !== undefined) content = input.content;
    let tags = existing.tags;
    if (input.tags !== undefined) tags = [...input.tags];
    const updated: ConsolePortfolioElementDetailRecord = {
      ...existing,
      displayName,
      metadata,
      content,
      tags,
      version: existing.version + 1,
      updatedAt: input.now,
      validationStatus: 'valid',
    };
    this.set(updated);
    return clonePortfolioElementDetailRecord(updated);
  }

  async delete(input: ConsolePortfolioElementDeleteInput): Promise<ConsolePortfolioElementDetailRecord | null> {
    await Promise.resolve();
    assertUuid(input.userId, 'userId');
    const recordKey = key(input.userId, input.type, input.canonicalName);
    const existing = this.records.get(recordKey);
    if (!existing) return null;
    if (existing.version !== input.expectedVersion) {
      throw new PortfolioElementVersionConflictError();
    }
    this.records.delete(recordKey);
    return clonePortfolioElementDetailRecord({
      ...existing,
      version: existing.version + 1,
      updatedAt: input.now,
    });
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
