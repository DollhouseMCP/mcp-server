import { describe, expect, it } from '@jest/globals';

import {
  InMemoryConsoleSecurityInvalidationStore,
  StaticConsoleSecurityInvalidationReadiness,
  StoreBackedConsoleSecurityInvalidationReadiness,
} from '../../../../src/web-console/index.js';

const NOW = new Date('2026-05-30T12:00:00.000Z');
const LATER = new Date('2026-05-30T12:00:20.000Z');
const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';

describe('ConsoleSecurityInvalidationReadiness', () => {
  it('reports the default static processor-not-ready state', async () => {
    const readiness = new StaticConsoleSecurityInvalidationReadiness(false, () => NOW);

    await expect(readiness.getReadiness()).resolves.toEqual({
      ready: false,
      status: 'not_ready',
      checkedAt: NOW,
      failureCodes: ['security_invalidation_processor_not_ready'],
    });
  });

  it('reports ready only after the processor is running, lease is live, and cursor is drained', async () => {
    const store = new InMemoryConsoleSecurityInvalidationStore();
    const readiness = new StoreBackedConsoleSecurityInvalidationReadiness({
      store,
      replicaId: 'replica-a',
      now: () => NOW,
    });
    const event = await store.appendEvent({
      kind: 'principal_authz_changed',
      urgency: 'acknowledged',
      userId: USER_ID,
      authzVersion: 2,
      reason: 'roles_changed',
      payload: { previousAuthzVersion: 1, newAuthzVersion: 2 },
      createdAt: NOW,
      createdByUserId: USER_ID,
    });

    await expect(readiness.getReadiness()).resolves.toMatchObject({
      ready: false,
      status: 'not_ready',
      failureCodes: [
        'security_invalidation_replica_lease_not_live',
        'security_invalidation_events_pending',
      ],
    });

    await store.acquireReplicaLease({
      replicaId: 'replica-a',
      renewedAt: NOW,
      leaseUntil: LATER,
    });
    await store.recordReplicaCursor('replica-a', event.sequenceId, NOW);

    await expect(readiness.getReadiness()).resolves.toEqual({
      ready: true,
      status: 'ok',
      checkedAt: NOW,
      failureCodes: [],
    });
  });

  it('reports processor and store check failures without throwing', async () => {
    const store = new InMemoryConsoleSecurityInvalidationStore();
    const readiness = new StoreBackedConsoleSecurityInvalidationReadiness({
      store,
      replicaId: '',
      processorReady: () => false,
      now: () => NOW,
    });

    await expect(readiness.getReadiness()).resolves.toEqual({
      ready: false,
      status: 'unavailable',
      checkedAt: NOW,
      failureCodes: ['security_invalidation_check_failed'],
    });
  });
});
