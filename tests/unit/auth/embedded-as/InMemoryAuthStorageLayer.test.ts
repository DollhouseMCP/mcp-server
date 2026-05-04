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
      const events = store.__testGetAuditEvents();
      expect(events.map(e => e.type)).toEqual(['auth.test.one', 'auth.test.two']);
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
