import { describe, it, expect, beforeEach } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { InviteTokenStore } from '../../../../src/auth/embedded-as/inviteTokens.js';

describe('InviteTokenStore', () => {
  let store: InviteTokenStore;

  beforeEach(() => {
    store = new InviteTokenStore(randomBytes(32));
  });

  it('rejects construction with a too-short secret', () => {
    expect(() => new InviteTokenStore(Buffer.from('short'))).toThrow(/at least 16 bytes/);
  });

  it('issues, verifies, and consumes a fresh token (must-fix #17 / #1)', () => {
    const token = store.issue({ sub: 'local_alice', email: 'alice@example.com', purpose: 'invite' });
    const verified = store.verify(token);
    expect(verified.ok).toBe(true);

    const consumed = store.consume(token);
    expect(consumed.ok).toBe(true);
    if (consumed.ok) {
      expect(consumed.payload.sub).toBe('local_alice');
      expect(consumed.payload.email).toBe('alice@example.com');
      expect(consumed.payload.purpose).toBe('invite');
    }
  });

  it('rejects a second consume on the same token (single-use)', () => {
    const token = store.issue({ sub: 'a', email: 'a@x', purpose: 'invite' });
    expect(store.consume(token).ok).toBe(true);
    const second = store.consume(token);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already-consumed');
  });

  it('verify does NOT consume — anti-pre-fetch (must-fix #1)', () => {
    const token = store.issue({ sub: 'a', email: 'a@x', purpose: 'magic-link' });
    expect(store.verify(token).ok).toBe(true);
    expect(store.verify(token).ok).toBe(true);
    expect(store.verify(token).ok).toBe(true);
    // Still consumable — verify never consumed.
    expect(store.consume(token).ok).toBe(true);
  });

  it('rejects tokens signed by a different secret', () => {
    const other = new InviteTokenStore(randomBytes(32));
    const token = other.issue({ sub: 'a', email: 'a@x', purpose: 'invite' });
    const verified = store.verify(token);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('invalid');
  });

  it('rejects expired tokens', () => {
    const token = store.issue({ sub: 'a', email: 'a@x', purpose: 'invite', ttlMs: 1 });
    const start = Date.now();
    while (Date.now() === start) { /* spin */ }
    const verified = store.verify(token);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('expired');
  });

  it('rejects malformed tokens', () => {
    expect(store.verify('not-a-token').ok).toBe(false);
    expect(store.verify('only-one-part').ok).toBe(false);
    expect(store.verify('aaa.bbb.ccc').ok).toBe(false);
  });

  it('prunes expired consumed entries on the next consume', () => {
    // Consume a short-TTL token, wait for it to expire, then consume a
    // long-TTL one — the expired jti should be evicted from the
    // consumed-set as part of the second consume.
    //
    // TTL is deliberately wider than the obvious "ttlMs: 1" choice: the
    // assertion at line `expect(store.consume(shortToken).ok).toBe(true)`
    // requires the consume to fall inside the token's lifetime, and a
    // 1 ms window races with V8 GC pauses + jest parallel-worker
    // scheduling under heavy CPU pressure (e.g. when other test files in
    // the suite are pegging cores with argon2 work). 50 ms is well past
    // any plausible GC pause yet still fast for the wait-for-expiry busy-
    // loop below.
    const shortTtlMs = 50;
    const shortToken = store.issue({ sub: 'a', email: 'a@x', purpose: 'invite', ttlMs: shortTtlMs });
    expect(store.consume(shortToken).ok).toBe(true);

    // @ts-expect-error reach into private state for the assertion
    expect(store['consumed'].size).toBe(1);

    const start = Date.now();
    while (Date.now() - start <= shortTtlMs) { /* spin past TTL */ }

    const longToken = store.issue({ sub: 'b', email: 'b@x', purpose: 'invite' });
    expect(store.consume(longToken).ok).toBe(true);

    // The expired short-token jti was pruned; only the long-token jti remains.
    // @ts-expect-error reach into private state for the assertion
    expect(store['consumed'].size).toBe(1);
  });

  it('refuses a new consume when the cap is reached with no expired entries to prune', () => {
    // Saturating the consumed-set with still-replayable tokens must not
    // evict any of them — that would let the evicted jti be replayed.
    // Instead the new consume is rejected with rate-exceeded.
    // @ts-expect-error stub the cap so we don't have to issue 10k tokens
    const consumed: Map<string, number> = store['consumed'];
    const stillValidExp = Date.now() + 60 * 60 * 1000;
    for (let i = 0; i < 10_000; i += 1) {
      consumed.set(`jti_${i}`, stillValidExp);
    }

    const fresh = store.issue({ sub: 'a', email: 'a@x', purpose: 'invite' });
    const result = store.consume(fresh);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('rate-exceeded');
  });

  describe('H11: oversize-token DoS guard', () => {
    it('rejects tokens longer than 4096 chars without computing the HMAC', () => {
      const oversized = 'a'.repeat(4097);
      const verified = store.verify(oversized);
      expect(verified.ok).toBe(false);
      if (!verified.ok) expect(verified.reason).toBe('invalid');
    });

    it('accepts tokens at the upper bound when the signature is valid', () => {
      // Genuine token issued by the store will be ~250 chars — well under
      // the 4096 cap. This asserts the cap doesn't reject legitimate
      // tokens in the typical size range.
      const token = store.issue({ sub: 'a', email: 'a@x', purpose: 'invite' });
      expect(token.length).toBeLessThan(4096);
      expect(store.verify(token).ok).toBe(true);
    });

    it('a 100KB attacker payload is rejected fast (no HMAC over 100KB)', () => {
      const huge = 'X'.repeat(100 * 1024);
      const t0 = process.hrtime.bigint();
      const verified = store.verify(huge);
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
      expect(verified.ok).toBe(false);
      // Way under any HMAC-of-100KB cost; the assertion is loose to
      // tolerate noisy CI runners.
      expect(elapsedMs).toBeLessThan(20);
    });
  });
});
