import { describe, expect, it, jest } from '@jest/globals';

const {
  InMemoryRuntimeSessionControlStore,
  RuntimeMcpSessionControlService,
  runtimePresenceLeaseMsFor,
  DEFAULT_RUNTIME_SESSION_LEASE_MS,
  RUNTIME_PRESENCE_LEASE_GRACE_MS,
} = await import('../../../../src/web-console/services/runtime/index.js');

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const ACCOUNT_CORRELATION_ID = '7e5355c1-bc0d-4bb8-a806-53bd05e44727';
const SESSION_ID = 'mcp-session-1';
const COMMAND_ID = '7257f15c-0f26-4cfc-a578-4dbbf60dc723';
const T0 = new Date('2026-05-28T12:00:00.000Z');

describe('RuntimeMcpSessionControlService', () => {
  it('registers presence and heartbeats replica-owned request counters', async () => {
    const store = new InMemoryRuntimeSessionControlStore();
    let now = T0;
    const service = new RuntimeMcpSessionControlService({
      store,
      replicaId: 'replica-a',
      now: () => now,
      leaseDurationMs: 45_000,
    });

    await service.registerSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    now = new Date('2026-05-28T12:00:15.000Z');

    await expect(service.recordActivity(SESSION_ID)).resolves.toMatchObject({
      kind: 'updated',
      presence: {
        sessionId: SESSION_ID,
        requestCount: 1,
        errorCount: 0,
        leaseUntil: new Date('2026-05-28T12:01:00.000Z'),
      },
    });
    await expect(store.findPresence(SESSION_ID, now)).resolves.toMatchObject({
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
  });

  it('keeps an idle-but-connected session visible across the transport lifetime', async () => {
    // Regression: the lease was 45s and gated visibility, so an idle agent that
    // had not sent a request in 45s vanished from /me/sessions even though its
    // streamable-http session was still alive. The lease now tracks the idle
    // timeout, so presence stays listed until the transport actually closes.
    const store = new InMemoryRuntimeSessionControlStore();
    let now = T0;
    const service = new RuntimeMcpSessionControlService({
      store,
      replicaId: 'replica-a',
      now: () => now,
      leaseDurationMs: runtimePresenceLeaseMsFor(15 * 60_000),
    });
    await service.registerSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      clientInfo: { name: 'Claude Code', version: '1.0.0' },
    });

    // Five minutes of inactivity — well past the old 45s lease.
    now = new Date(T0.getTime() + 5 * 60_000);
    await expect(store.listPresenceByUser(USER_ID, { now })).resolves.toHaveLength(1);

    // Once the transport disposes the session it is no longer visible.
    await service.markSessionDisposed(SESSION_ID);
    await expect(store.listPresenceByUser(USER_ID, { now })).resolves.toHaveLength(0);
  });

  it('sizes the presence lease from the transport idle timeout', () => {
    expect(runtimePresenceLeaseMsFor(15 * 60_000)).toBe(15 * 60_000 + RUNTIME_PRESENCE_LEASE_GRACE_MS);
    // Idle expiry disabled (0) falls back to the default lease window + grace.
    expect(runtimePresenceLeaseMsFor(0)).toBe(DEFAULT_RUNTIME_SESSION_LEASE_MS + RUNTIME_PRESENCE_LEASE_GRACE_MS);
  });

  it('removes local ownership when heartbeat reports a replica mismatch', async () => {
    const store = new InMemoryRuntimeSessionControlStore();
    const service = new RuntimeMcpSessionControlService({
      store,
      replicaId: 'replica-a',
      now: () => T0,
    });
    await service.registerSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
    });
    await store.registerPresence({
      sessionId: SESSION_ID,
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      replicaId: 'replica-b',
      transport: 'streamable-http',
      startedAt: T0,
      lastActiveAt: T0,
      leaseUntil: new Date(T0.getTime() + 45_000),
    });

    await expect(service.recordActivity(SESSION_ID)).resolves.toEqual({
      kind: 'lost',
      reason: 'replica_mismatch',
    });
    expect(service.getLocalSessionCount()).toBe(0);
  });

  it('lazy re-registers when heartbeat finds missing durable presence', async () => {
    const store = new InMemoryRuntimeSessionControlStore();
    const service = new RuntimeMcpSessionControlService({
      store,
      replicaId: 'replica-a',
      now: () => T0,
      leaseDurationMs: 45_000,
    });
    await service.registerSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
    });
    await expect(store.sweepStalePresence(new Date(T0.getTime() + 60_000))).resolves.toBe(1);

    await expect(service.recordActivity(SESSION_ID)).resolves.toMatchObject({
      kind: 'updated',
      presence: {
        sessionId: SESSION_ID,
        requestCount: 1,
      },
    });
    expect(service.getLocalSessionCount()).toBe(1);
    await expect(store.findPresence(SESSION_ID, T0)).resolves.toMatchObject({
      sessionId: SESSION_ID,
      replicaId: 'replica-a',
    });
  });

  it('terminates pending local commands and records already-absent acknowledgements', async () => {
    const store = new InMemoryRuntimeSessionControlStore();
    const service = new RuntimeMcpSessionControlService({
      store,
      replicaId: 'replica-a',
      now: () => T0,
    });
    await service.registerSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
    });
    await store.createTerminationCommand({
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      targetReplicaId: 'replica-a',
      reason: 'admin_terminated',
      requestedAt: T0,
      requestedBy: { kind: 'admin', userId: USER_ID },
    });

    const terminateLocalSession = jest.fn(() => Promise.resolve('terminated' as const));
    await expect(service.reconcilePendingCommands({ terminateLocalSession })).resolves.toBe(1);

    expect(terminateLocalSession).toHaveBeenCalledWith(SESSION_ID);
    await expect(store.getCommandAck(COMMAND_ID)).resolves.toMatchObject({
      commandId: COMMAND_ID,
      replicaId: 'replica-a',
      result: 'terminated',
    });

    await expect(service.reconcilePendingCommands({
      terminateLocalSession: jest.fn(() => Promise.resolve('already_absent' as const)),
    })).resolves.toBe(0);
  });

  it('acknowledges local termination failures with a bounded error code', async () => {
    const store = new InMemoryRuntimeSessionControlStore();
    const service = new RuntimeMcpSessionControlService({
      store,
      replicaId: 'replica-a',
      now: () => T0,
    });
    await store.createTerminationCommand({
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      targetReplicaId: 'replica-a',
      reason: 'operator_terminated',
      requestedAt: T0,
      requestedBy: { kind: 'operator', userId: USER_ID },
    });

    await expect(service.reconcilePendingCommands({
      terminateLocalSession: jest.fn(() => Promise.reject(new Error('transport close failed with sensitive detail'))),
    })).resolves.toBe(1);

    await expect(store.getCommandAck(COMMAND_ID)).resolves.toMatchObject({
      result: 'failed',
      errorCode: 'local_termination_failed',
    });
  });
});
