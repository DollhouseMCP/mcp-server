/**
 * MagicLinkMethod E2E (Phase 6.3).
 *
 * Drives the OAuth/PKCE flow against an EmbeddedAuthorizationServer
 * configured with MagicLinkMethod + an in-memory CollectingEmailSender.
 * Asserts the spec-relevant invariants:
 *   - GET /auth/email/verify renders confirmation page (does NOT consume) — must-fix #1
 *   - POST /auth/email/verify completes the OAuth interaction → access_token
 *   - Account-enumeration: identical response for known and unknown email — must-fix #2
 *   - Per-email rate limit triggers + audit event after threshold — must-fix #3
 *   - Token replay rejected (second consume fails)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { decodeJwt } from 'jose';
import { randomBytes } from 'node:crypto';
import {
  hashEmail,
  MagicLinkMethod,
  type EmailSender,
  type SendMagicLinkInput,
} from '../../../src/auth/embedded-as/methods/MagicLinkMethod.js';
import { InviteTokenStore } from '../../../src/auth/embedded-as/inviteTokens.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import {
  type ASHarness,
  CookieJar,
  followToCodeRedirect,
  getFreePort,
  startAuthorizeFlow,
  startASHarness,
} from './oauth-flow-helpers.js';

const REDIRECT_URI = 'http://127.0.0.1/callback';
const CLIENT_ID = 'dollhouse-claude-connector';
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const OAUTH_SCOPES = 'mcp offline_access';

class CollectingEmailSender implements EmailSender {
  sent: SendMagicLinkInput[] = [];
  async sendMagicLink(input: SendMagicLinkInput): Promise<void> {
    this.sent.push(input);
  }
}

async function fetchAuthServerMetadata(baseUrl: string) {
  const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  return res.json() as Promise<{
    authorization_endpoint: string;
    token_endpoint: string;
    issuer: string;
  }>;
}

async function postRequestLinkForm(
  interactionUrl: string,
  jar: CookieJar,
  email: string,
): Promise<Response> {
  // Pull CSRF token from the request-link form rendered by the AS.
  const consent = await fetch(interactionUrl, {
    method: 'GET', redirect: 'manual',
    headers: { Cookie: jar.header() },
  });
  jar.ingest(consent.headers);
  const html = await consent.text();
  const csrfMatch = /name="csrf_token"\s+value="([^"]+)"/.exec(html);
  if (!csrfMatch) throw new Error('CSRF token not found in magic-link request render');
  const csrfToken = csrfMatch[1];

  return fetch(interactionUrl, {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': FORM_CONTENT_TYPE,
      Cookie: jar.header(),
    },
    body: new URLSearchParams({
      csrf_token: csrfToken,
      action: 'request-link',
      email,
    }),
  });
}

describe('MagicLinkMethod — OAuth E2E', () => {
  let storage: InMemoryAuthStorageLayer;
  let invites: InviteTokenStore;
  let emailSender: CollectingEmailSender;
  let method: MagicLinkMethod;
  let harness: ASHarness;

  beforeEach(async () => {
    storage = new InMemoryAuthStorageLayer();
    invites = new InviteTokenStore(randomBytes(32), storage);
    emailSender = new CollectingEmailSender();
    // Build the AS first so we know the public base URL for verifyUrl.
    // Listen on a fixed port via the harness; we boot a placeholder method
    // first to learn the port, then rebuild with the real verifyUrl. Cleaner
    // shape: precompute publicBaseUrl, hand it to both harness and method.
  });

  afterEach(async () => {
    if (harness) await harness.close();
  });

  async function bootHarness(): Promise<void> {
    // Pre-allocate a port so verifyUrl can point at the same AS.
    const port = await getFreePort();
    const publicBaseUrl = `http://127.0.0.1:${port}`;
    method = new MagicLinkMethod({
      storage, invites, emailSender,
      verifyUrl: `${publicBaseUrl}/auth/email/verify`,
      // Drop the timing floor to keep the suite fast; the timing-equivalence
      // assertion uses the production default and lives in MagicLinkMethod.test.ts.
      requestResponseFloorMs: 0,
    });
    harness = await startASHarness({
      methods: [method],
      storage,
      publicBaseUrl,
      port,
    });
  }

  it('end-to-end: request link → verify GET → POST consume → access token', async () => {
    await bootHarness();
    const authServer = await fetchAuthServerMetadata(harness.baseUrl);
    const { interactionUrl, jar, verifier } = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`,
      scope: OAUTH_SCOPES,
    });

    // POST the request-link form. Stays on a 200 "check your email" page.
    const requestResp = await postRequestLinkForm(interactionUrl, jar, 'alice@example.com');
    // Method returns kind:'next-step' → router renders 200 with new CSRF.
    expect(requestResp.status).toBe(200);
    expect(emailSender.sent).toHaveLength(1);

    const magicUrl = emailSender.sent[0].url;
    expect(magicUrl).toContain('/auth/email/verify?token=');

    // GET the magic-link URL — must NOT consume the token (must-fix #1).
    const verifyGet = await fetch(magicUrl, {
      method: 'GET', redirect: 'manual',
      headers: { Cookie: jar.header() },
    });
    expect(verifyGet.status).toBe(200);
    expect(await verifyGet.text()).toContain('Confirm sign-in');

    // POST consumes the token + completes the OAuth interaction.
    const tokenParam = new URL(magicUrl).searchParams.get('token')!;
    const verifyPost = await fetch(`${harness.publicBaseUrl}/auth/email/verify`, {
      method: 'POST', redirect: 'manual',
      headers: {
        'Content-Type': FORM_CONTENT_TYPE,
        Cookie: jar.header(),
      },
      body: new URLSearchParams({ token: tokenParam }),
    });
    expect([302, 303]).toContain(verifyPost.status);
    jar.ingest(verifyPost.headers);

    // Follow the oidc-provider redirect chain to the client redirect_uri.
    const code = await followToCodeRedirect({
      baseUrl: harness.baseUrl,
      start: verifyPost.headers.get('location'),
      jar,
      redirectUriPrefix: REDIRECT_URI,
    });

    const tokenResp = await fetch(authServer.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': FORM_CONTENT_TYPE },
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
    expect(tokenBody.access_token).toBeTruthy();

    // Validate via the AS.
    const validation = await harness.as.validate(tokenBody.access_token);
    expect(validation.ok).toBe(true);
    if (validation.ok) expect(validation.claims.sub).toMatch(/^magic-link_/);

    // auth_time claim asserted (must-fix #12).
    const decoded = decodeJwt(tokenBody.access_token);
    expect(typeof decoded.auth_time).toBe('number');
  }, 30_000);

  it('account-enumeration: same response shape for known and unknown email (must-fix #2)', async () => {
    await bootHarness();
    const authServer = await fetchAuthServerMetadata(harness.baseUrl);

    // Known email (we just sent one above? No — fresh harness per test).
    const a = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`, scope: OAUTH_SCOPES,
    });
    const knownResp = await postRequestLinkForm(a.interactionUrl, a.jar, 'alice@example.com');
    const knownText = await knownResp.text();

    // Unknown email — same flow, different address. Response status + body
    // shape MUST be indistinguishable.
    const b = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`, scope: OAUTH_SCOPES,
    });
    const unknownResp = await postRequestLinkForm(b.interactionUrl, b.jar, 'nobody@example.com');
    const unknownText = await unknownResp.text();

    expect(knownResp.status).toBe(unknownResp.status);
    // Both responses should contain the "Check your email" pattern in their
    // re-rendered interaction page.
    expect(knownText).toContain('Check your email');
    expect(unknownText).toContain('Check your email');
  }, 30_000);

  it('rate-limit: per-email threshold triggers audit event (must-fix #3)', async () => {
    await bootHarness();
    const authServer = await fetchAuthServerMetadata(harness.baseUrl);

    // Hammer the same email > REQUEST_RATE_LIMIT_PER_EMAIL (3 in 60s).
    for (let i = 0; i < 5; i += 1) {
      const { interactionUrl, jar } = await startAuthorizeFlow({
        baseUrl: harness.baseUrl,
        authServerMetadata: authServer,
        clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
        resource: `${harness.publicBaseUrl}/mcp`, scope: OAUTH_SCOPES,
      });
      await postRequestLinkForm(interactionUrl, jar, 'flooder@example.com');
    }

    expect(emailSender.sent.length).toBeLessThanOrEqual(3);
    const events = await storage.listIdentityEvents({
      type: 'auth.magic_link.flood_suspected',
    });
    expect(events.length).toBeGreaterThan(0);
  }, 30_000);

  it('token replay: second POST with the same token is rejected', async () => {
    await bootHarness();
    const authServer = await fetchAuthServerMetadata(harness.baseUrl);
    const { interactionUrl, jar } = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`, scope: OAUTH_SCOPES,
    });
    await postRequestLinkForm(interactionUrl, jar, 'replay@example.com');
    const tokenParam = new URL(emailSender.sent[0].url).searchParams.get('token')!;

    // First POST consumes (we don't follow the redirect; that path is
    // already covered by the end-to-end test above).
    const first = await fetch(`${harness.publicBaseUrl}/auth/email/verify`, {
      method: 'POST', redirect: 'manual',
      headers: {
        'Content-Type': FORM_CONTENT_TYPE,
        Cookie: jar.header(),
      },
      body: new URLSearchParams({ token: tokenParam }),
    });
    expect([302, 303]).toContain(first.status);

    // Second POST must be rejected (token already consumed).
    const second = await fetch(`${harness.publicBaseUrl}/auth/email/verify`, {
      method: 'POST', redirect: 'manual',
      headers: {
        'Content-Type': FORM_CONTENT_TYPE,
        Cookie: jar.header(),
      },
      body: new URLSearchParams({ token: tokenParam }),
    });
    expect(second.status).toBe(400);
  }, 30_000);

  it('cycle-16: POST /auth/email/verify rejects when interaction cookie is absent', async () => {
    // The Phase 9 ordering fix verifies the cookie BEFORE consuming the
    // token. This test asserts: (a) the 400 fires, (b) the token is
    // NOT consumed (so a subsequent POST with the right cookie still
    // works) — pinning that mismatch doesn't burn the token.
    await bootHarness();
    const authServer = await fetchAuthServerMetadata(harness.baseUrl);
    const { interactionUrl, jar } = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`, scope: 'mcp',
    });
    await postRequestLinkForm(interactionUrl, jar, 'csrf@example.com');
    const tokenParam = new URL(emailSender.sent[0].url).searchParams.get('token')!;

    // POST without the cookie jar → cookie binding mismatches.
    const noCookie = await fetch(`${harness.publicBaseUrl}/auth/email/verify`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': FORM_CONTENT_TYPE },
      body: new URLSearchParams({ token: tokenParam }),
    });
    expect(noCookie.status).toBe(400);

    // Subsequent POST with the right cookie should still work — the
    // earlier mismatch must not have consumed the token.
    const withCookie = await fetch(`${harness.publicBaseUrl}/auth/email/verify`, {
      method: 'POST', redirect: 'manual',
      headers: {
        'Content-Type': FORM_CONTENT_TYPE,
        Cookie: jar.header(),
      },
      body: new URLSearchParams({ token: tokenParam }),
    });
    expect([302, 303]).toContain(withCookie.status);
  }, 30_000);

  it('admin claim: pre-claimed magic-link sub gets roles:["admin"] on JWT (cycle-16)', async () => {
    // Need to skip auto-bootstrap so we can pre-claim with a specific
    // admin sub. bootHarness() always auto-bootstraps with a placeholder
    // sub; build a custom harness here.
    const port = await getFreePort();
    const publicBaseUrl = `http://127.0.0.1:${port}`;
    method = new MagicLinkMethod({
      storage, invites, emailSender,
      verifyUrl: `${publicBaseUrl}/auth/email/verify`,
      requestResponseFloorMs: 0,
    });
    harness = await startASHarness({
      methods: [method], storage, publicBaseUrl, port,
      skipAutoBootstrap: true,
    });

    // Pre-claim the admin sub BEFORE the user requests the magic link.
    // Mirrors the admin-bootstrap CLI's behavior for the magic-link path.
    const adminEmail = 'admin@example.com';
    const adminSub = `magic-link_${hashEmail(adminEmail)}`;
    await storage.markBootstrapComplete(adminSub, 'magic-link');

    const authServer = await fetchAuthServerMetadata(harness.baseUrl);
    const { interactionUrl, jar, verifier } = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`, scope: 'mcp',
    });
    await postRequestLinkForm(interactionUrl, jar, adminEmail);

    const tokenParam = new URL(emailSender.sent[0].url).searchParams.get('token')!;
    const verifyPost = await fetch(`${harness.publicBaseUrl}/auth/email/verify`, {
      method: 'POST', redirect: 'manual',
      headers: {
        'Content-Type': FORM_CONTENT_TYPE,
        Cookie: jar.header(),
      },
      body: new URLSearchParams({ token: tokenParam }),
    });
    expect([302, 303]).toContain(verifyPost.status);
    jar.ingest(verifyPost.headers);

    const code = await followToCodeRedirect({
      baseUrl: harness.baseUrl,
      start: verifyPost.headers.get('location'),
      jar, redirectUriPrefix: REDIRECT_URI,
    });
    const tokenResp = await fetch(authServer.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': FORM_CONTENT_TYPE },
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
