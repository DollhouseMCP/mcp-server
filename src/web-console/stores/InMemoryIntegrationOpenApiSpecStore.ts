import { randomUUID } from 'node:crypto';

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

export class InMemoryIntegrationOpenApiSpecStore implements IIntegrationOpenApiSpecStore {
  private readonly records = new Map<string, IntegrationOpenApiSpecRecord>();
  private readonly byDescriptorId = new Map<string, string>();

  constructor(records: readonly IntegrationOpenApiSpecRecord[] = []) {
    for (const record of records) {
      this.set(record);
    }
  }

  async findByDescriptorId(descriptorId: string): Promise<IntegrationOpenApiSpecRecord | null> {
    await Promise.resolve();
    assertUuid(descriptorId, 'descriptorId');
    const id = this.byDescriptorId.get(descriptorId);
    const record = id ? this.records.get(id) : null;
    return record ? cloneIntegrationOpenApiSpecRecord(record) : null;
  }

  async upsert(input: IntegrationOpenApiSpecUpsertInput): Promise<IntegrationOpenApiSpecRecord> {
    await Promise.resolve();
    validateIntegrationOpenApiSpecInput(input);
    const existingId = this.byDescriptorId.get(input.descriptorId);
    const existing = existingId ? this.records.get(existingId) : null;
    const record: IntegrationOpenApiSpecRecord = {
      id: existing?.id ?? randomUUID(),
      descriptorId: input.descriptorId,
      spec: structuredClone(input.spec) as Record<string, unknown>,
      sourceUrl: input.sourceUrl ?? null,
      specHash: input.specHash,
      createdAt: existing?.createdAt ?? input.createdAt,
      updatedAt: input.updatedAt,
    };
    this.set(record);
    return cloneIntegrationOpenApiSpecRecord(record);
  }

  async create(input: IntegrationOpenApiSpecUpsertInput): Promise<IntegrationOpenApiSpecRecord> {
    await Promise.resolve();
    validateIntegrationOpenApiSpecInput(input);
    if (this.byDescriptorId.has(input.descriptorId)) throw new IntegrationSpecWriteError('exists');
    const record = { ...input, id: randomUUID(), sourceUrl: input.sourceUrl ?? null };
    this.set(record);
    return cloneIntegrationOpenApiSpecRecord(record);
  }

  async update(input: IntegrationOpenApiSpecUpsertInput, expectedSpecHash?: string): Promise<IntegrationOpenApiSpecRecord> {
    await Promise.resolve();
    validateIntegrationOpenApiSpecInput(input);
    const id = this.byDescriptorId.get(input.descriptorId);
    const existing = id ? this.records.get(id) : undefined;
    if (!existing) throw new IntegrationSpecWriteError(expectedSpecHash === undefined ? 'missing' : 'conflict');
    if (expectedSpecHash !== undefined && existing.specHash !== expectedSpecHash) {
      throw new IntegrationSpecWriteError('conflict');
    }
    const record = { ...input, id: existing.id, createdAt: existing.createdAt, sourceUrl: input.sourceUrl ?? null };
    this.set(record);
    return cloneIntegrationOpenApiSpecRecord(record);
  }

  async deleteByDescriptorId(descriptorId: string): Promise<boolean> {
    await Promise.resolve();
    assertUuid(descriptorId, 'descriptorId');
    const id = this.byDescriptorId.get(descriptorId);
    if (!id) return false;
    this.records.delete(id);
    this.byDescriptorId.delete(descriptorId);
    return true;
  }

  set(record: IntegrationOpenApiSpecRecord): void {
    validateIntegrationOpenApiSpecRecord(record);
    const cloned = cloneIntegrationOpenApiSpecRecord(record);
    this.records.set(cloned.id, cloned);
    this.byDescriptorId.set(cloned.descriptorId, cloned.id);
  }
}
