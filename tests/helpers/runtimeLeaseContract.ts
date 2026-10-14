import { describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type { IRuntimeSessionControlStore } from '../../src/web-console/services/runtime/IRuntimeSessionControlStore.js';
import { RuntimeMcpSessionControlService } from '../../src/web-console/services/runtime/RuntimeMcpSessionControlService.js';

export function runtimeLeaseContract(fixture: () => Promise<{ store: IRuntimeSessionControlStore; userId: string }>, available: () => boolean = () => true): void {
  const now = new Date('2026-10-12T12:00:00Z');
  const later = (ms: number) => new Date(now.getTime() + ms);
  async function setup() {
    const { store, userId } = await fixture();
    const input = { sessionId: randomUUID(), userId, accountCorrelationId: randomUUID(), replicaId: 'replica-a', transport: 'streamable-http' as const, startedAt: now, lastActiveAt: now, requestCount: 4, errorCount: 1, leaseUntil: later(1000) };
    await store.registerPresence(input);
    return { store, input };
  }
  describe('lease-only store and service contract', () => {
    it.each([true, false])('preserves counts/recency and never shortens leases in either write order (renew first: %s)', async renewFirst => {
      if (!available()) return;
      const { store, input } = await setup();
      const renew = () => store.renewSessionLease({ sessionId: input.sessionId, replicaId: input.replicaId, leaseUntil: later(5000) });
      const activity = () => store.heartbeatPresence({ ...input, requestCount: 5, lastActiveAt: later(100), leaseUntil: later(2000) });
      if (renewFirst) { await renew(); await activity(); } else { await activity(); await renew(); }
      expect(await store.findPresence(input.sessionId, now)).toMatchObject({ lastActiveAt: later(100), requestCount: 5, errorCount: 1, leaseUntil: later(5000) });
    });

    it('guards lease writes and close by replica/status; missing does not create', async () => {
      if (!available()) return;
      const { store, input } = await setup();
      await expect(store.renewSessionLease({ ...input, replicaId: 'replica-b' })).resolves.toEqual({ kind: 'lost', reason: 'replica_mismatch' });
      await store.markPresenceClosing(input.sessionId, now, 'replica-b');
      expect(await store.findPresence(input.sessionId, now)).not.toBeNull();
      await store.markPresenceClosing(input.sessionId, now, input.replicaId);
      await expect(store.renewSessionLease({ ...input, leaseUntil: later(5000) })).resolves.toEqual({ kind: 'lost', reason: 'closing' });
      await expect(store.renewSessionLease({ ...input, sessionId: randomUUID() })).resolves.toEqual({ kind: 'lost', reason: 'missing' });
    });

    it('service renews without changing activity, including a renewal immediately after another', async () => {
      if (!available()) return;
      const { store, input } = await setup(); let clock = now;
      const service = new RuntimeMcpSessionControlService({ store, replicaId: input.replicaId, now: () => clock, leaseDurationMs: 300 });
      await service.registerSession(input); await service.recordActivity(input.sessionId);
      clock = later(100); await service.renewSessionLease(input.sessionId);
      clock = later(101); await service.renewSessionLease(input.sessionId);
      expect(await store.findPresence(input.sessionId, clock)).toMatchObject({ lastActiveAt: now, requestCount: 1, errorCount: 0, leaseUntil: later(401) });
      expect(service.getLeaseRenewalIntervalMs()).toBe(100);
      await service.markSessionDisposed(input.sessionId);
      await expect(service.renewSessionLease(input.sessionId)).resolves.toEqual({ kind: 'lost', reason: 'closing' });
    });

    it.each([true, false])('disposal fences an initial registration (already in flight: %s)', async inFlight => {
      if (!available()) return;
      const { store, userId } = await fixture(); const sessionId = randomUUID();
      let release!: () => void; let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const realRegister = store.registerPresence.bind(store);
      const spy = jest.spyOn(store, 'registerPresence').mockImplementation(async input => { entered(); await gate; return realRegister(input); });
      const service = new RuntimeMcpSessionControlService({ store, replicaId: 'replica-a', now: () => now });
      const registered = service.registerSession({ sessionId, userId, accountCorrelationId: randomUUID() });
      if (inFlight) await started;
      const disposed = service.markSessionDisposed(sessionId);
      release(); await Promise.all([registered, disposed]); spy.mockRestore();
      expect(await store.findPresence(sessionId, now)).toBeNull();
      expect(service.getLocalSessionCount()).toBe(0);
    });

    it('disposal during a missing-row lookup never starts recovery or recreates presence', async () => {
      if (!available()) return;
      const { store, input } = await setup();
      const service = new RuntimeMcpSessionControlService({ store, replicaId: input.replicaId, now: () => now });
      await service.registerSession(input);
      let release!: () => void; let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const spy = jest.spyOn(store, 'heartbeatPresence').mockImplementation(async () => { entered(); await gate; return { kind: 'lost', reason: 'missing' }; });
      const registration = jest.spyOn(store, 'registerPresence');
      const activity = service.recordActivity(input.sessionId); await started;
      const disposed = service.markSessionDisposed(input.sessionId); release();
      await Promise.all([activity, disposed]);
      expect(registration).not.toHaveBeenCalled(); expect(await store.findPresence(input.sessionId, now)).toBeNull();
      spy.mockRestore(); registration.mockRestore();
    });
  });
}
