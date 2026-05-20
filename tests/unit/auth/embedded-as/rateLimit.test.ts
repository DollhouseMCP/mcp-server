import { describe, it, expect, beforeEach } from '@jest/globals';
import { LocalLoginRateLimiter } from '../../../../src/auth/embedded-as/rateLimit.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import {
  CLIENT_PRIMARY,
  CLIENT_ATTACKER,
  CLIENT_SATURATION_A,
  CLIENT_SATURATION_B,
  CLIENT_DRAIN_TRIGGER,
} from '../../../fixtures/test-ips.js';

describe('LocalLoginRateLimiter (must-fix #16)', () => {
  let storage: InMemoryAuthStorageLayer;
  let limiter: LocalLoginRateLimiter;

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
    limiter = new LocalLoginRateLimiter({ storage });
  });

  it('allows the first 5 failed attempts then backs off', async () => {
    const sub = 'local_alice';
    const ip = CLIENT_PRIMARY;
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.check(sub, ip).allowed).toBe(true);
      await limiter.noteFailure(sub, ip);
    }
    const sixth = limiter.check(sub, ip);
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterMs).toBeGreaterThan(0);
  });

  it('emits brute-force audit event at threshold (account dimension)', async () => {
    const sub = 'local_alice';
    const ip = CLIENT_PRIMARY;
    for (let i = 0; i < 5; i += 1) {
      await limiter.noteFailure(sub, ip);
    }
    const events = await storage.listIdentityEvents();
    const fired = events.find(
      e => e.type === 'auth.local.brute_force_suspected'
        && e.details?.dimension === 'account',
    );
    expect(fired).toBeDefined();
  });

  it('only fires the brute-force audit ONCE per breach (not on every failure)', async () => {
    const sub = 'local_alice';
    const ip = CLIENT_PRIMARY;
    for (let i = 0; i < 8; i += 1) {
      await limiter.noteFailure(sub, ip);
    }
    const events = await storage.listIdentityEvents();
    const accountFires = events.filter(
      e => e.type === 'auth.local.brute_force_suspected'
        && e.details?.dimension === 'account',
    );
    expect(accountFires).toHaveLength(1);
  });

  it('locks an IP after 20 failures across many accounts', async () => {
    const ip = CLIENT_PRIMARY;
    for (let i = 0; i < 20; i += 1) {
      await limiter.noteFailure(`local_user_${i}`, ip);
    }
    const check = limiter.check('local_anyone', ip);
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/ip locked/);

    const events = await storage.listIdentityEvents();
    const ipFire = events.find(
      e => e.type === 'auth.local.brute_force_suspected'
        && e.details?.dimension === 'ip',
    );
    expect(ipFire).toBeDefined();
  });

  it('preserves account failure record across noteSuccess (H9: credential-stuffing carryover)', async () => {
    // H9: a successful login does NOT clear the failure counter. An
    // attacker who succeeded with a stolen credential after several
    // failures cannot use that success to reset the threshold for a
    // fresh probe round on the same account.
    const sub = 'local_alice';
    const ip = CLIENT_PRIMARY;
    for (let i = 0; i < 4; i += 1) {
      await limiter.noteFailure(sub, ip);
    }
    await limiter.noteSuccess(sub, ip);
    // 5th failure must hit the threshold even though a success happened
    // in between. With the prior delete-on-success behavior the counter
    // was 0 after success and 5 more attempts were available.
    await limiter.noteFailure(sub, ip);
    expect(limiter.check(sub, ip).allowed).toBe(false);
  });

  it('still allows the legitimate user immediate access after success when sub-threshold', async () => {
    const sub = 'local_alice';
    const ip = CLIENT_PRIMARY;
    await limiter.noteFailure(sub, ip);
    await limiter.noteFailure(sub, ip);
    await limiter.noteSuccess(sub, ip);
    // Two prior failures + success — well under threshold (5). The
    // record persists but the user is not locked out; the next check
    // is allowed because the count is below the threshold.
    expect(limiter.check(sub, ip).allowed).toBe(true);
  });

  it("does not lump every 'unknown' IP into one shared bucket", async () => {
    // Twenty failures from unresolvable callers used to lock out everyone
    // arriving without a resolvable IP. Per-IP must skip the unknown bucket.
    for (let i = 0; i < 20; i += 1) {
      await limiter.noteFailure(`local_user_${i}`, 'unknown');
    }
    const check = limiter.check('local_someone_else', 'unknown');
    expect(check.allowed).toBe(true);

    const events = await storage.listIdentityEvents();
    const ipFire = events.find(
      e => e.type === 'auth.local.brute_force_suspected'
        && e.details?.dimension === 'ip',
    );
    expect(ipFire).toBeUndefined();
  });

  it('treats ::ffff:1.2.3.4 and 1.2.3.4 as the same IP bucket', async () => {
    // Otherwise an attacker can bypass the per-IP limit by alternating
    // between the IPv4-mapped IPv6 form and the bare IPv4 form.
    for (let i = 0; i < 10; i += 1) {
      await limiter.noteFailure(`local_user_${i}`, `::ffff:${CLIENT_PRIMARY}`);
    }
    for (let i = 10; i < 20; i += 1) {
      await limiter.noteFailure(`local_user_${i}`, CLIENT_PRIMARY);
    }
    const check = limiter.check('local_someone_else', CLIENT_PRIMARY);
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/ip locked/);
  });

  it('locked accounts survive an unbounded flood of unique-username failures', async () => {
    // The accounts Map must not grow without bound; an attacker who
    // generates millions of unique sub strings would otherwise OOM the
    // process. The cap evicts past-window entries; the locked one stays.
    const lockedSub = 'local_alice';
    for (let i = 0; i < 6; i += 1) {
      await limiter.noteFailure(lockedSub, 'unknown');
    }
    expect(limiter.check(lockedSub, 'unknown').allowed).toBe(false);

    for (let i = 0; i < 11_000; i += 1) {
      await limiter.noteFailure(`flood_${i}`, 'unknown');
    }
    // alice's record was kept (still actively locked) while flood entries
    // were FIFO-evicted past the cap.
    expect(limiter.check(lockedSub, 'unknown').allowed).toBe(false);
  }, 30_000);

  it('cycle 19 / H1: saturation guard resets when table drains below cap', async () => {
    // The earlier shape latched accountSaturationFired = true forever
    // after the first flood. A second wave (after the table aged out)
    // produced no audit event — operators only ever saw the first flood.
    // The cycle 19 fix resets the flag when boundAccounts observes the
    // table back below the cap.
    //
    // Cycle 22: renamed from "second flood emits second audit" to
    // match what the test actually pins. The end-to-end re-emission
    // requires flooding 22k+ entries twice (~minutes); the focused
    // assertion here is the flag reset itself, exercised through the
    // production noteFailure path.
    const internal = limiter as unknown as { accountSaturationFired: boolean; ipSaturationFired: boolean };
    internal.accountSaturationFired = true;
    internal.ipSaturationFired = true;

    // Single failure → hits noteFailure → calls boundAccounts on a
    // small table → early-returns with flag reset.
    await limiter.noteFailure('local_drain_check', CLIENT_ATTACKER);

    expect(internal.accountSaturationFired).toBe(false);
    expect(internal.ipSaturationFired).toBe(false);
  });

  it('cycle 22 / re-emission: a second saturation after drain re-fires the audit event', async () => {
    // End-to-end pin for the re-emission contract. Saturation requires
    // the eviction loop to FIFO-evict an actively-locked entry — a
    // flood of single-failure entries doesn't reach saturation
    // because pass-2 (non-locked eviction) drops them. Direct-state
    // manipulation creates 10_001 actively-locked entries, then
    // triggers boundAccounts via noteFailure. A second cycle after
    // drain proves the audit re-fires.
    const internal = limiter as unknown as {
      accounts: Map<string, { failures: number; firstFailureAt: number; bruteForceFired: boolean }>;
      ips: Map<string, { failures: number; firstFailureAt: number; lockedUntil: number; bruteForceFired: boolean }>;
    };

    // Populate 10_001 actively-locked accounts (above MAX cap of 10k).
    const now = Date.now();
    for (let i = 0; i < 10_001; i += 1) {
      internal.accounts.set(`locked1_${i}`, {
        failures: 5, // at threshold = locked
        firstFailureAt: now,
        bruteForceFired: true, // already audited per-account, suppress noise
      });
    }

    // Trigger boundAccounts via noteFailure. The single new failure
    // pushes size to 10_002; pass 1 finds nothing safe-to-evict
    // (within window + locked); pass 2 finds nothing non-locked;
    // pass 3 FIFO-evicts a locked entry → saturation fires.
    await limiter.noteFailure('saturation_trigger_1', CLIENT_SATURATION_A);

    let saturationEvents = (await storage.listIdentityEvents()).filter(
      e => e.type === 'auth.local.rate_limit_saturated',
    );
    const eventsAfterFlood1 = saturationEvents.length;
    expect(eventsAfterFlood1).toBeGreaterThanOrEqual(1);

    // Drain: clear the locked entries (simulate natural ageing).
    internal.accounts.clear();
    internal.ips.clear();

    // Triggering noteFailure on a small table → boundAccounts early-
    // returns → resets the flag.
    await limiter.noteFailure('drain_trigger', CLIENT_DRAIN_TRIGGER);

    // Re-saturate with another locked-entry flood.
    for (let i = 0; i < 10_001; i += 1) {
      internal.accounts.set(`locked2_${i}`, {
        failures: 5,
        firstFailureAt: now,
        bruteForceFired: true,
      });
    }
    await limiter.noteFailure('saturation_trigger_2', CLIENT_SATURATION_B);

    saturationEvents = (await storage.listIdentityEvents()).filter(
      e => e.type === 'auth.local.rate_limit_saturated',
    );
    expect(saturationEvents.length).toBeGreaterThan(eventsAfterFlood1);
  }, 30_000);
});
