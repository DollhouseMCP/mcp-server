/** Access tokens stay bound to the grant that issued them. */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { RequestHandler } from 'express';
import { decodeJwt } from 'jose';
import { randomBytes, randomUUID } from 'node:crypto';
import { createUnifiedAuthMiddleware } from '../../../src/auth/authMiddleware.js';
import { LocalAccountMethod } from '../../../src/auth/embedded-as/methods/LocalAccountMethod.js';
import { LocalLoginRateLimiter } from '../../../src/auth/embedded-as/rateLimit.js';
import { InviteTokenStore } from '../../../src/auth/embedded-as/inviteTokens.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { InMemoryRateLimitStore } from '../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import { ConsoleOAuthGrantRevocationService } from '../../../src/web-console/services/oauth/ConsoleOAuthGrantRevocationService.js';
import {
  type ASHarness,
  approveClientConsentPage,
  CookieJar,
  followToCodeRedirect,
  startAuthorizeFlow,
  startASHarness,
} from './oauth-flow-helpers.js';

const REDIRECT_URI = 'http://127.0.0.1/callback';
const USERNAME = 'grantbinding';
const SUB = `local_${USERNAME}`;
const PASSWORD = 'a-very-long-password';
const PROTECTED_PATH = '/protected';

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
  const csrfMatch = /name="csrf_token"\s+value="([^"]+)"/.exec(html);
  if (!csrfMatch) throw new Error('CSRF token not found in interaction render');
  return fetch(interactionUrl, {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar.header(),
    },
    body: new URLSearchParams({ csrf_token: csrfMatch[1], ...body }),
  });
}

describe('Access-token grant binding', () => {
  let storage: InMemoryAuthStorageLayer;
  let harness: ASHarness;

  beforeEach(async () => {
    storage = new InMemoryAuthStorageLayer();
    const invites = new InviteTokenStore(randomBytes(32), storage);
    const rateLimiter = new LocalLoginRateLimiter({ storage, store: new InMemoryRateLimitStore(), storeBackend: 'memory' });
    const method = new LocalAccountMethod({ storage, invites, rateLimiter });
    // The same middleware that guards /mcp, mounted on a bare route.
    let bearerAuth: RequestHandler | undefined;
    harness = await startASHarness({
      methods: [method], storage, openDCR: true,
      configureApp: app => {
        app.get(PROTECTED_PATH, (req, res, next) => {
          bearerAuth ??= createUnifiedAuthMiddleware({
            provider: harness.as,
            protectedResourceMetadataUrl: harness.as.getProtectedResourceMetadataUrl(),
            requiredScopes: ['mcp'],
          });
          void bearerAuth(req, res, next);
        }, (_req, res) => { res.json({ ok: true }); });
      },
    });
    const invite = method.issueInvite(SUB, 'grant-binding@example.com', REDIRECT_URI);
    await method.consumeInvite(new URL(invite).searchParams.get('invite')!, PASSWORD);
  });

  afterEach(async () => {
    if (harness) await harness.close();
  });

  /** Registers a fresh client and signs the account in, which creates a new grant. */
  async function authorize(): Promise<{ accessToken: string; grantId: string }> {
    const registration = await fetch(`${harness.baseUrl}/reg`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'grant-binding', application_type: 'native', redirect_uris: [REDIRECT_URI],
        response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none', scope: 'openid offline_access mcp profile email' }) });
    expect(registration.status).toBe(201);
    const { client_id: clientId } = await registration.json() as { client_id: string };
    const metadataResponse = await fetch(`${harness.baseUrl}/.well-known/oauth-authorization-server`);
    const authServer = await metadataResponse.json() as { authorization_endpoint: string; token_endpoint: string };
    const { interactionUrl, jar, verifier } = await startAuthorizeFlow({ baseUrl: harness.baseUrl, authServerMetadata: authServer,
      clientId, redirectUri: REDIRECT_URI, resource: `${harness.publicBaseUrl}/mcp`,
      scope: 'openid offline_access mcp profile email' });
    const consent = await postConsentForm(interactionUrl, jar, { action: 'login', username: USERNAME, password: PASSWORD });
    const approved = await approveClientConsentPage({ baseUrl: harness.baseUrl, response: consent, jar });
    jar.ingest(approved.headers);
    const code = await followToCodeRedirect({ baseUrl: harness.baseUrl, start: approved.headers.get('location'), jar, redirectUriPrefix: REDIRECT_URI });
    const response = await fetch(authServer.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: REDIRECT_URI, code,
        code_verifier: verifier, resource: `${harness.publicBaseUrl}/mcp` }) });
    expect(response.status).toBe(200);
    const tokens = await response.json() as { access_token: string };
    const grantId = decodeJwt(tokens.access_token).grant_id;
    if (typeof grantId !== 'string') throw new Error('access token carries no grant_id claim');
    return { accessToken: tokens.access_token, grantId };
  }

  function callProtected(accessToken: string): Promise<Response> {
    return fetch(`${harness.baseUrl}${PROTECTED_PATH}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  }

  it('accepts an access token while its grant exists', async () => {
    const { accessToken } = await authorize();
    expect(await harness.as.validate(accessToken)).toMatchObject({ ok: true, claims: { sub: SUB } });
    expect((await callProtected(accessToken)).status).toBe(200);
  }, 30_000);

  it('rejects an issued access token once its grant has been revoked', async () => {
    const { accessToken, grantId } = await authorize();
    expect((await callProtected(accessToken)).status).toBe(200);

    const revocation = new ConsoleOAuthGrantRevocationService({ listLinkedSubjects: () => Promise.resolve([SUB]) }, storage);
    const summary = await revocation.revokePrincipalGrants({ userId: randomUUID(), revokedAt: new Date() });
    expect(summary.oauthGrantFamiliesRevoked).toBe(1);
    expect(await storage.findGrantsByAccountId(SUB)).not.toContain(grantId);

    expect(await harness.as.validate(accessToken)).toEqual({ ok: false, reason: 'token grant is no longer active' });
    const rejected = await callProtected(accessToken);
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get('www-authenticate')).toContain('Bearer');
  }, 30_000);

  it('keeps another grant for the same account working when one is revoked', async () => {
    const first = await authorize();
    const second = await authorize();
    expect(second.grantId).not.toBe(first.grantId);

    await storage.genericRevokeByGrantId(first.grantId);

    expect((await callProtected(first.accessToken)).status).toBe(401);
    expect((await callProtected(second.accessToken)).status).toBe(200);
  }, 30_000);
});
