import { describe, it, expect, beforeEach } from '@jest/globals';
import { LocalLoginRateLimiter } from '../../../../src/auth/embedded-as/rateLimit.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';

describe('LocalLoginRateLimiter (must-fix #16)', () => {
  let storage: InMemoryAuthStorageLayer;
  let limiter: LocalLoginRateLimiter;

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
    limiter = new LocalLoginRateLimiter({ storage });
  });

  it('allows the first 5 failed attempts then backs off', async () => {
    const sub = 'local_alice';
    const ip = '10.0.0.1';
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
    const ip = '10.0.0.1';
    for (let i = 0; i < 5; i += 1) {
      await limiter.noteFailure(sub, ip);
    }
    const events = await storage.listIdentityEvents();
    const fired = events.find(
      e => e.type === 'auth.local.brute_force_suspected'
        && (e.details as Record<string, unknown> | undefined)?.dimension === 'account',
    );
    expect(fired).toBeDefined();
  });

  it('only fires the brute-force audit ONCE per breach (not on every failure)', async () => {
    const sub = 'local_alice';
    const ip = '10.0.0.1';
    for (let i = 0; i < 8; i += 1) {
      await limiter.noteFailure(sub, ip);
    }
    const events = await storage.listIdentityEvents();
    const accountFires = events.filter(
      e => e.type === 'auth.local.brute_force_suspected'
        && (e.details as Record<string, unknown> | undefined)?.dimension === 'account',
    );
    expect(accountFires).toHaveLength(1);
  });

  it('locks an IP after 20 failures across many accounts', async () => {
    const ip = '10.0.0.1';
    for (let i = 0; i < 20; i += 1) {
      await limiter.noteFailure(`local_user_${i}`, ip);
    }
    const check = limiter.check('local_anyone', ip);
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/ip locked/);

    const events = await storage.listIdentityEvents();
    const ipFire = events.find(
      e => e.type === 'auth.local.brute_force_suspected'
        && (e.details as Record<string, unknown> | undefined)?.dimension === 'ip',
    );
    expect(ipFire).toBeDefined();
  });

  it('preserves account failure record across noteSuccess (H9: credential-stuffing carryover)', async () => {
    // H9: a successful login does NOT clear the failure counter. An
    // attacker who succeeded with a stolen credential after several
    // failures cannot use that success to reset the threshold for a
    // fresh probe round on the same account.
    const sub = 'local_alice';
    const ip = '10.0.0.1';
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
    const ip = '10.0.0.1';
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
        && (e.details as Record<string, unknown> | undefined)?.dimension === 'ip',
    );
    expect(ipFire).toBeUndefined();
  });

  it('treats ::ffff:1.2.3.4 and 1.2.3.4 as the same IP bucket', async () => {
    // Otherwise an attacker can bypass the per-IP limit by alternating
    // between the IPv4-mapped IPv6 form and the bare IPv4 form.
    for (let i = 0; i < 10; i += 1) {
      await limiter.noteFailure(`local_user_${i}`, '::ffff:10.0.0.1');
    }
    for (let i = 10; i < 20; i += 1) {
      await limiter.noteFailure(`local_user_${i}`, '10.0.0.1');
    }
    const check = limiter.check('local_someone_else', '10.0.0.1');
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
});
