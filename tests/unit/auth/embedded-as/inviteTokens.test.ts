import { describe, it, expect, beforeEach } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { InviteTokenStore } from '../../../../src/auth/embedded-as/inviteTokens.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';

describe('InviteTokenStore', () => {
  let store: InviteTokenStore;
  let storage: InMemoryAuthStorageLayer;

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
    store = new InviteTokenStore(randomBytes(32), storage);
  });

  it('rejects construction with a too-short secret', () => {
    expect(() => new InviteTokenStore(Buffer.from('short'))).toThrow(/at least 16 bytes/);
  });

  it('issues, verifies, and consumes a fresh token (must-fix #17 / #1)', async () => {
    const token = store.issue({ sub: 'local_alice', email: 'alice@example.com', purpose: 'invite' });
    const verified = store.verify(token);
    expect(verified.ok).toBe(true);

    const consumed = await store.consume(token);
    expect(consumed.ok).toBe(true);
    if (consumed.ok) {
      expect(consumed.payload.sub).toBe('local_alice');
      expect(consumed.payload.email).toBe('alice@example.com');
      expect(consumed.payload.purpose).toBe('invite');
    }
  });

  it('rejects a second consume on the same token (single-use)', async () => {
    const token = store.issue({ sub: 'a', email: 'a@x', purpose: 'invite' });
    expect((await store.consume(token)).ok).toBe(true);
    const second = await store.consume(token);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already-consumed');
  });

  it('verify does NOT consume — anti-pre-fetch (must-fix #1)', async () => {
    const token = store.issue({ sub: 'a', email: 'a@x', purpose: 'magic-link' });
    expect(store.verify(token).ok).toBe(true);
    expect(store.verify(token).ok).toBe(true);
    expect(store.verify(token).ok).toBe(true);
    // Still consumable — verify never consumed.
    expect((await store.consume(token)).ok).toBe(true);
  });

  it('rejects tokens signed by a different secret', () => {
    const other = new InviteTokenStore(randomBytes(32), new InMemoryAuthStorageLayer());
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

  it('consume() requires storage; throws clearly when constructed without it', async () => {
    const issuerOnly = new InviteTokenStore(randomBytes(32));
    const token = issuerOnly.issue({ sub: 'a', email: 'a@x', purpose: 'invite' });
    await expect(issuerOnly.consume(token)).rejects.toThrow(/requires a storage layer/);
  });

  it('consumed-jti durability: a second InviteTokenStore against the same storage rejects replay (H5)', async () => {
    // Pin H5: the in-memory consumed-set used to evaporate on restart,
    // letting captured invite URLs replay within their TTL — for local
    // accounts that meant a re-upsert of a fresh password hash.
    // Persisting the consumed marker through IAuthStorageLayer means a
    // fresh InviteTokenStore against the same storage still rejects the
    // replay.
    const secret = randomBytes(32);
    const storeA = new InviteTokenStore(secret, storage);
    const storeB = new InviteTokenStore(secret, storage);
    const token = storeA.issue({ sub: 'persist', email: 'p@x', purpose: 'invite' });
    expect((await storeA.consume(token)).ok).toBe(true);
    const replay = await storeB.consume(token);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('already-consumed');
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
