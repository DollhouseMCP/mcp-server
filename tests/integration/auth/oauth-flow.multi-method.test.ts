/**
 * Multi-method OAuth E2E (Phase 6.5).
 *
 * Boots an EmbeddedAuthorizationServer with both GithubSocialMethod and
 * MagicLinkMethod configured. Asserts:
 *   - GET /interaction/:uid renders the LoginChooser (Phase 2.3)
 *   - Picking `?method=github` dispatches the GitHub redirect flow
 *   - Picking `?method=magic-link` dispatches the magic-link form
 *   - findAccount on the AS is ownership-segregated: only the magic-link
 *     method serves `magic-link_*` subs, only github serves `github_*`
 *     subs (the convention codified in Phase 2.1)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { GithubSocialMethod } from '../../../src/auth/embedded-as/methods/GithubSocialMethod.js';
import {
  MagicLinkMethod,
  type EmailSender,
  type SendMagicLinkInput,
} from '../../../src/auth/embedded-as/methods/MagicLinkMethod.js';
import { InviteTokenStore } from '../../../src/auth/embedded-as/inviteTokens.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import {
  type ASHarness,
  followToCodeRedirect,
  getFreePort,
  startAuthorizeFlow,
  startASHarness,
} from './oauth-flow-helpers.js';

const REDIRECT_URI = 'http://127.0.0.1/callback';
const CLIENT_ID = 'dollhouse-claude-connector';

class CollectingEmailSender implements EmailSender {
  sent: SendMagicLinkInput[] = [];
  async sendMagicLink(input: SendMagicLinkInput): Promise<void> {
    this.sent.push(input);
  }
}

function buildGithubFakeFetch(
  profile: { userId: number; login: string; name: string; primaryEmail: string },
): typeof fetch {
  return async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'gh-fake-access-token' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === 'https://api.github.com/user') {
      return new Response(
        JSON.stringify({ id: profile.userId, login: profile.login, name: profile.name }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url === 'https://api.github.com/user/emails') {
      return new Response(
        JSON.stringify([{ email: profile.primaryEmail, verified: true, primary: true }]),
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

describe('Multi-method (GitHub + MagicLink) — OAuth E2E', () => {
  let storage: InMemoryAuthStorageLayer;
  let emailSender: CollectingEmailSender;
  let github: GithubSocialMethod;
  let magicLink: MagicLinkMethod;
  let harness: ASHarness;

  beforeEach(async () => {
    storage = new InMemoryAuthStorageLayer();
    emailSender = new CollectingEmailSender();
    const port = await getFreePort();
    const publicBaseUrl = `http://127.0.0.1:${port}`;

    github = new GithubSocialMethod({
      clientId: 'gh-test-client',
      clientSecret: 'gh-test-secret',
      callbackUrl: `${publicBaseUrl}/auth/social/github/callback`,
      storage,
      fetchImpl: buildGithubFakeFetch({
        userId: 9999, login: 'multi', name: 'Multi User',
        primaryEmail: 'multi@example.com',
      }),
      emailVerifiedCacheTtlMs: 0,
    });

    magicLink = new MagicLinkMethod({
      storage,
      invites: new InviteTokenStore(randomBytes(32)),
      emailSender,
      verifyUrl: `${publicBaseUrl}/auth/email/verify`,
      requestResponseFloorMs: 0,
    });

    harness = await startASHarness({
      methods: [github, magicLink],
      storage,
      publicBaseUrl,
      port,
    });
  });

  afterEach(async () => {
    if (harness) await harness.close();
  });

  it('renders the LoginChooser when no method is selected', async () => {
    const authServer = await fetchAuthServerMetadata(harness.baseUrl);
    const { interactionUrl, jar } = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`, scope: 'mcp offline_access',
    });

    const chooserResp = await fetch(interactionUrl, {
      method: 'GET', redirect: 'manual',
      headers: { Cookie: jar.header() },
    });
    expect(chooserResp.status).toBe(200);
    const html = await chooserResp.text();
    // Each method's display name appears as a link with ?method=<id>.
    expect(html).toMatch(/method=github/);
    expect(html).toMatch(/method=magic-link/);
    expect(html).toContain('GitHub');
    expect(html).toContain('Email magic link');
  }, 30_000);

  it('?method=github dispatches the GitHub redirect flow', async () => {
    const authServer = await fetchAuthServerMetadata(harness.baseUrl);
    const { interactionUrl, jar } = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`, scope: 'mcp offline_access',
    });

    const chosenUrl = `${interactionUrl}?method=github`;
    const dispatch = await fetch(chosenUrl, {
      method: 'GET', redirect: 'manual',
      headers: { Cookie: jar.header() },
    });
    expect(dispatch.status).toBe(303);
    expect(dispatch.headers.get('location')).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
  }, 30_000);

  it('?method=magic-link dispatches the magic-link request page', async () => {
    const authServer = await fetchAuthServerMetadata(harness.baseUrl);
    const { interactionUrl, jar } = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`, scope: 'mcp offline_access',
    });

    const chosenUrl = `${interactionUrl}?method=magic-link`;
    const dispatch = await fetch(chosenUrl, {
      method: 'GET', redirect: 'manual',
      headers: { Cookie: jar.header() },
    });
    expect(dispatch.status).toBe(200);
    const html = await dispatch.text();
    expect(html).toContain('Sign in');
    expect(html).toMatch(/<input[^>]*name="email"/);
    // CSRF token should be injected by the router.
    expect(html).toMatch(/name="csrf_token"\s+value="[^"]+"/);
  }, 30_000);

  it('end-to-end via magic-link → access_token', async () => {
    const authServer = await fetchAuthServerMetadata(harness.baseUrl);
    const { interactionUrl, jar, verifier } = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`, scope: 'mcp offline_access',
    });
    const chosen = `${interactionUrl}?method=magic-link`;
    const initial = await fetch(chosen, { method: 'GET', redirect: 'manual', headers: { Cookie: jar.header() } });
    jar.ingest(initial.headers);
    const html = await initial.text();
    const csrfToken = html.match(/name="csrf_token"\s+value="([^"]+)"/)![1]!;

    const requestResp = await fetch(interactionUrl, {
      method: 'POST', redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: jar.header(),
      },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        action: 'request-link',
        email: 'multi@example.com',
      }),
    });
    expect(requestResp.status).toBe(200);
    expect(emailSender.sent).toHaveLength(1);

    const tokenParam = new URL(emailSender.sent[0]!.url).searchParams.get('token')!;
    const verifyPost = await fetch(`${harness.publicBaseUrl}/auth/email/verify`, {
      method: 'POST', redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: jar.header(),
      },
      body: new URLSearchParams({ token: tokenParam }),
    });
    expect([302, 303]).toContain(verifyPost.status);
    jar.ingest(verifyPost.headers);

    const code = await followToCodeRedirect({
      baseUrl: harness.baseUrl,
      start: verifyPost.headers.get('location'),
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
    const body = await tokenResp.json() as { access_token: string };
    const validation = await harness.as.validate(body.access_token);
    expect(validation.ok).toBe(true);
    if (validation.ok) expect(validation.claims.sub).toMatch(/^magic-link_/);
  }, 30_000);

  it('findAccount is provider-segregated: each method only owns its own subs', async () => {
    // Seed accounts for both providers.
    await storage.upsertAccount({
      sub: 'magic-link_abc123',
      provider: 'magic-link',
      externalSub: 'abc123',
      email: 'ml@example.com',
      emailVerified: true,
      displayName: 'ML User',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await storage.upsertAccount({
      sub: 'github_4242',
      provider: 'github',
      externalSub: '4242',
      email: 'gh@example.com',
      emailVerified: true,
      displayName: 'GH User',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastAuthAt: Date.now(),
    });

    // Magic-link method only resolves its own prefix.
    expect(await magicLink.findAccount('magic-link_abc123')).not.toBeNull();
    expect(await magicLink.findAccount('github_4242')).toBeNull();
    // GitHub method only resolves its own prefix.
    expect(await github.findAccount('github_4242')).not.toBeNull();
    expect(await github.findAccount('magic-link_abc123')).toBeNull();
  });
});
