/**
 * GithubSocialMethod E2E (Phase 6.4).
 *
 * Drives the OAuth/PKCE flow against an EmbeddedAuthorizationServer
 * configured with GithubSocialMethod and a mocked `fetchImpl` that
 * stands in for github.com/api.github.com. Asserts:
 *   - /interaction/:uid begins the flow with a 303 redirect to GitHub
 *   - The callback consumes the code → fetches user/emails → finishes
 *     the OAuth interaction → token exchange yields an access_token
 *   - When the same external GitHub user comes back with a different
 *     primary email, an `auth.social.identity_changed` audit event is
 *     emitted AND any active grants for that sub are revoked (H14 +
 *     must-fix #21)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { decodeJwt } from 'jose';
import { GithubSocialMethod } from '../../../src/auth/embedded-as/methods/GithubSocialMethod.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import {
  type ASHarness,
  type CookieJar,
  followToCodeRedirect,
  getFreePort,
  startAuthorizeFlow,
  startASHarness,
} from './oauth-flow-helpers.js';

const REDIRECT_URI = 'http://127.0.0.1/callback';
const CLIENT_ID = 'dollhouse-claude-connector';

interface GithubFetchProfile {
  userId: number;
  login: string;
  name: string | null;
  primaryEmail: string;
}

/**
 * Build a minimal stub for `fetch` that satisfies GithubSocialMethod's three
 * upstream calls (token exchange, /user, /user/emails). The profile is
 * mutable per-call so tests can simulate identity changes.
 */
