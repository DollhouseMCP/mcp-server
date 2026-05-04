import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { GithubSocialMethod } from '../../../../../src/auth/embedded-as/methods/GithubSocialMethod.js';
import { InMemoryAuthStorageLayer } from '../../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';

interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

function makeFetchMock(handlers: Record<string, (call: FetchCall) => Response>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? String(init.body) : undefined,
    };
    calls.push(call);
    for (const [matcher, handler] of Object.entries(handlers)) {
      if (url.includes(matcher)) {
        return handler(call);
      }
    }
    return new Response('not mocked', { status: 500 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GithubSocialMethod', () => {
  let storage: InMemoryAuthStorageLayer;

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
  });

  describe('beginInteraction', () => {
    it('redirects to GitHub authorize URL with state=interactionId and minimal scopes', async () => {
      const method = new GithubSocialMethod({
        clientId: 'client123',
        clientSecret: 'secret',
        callbackUrl: 'https://example.com/auth/social/github/callback',
        storage,
        fetchImpl: jest.fn() as unknown as typeof fetch,
      });

      const step = await method.beginInteraction({
        interactionId: 'interaction-uid',
        clientId: 'mcp-client',
        requestedScopes: ['mcp'],
        requestUrl: '/interaction/interaction-uid',
      });

      expect(step.kind).toBe('redirect');
      if (step.kind !== 'redirect') return;
      const url = new URL(step.url);
      expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe('client123');
      expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/auth/social/github/callback');
      expect(url.searchParams.get('state')).toBe('interaction-uid');
      expect(url.searchParams.get('scope')).toBe('read:user user:email');
    });
  });

  describe('processCallback', () => {
    it('exchanges code, fetches verified primary email, persists account, returns identity', async () => {
      const { fetch, calls } = makeFetchMock({
        'github.com/login/oauth/access_token': () => jsonResponse({ access_token: 'gho_xyz' }),
        'api.github.com/user/emails': () => jsonResponse([
          { email: 'unverified@example.com', verified: false, primary: false },
          { email: 'verified@example.com', verified: true, primary: true },
        ]),
        'api.github.com/user': () => jsonResponse({ id: 42, login: 'octocat', name: 'Octo Cat' }),
      });

      const method = new GithubSocialMethod({
        clientId: 'client123',
        clientSecret: 'secret',
        callbackUrl: 'https://example.com/auth/social/github/callback',
        storage,
        fetchImpl: fetch,
      });

      const result = await method.processCallback({ code: 'gh-code', state: 'interaction-uid' });

      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.interactionId).toBe('interaction-uid');
      expect(result.identity.sub).toBe('github_42');
      expect(result.identity.email).toBe('verified@example.com');
      expect(result.identity.emailVerified).toBe(true);
      expect(result.identity.displayName).toBe('Octo Cat');

      // must-fix #18: account is keyed on (provider, externalSub)
      const stored = await storage.findAccountByExternalId('github', '42');
      expect(stored?.sub).toBe('github_42');
      expect(stored?.email).toBe('verified@example.com');

      // Token exchange call
      const tokenCall = calls.find(c => c.url.includes('login/oauth/access_token'));
      expect(tokenCall?.method).toBe('POST');
      expect(tokenCall?.body).toContain('code=gh-code');
      expect(tokenCall?.body).toContain('client_secret=secret');
    });

    it('refuses to link when no verified primary email exists (must-fix #19)', async () => {
      const { fetch } = makeFetchMock({
        'github.com/login/oauth/access_token': () => jsonResponse({ access_token: 'gho_xyz' }),
        'api.github.com/user/emails': () => jsonResponse([
          { email: 'verified-but-not-primary@example.com', verified: true, primary: false },
          { email: 'primary-but-not-verified@example.com', verified: false, primary: true },
        ]),
        'api.github.com/user': () => jsonResponse({ id: 99, login: 'x', name: null }),
      });

      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: 'https://example.com/cb',
        storage, fetchImpl: fetch,
      });

      const result = await method.processCallback({ code: 'c', state: 'i' });
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') return;
      expect(result.reason).toMatch(/verified primary email/);

      // No account persisted on error.
      expect(await storage.findAccountByExternalId('github', '99')).toBeNull();
    });

    it('emits identity_changed audit when the email mapping moves (must-fix #21)', async () => {
      // Seed an existing account for this externalSub with an old email.
      await storage.upsertAccount({
        sub: 'github_42',
        provider: 'github',
        externalSub: '42',
        email: 'old@example.com',
        emailVerified: true,
        displayName: 'Octo Cat',
        createdAt: 1000,
        updatedAt: 1000,
      });

      const { fetch } = makeFetchMock({
        'github.com/login/oauth/access_token': () => jsonResponse({ access_token: 'gho' }),
        'api.github.com/user/emails': () => jsonResponse([
          { email: 'new@example.com', verified: true, primary: true },
        ]),
        'api.github.com/user': () => jsonResponse({ id: 42, login: 'octocat', name: 'Octo Cat' }),
      });

      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: 'https://example.com/cb',
        storage, fetchImpl: fetch,
      });

      const result = await method.processCallback({ code: 'c', state: 'i' });
      expect(result.kind).toBe('ok');

      const events = storage.__testGetAuditEvents();
      const change = events.find(e => e.type === 'auth.social.identity_changed');
      expect(change).toBeDefined();
      expect(change?.externalSub).toBe('42');
      expect(change?.details).toMatchObject({
        previousEmail: 'old@example.com',
        newEmail: 'new@example.com',
      });
    });

    it('does NOT emit identity_changed when the email is unchanged', async () => {
      await storage.upsertAccount({
        sub: 'github_42',
        provider: 'github',
        externalSub: '42',
        email: 'same@example.com',
        emailVerified: true,
        displayName: 'Octo Cat',
        createdAt: 1000,
        updatedAt: 1000,
      });

      const { fetch } = makeFetchMock({
        'github.com/login/oauth/access_token': () => jsonResponse({ access_token: 'gho' }),
        'api.github.com/user/emails': () => jsonResponse([
          { email: 'same@example.com', verified: true, primary: true },
        ]),
        'api.github.com/user': () => jsonResponse({ id: 42, login: 'octocat', name: 'Octo Cat' }),
      });

      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: 'https://example.com/cb',
        storage, fetchImpl: fetch,
      });

      await method.processCallback({ code: 'c', state: 'i' });

      const events = storage.__testGetAuditEvents();
      expect(events.find(e => e.type === 'auth.social.identity_changed')).toBeUndefined();
    });

    it('returns error when the GitHub token exchange fails', async () => {
      const { fetch } = makeFetchMock({
        'github.com/login/oauth/access_token': () => jsonResponse({ error: 'bad_verification_code' }, 400),
      });

      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: 'https://example.com/cb',
        storage, fetchImpl: fetch,
      });

      const result = await method.processCallback({ code: 'bad', state: 'i' });
      expect(result.kind).toBe('error');
    });

    it('rejects empty code or state', async () => {
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: 'https://example.com/cb',
        storage,
        fetchImpl: jest.fn() as unknown as typeof fetch,
      });
      expect((await method.processCallback({ code: '', state: 'x' })).kind).toBe('error');
      expect((await method.processCallback({ code: 'x', state: '' })).kind).toBe('error');
    });
  });

  describe('findAccount', () => {
    it('returns null for non-github subs', async () => {
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: 'https://example.com/cb',
        storage,
        fetchImpl: jest.fn() as unknown as typeof fetch,
      });
      expect(await method.findAccount('local_alice')).toBeNull();
      expect(await method.findAccount('whatever')).toBeNull();
    });

    it('returns the cached account for a known github sub', async () => {
      const now = Date.now();
      await storage.upsertAccount({
        sub: 'github_42',
        provider: 'github',
        externalSub: '42',
        email: 'a@example.com',
        emailVerified: true,
        displayName: 'A',
        createdAt: now, updatedAt: now,
        lastAuthAt: now,
      });
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: 'https://example.com/cb',
        storage,
        fetchImpl: jest.fn() as unknown as typeof fetch,
      });
      const found = await method.findAccount('github_42');
      expect(found?.sub).toBe('github_42');
      expect(found?.email).toBe('a@example.com');
      expect(found?.emailVerified).toBe(true);
    });

    it('returns null once lastAuthAt is older than the TTL (forces re-auth)', async () => {
      // Defense-in-depth: when the cached account is older than the TTL,
      // findAccount returns null. oidc-provider treats that as "account
      // not found" and refuses the refresh, forcing the client to redirect
      // through /authorize — which re-runs processCallback and re-validates
      // email_verified against current GitHub state. The earlier shape
      // (return emailVerified=false) was theater because most clients
      // silently accept the degraded id_token.
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      await storage.upsertAccount({
        sub: 'github_42',
        provider: 'github',
        externalSub: '42',
        email: 'a@example.com',
        emailVerified: true,
        displayName: 'A',
        createdAt: eightDaysAgo, updatedAt: eightDaysAgo,
        lastAuthAt: eightDaysAgo,
      });
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: 'https://example.com/cb',
        storage,
        fetchImpl: jest.fn() as unknown as typeof fetch,
      });
      expect(await method.findAccount('github_42')).toBeNull();
    });

    it('returns null when lastAuthAt is undefined under the default TTL (legacy row)', async () => {
      // Pre-C10 accounts have no lastAuthAt. The staleness check treats
      // missing lastAuthAt as stale, so a legacy account row forces re-auth
      // before any token can be issued for it.
      await storage.upsertAccount({
        sub: 'github_42',
        provider: 'github',
        externalSub: '42',
        email: 'a@example.com',
        emailVerified: true,
        displayName: 'A',
        createdAt: 1, updatedAt: 1,
      });
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: 'https://example.com/cb',
        storage,
        fetchImpl: jest.fn() as unknown as typeof fetch,
      });
      expect(await method.findAccount('github_42')).toBeNull();
    });

    it('emailVerifiedCacheTtlMs=0 disables the staleness check entirely', async () => {
      const ancient = 1; // epoch ms; very stale
      await storage.upsertAccount({
        sub: 'github_42',
        provider: 'github',
        externalSub: '42',
        email: 'a@example.com',
        emailVerified: true,
        displayName: 'A',
        createdAt: ancient, updatedAt: ancient,
        lastAuthAt: ancient,
      });
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: 'https://example.com/cb',
        storage,
        fetchImpl: jest.fn() as unknown as typeof fetch,
        emailVerifiedCacheTtlMs: 0,
      });
      const found = await method.findAccount('github_42');
      expect(found?.emailVerified).toBe(true);
    });
  });

  describe('completeInteraction (POST /interaction)', () => {
    it('denies — GitHub flow completes via the callback route, not the consent POST', async () => {
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: 'https://example.com/cb',
        storage,
        fetchImpl: jest.fn() as unknown as typeof fetch,
      });
      const result = await method.completeInteraction(
        { interactionId: 'i', clientId: 'c', requestedScopes: [], requestUrl: '' },
        {},
      );
      expect(result.kind).toBe('denied');
    });
  });
});
