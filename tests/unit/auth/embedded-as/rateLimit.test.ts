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
    const events = storage.__testGetAuditEvents();
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
    const events = storage.__testGetAuditEvents();
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

    const events = storage.__testGetAuditEvents();
    const ipFire = events.find(
      e => e.type === 'auth.local.brute_force_suspected'
        && (e.details as Record<string, unknown> | undefined)?.dimension === 'ip',
    );
    expect(ipFire).toBeDefined();
  });

  it('clears account failures on noteSuccess', async () => {
    const sub = 'local_alice';
    const ip = '10.0.0.1';
    for (let i = 0; i < 4; i += 1) {
      await limiter.noteFailure(sub, ip);
    }
    await limiter.noteSuccess(sub, ip);
    // After a success, the account counter resets — next failure starts fresh.
    expect(limiter.check(sub, ip).allowed).toBe(true);
  });
});
