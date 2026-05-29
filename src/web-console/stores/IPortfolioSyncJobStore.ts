import {
  ConsoleStoreValidationError,
  assertNullableDisplayString,
  assertUuid,
  cloneDate,
} from './ConsoleStoreValidation.js';

export type PortfolioSyncProvider = 'github';
export type PortfolioSyncJobDirection = 'pull' | 'push' | 'bidirectional';
export type PortfolioSyncJobConflictPolicy = 'fail' | 'prefer_local' | 'prefer_remote';
export type PortfolioSyncJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface PortfolioSyncJobRecord {
  readonly id: string;
  readonly userId: string;
  readonly integrationId: string;
  readonly direction: PortfolioSyncJobDirection;
  readonly conflictPolicy: PortfolioSyncJobConflictPolicy;
  readonly status: PortfolioSyncJobStatus;
  readonly claimVersion: number;
  readonly claimedByWorkerId: string | null;
  readonly leaseUntil: Date | null;
  readonly attemptCount: number;
  readonly resultSummary: Readonly<Record<string, unknown>> | null;
  readonly operationalErrorCode: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

export interface PortfolioSyncJobCreateInput {
  readonly userId: string;
  readonly integrationId: string;
  readonly direction: PortfolioSyncJobDirection;
  readonly conflictPolicy: PortfolioSyncJobConflictPolicy;
  readonly createdAt: Date;
}

export interface PortfolioSyncJobClaimInput {
  readonly workerId: string;
  readonly leaseUntil: Date;
  readonly now: Date;
}

export interface PortfolioSyncJobRenewLeaseInput {
  readonly jobId: string;
  readonly claimVersion: number;
  readonly workerId: string;
  readonly leaseUntil: Date;
  readonly now: Date;
}

export interface PortfolioSyncJobCompleteInput {
  readonly jobId: string;
  readonly claimVersion: number;
  readonly resultSummary: Readonly<Record<string, unknown>>;
  readonly completedAt: Date;
}

export interface PortfolioSyncJobFailInput {
  readonly jobId: string;
  readonly claimVersion: number;
  readonly operationalErrorCode: string;
  readonly resultSummary: Readonly<Record<string, unknown>> | null;
  readonly completedAt: Date;
}

export interface IPortfolioSyncJobStore {
  create(input: PortfolioSyncJobCreateInput): Promise<PortfolioSyncJobRecord>;
  findById(userId: string, jobId: string): Promise<PortfolioSyncJobRecord | null>;
  claimNext(input: PortfolioSyncJobClaimInput): Promise<PortfolioSyncJobRecord | null>;
  renewLease(input: PortfolioSyncJobRenewLeaseInput): Promise<boolean>;
  complete(input: PortfolioSyncJobCompleteInput): Promise<PortfolioSyncJobRecord | null>;
  fail(input: PortfolioSyncJobFailInput): Promise<PortfolioSyncJobRecord | null>;
}

export class PortfolioSyncAlreadyPendingError extends Error {
  constructor(message = 'portfolio sync already pending') {
    super(message);
    this.name = 'PortfolioSyncAlreadyPendingError';
  }
}

export const PORTFOLIO_SYNC_RESULT_SUMMARY_MAX_BYTES = 4_096;
export const PORTFOLIO_SYNC_WORKER_ID_MAX_LENGTH = 128;
export const PORTFOLIO_SYNC_ERROR_CODE_MAX_LENGTH = 100;

export function validatePortfolioSyncJobRecord(record: PortfolioSyncJobRecord): void {
  assertUuid(record.id, 'id');
  assertUuid(record.userId, 'userId');
  assertUuid(record.integrationId, 'integrationId');
  if (!isPortfolioSyncJobDirection(record.direction)) {
    throw new ConsoleStoreValidationError(`unsupported sync direction '${record.direction}'`);
  }
  if (!isPortfolioSyncJobConflictPolicy(record.conflictPolicy)) {
    throw new ConsoleStoreValidationError(`unsupported sync conflict policy '${record.conflictPolicy}'`);
  }
  if (!isPortfolioSyncJobStatus(record.status)) {
    throw new ConsoleStoreValidationError(`unsupported sync job status '${record.status}'`);
  }
  if (!Number.isSafeInteger(record.claimVersion) || record.claimVersion < 0) {
    throw new ConsoleStoreValidationError('claimVersion must be a non-negative safe integer');
  }
  assertNullableDisplayString(record.claimedByWorkerId, 'claimedByWorkerId', PORTFOLIO_SYNC_WORKER_ID_MAX_LENGTH);
  if (!Number.isSafeInteger(record.attemptCount) || record.attemptCount < 0) {
    throw new ConsoleStoreValidationError('attemptCount must be a non-negative safe integer');
  }
  if (record.resultSummary !== null) validateResultSummary(record.resultSummary);
  assertNullableDisplayString(record.operationalErrorCode, 'operationalErrorCode', PORTFOLIO_SYNC_ERROR_CODE_MAX_LENGTH);
  validateLeaseShape(record);
  validateTerminalShape(record);
}

export function clonePortfolioSyncJobRecord(record: PortfolioSyncJobRecord): PortfolioSyncJobRecord {
  return {
    ...record,
    leaseUntil: cloneDate(record.leaseUntil),
    resultSummary: record.resultSummary ? cloneJsonRecord(record.resultSummary) : null,
    createdAt: cloneDate(record.createdAt) ?? new Date(record.createdAt.getTime()),
    startedAt: cloneDate(record.startedAt),
    completedAt: cloneDate(record.completedAt),
  };
}

export function isPortfolioSyncJobDirection(value: string): value is PortfolioSyncJobDirection {
  return value === 'pull' || value === 'push' || value === 'bidirectional';
}

export function isPortfolioSyncJobConflictPolicy(value: string): value is PortfolioSyncJobConflictPolicy {
  return value === 'fail' || value === 'prefer_local' || value === 'prefer_remote';
}

function isPortfolioSyncJobStatus(value: string): value is PortfolioSyncJobStatus {
  return value === 'queued' ||
    value === 'running' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'cancelled';
}

function validateLeaseShape(record: PortfolioSyncJobRecord): void {
  if (record.status === 'running' && (!record.claimedByWorkerId || !record.leaseUntil)) {
    throw new ConsoleStoreValidationError('running sync job requires a worker and lease');
  }
  if (record.status !== 'running' && (record.claimedByWorkerId !== null || record.leaseUntil !== null)) {
    throw new ConsoleStoreValidationError('non-running sync job cannot hold a worker lease');
  }
}

function validateTerminalShape(record: PortfolioSyncJobRecord): void {
  if (['succeeded', 'failed', 'cancelled'].includes(record.status) && !record.completedAt) {
    throw new ConsoleStoreValidationError('terminal sync job requires completedAt');
  }
  if (record.status === 'failed' && !record.operationalErrorCode) {
    throw new ConsoleStoreValidationError('failed sync job requires operationalErrorCode');
  }
  if (record.status !== 'failed' && record.operationalErrorCode !== null) {
    throw new ConsoleStoreValidationError('operationalErrorCode requires failed status');
  }
}

function validateResultSummary(value: Readonly<Record<string, unknown>>): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ConsoleStoreValidationError('resultSummary must be JSON-serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > PORTFOLIO_SYNC_RESULT_SUMMARY_MAX_BYTES) {
    throw new ConsoleStoreValidationError(`resultSummary must be at most ${PORTFOLIO_SYNC_RESULT_SUMMARY_MAX_BYTES} bytes`);
  }
}

function cloneJsonRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
