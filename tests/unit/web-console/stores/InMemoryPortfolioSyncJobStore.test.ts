import { describe, expect, it } from '@jest/globals';

import {
  ConsoleStoreValidationError,
  InMemoryPortfolioSyncJobStore,
  PortfolioSyncAlreadyPendingError,
  PORTFOLIO_SYNC_RESULT_SUMMARY_MAX_BYTES,
  validatePortfolioSyncJobRecord,
  type PortfolioSyncJobRecord,
} from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const OTHER_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const INTEGRATION_ID = '35e22a52-dc56-4cd0-9d13-b2802524fbd3';
const JOB_ID = '90dc6b61-d6d8-455a-adb1-a227e7fdbf77';
const NOW = new Date('2026-05-29T12:00:00.000Z');
const ONE_MINUTE = new Date('2026-05-29T12:01:00.000Z');
const TWO_MINUTES = new Date('2026-05-29T12:02:00.000Z');

function syncJob(overrides: Partial<PortfolioSyncJobRecord> = {}): PortfolioSyncJobRecord {
  return {
    id: JOB_ID,
    userId: USER_ID,
    integrationId: INTEGRATION_ID,
    direction: 'pull',
    conflictPolicy: 'fail',
    status: 'queued',
    claimVersion: 0,
    claimedByWorkerId: null,
    leaseUntil: null,
    attemptCount: 0,
    resultSummary: null,
    operationalErrorCode: null,
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe('InMemoryPortfolioSyncJobStore', () => {
  it('creates and finds jobs only for the owning user', async () => {
    const store = new InMemoryPortfolioSyncJobStore();

    const created = await store.create({
      userId: USER_ID,
      integrationId: INTEGRATION_ID,
      direction: 'pull',
      conflictPolicy: 'fail',
      createdAt: NOW,
    });

    await expect(store.findById(USER_ID, created.id)).resolves.toMatchObject({
      userId: USER_ID,
      integrationId: INTEGRATION_ID,
      status: 'queued',
    });
    await expect(store.findById(OTHER_USER_ID, created.id)).resolves.toBeNull();
    await expect(store.create({
      userId: USER_ID,
      integrationId: INTEGRATION_ID,
      direction: 'pull',
      conflictPolicy: 'fail',
      createdAt: NOW,
    })).rejects.toThrow(PortfolioSyncAlreadyPendingError);
  });

  it('uses claim_version fences for claim, renew, complete, and stale completion rejection', async () => {
    const store = new InMemoryPortfolioSyncJobStore([syncJob()]);

    const claimed = await store.claimNext({
      workerId: 'worker-1',
      leaseUntil: ONE_MINUTE,
      now: NOW,
    });
    expect(claimed).toMatchObject({
      id: JOB_ID,
      status: 'running',
      claimVersion: 1,
      claimedByWorkerId: 'worker-1',
      attemptCount: 1,
    });
    await expect(store.renewLease({
      jobId: JOB_ID,
      claimVersion: 1,
      workerId: 'worker-1',
      leaseUntil: TWO_MINUTES,
      now: NOW,
    })).resolves.toBe(true);
    await expect(store.complete({
      jobId: JOB_ID,
      claimVersion: 0,
      resultSummary: { imported: 1 },
      completedAt: TWO_MINUTES,
    })).resolves.toBeNull();

    const completed = await store.complete({
      jobId: JOB_ID,
      claimVersion: 1,
      resultSummary: { imported: 1 },
      completedAt: TWO_MINUTES,
    });
    expect(completed).toMatchObject({
      status: 'succeeded',
      claimedByWorkerId: null,
      leaseUntil: null,
      resultSummary: { imported: 1 },
    });
  });

  it('reclaims expired running jobs and prevents replaced workers from committing', async () => {
    const store = new InMemoryPortfolioSyncJobStore([syncJob({
      status: 'running',
      claimVersion: 1,
      claimedByWorkerId: 'worker-1',
      leaseUntil: NOW,
      attemptCount: 1,
      startedAt: NOW,
    })]);

    const reclaimed = await store.claimNext({
      workerId: 'worker-2',
      leaseUntil: TWO_MINUTES,
      now: ONE_MINUTE,
    });
    expect(reclaimed).toMatchObject({
      claimVersion: 2,
      claimedByWorkerId: 'worker-2',
      attemptCount: 2,
    });
    await expect(store.fail({
      jobId: JOB_ID,
      claimVersion: 1,
      operationalErrorCode: 'stale_worker',
      resultSummary: null,
      completedAt: TWO_MINUTES,
    })).resolves.toBeNull();
  });

  it('fails running jobs through the current claim fence', async () => {
    const store = new InMemoryPortfolioSyncJobStore([syncJob({
      status: 'running',
      claimVersion: 1,
      claimedByWorkerId: 'worker-1',
      leaseUntil: ONE_MINUTE,
      attemptCount: 1,
      startedAt: NOW,
    })]);

    const failed = await store.fail({
      jobId: JOB_ID,
      claimVersion: 1,
      operationalErrorCode: 'provider_unavailable',
      resultSummary: { failed: 1 },
      completedAt: TWO_MINUTES,
    });

    expect(failed).toMatchObject({
      status: 'failed',
      claimedByWorkerId: null,
      leaseUntil: null,
      operationalErrorCode: 'provider_unavailable',
      resultSummary: { failed: 1 },
    });
  });

  it('rejects lease renewal for stale, wrong-worker, and expired leases', async () => {
    const store = new InMemoryPortfolioSyncJobStore([syncJob({
      status: 'running',
      claimVersion: 1,
      claimedByWorkerId: 'worker-1',
      leaseUntil: ONE_MINUTE,
      attemptCount: 1,
      startedAt: NOW,
    })]);

    await expect(store.renewLease({
      jobId: JOB_ID,
      claimVersion: 0,
      workerId: 'worker-1',
      leaseUntil: TWO_MINUTES,
      now: NOW,
    })).resolves.toBe(false);
    await expect(store.renewLease({
      jobId: JOB_ID,
      claimVersion: 1,
      workerId: 'worker-2',
      leaseUntil: TWO_MINUTES,
      now: NOW,
    })).resolves.toBe(false);
    await expect(store.renewLease({
      jobId: JOB_ID,
      claimVersion: 1,
      workerId: 'worker-1',
      leaseUntil: TWO_MINUTES,
      now: TWO_MINUTES,
    })).resolves.toBe(false);
  });

  it('validates illegal state-machine shapes and result summary caps', () => {
    expect(() => validatePortfolioSyncJobRecord(syncJob({
      status: 'running',
      claimedByWorkerId: 'worker-1',
    }))).toThrow(ConsoleStoreValidationError);
    expect(() => validatePortfolioSyncJobRecord(syncJob({
      status: 'succeeded',
    }))).toThrow(ConsoleStoreValidationError);
    expect(() => validatePortfolioSyncJobRecord(syncJob({
      status: 'failed',
      completedAt: NOW,
    }))).toThrow(ConsoleStoreValidationError);
    expect(() => validatePortfolioSyncJobRecord(syncJob({
      resultSummary: { value: 'x'.repeat(PORTFOLIO_SYNC_RESULT_SUMMARY_MAX_BYTES) },
    }))).toThrow(ConsoleStoreValidationError);
  });
});
