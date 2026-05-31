import { describe, expect, it, jest } from '@jest/globals';

import {
  ConsolePortfolioSyncWorker,
  InMemoryPortfolioSyncJobStore,
  PORTFOLIO_SYNC_WORKER_TASK_LABEL,
  type IPortfolioSyncJobExecutor,
} from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const INTEGRATION_ID = '35e22a52-dc56-4cd0-9d13-b2802524fbd3';
const NOW = new Date('2026-05-31T12:00:00.000Z');

describe('ConsolePortfolioSyncWorker', () => {
  it('registers a lifecycle task and reports readiness', () => {
    const lifecycle = { registerPeriodicTask: jest.fn() };
    const worker = new ConsolePortfolioSyncWorker({
      store: new InMemoryPortfolioSyncJobStore(),
      workerId: 'worker-a',
      intervalMs: 7_000,
      now: () => NOW,
    });

    expect(worker.isRunning()).toBe(false);
    worker.register(lifecycle);
    worker.register(lifecycle);

    expect(worker.isRunning()).toBe(true);
    expect(lifecycle.registerPeriodicTask).toHaveBeenCalledTimes(1);
    expect(lifecycle.registerPeriodicTask).toHaveBeenCalledWith(
      7_000,
      expect.any(Function),
      PORTFOLIO_SYNC_WORKER_TASK_LABEL,
    );
  });

  it('claims queued jobs and completes successful executor results', async () => {
    const store = new InMemoryPortfolioSyncJobStore();
    const queued = await store.create(syncJobCreateInput());
    const executor: IPortfolioSyncJobExecutor = {
      execute: jest.fn(() => Promise.resolve({
        status: 'succeeded',
        resultSummary: { pulled: 1 },
      })),
    };
    const worker = new ConsolePortfolioSyncWorker({
      store,
      workerId: 'worker-a',
      executor,
      leaseDurationMs: 60_000,
      now: () => NOW,
    });

    await expect(worker.runOnce()).resolves.toEqual({
      workerId: 'worker-a',
      claimed: 1,
      succeeded: 1,
      failed: 0,
      staleCompletions: 0,
    });

    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      id: queued.id,
      status: 'running',
      claimedByWorkerId: 'worker-a',
    }));
    await expect(store.findById(USER_ID, queued.id)).resolves.toMatchObject({
      status: 'succeeded',
      resultSummary: { pulled: 1 },
      completedAt: NOW,
      leaseUntil: null,
    });
  });

  it('fails jobs with a content-free provider-unavailable result until the provider executor is wired', async () => {
    const store = new InMemoryPortfolioSyncJobStore();
    const queued = await store.create(syncJobCreateInput());
    const worker = new ConsolePortfolioSyncWorker({
      store,
      workerId: 'worker-a',
      leaseDurationMs: 60_000,
      now: () => NOW,
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      claimed: 1,
      succeeded: 0,
      failed: 1,
    });

    await expect(store.findById(USER_ID, queued.id)).resolves.toMatchObject({
      status: 'failed',
      operationalErrorCode: 'portfolio_sync_provider_unavailable',
      resultSummary: { provider_available: false },
      completedAt: NOW,
    });
  });

  it('reports executor exceptions and fails the claimed job', async () => {
    const store = new InMemoryPortfolioSyncJobStore();
    const queued = await store.create(syncJobCreateInput());
    const error = new Error('provider crashed');
    const reportError = jest.fn();
    const worker = new ConsolePortfolioSyncWorker({
      store,
      workerId: 'worker-a',
      executor: {
        execute: jest.fn(() => Promise.reject(error)),
      },
      now: () => NOW,
      reportError,
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      claimed: 1,
      failed: 1,
    });

    expect(reportError).toHaveBeenCalledWith(error);
    await expect(store.findById(USER_ID, queued.id)).resolves.toMatchObject({
      status: 'failed',
      operationalErrorCode: 'portfolio_sync_worker_failed',
    });
  });

  it('does not overlap concurrent drains', async () => {
    const store = new InMemoryPortfolioSyncJobStore();
    await store.create(syncJobCreateInput());
    let release: (() => void) | undefined;
    const executor: IPortfolioSyncJobExecutor = {
      execute: jest.fn(() => new Promise(resolve => {
        release = () => resolve({ status: 'succeeded', resultSummary: {} });
      })),
    };
    const worker = new ConsolePortfolioSyncWorker({
      store,
      workerId: 'worker-a',
      executor,
      now: () => NOW,
    });

    const first = worker.runOnce();
    await expect(worker.runOnce()).resolves.toBeNull();
    release?.();
    await expect(first).resolves.toMatchObject({ claimed: 1 });
  });
});

function syncJobCreateInput() {
  return {
    userId: USER_ID,
    integrationId: INTEGRATION_ID,
    direction: 'pull' as const,
    conflictPolicy: 'fail' as const,
    createdAt: new Date('2026-05-31T11:59:00.000Z'),
  };
}
