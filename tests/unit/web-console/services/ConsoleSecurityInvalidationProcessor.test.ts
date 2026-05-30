import { describe, expect, it, jest } from '@jest/globals';

import {
  ConsoleSecurityInvalidationProcessor,
  InMemoryConsoleSecurityInvalidationStore,
  InMemoryConsoleSessionStore,
  SECURITY_INVALIDATION_PROCESSOR_TASK_LABEL,
} from '../../../../src/web-console/index.js';
import type {
  ConsoleSessionRecord,
  IConsoleSecurityInvalidationStore,
  SecurityInvalidationEvent,
} from '../../../../src/web-console/index.js';

const NOW = new Date('2026-05-30T12:00:00.000Z');
const LATER = new Date('2026-05-30T12:00:20.000Z');
const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const OTHER_USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb2';

describe('ConsoleSecurityInvalidationProcessor', () => {
  it('renews its lease, applies events, acknowledges them, and advances its cursor', async () => {
    const store = new InMemoryConsoleSecurityInvalidationStore();
    const sessionStore = new InMemoryConsoleSessionStore();
    const revokedHash = hash(1);
    const elevatedHash = hash(2);
    const untouchedHash = hash(3);
    await sessionStore.create(sessionFixture({ idHash: revokedHash, userId: USER_ID, elevated: false }));
    await sessionStore.create(sessionFixture({ idHash: elevatedHash, userId: USER_ID, elevated: true }));
    await sessionStore.create(sessionFixture({ idHash: untouchedHash, userId: OTHER_USER_ID, elevated: true }));
    const revokeEvent = await store.appendEvent({
      kind: 'principal_credentials_revoked',
      urgency: 'acknowledged',
      userId: USER_ID,
      authzVersion: 2,
      reason: 'credentials_revoked',
      payload: { revokedGrants: true, authzVersionBumped: true },
      createdAt: NOW,
      createdByUserId: USER_ID,
    });
    const elevationEvent = await store.appendEvent({
      kind: 'admin_factor_disabled',
      urgency: 'acknowledged',
      userId: OTHER_USER_ID,
      reason: 'totp_reset',
      payload: { clearedElevations: true, proofMethod: 'admin_reset' },
      createdAt: NOW,
      createdByUserId: USER_ID,
    });
    const processor = new ConsoleSecurityInvalidationProcessor({
      store,
      sessionStore,
      replicaId: 'replica-a',
      leaseDurationMs: 20_000,
      now: () => NOW,
    });

    await expect(processor.runOnce()).resolves.toEqual({
      replicaId: 'replica-a',
      leasedUntil: LATER,
      processed: 2,
      acknowledged: 2,
      cursorSequenceId: elevationEvent.sequenceId,
    });

    await expect(store.listLiveReplicaIds(NOW)).resolves.toEqual(['replica-a']);
    await expect(store.getReplicaCursor('replica-a')).resolves.toBe(elevationEvent.sequenceId);
    await expect(store.listAcknowledgedReplicaIds(revokeEvent.eventId)).resolves.toEqual(['replica-a']);
    await expect(store.listAcknowledgedReplicaIds(elevationEvent.eventId)).resolves.toEqual(['replica-a']);
    await expect(sessionStore.findActiveByIdHash(revokedHash, NOW)).resolves.toBeNull();
    await expect(sessionStore.findActiveByIdHash(elevatedHash, NOW)).resolves.toBeNull();
    await expect(sessionStore.findActiveByIdHash(untouchedHash, NOW)).resolves.toMatchObject({
      elevation: null,
    });
  });

  it('revokes one console session when an event carries a session hash', async () => {
    const store = new InMemoryConsoleSecurityInvalidationStore();
    const sessionStore = new InMemoryConsoleSessionStore();
    const revokedHash = hash(4);
    const activeHash = hash(5);
    await sessionStore.create(sessionFixture({ idHash: revokedHash, userId: USER_ID, elevated: false }));
    await sessionStore.create(sessionFixture({ idHash: activeHash, userId: USER_ID, elevated: false }));
    const event = await store.appendEvent({
      kind: 'console_session_revoked',
      urgency: 'acknowledged',
      userId: null,
      consoleSessionIdHash: revokedHash,
      reason: 'self_session_revoked',
      payload: { sessionRevoked: true },
      createdAt: NOW,
      createdByUserId: USER_ID,
    });
    const processor = new ConsoleSecurityInvalidationProcessor({
      store,
      sessionStore,
      replicaId: 'replica-a',
      now: () => NOW,
    });

    await expect(processor.runOnce()).resolves.toMatchObject({
      processed: 1,
      acknowledged: 1,
      cursorSequenceId: event.sequenceId,
    });

    await expect(sessionStore.findActiveByIdHash(revokedHash, NOW)).resolves.toBeNull();
    await expect(sessionStore.findActiveByIdHash(activeHash, NOW)).resolves.toMatchObject({
      idHash: activeHash,
    });
  });

  it('does not acknowledge or advance the cursor when local application fails', async () => {
    class FailingSessionStore extends InMemoryConsoleSessionStore {
      override async revokeForUser(): Promise<number> {
        await Promise.resolve();
        throw new Error('session store unavailable');
      }
    }
    const store = new InMemoryConsoleSecurityInvalidationStore();
    const event = await store.appendEvent({
      kind: 'principal_disabled',
      urgency: 'acknowledged',
      userId: USER_ID,
      authzVersion: 3,
      reason: 'principal_disabled',
      payload: { revokedSessions: true, revokedCredentials: true, terminatedRuntimeSessions: true },
      createdAt: NOW,
      createdByUserId: USER_ID,
    });
    const reportError = jest.fn();
    const processor = new ConsoleSecurityInvalidationProcessor({
      store,
      sessionStore: new FailingSessionStore(),
      replicaId: 'replica-a',
      now: () => NOW,
      reportError,
    });

    await expect(processor.runOnce()).rejects.toThrow('session store unavailable');
    expect(reportError).toHaveBeenCalledTimes(1);
    await expect(store.getReplicaCursor('replica-a')).resolves.toBe(0);
    await expect(store.listAcknowledgedReplicaIds(event.eventId)).resolves.toEqual([]);
  });

  it('fails closed on runtime-unknown event kinds before acknowledgement or cursor advancement', async () => {
    const event = eventFixture({
      kind: 'future_principal_security_revoked',
      userId: USER_ID,
    });
    const store = eventStoreFixture(event);
    const processor = new ConsoleSecurityInvalidationProcessor({
      store,
      sessionStore: new InMemoryConsoleSessionStore(),
      replicaId: 'replica-a',
      now: () => NOW,
    });

    await expect(processor.runOnce()).rejects.toThrow(
      "Unsupported security invalidation event kind 'future_principal_security_revoked'",
    );
    expect(store.acknowledgeEvent).not.toHaveBeenCalled();
    expect(store.recordReplicaCursor).not.toHaveBeenCalled();
  });

  it('fails closed when an event is missing required local-application data', async () => {
    const event = eventFixture({
      kind: 'principal_disabled',
      userId: null,
    });
    const store = eventStoreFixture(event);
    const processor = new ConsoleSecurityInvalidationProcessor({
      store,
      sessionStore: new InMemoryConsoleSessionStore(),
      replicaId: 'replica-a',
      now: () => NOW,
    });

    await expect(processor.runOnce()).rejects.toThrow(
      `Security invalidation event ${event.eventId} is missing userId`,
    );
    expect(store.acknowledgeEvent).not.toHaveBeenCalled();
    expect(store.recordReplicaCursor).not.toHaveBeenCalled();
  });

  it('registers a periodic lifecycle task and reports running state', () => {
    const store = new InMemoryConsoleSecurityInvalidationStore();
    const sessionStore = new InMemoryConsoleSessionStore();
    const lifecycle = { registerPeriodicTask: jest.fn() };
    const processor = new ConsoleSecurityInvalidationProcessor({
      store,
      sessionStore,
      replicaId: 'replica-a',
      intervalMs: 7_000,
      now: () => NOW,
    });

    expect(processor.isRunning()).toBe(false);
    processor.register(lifecycle);
    processor.register(lifecycle);

    expect(processor.isRunning()).toBe(true);
    expect(lifecycle.registerPeriodicTask).toHaveBeenCalledTimes(1);
    expect(lifecycle.registerPeriodicTask).toHaveBeenCalledWith(
      7_000,
      expect.any(Function),
      SECURITY_INVALIDATION_PROCESSOR_TASK_LABEL,
    );
  });
});

