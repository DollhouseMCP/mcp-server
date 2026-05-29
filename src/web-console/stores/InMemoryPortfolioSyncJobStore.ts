import { randomUUID } from 'node:crypto';

import { assertUuid } from './ConsoleStoreValidation.js';
import {
  clonePortfolioSyncJobRecord,
  type IPortfolioSyncJobStore,
  type PortfolioSyncJobClaimInput,
  type PortfolioSyncJobCompleteInput,
  type PortfolioSyncJobCreateInput,
  type PortfolioSyncJobFailInput,
  PortfolioSyncAlreadyPendingError,
  type PortfolioSyncJobRecord,
  type PortfolioSyncJobRenewLeaseInput,
  validatePortfolioSyncJobRecord,
} from './IPortfolioSyncJobStore.js';

export class InMemoryPortfolioSyncJobStore implements IPortfolioSyncJobStore {
  private readonly records = new Map<string, PortfolioSyncJobRecord>();

  constructor(records: readonly PortfolioSyncJobRecord[] = []) {
    for (const record of records) {
      this.set(record);
    }
  }

  async create(input: PortfolioSyncJobCreateInput): Promise<PortfolioSyncJobRecord> {
    await Promise.resolve();
    if ([...this.records.values()].some(record =>
      record.userId === input.userId && (record.status === 'queued' || record.status === 'running'))) {
      throw new PortfolioSyncAlreadyPendingError();
    }
    const record: PortfolioSyncJobRecord = {
      id: randomUUID(),
      userId: input.userId,
      integrationId: input.integrationId,
      direction: input.direction,
      conflictPolicy: input.conflictPolicy,
      status: 'queued',
      claimVersion: 0,
      claimedByWorkerId: null,
      leaseUntil: null,
      attemptCount: 0,
      resultSummary: null,
      operationalErrorCode: null,
      createdAt: input.createdAt,
      startedAt: null,
      completedAt: null,
    };
    this.set(record);
    return clonePortfolioSyncJobRecord(record);
  }

  async findById(userId: string, jobId: string): Promise<PortfolioSyncJobRecord | null> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    assertUuid(jobId, 'jobId');
    const record = this.records.get(jobId);
    return record?.userId === userId ? clonePortfolioSyncJobRecord(record) : null;
  }

  async claimNext(input: PortfolioSyncJobClaimInput): Promise<PortfolioSyncJobRecord | null> {
    await Promise.resolve();
    const claimableRecords = [...this.records.values()]
      .filter(record => record.status === 'queued' ||
        (record.status === 'running' && record.leaseUntil !== null && record.leaseUntil <= input.now))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    if (claimableRecords.length === 0) return null;
    const claimable = claimableRecords[0];
    const claimed: PortfolioSyncJobRecord = {
      ...claimable,
      status: 'running',
      claimVersion: claimable.claimVersion + 1,
      claimedByWorkerId: input.workerId,
      leaseUntil: input.leaseUntil,
      attemptCount: claimable.attemptCount + 1,
      startedAt: claimable.startedAt ?? input.now,
      completedAt: null,
      operationalErrorCode: null,
    };
    this.set(claimed);
    return clonePortfolioSyncJobRecord(claimed);
  }

  async renewLease(input: PortfolioSyncJobRenewLeaseInput): Promise<boolean> {
    await Promise.resolve();
    const existing = this.records.get(input.jobId);
    if (existing?.status !== 'running' ||
        existing.claimVersion !== input.claimVersion ||
        existing.claimedByWorkerId !== input.workerId ||
        existing.leaseUntil === null ||
        existing.leaseUntil <= input.now) {
      return false;
    }
    this.set({
      ...existing,
      leaseUntil: input.leaseUntil,
    });
    return true;
  }

  async complete(input: PortfolioSyncJobCompleteInput): Promise<PortfolioSyncJobRecord | null> {
    await Promise.resolve();
    const existing = this.records.get(input.jobId);
    if (existing?.status !== 'running' || existing.claimVersion !== input.claimVersion) return null;
    const completed: PortfolioSyncJobRecord = {
      ...existing,
      status: 'succeeded',
      claimedByWorkerId: null,
      leaseUntil: null,
      resultSummary: input.resultSummary,
      operationalErrorCode: null,
      completedAt: input.completedAt,
    };
    this.set(completed);
    return clonePortfolioSyncJobRecord(completed);
  }

  async fail(input: PortfolioSyncJobFailInput): Promise<PortfolioSyncJobRecord | null> {
    await Promise.resolve();
    const existing = this.records.get(input.jobId);
    if (existing?.status !== 'running' || existing.claimVersion !== input.claimVersion) return null;
    const failed: PortfolioSyncJobRecord = {
      ...existing,
      status: 'failed',
      claimedByWorkerId: null,
      leaseUntil: null,
      resultSummary: input.resultSummary,
      operationalErrorCode: input.operationalErrorCode,
      completedAt: input.completedAt,
    };
    this.set(failed);
    return clonePortfolioSyncJobRecord(failed);
  }

  set(record: PortfolioSyncJobRecord): void {
    validatePortfolioSyncJobRecord(record);
    this.records.set(record.id, clonePortfolioSyncJobRecord(record));
  }
}
