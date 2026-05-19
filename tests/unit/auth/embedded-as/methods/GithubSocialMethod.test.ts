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
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      // Production calls fetch with either a string body or URLSearchParams
      // (the OAuth token POST uses the latter). Narrow explicitly so we don't
      // stringify a BodyInit subtype with no meaningful toString().
      body: typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : undefined,
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

const CALLBACK_URL = 'https://example.com/cb';
const TEST_EMAIL = 'a@example.com';

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
    it('cycle 19 / security-#3: rawProfile is explicitly narrowed to {id, login, name} and excludes upstream PII', async () => {
      // Reviewer caught the previous shape relying on a TypeScript cast
      // to "narrow" the /user payload. Casts narrow types at compile
      // time only; at runtime the full GitHub /user response (email,
      // bio, company, location, twitter_username, blog, etc.) was
      // landing in rawProfile. IAuthStorageLayer documents rawProfile
      // as audit-safe — storing PII broke that contract. Cycle 19 fix:
      // explicit projection in the response builder.
      const { fetch } = makeFetchMock({
        'github.com/login/oauth/access_token': () => jsonResponse({ access_token: 'gho_xyz' }),
        'api.github.com/user/emails': () => jsonResponse([
          { email: 'verified@example.com', verified: true, primary: true },
        ]),
        // Mock returns a /user response with PII fields the API actually
        // sends — bio, company, twitter_username, blog. The narrowing
        // must drop them before they reach storage.
        'api.github.com/user': () => jsonResponse({
          id: 42,
          login: 'octocat',
          name: 'Octo Cat',
          email: 'shouldnotbestoredhere@example.com',
          bio: 'PII payload',
          company: 'PII Inc',
          location: 'PII City',
          twitter_username: 'pii_handle',
          blog: 'https://pii.example.com',
          gravatar_id: 'pii-gravatar',
          created_at: '2010-01-01T00:00:00Z',
        }),
      });

      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: CALLBACK_URL,
        storage, fetchImpl: fetch,
      });

      const result = await method.processCallback({ code: 'c', state: 'i' });
      expect(result.kind).toBe('ok');

      const stored = await storage.findAccountByExternalId('github', '42');
      const raw = stored?.rawProfile;
      expect(raw).toBeDefined();
      const userField = raw?.user as Record<string, unknown> | undefined;
      // Whitelisted fields present:
      expect(userField).toEqual({ id: 42, login: 'octocat', name: 'Octo Cat' });
      // Explicit PII fields absent:
      const json = JSON.stringify(stored);
      expect(json).not.toContain('PII payload');
      expect(json).not.toContain('PII Inc');
      expect(json).not.toContain('PII City');
      expect(json).not.toContain('pii_handle');
      expect(json).not.toContain('pii.example.com');
      expect(json).not.toContain('pii-gravatar');
      // The shouldnotbestoredhere@ string is the upstream /user.email
      // field — distinct from /user/emails' verified primary. It must
      // not leak into rawProfile.
      expect(json).not.toContain('shouldnotbestoredhere@');
    });

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
        callbackUrl: CALLBACK_URL,
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
        callbackUrl: CALLBACK_URL,
        storage, fetchImpl: fetch,
      });

      const result = await method.processCallback({ code: 'c', state: 'i' });
      expect(result.kind).toBe('ok');

      const events = await storage.listIdentityEvents();
      const change = events.find(e => e.type === 'auth.social.identity_changed');
      expect(change).toBeDefined();
      expect(change?.externalSub).toBe('42');
      expect(change?.details).toMatchObject({
        previousEmail: 'old@example.com',
        newEmail: 'new@example.com',
      });
    });

    it('revokes active grants on identity_changed (H14)', async () => {
      // Seed an existing account whose email is about to move.
      await storage.upsertAccount({
        sub: 'github_42',
        provider: 'github',
        externalSub: '42',
        email: 'old@example.com',
        emailVerified: true,
        displayName: 'Octo Cat',
        createdAt: 1000, updatedAt: 1000,
      });
      // Seed two grants for this sub plus a grant for a different sub
      // (must NOT be revoked) and a token referencing one of the grants
      // (must be revoked via genericRevokeByGrantId).
      await storage.genericSet('Grant', 'g-affected-1', { accountId: 'github_42', clientId: 'c1' });
      await storage.genericSet('Grant', 'g-affected-2', { accountId: 'github_42', clientId: 'c2' });
      await storage.genericSet('Grant', 'g-other', { accountId: 'github_99', clientId: 'c1' });
      await storage.genericSet('AccessToken', 't-affected', { grantId: 'g-affected-1', accountId: 'github_42' });
      await storage.genericSet('AccessToken', 't-other', { grantId: 'g-other', accountId: 'github_99' });

      const { fetch } = makeFetchMock({
        'github.com/login/oauth/access_token': () => jsonResponse({ access_token: 'gho' }),
        'api.github.com/user/emails': () => jsonResponse([
          { email: 'new@example.com', verified: true, primary: true },
        ]),
        'api.github.com/user': () => jsonResponse({ id: 42, login: 'octocat', name: 'Octo Cat' }),
      });
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: CALLBACK_URL,
        storage, fetchImpl: fetch,
      });
      const result = await method.processCallback({ code: 'c', state: 'i' });
      expect(result.kind).toBe('ok');

      // Both affected grants and the token referencing one of them are gone.
      expect(await storage.genericGet('Grant', 'g-affected-1')).toBeNull();
      expect(await storage.genericGet('Grant', 'g-affected-2')).toBeNull();
      expect(await storage.genericGet('AccessToken', 't-affected')).toBeNull();
      // Untouched.
      expect(await storage.genericGet('Grant', 'g-other')).not.toBeNull();
      expect(await storage.genericGet('AccessToken', 't-other')).not.toBeNull();

      // Audit event records the revocation count.
      const events = await storage.listIdentityEvents({ type: 'auth.social.identity_changed' });
      expect(events).toHaveLength(1);
      expect(events[0].details).toMatchObject({ grantsRevoked: 2 });
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
        callbackUrl: CALLBACK_URL,
        storage, fetchImpl: fetch,
      });

      await method.processCallback({ code: 'c', state: 'i' });

      const events = await storage.listIdentityEvents();
      expect(events.find(e => e.type === 'auth.social.identity_changed')).toBeUndefined();
    });

    it('returns error when the GitHub token exchange fails', async () => {
      const { fetch } = makeFetchMock({
        'github.com/login/oauth/access_token': () => jsonResponse({ error: 'bad_verification_code' }, 400),
      });

      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: CALLBACK_URL,
        storage, fetchImpl: fetch,
      });

      const result = await method.processCallback({ code: 'bad', state: 'i' });
      expect(result.kind).toBe('error');
    });

    it('rejects empty code or state', async () => {
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: CALLBACK_URL,
        storage,
        fetchImpl: jest.fn() as unknown as typeof fetch,
      });
      expect((await method.processCallback({ code: '', state: 'x' })).kind).toBe('error');
      expect((await method.processCallback({ code: 'x', state: '' })).kind).toBe('error');
    });

    it('returns structured error when token-exchange fetch throws (network failure) — H7', async () => {
      const fetchImpl = (async () => {
        throw new TypeError('fetch failed: ECONNREFUSED');
      }) as unknown as typeof fetch;
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: CALLBACK_URL,
        storage, fetchImpl,
      });
      const result = await method.processCallback({ code: 'c', state: 'i' });
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') return;
      expect(result.reason).toMatch(/token exchange/);
    });

    it('returns structured error when token-exchange returns non-JSON body — H7', async () => {
      // GitHub has been observed returning HTML on 5xx; .json() throws.
      const fetchImpl = (async () => new Response('<html>oops</html>', {
        status: 200, headers: { 'Content-Type': 'text/html' },
      })) as unknown as typeof fetch;
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: CALLBACK_URL,
        storage, fetchImpl,
      });
      const result = await method.processCallback({ code: 'c', state: 'i' });
      expect(result.kind).toBe('error');
    });

    it('returns structured error when /user fetch throws — H7', async () => {
      const { fetch } = makeFetchMock({
        'github.com/login/oauth/access_token': () => jsonResponse({ access_token: 'gho' }),
      });
      // Wrap to throw on /user
      const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('api.github.com/user') && !url.includes('/emails')) {
          throw new TypeError('fetch failed: ETIMEDOUT');
        }
        return fetch(input, init);
      }) as unknown as typeof fetch;
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: CALLBACK_URL,
        storage, fetchImpl: wrapped,
      });
      const result = await method.processCallback({ code: 'c', state: 'i' });
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') return;
      expect(result.reason).toMatch(/github user/);
    });

    it('returns structured error when /user/emails fetch throws — H7', async () => {
      const { fetch } = makeFetchMock({
        'github.com/login/oauth/access_token': () => jsonResponse({ access_token: 'gho' }),
        'api.github.com/user': () => jsonResponse({ id: 42, login: 'octo', name: 'Octo' }),
      });
      const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('api.github.com/user/emails')) {
          throw new TypeError('fetch failed: ETIMEDOUT');
        }
        return fetch(input, init);
      }) as unknown as typeof fetch;
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: CALLBACK_URL,
        storage, fetchImpl: wrapped,
      });
      const result = await method.processCallback({ code: 'c', state: 'i' });
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') return;
      expect(result.reason).toMatch(/emails/);
    });
  });

  describe('findAccount', () => {
    it('returns null for non-github subs', async () => {
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: CALLBACK_URL,
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
        email: TEST_EMAIL,
        emailVerified: true,
        displayName: 'A',
        createdAt: now, updatedAt: now,
        lastAuthAt: now,
      });
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: CALLBACK_URL,
        storage,
        fetchImpl: jest.fn() as unknown as typeof fetch,
      });
      const found = await method.findAccount('github_42');
      expect(found?.sub).toBe('github_42');
      expect(found?.email).toBe(TEST_EMAIL);
      expect(found?.emailVerified).toBe(true);
    });

    it('H6: downgrades emailVerified to false once lastAuthAt is older than the TTL', async () => {
      // Round 5 / H6: stale cache means the email_verified claim is
      // suspect, NOT that the account doesn't exist. Returning null
      // would also drop roles + auth_time on every refresh redeem
      // (oidc-provider calls findAccount on each rotation), losing
      // an admin's claim mid-session. The current shape preserves
      // those orthogonal claims and only downgrades email_verified.
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      await storage.upsertAccount({
        sub: 'github_42',
        provider: 'github',
        externalSub: '42',
        email: TEST_EMAIL,
        emailVerified: true,
        displayName: 'A',
        createdAt: eightDaysAgo, updatedAt: eightDaysAgo,
        lastAuthAt: eightDaysAgo,
      });
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: CALLBACK_URL,
        storage,
        fetchImpl: jest.fn() as unknown as typeof fetch,
      });
      const found = await method.findAccount('github_42');
      expect(found).not.toBeNull();
      expect(found?.sub).toBe('github_42');
      expect(found?.email).toBe(TEST_EMAIL);
      expect(found?.emailVerified).toBe(false); // downgraded
    });

    it('H6: downgrades emailVerified to false when lastAuthAt is undefined (legacy row)', async () => {
      // Pre-C10 accounts have no lastAuthAt. Legacy rows are treated
      // as stale-cache, NOT as nonexistent, so the row's other
      // claims still flow through.
      await storage.upsertAccount({
        sub: 'github_42',
        provider: 'github',
        externalSub: '42',
        email: TEST_EMAIL,
        emailVerified: true,
        displayName: 'A',
        createdAt: 1, updatedAt: 1,
      });
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: CALLBACK_URL,
        storage,
        fetchImpl: jest.fn() as unknown as typeof fetch,
      });
      const found = await method.findAccount('github_42');
      expect(found).not.toBeNull();
      expect(found?.emailVerified).toBe(false);
    });

    it('emailVerifiedCacheTtlMs=0 disables the staleness check entirely', async () => {
      const ancient = 1; // epoch ms; very stale
      await storage.upsertAccount({
        sub: 'github_42',
        provider: 'github',
        externalSub: '42',
        email: TEST_EMAIL,
        emailVerified: true,
        displayName: 'A',
        createdAt: ancient, updatedAt: ancient,
        lastAuthAt: ancient,
      });
      const method = new GithubSocialMethod({
        clientId: 'c', clientSecret: 's',
        callbackUrl: CALLBACK_URL,
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
        callbackUrl: CALLBACK_URL,
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
