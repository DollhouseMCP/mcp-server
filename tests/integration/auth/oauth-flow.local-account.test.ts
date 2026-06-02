/**
 * LocalAccountMethod E2E (Phase 6.2).
 *
 * Drives the OAuth/PKCE flow against an EmbeddedAuthorizationServer
 * configured with LocalAccountMethod. Asserts the spec-relevant
 * invariants:
 *   - Invite redemption + first login → access_token issued
 *   - access_token validates with auth_time claim
 *   - Login flow with username/password → access_token issued
 *   - Rate-limit triggers after threshold failures (must-fix #16)
 *   - Wrong-password noteFailure does not allow next attempt past threshold
 *
 * The existing oauth-http-auth.test.ts covers the StreamableHTTP
 * transport handoff for trivial-consent; this file covers the
 * LocalAccountMethod-specific flow without the heavy DI container.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { decodeJwt } from 'jose';
import { LocalAccountMethod } from '../../../src/auth/embedded-as/methods/LocalAccountMethod.js';
import { LocalLoginRateLimiter } from '../../../src/auth/embedded-as/rateLimit.js';
import { InviteTokenStore } from '../../../src/auth/embedded-as/inviteTokens.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { InMemoryRateLimitStore } from '../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import { randomBytes } from 'node:crypto';
import {
  type ASHarness,
  approveClientConsentPage,
  CookieJar,
  followToCodeRedirect,
  startAuthorizeFlow,
  startASHarness,
} from './oauth-flow-helpers.js';

const REDIRECT_URI = 'http://127.0.0.1/callback';
const CLIENT_ID = 'dollhouse-claude-connector';
const VALID_PASSWORD = 'a-very-long-password';

function buildLocalMethod(storage: InMemoryAuthStorageLayer): LocalAccountMethod {
  const invites = new InviteTokenStore(randomBytes(32), storage);
  const rateLimiter = new LocalLoginRateLimiter({ storage, store: new InMemoryRateLimitStore(), storeBackend: 'memory' });
  return new LocalAccountMethod({ storage, invites, rateLimiter });
}

async function fetchAuthServerMetadata(baseUrl: string) {
  const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  return res.json() as Promise<{
    authorization_endpoint: string;
    token_endpoint: string;
    issuer: string;
  }>;
}

async function postConsentForm(
  interactionUrl: string,
  jar: CookieJar,
  body: Record<string, string>,
): Promise<Response> {
  // Pull CSRF token from the rendered HTML.
  const consent = await fetch(interactionUrl, {
    method: 'GET', redirect: 'manual',
    headers: { Cookie: jar.header() },
  });
  jar.ingest(consent.headers);
  const html = await consent.text();
  const csrfMatch = /name="csrf_token"\s+value="([^"]+)"/.exec(html);
  if (!csrfMatch) throw new Error('CSRF token not found in interaction render');
  const csrfToken = csrfMatch[1];

  return fetch(interactionUrl, {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar.header(),
    },
    body: new URLSearchParams({ csrf_token: csrfToken, ...body }),
  });
}

describe('LocalAccountMethod — OAuth E2E', () => {
  let storage: InMemoryAuthStorageLayer;
  let method: LocalAccountMethod;
  let harness: ASHarness;

  beforeEach(async () => {
    storage = new InMemoryAuthStorageLayer();
    method = buildLocalMethod(storage);
    harness = await startASHarness({
      methods: [method],
      storage,
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('end-to-end: invite redemption → access token → validate', async () => {
    // Operator issues an invite via the method's API (CLI equivalent).
    const inviteUrl = method.issueInvite('local_alice', 'alice@example.com', REDIRECT_URI);
    const inviteToken = new URL(inviteUrl).searchParams.get('invite')!;

    // Begin OAuth flow.
    const authServer = await fetchAuthServerMetadata(harness.baseUrl);
    const { interactionUrl, jar, verifier } = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`,
      scope: 'mcp offline_access',
    });

    // POST the consent form with action=set-password to consume the invite.
    const consentPost = await postConsentForm(interactionUrl, jar, {
      action: 'set-password',
      invite: inviteToken,
      password: VALID_PASSWORD,
    });
    expect(consentPost.status).toBe(200);

    const approvePost = await approveClientConsentPage({
      baseUrl: harness.baseUrl,
      response: consentPost,
      jar,
    });
    expect([302, 303]).toContain(approvePost.status);
    jar.ingest(approvePost.headers);

    // Follow oidc-provider's redirect chain to the client redirect_uri with code.
    const code = await followToCodeRedirect({
      baseUrl: harness.baseUrl,
      start: approvePost.headers.get('location'),
      jar,
      redirectUriPrefix: REDIRECT_URI,
    });

    // Exchange code for token.
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
    const tokenBody = await tokenResp.json() as { access_token: string; refresh_token?: string };
    expect(tokenBody.access_token).toBeTruthy();

    // Validate the access token via the AS.
    const validation = await harness.as.validate(tokenBody.access_token);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.claims.sub).toBe('local_alice');
    }

    // auth_time claim is on the issued token (must-fix #12).
    const decoded = decodeJwt(tokenBody.access_token);
    expect(typeof decoded.auth_time).toBe('number');
    expect(decoded.auth_time).toBeGreaterThan(0);

    const tokenEvents = await storage.listIdentityEvents({ type: 'auth.oauth.token_issued' });
    expect(tokenEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sub: 'local_alice',
          details: expect.objectContaining({
            providerEvent: 'access_token.issued',
            tokenKind: 'AccessToken',
            clientId: CLIENT_ID,
            scope: 'mcp',
            audience: `${harness.publicBaseUrl}/mcp`,
          }),
        }),
      ]),
    );

    // Account row in storage carries the password hash on credentials,
    // not rawProfile (B4).
    const stored = await storage.getAccount('local_alice');
    expect(stored?.credentials?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored?.rawProfile).toBeUndefined();
  }, 30_000);

  it('admin claim: pre-claimed sub gets roles:["admin"] on JWT (must-fix #22)', async () => {
    // Replace the auto-bootstrapped harness with one that skips
    // auto-bootstrap so we can simulate the create-user CLI's pre-claim
    // for a specific admin sub. Auto-bootstrap uses a placeholder sub
    // that doesn't match what we issue here.
    await harness.close();
    storage = new InMemoryAuthStorageLayer();
    method = buildLocalMethod(storage);
    harness = await startASHarness({ methods: [method], storage, skipAutoBootstrap: true });

    // Simulate the create-user CLI behavior: it pre-claims bootstrap with
    // the to-be-admin sub BEFORE the invite URL is delivered. Then the
    // admin redeems the invite, sets a password, completes OAuth — the
    // access token they receive carries roles:['admin'].
    await storage.markBootstrapComplete('local_admin', 'local-password');

    const inviteUrl = method.issueInvite('local_admin', 'admin@example.com', REDIRECT_URI);
    const inviteToken = new URL(inviteUrl).searchParams.get('invite')!;

    const authServer = await fetchAuthServerMetadata(harness.baseUrl);
    const { interactionUrl, jar, verifier } = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`,
      scope: 'mcp',
    });
    const consentPost = await postConsentForm(interactionUrl, jar, {
      action: 'set-password',
      invite: inviteToken,
      password: VALID_PASSWORD,
    });
    expect(consentPost.status).toBe(200);

    const approvePost = await approveClientConsentPage({
      baseUrl: harness.baseUrl,
      response: consentPost,
      jar,
    });
    expect([302, 303]).toContain(approvePost.status);
    jar.ingest(approvePost.headers);

    const code = await followToCodeRedirect({
      baseUrl: harness.baseUrl,
      start: approvePost.headers.get('location'),
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

    // Validate via AS — claims should include admin role.
    const validation = await harness.as.validate(tokenBody.access_token);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.claims.sub).toBe('local_admin');
      expect(validation.claims.roles).toEqual(['admin']);
    }

    // Decoded JWT also carries roles claim — what downstream services see.
    const decoded = decodeJwt(tokenBody.access_token);
    expect(decoded.roles).toEqual(['admin']);

    // Account in storage has roles persisted (so future logins still
    // get admin via extraTokenClaims, even after token rotation).
    const stored = await storage.getAccount('local_admin');
    expect(stored?.roles).toEqual(['admin']);
  }, 30_000);

  it('non-admin: invite redeemed by a different sub does NOT get admin role', async () => {
    // Same harness rebuild as above — clean storage with skip-auto-bootstrap.
    await harness.close();
    storage = new InMemoryAuthStorageLayer();
    method = buildLocalMethod(storage);
    harness = await startASHarness({ methods: [method], storage, skipAutoBootstrap: true });

    // Pre-claim adminSub = local_admin. Then issue an invite for a
    // DIFFERENT sub (local_alice) and have her redeem it. Alice should
    // NOT receive admin role even though bootstrap is complete —
    // because adminSub doesn't match her sub.
    await storage.markBootstrapComplete('local_admin', 'local-password');

    const inviteUrl = method.issueInvite('local_alice', 'alice@example.com', REDIRECT_URI);
    const inviteToken = new URL(inviteUrl).searchParams.get('invite')!;
    await method.consumeInvite(inviteToken, VALID_PASSWORD);

    const stored = await storage.getAccount('local_alice');
    expect(stored?.roles).toBeUndefined();
  }, 30_000);

  it('login flow with existing account → access token', async () => {
    // First, redeem an invite to set up the account out-of-band.
    const inviteUrl = method.issueInvite('local_bob', 'bob@example.com', REDIRECT_URI);
    const inviteToken = new URL(inviteUrl).searchParams.get('invite')!;
    await method.consumeInvite(inviteToken, VALID_PASSWORD);

    // Now drive an OAuth flow as a LOGIN (not invite redemption).
    const authServer = await fetchAuthServerMetadata(harness.baseUrl);
    const { interactionUrl, jar, verifier } = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`,
      scope: 'mcp offline_access',
    });

    const consentPost = await postConsentForm(interactionUrl, jar, {
      action: 'login',
      username: 'bob',
      password: VALID_PASSWORD,
    });
    expect(consentPost.status).toBe(200);

    const approvePost = await approveClientConsentPage({
      baseUrl: harness.baseUrl,
      response: consentPost,
      jar,
    });
    expect([302, 303]).toContain(approvePost.status);
    jar.ingest(approvePost.headers);

    const code = await followToCodeRedirect({
      baseUrl: harness.baseUrl,
      start: approvePost.headers.get('location'),
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
  }, 30_000);

  it('rate-limit: 5 wrong-password attempts lock the account (must-fix #16)', async () => {
    // Set up the account.
    const inviteUrl = method.issueInvite('local_carol', 'carol@example.com', REDIRECT_URI);
    const inviteToken = new URL(inviteUrl).searchParams.get('invite')!;
    await method.consumeInvite(inviteToken, VALID_PASSWORD);

    const authServer = await fetchAuthServerMetadata(harness.baseUrl);

    // Attempt to login 6 times with the wrong password. The 6th attempt
    // (or later) hits the lockout. We assert via the method's check
    // function: after 5 noteFailures, check returns allowed=false.
    for (let i = 0; i < 6; i += 1) {
      const { interactionUrl, jar } = await startAuthorizeFlow({
        baseUrl: harness.baseUrl,
        authServerMetadata: authServer,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        resource: `${harness.publicBaseUrl}/mcp`,
        scope: 'mcp offline_access',
      });
      await postConsentForm(interactionUrl, jar, {
        action: 'login',
        username: 'carol',
        password: 'wrong',
      });
    }

    // Audit event recorded.
    const events = await storage.listIdentityEvents({
      type: 'auth.local.brute_force_suspected',
    });
    expect(events.length).toBeGreaterThan(0);

    // Even with the right password now, the account is locked.
    const { interactionUrl, jar } = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`,
      scope: 'mcp offline_access',
    });
    const lockedAttempt = await postConsentForm(interactionUrl, jar, {
      action: 'login',
      username: 'carol',
      password: VALID_PASSWORD,
    });
    // Method returns 'denied' → InteractionRouter sends 400.
    expect(lockedAttempt.status).toBe(400);
    const body = await lockedAttempt.json() as { error: string; error_description: string };
    expect(body.error_description).toMatch(/locked/);
  }, 60_000);
});
