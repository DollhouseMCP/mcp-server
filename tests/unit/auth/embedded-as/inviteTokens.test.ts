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
});
