import { describe, it, expect, beforeEach } from '@jest/globals';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import type { StoredAccount } from '../../../../src/auth/embedded-as/storage/IAuthStorageLayer.js';

function makeAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    sub: 'github_42',
    provider: 'github',
    externalSub: '42',
    email: 'user@example.com',
    emailVerified: true,
    displayName: 'Test User',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('InMemoryAuthStorageLayer', () => {
  let store: InMemoryAuthStorageLayer;

  beforeEach(() => {
    store = new InMemoryAuthStorageLayer();
  });

  describe('accounts (must-fix #18: keyed on (provider, external_sub))', () => {
    it('upserts and finds by external id', async () => {
      const account = makeAccount();
      await store.upsertAccount(account);
      const found = await store.findAccountByExternalId('github', '42');
      expect(found).toEqual(account);
    });

    it('survives email change when external_sub is stable', async () => {
      await store.upsertAccount(makeAccount({ email: 'old@example.com' }));
      await store.upsertAccount(makeAccount({ email: 'new@example.com', updatedAt: Date.now() + 1 }));
      const found = await store.findAccountByExternalId('github', '42');
      expect(found?.email).toBe('new@example.com');
      expect(found?.sub).toBe('github_42');
    });

    it('returns null for unknown external id', async () => {
      const found = await store.findAccountByExternalId('github', '9999');
      expect(found).toBeNull();
    });

    it('looks up by sub after upsert', async () => {
      const account = makeAccount();
      await store.upsertAccount(account);
      const found = await store.getAccount('github_42');
      expect(found).toEqual(account);
    });
  });

  describe('audit events (must-fix #21)', () => {
    it('records identity events in order', async () => {
      await store.recordIdentityEvent({ type: 'auth.test.one', timestamp: 1 });
      await store.recordIdentityEvent({ type: 'auth.test.two', timestamp: 2 });
      const events = await store.listIdentityEvents();
      expect(events.map(e => e.type)).toEqual(['auth.test.one', 'auth.test.two']);
    });

    it('listIdentityEvents filters by type', async () => {
      await store.recordIdentityEvent({ type: 'auth.test.one', timestamp: 1 });
      await store.recordIdentityEvent({ type: 'auth.test.two', timestamp: 2 });
      const events = await store.listIdentityEvents({ type: 'auth.test.two' });
      expect(events.map(e => e.type)).toEqual(['auth.test.two']);
    });

    it('listIdentityEvents filters by sub', async () => {
      await store.recordIdentityEvent({ type: 'auth.x', sub: 'a', timestamp: 1 });
      await store.recordIdentityEvent({ type: 'auth.x', sub: 'b', timestamp: 2 });
      const events = await store.listIdentityEvents({ sub: 'a' });
      expect(events).toHaveLength(1);
      expect(events[0]!.sub).toBe('a');
    });

    it('listIdentityEvents filters by since (inclusive)', async () => {
      await store.recordIdentityEvent({ type: 'auth.x', timestamp: 100 });
      await store.recordIdentityEvent({ type: 'auth.x', timestamp: 200 });
      await store.recordIdentityEvent({ type: 'auth.x', timestamp: 300 });
      const events = await store.listIdentityEvents({ since: 200 });
      expect(events.map(e => e.timestamp)).toEqual([200, 300]);
    });

    it('listIdentityEvents returns events sorted by timestamp', async () => {
      // Push out-of-order to confirm the sort.
      await store.recordIdentityEvent({ type: 'auth.x', timestamp: 300 });
      await store.recordIdentityEvent({ type: 'auth.x', timestamp: 100 });
      await store.recordIdentityEvent({ type: 'auth.x', timestamp: 200 });
      const events = await store.listIdentityEvents();
      expect(events.map(e => e.timestamp)).toEqual([100, 200, 300]);
    });
  });

  describe('grant lookup (Phase 5 H14)', () => {
    it('findGrantsByAccountId returns ids of grants owned by the sub', async () => {
      await store.genericSet('Grant', 'g1', { accountId: 'github_42', clientId: 'c1' });
      await store.genericSet('Grant', 'g2', { accountId: 'github_42', clientId: 'c2' });
      await store.genericSet('Grant', 'g3', { accountId: 'github_99', clientId: 'c1' });
      await store.genericSet('Session', 'session-not-grant', { accountId: 'github_42' });
      const grants = await store.findGrantsByAccountId('github_42');
      expect(new Set(grants)).toEqual(new Set(['g1', 'g2']));
    });

    it('findGrantsByAccountId skips expired Grant entries', async () => {
      await store.genericSet('Grant', 'g-expired', { accountId: 'github_42' }, -1);
      await store.genericSet('Grant', 'g-live', { accountId: 'github_42' });
      const grants = await store.findGrantsByAccountId('github_42');
      expect(grants).toEqual(['g-live']);
    });

    it('findGrantsByAccountId returns empty array when no grants exist for sub', async () => {
      const grants = await store.findGrantsByAccountId('local_unknown');
      expect(grants).toEqual([]);
    });
  });

  describe('generic K/V (oidc-provider adapter sink)', () => {
    it('round-trips set/get/destroy', async () => {
      await store.genericSet('Session', 's-1', { user: 'alice' });
      expect(await store.genericGet('Session', 's-1')).toEqual({ user: 'alice' });
      await store.genericDestroy('Session', 's-1');
      expect(await store.genericGet('Session', 's-1')).toBeNull();
    });

    it('returns null for expired entries', async () => {
      await store.genericSet('Session', 's-2', { user: 'bob' }, -1);
      expect(await store.genericGet('Session', 's-2')).toBeNull();
    });

    it('isolates models with the same id', async () => {
      await store.genericSet('Session', 'shared', { kind: 'session' });
      await store.genericSet('Grant', 'shared', { kind: 'grant' });
      expect(await store.genericGet('Session', 'shared')).toEqual({ kind: 'session' });
      expect(await store.genericGet('Grant', 'shared')).toEqual({ kind: 'grant' });
    });

    it('finds Session payloads by their uid index field', async () => {
      await store.genericSet('Session', 's-id-1', { uid: 'session-uid-abc', accountId: 'alice' });
      const found = await store.genericFindByUid('session-uid-abc');
      expect(found).toEqual({ uid: 'session-uid-abc', accountId: 'alice' });
    });

    it('genericFindByUid returns null when no Session matches', async () => {
      await store.genericSet('Session', 's-id-1', { uid: 'session-uid-abc' });
      expect(await store.genericFindByUid('nonexistent')).toBeNull();
    });
  });
});
