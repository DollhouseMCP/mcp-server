/**
 * GET /auth/admin/me — Round 5 / H7 admin role enforcement.
 *
 * Closes the must-fix #22 loop end-to-end:
 *   1. CLI pre-claims bootstrap admin sub
 *   2. Admin redeems invite, completes OAuth
 *   3. JWT carries roles:['admin']
 *   4. GET /auth/admin/me with Bearer token → 200 with claims body
 *   5. Same endpoint with non-admin token → 403
 *   6. Same endpoint with no token → 401
 *
 * Without a route that actually checks the role, the dashboard's
 * "admin claim flows end-to-end" assertion was theoretical. This file
 * makes it observable.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LocalAccountMethod } from '../../../src/auth/embedded-as/methods/LocalAccountMethod.js';
import { LocalLoginRateLimiter } from '../../../src/auth/embedded-as/rateLimit.js';
import { InviteTokenStore } from '../../../src/auth/embedded-as/inviteTokens.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { randomBytes } from 'node:crypto';
import {
  type ASHarness,
  CookieJar,
  followToCodeRedirect,
  startAuthorizeFlow,
  startASHarness,
} from './oauth-flow-helpers.js';

const REDIRECT_URI = 'http://127.0.0.1/callback';
const CLIENT_ID = 'dollhouse-claude-connector';

function buildLocalMethod(storage: InMemoryAuthStorageLayer): LocalAccountMethod {
  const invites = new InviteTokenStore(randomBytes(32), storage);
  const rateLimiter = new LocalLoginRateLimiter({ storage });
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
  const consent = await fetch(interactionUrl, {
    method: 'GET', redirect: 'manual',
    headers: { Cookie: jar.header() },
  });
  jar.ingest(consent.headers);
  const html = await consent.text();
  const csrfMatch = html.match(/name="csrf_token"\s+value="([^"]+)"/);
  if (!csrfMatch) throw new Error('CSRF token not found in interaction render');
  const csrfToken = csrfMatch[1]!;
  return fetch(interactionUrl, {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar.header(),
    },
    body: new URLSearchParams({ csrf_token: csrfToken, ...body }),
  });
}

/**
 * Run the full local-password OAuth flow for the named sub and return
 * the access token. Caller has already pre-claimed bootstrap state if
 * they want this sub to be the admin.
 */
async function loginAsLocalUser(
  harness: ASHarness,
  method: LocalAccountMethod,
  sub: string,
  email: string,
): Promise<string> {
  const inviteUrl = method.issueInvite(sub, email, REDIRECT_URI);
  const inviteToken = new URL(inviteUrl).searchParams.get('invite')!;

  const authServer = await fetchAuthServerMetadata(harness.baseUrl);
  const { interactionUrl, jar, verifier } = await startAuthorizeFlow({
    baseUrl: harness.baseUrl,
    authServerMetadata: authServer,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    resource: `${harness.publicBaseUrl}/mcp`,
    scope: 'mcp',
  });
  const consentPost = await postConsentForm(interactionUrl, jar, {
    action: 'set-password',
    invite: inviteToken,
    password: 'a-very-long-password',
  });
  jar.ingest(consentPost.headers);
  const code = await followToCodeRedirect({
    baseUrl: harness.baseUrl,
    start: consentPost.headers.get('location'),
    jar,
    redirectUriPrefix: REDIRECT_URI,
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
  if (tokenResp.status !== 200) {
    throw new Error(`token endpoint returned ${tokenResp.status}: ${await tokenResp.text()}`);
  }
  const tokenBody = await tokenResp.json() as { access_token: string };
  return tokenBody.access_token;
}

describe('GET /auth/admin/me — H7 admin role enforcement', () => {
  let storage: InMemoryAuthStorageLayer;
  let method: LocalAccountMethod;
  let harness: ASHarness;

  beforeEach(async () => {
    storage = new InMemoryAuthStorageLayer();
    method = buildLocalMethod(storage);
    harness = await startASHarness({
      methods: [method],
      storage,
      skipAutoBootstrap: true, // we drive bootstrap explicitly
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('admin token → 200 with claims body containing roles:["admin"]', async () => {
    await storage.markBootstrapComplete('local_admin', 'local-password');
    const adminToken = await loginAsLocalUser(harness, method, 'local_admin', 'admin@example.com');

    const res = await fetch(`${harness.baseUrl}/auth/admin/me`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      sub: string;
      roles: string[];
      email: string;
      bootstrap: { adminSub: string; adminMethod: string; completedAt: number };
    };
    expect(body.sub).toBe('local_admin');
    expect(body.roles).toContain('admin');
    expect(body.email).toBe('admin@example.com');
    expect(body.bootstrap.adminSub).toBe('local_admin');
    expect(body.bootstrap.adminMethod).toBe('local-password');
  }, 30_000);

  it('non-admin token → 403 with required_role hint', async () => {
    // Pre-claim a different sub as admin, then log in as a regular user.
    await storage.markBootstrapComplete('local_admin', 'local-password');
    const aliceToken = await loginAsLocalUser(harness, method, 'local_alice', 'alice@example.com');

    const res = await fetch(`${harness.baseUrl}/auth/admin/me`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; required_role: string };
    expect(body.required_role).toBe('admin');
    expect(body.error).toMatch(/forbidden/i);
  }, 30_000);

  it('no token → 401 with WWW-Authenticate header', async () => {
    // Bootstrap so the gate is open; we want a clean 401, not a 503.
    await storage.markBootstrapComplete('local_admin', 'local-password');

    const res = await fetch(`${harness.baseUrl}/auth/admin/me`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
  }, 30_000);

  it('invalid token → 401', async () => {
    await storage.markBootstrapComplete('local_admin', 'local-password');

    const res = await fetch(`${harness.baseUrl}/auth/admin/me`, {
      headers: { Authorization: 'Bearer not.a.real.jwt' },
    });
    expect(res.status).toBe(401);
  }, 30_000);

  it('pre-bootstrap → 503 (gate intercepts before role check)', async () => {
    // No markBootstrapComplete called. The bootstrap gate is mounted
    // before /auth/admin/me; pre-bootstrap requests get the same 503
    // as every other auth-flow path. This pins that mount order.
    const res = await fetch(`${harness.baseUrl}/auth/admin/me`, {
      headers: { Authorization: 'Bearer not.even.checked' },
    });
    expect(res.status).toBe(503);
  }, 30_000);
});