function sessionFixture(options: {
  readonly idHash: Buffer;
  readonly userId: string;
  readonly elevated: boolean;
}): ConsoleSessionRecord {
  const elevation = options.elevated ? {
    capabilities: ['console:admin:security'] as const,
    expiresAt: new Date('2026-05-30T12:10:00.000Z'),
    acr: 'urn:dollhouse:acr:admin-stepup',
    amr: ['otp'],
    authTime: new Date('2026-05-30T12:00:00.000Z'),
  } : null;
  return {
    idHash: options.idHash,
    userId: options.userId,
    authSub: `github|${options.userId}`,
    csrfTokenHash: hash(100),
    grantedCapabilities: elevation ? ['console:self', ...elevation.capabilities] : ['console:self'],
    elevation,
    createdAt: new Date('2026-05-30T11:50:00.000Z'),
    lastUsedAt: NOW,
    idleExpiresAt: new Date('2026-05-30T13:00:00.000Z'),
    absoluteExpiresAt: new Date('2026-06-29T12:00:00.000Z'),
    revokedAt: null,
    lastIp: null,
    userAgent: null,
  };
}

function hash(byte: number): Buffer {
  return Buffer.alloc(32, byte);
}

function eventFixture(
  overrides: Partial<Omit<SecurityInvalidationEvent, 'kind'>> & { readonly kind?: string } = {},
): SecurityInvalidationEvent {
  return {
    sequenceId: 1,
    eventId: 'e6174fd8-f6ef-4286-8bd2-3f3eb30194c1',
    kind: 'principal_disabled',
    urgency: 'acknowledged',
    userId: USER_ID,
    consoleSessionIdHash: null,
    authzVersion: 2,
    reason: 'test_event',
    payload: {},
    createdAt: NOW,
    createdByUserId: USER_ID,
    ...overrides,
  } as SecurityInvalidationEvent;
}

function eventStoreFixture(event: SecurityInvalidationEvent) {
  return {
    appendEvent: jest.fn(),
    listEventsAfter: jest.fn(() => Promise.resolve([event])),
    getReplicaCursor: jest.fn(() => Promise.resolve(0)),
    recordReplicaCursor: jest.fn(() => Promise.resolve()),
    acquireReplicaLease: jest.fn(() => Promise.resolve()),
    listLiveReplicaIds: jest.fn(() => Promise.resolve(['replica-a'])),
    acknowledgeEvent: jest.fn(() => Promise.resolve()),
    listAcknowledgedReplicaIds: jest.fn(() => Promise.resolve([])),
  } satisfies IConsoleSecurityInvalidationStore;
}
