import { and, eq, gt, sql } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { portfolioSyncJobs } from '../../database/schema/index.js';
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
import { assertUuid, isUniqueViolation } from './ConsoleStoreValidation.js';

export class PostgresPortfolioSyncJobStore implements IPortfolioSyncJobStore {
  constructor(private readonly db: DatabaseInstance) {}

  async create(input: PortfolioSyncJobCreateInput): Promise<PortfolioSyncJobRecord> {
    validatePortfolioSyncJobRecord({
      id: '00000000-0000-4000-8000-000000000000',
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
    });
    let rows: (typeof portfolioSyncJobs.$inferSelect)[];
    try {
      rows = await withSystemContext(this.db, tx =>
        tx.insert(portfolioSyncJobs).values({
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
        }).returning(),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new PortfolioSyncAlreadyPendingError();
      throw error;
    }
    if (!rows[0]) throw new Error('PostgreSQL did not return inserted portfolio sync job row');
    return fromRow(rows[0]);
  }

  async findById(userId: string, jobId: string): Promise<PortfolioSyncJobRecord | null> {
    assertUuid(userId, 'userId');
    assertUuid(jobId, 'jobId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(portfolioSyncJobs).where(and(
        eq(portfolioSyncJobs.userId, userId),
        eq(portfolioSyncJobs.id, jobId),
      )).limit(1),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async claimNext(input: PortfolioSyncJobClaimInput): Promise<PortfolioSyncJobRecord | null> {
    const rows: (typeof portfolioSyncJobs.$inferSelect)[] = await withSystemContext(this.db, tx => tx.execute(sql`
      UPDATE portfolio_sync_jobs
      SET
        status = 'running',
        claim_version = claim_version + 1,
        claimed_by_worker_id = ${input.workerId},
        lease_until = ${input.leaseUntil},
        attempt_count = attempt_count + 1,
        started_at = COALESCE(started_at, ${input.now}),
        completed_at = NULL,
        operational_error_code = NULL
      WHERE id = (
        SELECT id
        FROM portfolio_sync_jobs
        WHERE status = 'queued'
          OR (status = 'running' AND lease_until <= ${input.now})
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING
        id,
        user_id AS "userId",
        integration_id AS "integrationId",
        direction,
        conflict_policy AS "conflictPolicy",
        status,
        claim_version AS "claimVersion",
        claimed_by_worker_id AS "claimedByWorkerId",
        lease_until AS "leaseUntil",
        attempt_count AS "attemptCount",
        result_summary AS "resultSummary",
        operational_error_code AS "operationalErrorCode",
        created_at AS "createdAt",
        started_at AS "startedAt",
        completed_at AS "completedAt"
    `));
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async renewLease(input: PortfolioSyncJobRenewLeaseInput): Promise<boolean> {
    assertUuid(input.jobId, 'jobId');
    const rows = await withSystemContext(this.db, tx =>
      tx.update(portfolioSyncJobs).set({
        leaseUntil: input.leaseUntil,
      }).where(and(
        eq(portfolioSyncJobs.id, input.jobId),
        eq(portfolioSyncJobs.status, 'running'),
        eq(portfolioSyncJobs.claimVersion, input.claimVersion),
        eq(portfolioSyncJobs.claimedByWorkerId, input.workerId),
        gt(portfolioSyncJobs.leaseUntil, input.now),
      )).returning(),
    );
    return rows.length > 0;
  }

  async complete(input: PortfolioSyncJobCompleteInput): Promise<PortfolioSyncJobRecord | null> {
    assertUuid(input.jobId, 'jobId');
    const rows = await withSystemContext(this.db, tx =>
      tx.update(portfolioSyncJobs).set({
        status: 'succeeded',
        claimedByWorkerId: null,
        leaseUntil: null,
        resultSummary: input.resultSummary,
        operationalErrorCode: null,
        completedAt: input.completedAt,
      }).where(and(
        eq(portfolioSyncJobs.id, input.jobId),
        eq(portfolioSyncJobs.status, 'running'),
        eq(portfolioSyncJobs.claimVersion, input.claimVersion),
      )).returning(),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async fail(input: PortfolioSyncJobFailInput): Promise<PortfolioSyncJobRecord | null> {
    assertUuid(input.jobId, 'jobId');
    const rows = await withSystemContext(this.db, tx =>
      tx.update(portfolioSyncJobs).set({
        status: 'failed',
        claimedByWorkerId: null,
        leaseUntil: null,
        resultSummary: input.resultSummary,
        operationalErrorCode: input.operationalErrorCode,
        completedAt: input.completedAt,
      }).where(and(
        eq(portfolioSyncJobs.id, input.jobId),
        eq(portfolioSyncJobs.status, 'running'),
        eq(portfolioSyncJobs.claimVersion, input.claimVersion),
      )).returning(),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }
}

function fromRow(row: typeof portfolioSyncJobs.$inferSelect): PortfolioSyncJobRecord {
  const record: PortfolioSyncJobRecord = {
    id: row.id,
    userId: row.userId,
    integrationId: row.integrationId,
    direction: row.direction,
    conflictPolicy: row.conflictPolicy,
    status: row.status,
    claimVersion: row.claimVersion,
    claimedByWorkerId: row.claimedByWorkerId,
    leaseUntil: row.leaseUntil,
    attemptCount: row.attemptCount,
    resultSummary: asJsonRecordOrNull(row.resultSummary),
    operationalErrorCode: row.operationalErrorCode,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
  validatePortfolioSyncJobRecord(record);
  return clonePortfolioSyncJobRecord(record);
}

function asJsonRecordOrNull(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null) return null;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
