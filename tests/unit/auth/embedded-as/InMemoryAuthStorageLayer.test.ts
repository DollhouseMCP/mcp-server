import { describe, it, expect, beforeEach } from '@jest/globals';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import type {
  StoredAccount,
  StoredAuthCode,
  StoredRefreshToken,
} from '../../../../src/auth/embedded-as/storage/IAuthStorageLayer.js';

const FUTURE_MS = Date.now() + 5 * 60 * 1000;
const PAST_MS = Date.now() - 1000;

function makeAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    sub: 'github:42',
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

function makeCode(overrides: Partial<StoredAuthCode> = {}): StoredAuthCode {
  return {
    code: 'code-abc',
    clientId: 'client-1',
    redirectUri: 'http://127.0.0.1/cb',
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256',
    scope: 'mcp',
    sub: 'local:operator',
    expiresAt: FUTURE_MS,
    ...overrides,
  };
}

function makeRefresh(overrides: Partial<StoredRefreshToken> = {}): StoredRefreshToken {
  return {
    token: 'rt-1',
    familyId: 'fam-1',
    clientId: 'client-1',
    sub: 'local:operator',
    scope: 'mcp',
    expiresAt: FUTURE_MS,
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
      expect(found?.sub).toBe('github:42');
    });

    it('returns null for unknown external id', async () => {
      const found = await store.findAccountByExternalId('github', '9999');
      expect(found).toBeNull();
    });

    it('looks up by sub after upsert', async () => {
      const account = makeAccount();
      await store.upsertAccount(account);
      const found = await store.getAccount('github:42');
      expect(found).toEqual(account);
    });
  });

  describe('authorization codes (atomic single-use)', () => {
    it('returns the code on first consume, null on second', async () => {
      await store.storeAuthorizationCode(makeCode());
      const first = await store.consumeAuthorizationCode('code-abc');
      expect(first).not.toBeNull();
      const second = await store.consumeAuthorizationCode('code-abc');
      expect(second).toBeNull();
    });

    it('returns null for expired codes', async () => {
      await store.storeAuthorizationCode(makeCode({ expiresAt: PAST_MS }));
      const result = await store.consumeAuthorizationCode('code-abc');
      expect(result).toBeNull();
    });

    it('returns null for unknown codes', async () => {
      const result = await store.consumeAuthorizationCode('nonexistent');
      expect(result).toBeNull();
    });

    it('serializes concurrent consume of the same code to exactly one success', async () => {
      await store.storeAuthorizationCode(makeCode());
      const results = await Promise.all([
        store.consumeAuthorizationCode('code-abc'),
        store.consumeAuthorizationCode('code-abc'),
        store.consumeAuthorizationCode('code-abc'),
      ]);
      const successes = results.filter(r => r !== null);
      expect(successes).toHaveLength(1);
    });

    it('allows concurrent consume of different codes', async () => {
      await store.storeAuthorizationCode(makeCode({ code: 'a' }));
      await store.storeAuthorizationCode(makeCode({ code: 'b' }));
      const [a, b] = await Promise.all([
        store.consumeAuthorizationCode('a'),
        store.consumeAuthorizationCode('b'),
      ]);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
    });
  });

  describe('refresh tokens (must-fix #11: atomic rotation + reuse detection)', () => {
    it('returns rotated when a known live token is rotated', async () => {
      await store.storeRefreshToken(makeRefresh());
      const successor = makeRefresh({ token: 'rt-2' });
      const result = await store.rotateRefreshToken('rt-1', successor);
      expect(result.kind).toBe('rotated');
    });

    it('marks the consumed token as rotated and lookup returns the successor', async () => {
      await store.storeRefreshToken(makeRefresh());
      await store.rotateRefreshToken('rt-1', makeRefresh({ token: 'rt-2' }));
      // The new token must be retrievable for the next rotation.
      const second = await store.rotateRefreshToken('rt-2', makeRefresh({ token: 'rt-3' }));
      expect(second.kind).toBe('rotated');
    });

    it('rejects successor with a different familyId', async () => {
      await store.storeRefreshToken(makeRefresh());
      const wrongFamily = makeRefresh({ token: 'rt-2', familyId: 'fam-WRONG' });
      await expect(store.rotateRefreshToken('rt-1', wrongFamily)).rejects.toThrow(/familyId/);
    });

    it('returns unknown for an already-rotated token (must-fix #11 reuse signal)', async () => {
      await store.storeRefreshToken(makeRefresh());
      await store.rotateRefreshToken('rt-1', makeRefresh({ token: 'rt-2' }));
      const replay = await store.rotateRefreshToken('rt-1', makeRefresh({ token: 'rt-3' }));
      expect(replay.kind).toBe('unknown');
    });

    it('returns unknown for an expired token', async () => {
      await store.storeRefreshToken(makeRefresh({ expiresAt: PAST_MS }));
      const result = await store.rotateRefreshToken('rt-1', makeRefresh({ token: 'rt-2' }));
      expect(result.kind).toBe('unknown');
    });

    it('returns unknown after the family is revoked', async () => {
      await store.storeRefreshToken(makeRefresh());
      await store.revokeRefreshTokenFamily('fam-1');
      const result = await store.rotateRefreshToken('rt-1', makeRefresh({ token: 'rt-2' }));
      expect(result.kind).toBe('unknown');
    });

    it('serializes concurrent rotation of the same token to exactly one success', async () => {
      await store.storeRefreshToken(makeRefresh());
      const results = await Promise.all([
        store.rotateRefreshToken('rt-1', makeRefresh({ token: 'rt-A' })),
        store.rotateRefreshToken('rt-1', makeRefresh({ token: 'rt-B' })),
        store.rotateRefreshToken('rt-1', makeRefresh({ token: 'rt-C' })),
      ]);
      const rotated = results.filter(r => r.kind === 'rotated');
      const unknown = results.filter(r => r.kind === 'unknown');
      expect(rotated).toHaveLength(1);
      expect(unknown).toHaveLength(2);
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
  });
});
