import { MAX_TIMER_DELAY_MS } from '../../../src/utils/timers.js';
import { InMemoryRuntimeSessionControlStore } from '../../../src/web-console/services/runtime/InMemoryRuntimeSessionControlStore.js';
import { RuntimeMcpSessionControlService, runtimePresenceLeaseMsFor } from '../../../src/web-console/services/runtime/RuntimeMcpSessionControlService.js';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { RuntimePresenceLease } from '../../../src/server/http/RuntimePresenceLease.js';

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(0); jest.spyOn(Math, 'random').mockReturnValue(0.5); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe('presence renewal cadence', () => {
  const confirmedLeaseUntil = () => new Date(300);
  const updated = (until = 300) => ({ kind: 'updated' as const, presence: { leaseUntil: new Date(until) } }) as Awaited<ReturnType<import('../../../src/web-console/services/runtime/RuntimeMcpSessionControlService.js').RuntimeMcpSessionControlService['renewSessionLease']>>;

  it.each(['post', 'stream'] as const)('maintains presence until both owners finish, %s finishing first', async first => {
    const lost = jest.fn();
    const renew = jest.fn(async () => updated(Date.now() + 300));
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil, renew, lost });
    lease.setPostActive(true);
    lease.open();
    await jest.advanceTimersByTimeAsync(400);
    if (first === 'post') lease.setPostActive(false);
    else lease.close();
    await jest.advanceTimersByTimeAsync(400);
    expect(lost).not.toHaveBeenCalled();
    expect(lease.hasExpired()).toBe(false);
    if (first === 'post') lease.close();
    else lease.setPostActive(false);
    await jest.advanceTimersByTimeAsync(0);
    const count = renew.mock.calls.length;
    await jest.advanceTimersByTimeAsync(400);
    expect(renew).toHaveBeenCalledTimes(count);
    expect(jest.getTimerCount()).toBe(0);
    lease.dispose();
  });

  it.each(['quiet', 'stream', 'idle'] as const)('short POSTs add no renewal writes, mode=%s', async mode => {
    const renew = jest.fn(async () => updated(Date.now() + 300));
    const lease = new RuntimePresenceLease({ intervalMs: 100, renewWhileIdle: mode === 'idle', confirmedLeaseUntil, renew, lost: jest.fn() });
    if (mode === 'stream') { lease.open(); await jest.advanceTimersByTimeAsync(0); renew.mockClear(); }
    for (let i = 0; i < 3; i++) {
      lease.setPostActive(true);
      await jest.advanceTimersByTimeAsync(10);
      lease.activityStarted(); lease.setPostActive(false); lease.activityFinished();
    }
    expect(renew).not.toHaveBeenCalled();
    lease.dispose(); expect(jest.getTimerCount()).toBe(0);
  });

  it('defers busy renewal, repeats while held, and cancels it on completion', async () => {
    const renew = jest.fn(async () => updated(Date.now() + 300));
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil, renew, lost: jest.fn() });
    lease.setPostActive(true);
    await jest.advanceTimersByTimeAsync(99); expect(renew).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(201); expect(renew).toHaveBeenCalledTimes(3);
    lease.setPostActive(false);
    await jest.advanceTimersByTimeAsync(400); expect(renew).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([250, 150])('short POST after quiet time %sms adds no renewal while heartbeat settles', async start => {
    let confirmed = new Date(300);
    const renew = jest.fn(async () => updated(Date.now() + 300));
    const lost = jest.fn();
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil: () => confirmed, renew, lost });
    jest.setSystemTime(start);
    lease.setPostActive(true);
    await jest.advanceTimersByTimeAsync(10);
    lease.activityStarted(); lease.setPostActive(false);
    // Cross the old renewal point, but stay inside the guarded durable lease.
    await jest.advanceTimersByTimeAsync(start === 250 ? 30 : 80);
    expect(renew).not.toHaveBeenCalled();
    confirmed = new Date(Date.now() + 300); lease.activityFinished();
    expect(lost).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });

  it('held POST near expiry renews before expiry and continues on interval cadence', async () => {
    const renew = jest.fn(async () => updated(Date.now() + 300));
    const lost = jest.fn();
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil, renew, lost });
    jest.setSystemTime(250); lease.setPostActive(true);
    await jest.advanceTimersByTimeAsync(24); expect(renew).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1); expect(renew).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(200); expect(renew).toHaveBeenCalledTimes(3);
    expect(lost).not.toHaveBeenCalled(); expect(lease.hasExpired()).toBe(false);
    lease.setPostActive(false);
    await jest.advanceTimersByTimeAsync(300); expect(renew).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fails closed with one millisecond left when the deferred renewal cannot run in time', async () => {
    const renew = jest.fn(async () => updated(600)); const lost = jest.fn();
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil, renew, lost });
    jest.setSystemTime(299); lease.setPostActive(true);
    await jest.advanceTimersByTimeAsync(1);
    expect(lost).toHaveBeenCalledWith('lease_expired');
    expect(renew).not.toHaveBeenCalled(); expect(lease.hasExpired()).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels quiet maintenance but keeps the pending heartbeat expiry guard', async () => {
    const renew = jest.fn(async () => updated(600)); const lost = jest.fn();
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil, renew, lost });
    lease.setPostActive(true); lease.activityStarted(); lease.setPostActive(false);
    await jest.advanceTimersByTimeAsync(300);
    expect(renew).not.toHaveBeenCalled(); expect(lost).toHaveBeenCalledWith('lease_expired');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves renewal retry backoff after the POST completes', async () => {
    const renew = jest.fn(async () => updated(Date.now() + 300)).mockRejectedValueOnce(new Error('offline'));
    const lost = jest.fn();
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil, renew, lost });
    lease.setPostActive(true);
    await jest.advanceTimersByTimeAsync(100); expect(renew).toHaveBeenCalledTimes(1);
    lease.setPostActive(false);
    await jest.advanceTimersByTimeAsync(100); expect(renew).toHaveBeenCalledTimes(2);
    expect(lost).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });

  it('schedules earlier when an admitted POST starts near lease expiry', async () => {
    const renew = jest.fn(async () => updated(Date.now() + 300));
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil, renew, lost: jest.fn() });
    jest.setSystemTime(150);
    lease.setPostActive(true);
    await jest.advanceTimersByTimeAsync(74); expect(renew).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1); expect(renew).toHaveBeenCalledTimes(1);
    lease.dispose();
  });

  it.each([false, true])('registration alone covers initialization; long initialize=%s', async long => {
    let confirmed: Date | undefined;
    const renew = jest.fn(async () => updated(Date.now() + 300));
    const lost = jest.fn();
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil: () => confirmed, renew, lost });
    lease.setPostActive(true);
    await jest.advanceTimersByTimeAsync(150);
    expect(renew).not.toHaveBeenCalled();
    confirmed = new Date(Date.now() + 300); lease.activitySucceeded();
    if (long) {
      await jest.advanceTimersByTimeAsync(400);
      expect(renew).toHaveBeenCalledTimes(4);
      expect(lost).not.toHaveBeenCalled();
    }
    lease.setPostActive(false);
    const count = renew.mock.calls.length;
    await jest.advanceTimersByTimeAsync(400);
    expect(renew).toHaveBeenCalledTimes(count);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([false, true])('bounds unconfirmed initialization without redundant renewals, responseComplete=%s', async responseComplete => {
    const renew = jest.fn(async () => updated()); const lost = jest.fn();
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil: () => undefined, renew, lost });
    lease.setPostActive(true);
    if (responseComplete) lease.setPostActive(false);
    await jest.advanceTimersByTimeAsync(300);
    expect(renew).not.toHaveBeenCalled(); expect(lost).toHaveBeenCalledWith('lease_expired');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not revive an expired lease for a POST', async () => {
    const renew = jest.fn(async () => updated(900));
    const lost = jest.fn();
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil, renew, lost });
    jest.setSystemTime(300);
    lease.setPostActive(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(lost).toHaveBeenCalledWith('lease_expired');
    expect(renew).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('publishes a fresh final-close lease after a successful pending renewal', async () => {
    let complete!: (value: ReturnType<typeof updated>) => void;
    const first = new Promise<ReturnType<typeof updated>>(resolve => { complete = resolve; });
    const renew = jest.fn(async () => updated()).mockImplementationOnce(() => first);
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil, renew, lost: jest.fn() });
    lease.open(); await jest.advanceTimersByTimeAsync(0); lease.close();
    expect(renew).toHaveBeenCalledTimes(1); complete(updated());
    await jest.advanceTimersByTimeAsync(0);
    expect(renew).toHaveBeenCalledTimes(2); expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['closing', 'replica_mismatch'] as const)('disposes immediately for typed loss %s', async reason => {
    const lost = jest.fn();
    new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil, renew: async () => ({ kind: 'lost', reason }), lost }).open();
    await jest.advanceTimersByTimeAsync(0);
    expect(lost).toHaveBeenCalledWith(reason); expect(jest.getTimerCount()).toBe(0);
  });

  it('survives a thrown renewal and retries inside the confirmed lease', async () => {
    const lost = jest.fn(); const warn = jest.fn();
    const renew = jest.fn(async () => updated(600)).mockImplementationOnce(() => { throw new Error('temporary'); });
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil, renew, lost, warn });
    lease.open(); await jest.advanceTimersByTimeAsync(100);
    expect(renew).toHaveBeenCalledTimes(2); expect(warn).toHaveBeenCalledWith('outage'); expect(lost).not.toHaveBeenCalled();
    lease.dispose(); expect(jest.getTimerCount()).toBe(0);
  });

  it('allows a slow renewal to finish without shortening its confirmed lease', async () => {
    let complete!: (value: ReturnType<typeof updated>) => void;
    const lost = jest.fn(); const warn = jest.fn();
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil, renew: () => new Promise(resolve => { complete = resolve; }), lost, warn });
    lease.open(); await jest.advanceTimersByTimeAsync(150);
    expect(warn).toHaveBeenCalledWith('timeout'); expect(lost).not.toHaveBeenCalled();
    complete(updated(600)); await jest.advanceTimersByTimeAsync(150);
    expect(lost).not.toHaveBeenCalled(); lease.dispose(); expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['pending', 'error', 'missing'])('closes prolonged %s only at confirmed lease expiry', async failure => {
    const lost = jest.fn();
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil, renew: async () => {
      if (failure === 'pending') return new Promise(() => {});
      if (failure === 'error') throw new Error('offline');
      return { kind: 'lost', reason: 'missing' };
    }, lost });
    lease.open(); await jest.advanceTimersByTimeAsync(299); expect(lost).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1); expect(lost).toHaveBeenCalledWith('lease_expired'); expect(jest.getTimerCount()).toBe(0);
  });

  it('observes newer activity confirmations when its expiry timer fires', async () => {
    let confirmation = new Date(300); const lost = jest.fn();
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil: () => confirmation, renew: () => new Promise(() => {}), lost });
    lease.open(); await jest.advanceTimersByTimeAsync(200); confirmation = new Date(600);
    await jest.advanceTimersByTimeAsync(200); expect(lost).not.toHaveBeenCalled();
    lease.dispose(); expect(jest.getTimerCount()).toBe(0);
  });
});