function buildFakeFetch(getProfile: () => GithubFetchProfile): typeof fetch {
  return async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'gh-fake-access-token' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === 'https://api.github.com/user') {
      const p = getProfile();
      return new Response(
        JSON.stringify({ id: p.userId, login: p.login, name: p.name }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url === 'https://api.github.com/user/emails') {
      const p = getProfile();
      return new Response(
        JSON.stringify([{ email: p.primaryEmail, verified: true, primary: true }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`fake fetch: unexpected URL ${url}`);
  };
}

async function fetchAuthServerMetadata(baseUrl: string) {
  const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  return res.json() as Promise<{
    authorization_endpoint: string;
    token_endpoint: string;
    issuer: string;
  }>;
}

/**
 * Drive the GitHub-redirect interaction GET, capture the GitHub authorize URL
 * (so we can pull `state` from it), then simulate the GitHub callback hitting
 * /auth/social/github/callback with a fake `code` + correct `state`.
 */
async function simulateGithubCallback(opts: {
  publicBaseUrl: string;
  interactionUrl: string;
  jar: CookieJar;
  code: string;
}): Promise<Response> {
  const interactionResp = await fetch(opts.interactionUrl, {
    method: 'GET', redirect: 'manual',
    headers: { Cookie: opts.jar.header() },
  });
  opts.jar.ingest(interactionResp.headers);
  // Step is kind:'redirect' → router sends a 303 to GitHub. The state param
  // is the interactionId.
  const githubLocation = interactionResp.headers.get('location');
  if (!githubLocation) throw new Error('Expected 303 to GitHub authorize URL');
  const state = new URL(githubLocation).searchParams.get('state');
  if (!state) throw new Error('GitHub authorize URL missing state');

  const callbackUrl = `${opts.publicBaseUrl}/auth/social/github/callback?code=${opts.code}&state=${state}`;
  return fetch(callbackUrl, {
    method: 'GET', redirect: 'manual',
    headers: { Cookie: opts.jar.header() },
  });
}

describe('GithubSocialMethod — OAuth E2E', () => {
  let storage: InMemoryAuthStorageLayer;
  let method: GithubSocialMethod;
  let harness: ASHarness;
  let profile: GithubFetchProfile;

  beforeEach(async () => {
    storage = new InMemoryAuthStorageLayer();
    profile = {
      userId: 4242,
      login: 'octocat',
      name: 'Octo Cat',
      primaryEmail: 'octo@example.com',
    };
    const port = await getFreePort();
    const publicBaseUrl = `http://127.0.0.1:${port}`;
    method = new GithubSocialMethod({
      clientId: 'gh-test-client-id',
      clientSecret: 'gh-test-client-secret',
      callbackUrl: `${publicBaseUrl}/auth/social/github/callback`,
      storage,
      fetchImpl: buildFakeFetch(() => profile),
      // Disable the cached emailVerified TTL downgrade so the
      // identity-change test below doesn't get an emailVerified:false
      // downgrade on its lookup (Round 5 / H6 changed the stale-cache
      // path from null-return to emailVerified:false; either shape
      // would interfere with this test's assertions).
      emailVerifiedCacheTtlMs: 0,
    });
    harness = await startASHarness({
      methods: [method],
      storage,
      publicBaseUrl,
      port,
    });
  });

  afterEach(async () => {
    if (harness) await harness.close();
  });

  it('end-to-end: github redirect → callback → access token', async () => {
    const authServer = await fetchAuthServerMetadata(harness.baseUrl);
    const { interactionUrl, jar, verifier } = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`,
      scope: 'mcp offline_access',
    });

    const callback = await simulateGithubCallback({
      publicBaseUrl: harness.publicBaseUrl,
      interactionUrl, jar,
      code: 'gh-fake-code',
    });
    expect([302, 303]).toContain(callback.status);
    jar.ingest(callback.headers);

    const code = await followToCodeRedirect({
      baseUrl: harness.baseUrl,
      start: callback.headers.get('location'),
      jar,
      redirectUriPrefix: REDIRECT_URI,
    });

    const tokenResp = await fetch(authServer.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code,
        code_verifier: verifier,
        resource: `${harness.publicBaseUrl}/mcp`,
      }),
    });
    expect(tokenResp.status).toBe(200);
    const tokenBody = await tokenResp.json() as { access_token: string };
    const validation = await harness.as.validate(tokenBody.access_token);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.claims.sub).toBe('github_4242');
    }

    const decoded = decodeJwt(tokenBody.access_token);
    expect(typeof decoded.auth_time).toBe('number');

    // Account persisted with the GitHub external sub mapping.
    const stored = await storage.findAccountByExternalId('github', '4242');
    expect(stored?.email).toBe('octo@example.com');
    expect(stored?.emailVerified).toBe(true);
  }, 30_000);

  it('identity_changed: same GitHub user, new primary email → audit + grant revocation (H14, must-fix #21)', async () => {
    const authServer = await fetchAuthServerMetadata(harness.baseUrl);

    // First sign-in establishes the account at octo@example.com.
    {
      const { interactionUrl, jar } = await startAuthorizeFlow({
        baseUrl: harness.baseUrl,
        authServerMetadata: authServer,
        clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
        resource: `${harness.publicBaseUrl}/mcp`, scope: 'mcp offline_access',
      });
      const cb = await simulateGithubCallback({
        publicBaseUrl: harness.publicBaseUrl, interactionUrl, jar, code: 'gh-fake-code-1',
      });
      expect([302, 303]).toContain(cb.status);
      // Drive the flow to completion so a grant is created in storage.
      jar.ingest(cb.headers);
      await followToCodeRedirect({
        baseUrl: harness.baseUrl,
        start: cb.headers.get('location'),
        jar,
        redirectUriPrefix: REDIRECT_URI,
      });
    }

    // Second sign-in: same userId, different primary email. processCallback
    // should detect the change, emit the audit event, and call
    // genericRevokeByGrantId for every active grant on this sub.
    profile.primaryEmail = 'newaddress@example.com';
    {
      const { interactionUrl, jar } = await startAuthorizeFlow({
        baseUrl: harness.baseUrl,
        authServerMetadata: authServer,
        clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
        resource: `${harness.publicBaseUrl}/mcp`, scope: 'mcp offline_access',
      });
      const cb = await simulateGithubCallback({
        publicBaseUrl: harness.publicBaseUrl, interactionUrl, jar, code: 'gh-fake-code-2',
      });
      expect([302, 303]).toContain(cb.status);
    }

    // Audit event recorded with previous→new email + grants revoked.
    const events = await storage.listIdentityEvents({
      type: 'auth.social.identity_changed',
    });
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1]!;
    expect(last.details).toMatchObject({
      previousEmail: 'octo@example.com',
      newEmail: 'newaddress@example.com',
    });
    expect(typeof (last.details as { grantsRevoked?: number }).grantsRevoked).toBe('number');
  }, 30_000);

  it('callback rejects when state does not match an active interaction', async () => {
    // Hit the callback directly with a bogus state. The processCallback path
    // depends on oidc-provider's interactionDetails — without a matching
    // interaction the route returns a 4xx rather than driving a redirect.
    const callback = await fetch(
      `${harness.publicBaseUrl}/auth/social/github/callback?code=anything&state=bogus-state`,
      { method: 'GET', redirect: 'manual' },
    );
    expect(callback.status).toBeGreaterThanOrEqual(400);
    expect(callback.status).toBeLessThan(500);
  }, 30_000);

  it('admin claim: pre-claimed github sub gets roles:["admin"] on JWT (cycle-16)', async () => {
    // Rebuild harness without auto-bootstrap so we can pre-claim a
    // specific admin sub.
    await harness.close();
    storage = new InMemoryAuthStorageLayer();
    const port = await getFreePort();
    const publicBaseUrl = `http://127.0.0.1:${port}`;
    method = new GithubSocialMethod({
      clientId: 'gh-test-client-id',
      clientSecret: 'gh-test-client-secret',
      callbackUrl: `${publicBaseUrl}/auth/social/github/callback`,
      storage,
      fetchImpl: buildFakeFetch(() => profile),
      emailVerifiedCacheTtlMs: 0,
    });
    harness = await startASHarness({
      methods: [method], storage, publicBaseUrl, port,
      skipAutoBootstrap: true,
    });

    // Pre-claim the admin sub before the OAuth flow runs. Mirrors the
    // admin-bootstrap CLI's behavior for the github path.
    const adminSub = `github_${profile.userId}`;
    await storage.markBootstrapComplete(adminSub, 'github');

    const authServer = await fetchAuthServerMetadata(harness.baseUrl);
    const { interactionUrl, jar, verifier } = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`, scope: 'mcp',
    });
    const callback = await simulateGithubCallback({
      publicBaseUrl: harness.publicBaseUrl,
      interactionUrl, jar, code: 'gh-fake-code-admin',
    });
    expect([302, 303]).toContain(callback.status);
    jar.ingest(callback.headers);

    const code = await followToCodeRedirect({
      baseUrl: harness.baseUrl,
      start: callback.headers.get('location'),
      jar, redirectUriPrefix: REDIRECT_URI,
    });
    const tokenResp = await fetch(authServer.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
        code, code_verifier: verifier,
        resource: `${harness.publicBaseUrl}/mcp`,
      }),
    });
    expect(tokenResp.status).toBe(200);
    const tokenBody = await tokenResp.json() as { access_token: string };

    const validation = await harness.as.validate(tokenBody.access_token);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.claims.sub).toBe(adminSub);
      expect(validation.claims.roles).toEqual(['admin']);
    }
    const decoded = decodeJwt(tokenBody.access_token);
    expect(decoded.roles).toEqual(['admin']);

    const stored = await storage.getAccount(adminSub);
    expect(stored?.roles).toEqual(['admin']);
  }, 30_000);
});