describe('non-streaming presence guards', () => {
  it('bounds failed POST writes without periodic quiet renewal', async () => {
    const renew = jest.fn(async () => ({ kind: 'lost' as const, reason: 'missing' as const }));
    const lost = jest.fn();
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil: () => new Date(300), renew, lost });
    lease.guard(); lease.activitySucceeded();
    await jest.advanceTimersByTimeAsync(100); expect(renew).not.toHaveBeenCalled();
    lease.guard(); lease.recover();
    await jest.advanceTimersByTimeAsync(199); expect(lost).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1); expect(lost).toHaveBeenCalledWith('lease_expired');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('registration success cannot clear a guard for a still-pending POST write', async () => {
    let confirmed: Date | undefined; const lost = jest.fn();
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil: () => confirmed, renew: () => new Promise(() => {}), lost });
    lease.guard(); lease.activityStarted(); confirmed = new Date(300); lease.activitySucceeded();
    await jest.advanceTimersByTimeAsync(300);
    expect(lost).toHaveBeenCalledWith('lease_expired'); expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds stalled registration even if no stream is opened', async () => {
    const lost = jest.fn(); const renew = jest.fn(async () => ({ kind: 'lost' as const, reason: 'missing' as const }));
    const lease = new RuntimePresenceLease({ intervalMs: 100, confirmedLeaseUntil: () => undefined, renew, lost });
    lease.guard(); await jest.advanceTimersByTimeAsync(300);
    expect(lost).toHaveBeenCalledWith('lease_expired'); expect(renew).not.toHaveBeenCalled();
  });


});



describe('presence timer boundaries', () => {
  it('chunks the maximum configured idle lease and expires only at its absolute deadline', async () => {
    const duration = runtimePresenceLeaseMsFor(MAX_TIMER_DELAY_MS);
    expect(duration).toBeGreaterThan(MAX_TIMER_DELAY_MS);
    const lost = jest.fn(); const timers = jest.spyOn(globalThis, 'setTimeout');
    const lease = new RuntimePresenceLease({ intervalMs: duration / 3, confirmedLeaseUntil: () => new Date(duration), renew: () => new Promise(() => {}), lost });
    lease.open(); await jest.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
    expect(lost).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(duration - MAX_TIMER_DELAY_MS - 1);
    expect(lost).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(lost).toHaveBeenCalledWith('lease_expired');
    expect(timers.mock.calls.every(([, delay]) => delay! <= MAX_TIMER_DELAY_MS)).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('chunks a periodic renewal beyond the Node limit without renewing early', async () => {
    const intervalMs = MAX_TIMER_DELAY_MS + 60_000;
    const renew = jest.fn(async () => ({ kind: 'updated' as const, presence: { leaseUntil: new Date(Date.now() + intervalMs * 3) } }) as Awaited<ReturnType<RuntimeMcpSessionControlService['renewSessionLease']>>);
    const timers = jest.spyOn(globalThis, 'setTimeout');
    const lease = new RuntimePresenceLease({ intervalMs, confirmedLeaseUntil: () => new Date(intervalMs * 3), renew, lost: jest.fn() });
    lease.open(); await jest.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
    expect(renew).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledTimes(2);
    expect(timers.mock.calls.every(([, delay]) => delay! <= MAX_TIMER_DELAY_MS)).toBe(true);
    lease.dispose(); expect(jest.getTimerCount()).toBe(0);
  });
});

describe('idle-disabled presence maintenance', () => {
  async function setup(renewWhileIdle: boolean) {
    const duration = runtimePresenceLeaseMsFor(0);
    const store = new InMemoryRuntimeSessionControlStore();
    const control = new RuntimeMcpSessionControlService({ store, replicaId: 'replica', leaseDurationMs: duration });
    await control.registerSession({ sessionId: 'session', userId: '018f3d47-73ae-7f10-a0de-0742618d4fb1', accountCorrelationId: '7e5355c1-bc0d-4bb8-a806-53bd05e44727' });
    const lost = jest.fn();
    const lease = new RuntimePresenceLease({ intervalMs: control.getLeaseRenewalIntervalMs(), renewWhileIdle, confirmedLeaseUntil: () => control.getConfirmedLeaseUntil('session'), renew: () => control.renewSessionLease('session'), lost });
    lease.guard(); lease.activitySucceeded();
    return { duration, store, control, lease, lost };
  }

  it('survives two full quiet intervals and sweeps without activity or re-registration', async () => {
    const { duration, store, control, lease, lost } = await setup(true);
    const register = jest.spyOn(store, 'registerPresence');
    for (let interval = 0; interval < 2; interval++) {
      await jest.advanceTimersByTimeAsync(duration + 60_000);
      expect(await store.sweepStalePresence(new Date())).toBe(0);
      expect(control.getConfirmedLeaseUntil('session')!.getTime()).toBeGreaterThan(Date.now());
      expect(await store.findPresence('session')).toMatchObject({ requestCount: 0, lastActiveAt: new Date(0) });
      expect(lease.hasExpired()).toBe(false);
    }
    expect(lost).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
    lease.dispose(); expect(jest.getTimerCount()).toBe(0);
  });

  it('parks when idle expiry is enabled; local admission notices a lapsed lease before a timer runs', async () => {
    const { duration, lease, lost } = await setup(false);
    expect(jest.getTimerCount()).toBe(0);
    jest.setSystemTime(duration);
    expect(lease.hasExpired()).toBe(true);
    expect(lost).not.toHaveBeenCalled(); lease.dispose();
  });

  it('keeps idle-disabled outages bounded to the confirmed lease', async () => {
    const { duration, store, lease, lost } = await setup(true);
    jest.spyOn(store, 'renewSessionLease').mockRejectedValue(new Error('offline'));
    await jest.advanceTimersByTimeAsync(duration - 1); expect(lost).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1); expect(lost).toHaveBeenCalledWith('lease_expired');
    expect(jest.getTimerCount()).toBe(0); expect(lease.hasExpired()).toBe(true);
  });

  it('continues periodic renewal after final stream close when idle expiry is disabled', async () => {
    const { duration, store, lease, lost } = await setup(true);
    lease.open(); await jest.advanceTimersByTimeAsync(0); lease.close();
    await jest.advanceTimersByTimeAsync(duration * 2);
    expect(lost).not.toHaveBeenCalled(); expect(await store.sweepStalePresence(new Date())).toBe(0);
    lease.dispose(); expect(jest.getTimerCount()).toBe(0);
  });
});
