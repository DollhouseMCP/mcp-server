/** Authorization-code replay and refresh-token issuance/rotation contracts. */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { decodeJwt } from 'jose';
import { randomBytes } from 'node:crypto';
import { LocalAccountMethod } from '../../../src/auth/embedded-as/methods/LocalAccountMethod.js';
import { LocalLoginRateLimiter } from '../../../src/auth/embedded-as/rateLimit.js';
import { InviteTokenStore } from '../../../src/auth/embedded-as/inviteTokens.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { InMemoryRateLimitStore } from '../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
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

describe('Token reuse-detection — OAuth 2.1 §4.1.3', () => {
  let storage: InMemoryAuthStorageLayer;
  let method: LocalAccountMethod;
  let harness: ASHarness;

  beforeEach(async () => {
    storage = new InMemoryAuthStorageLayer();
    const invites = new InviteTokenStore(randomBytes(32), storage);
    const rateLimiter = new LocalLoginRateLimiter({ storage, store: new InMemoryRateLimitStore(), storeBackend: 'memory' });
    method = new LocalAccountMethod({ storage, invites, rateLimiter });
    harness = await startASHarness({ methods: [method], storage, openDCR: true });
  });

  afterEach(async () => {
    if (harness) await harness.close();
  });

  async function authorizeDcr(offline: boolean, refreshAllowed: boolean, prompt?: string, par = false, loginHint?: string) {
    const registration = await fetch(`${harness.baseUrl}/reg`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'refresh-proof', application_type: 'native', redirect_uris: [REDIRECT_URI], response_types: ['code'],
        grant_types: refreshAllowed ? ['authorization_code', 'refresh_token'] : ['authorization_code'],
        token_endpoint_auth_method: 'none', scope: 'openid offline_access mcp profile email' }) });
    expect(registration.status).toBe(201);
    const { client_id: clientId } = await registration.json() as { client_id: string };
    const invite = method.issueInvite('local_refresh', 'refresh@example.com', REDIRECT_URI);
    const authServer = await fetchAuthServerMetadata(harness.baseUrl);
    const { interactionUrl, jar, verifier } = await startAuthorizeFlow({ baseUrl: harness.baseUrl, authServerMetadata: authServer,
      clientId, redirectUri: REDIRECT_URI, resource: `${harness.publicBaseUrl}/mcp`,
      scope: offline ? 'openid offline_access mcp profile email' : 'openid mcp profile email', prompt, loginHint,
      pushedAuthorizationEndpoint: par ? `${harness.baseUrl}/request` : undefined });
    const consent = await postConsentForm(interactionUrl, jar, { action: 'set-password',
      invite: new URL(invite).searchParams.get('invite')!, password: 'a-very-long-password' });
    const consentHtml = await consent.clone().text();
    if (offline && refreshAllowed) expect(consentHtml).toContain('Keep access between sessions');
    else expect(consentHtml).not.toContain('Keep access between sessions');
    const approved = await approveClientConsentPage({ baseUrl: harness.baseUrl, response: consent, jar });
    jar.ingest(approved.headers);
    const code = await followToCodeRedirect({ baseUrl: harness.baseUrl, start: approved.headers.get('location'), jar, redirectUriPrefix: REDIRECT_URI });
    const response = await fetch(authServer.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: REDIRECT_URI, code,
        code_verifier: verifier, resource: `${harness.publicBaseUrl}/mcp` }) });
    expect(response.status).toBe(200);
    const tokens = await response.json() as { access_token: string; refresh_token?: string };
    return { clientId, tokens, tokenEndpoint: authServer.token_endpoint };
  }

  it.each([undefined, 'consent'])('issues and rotates public-client refresh tokens with stable grant binding (prompt=%s)', async prompt => {
    const { clientId, tokens, tokenEndpoint } = await authorizeDcr(true, true, prompt);
    expect(tokens.refresh_token).toEqual(expect.any(String));
    const refresh = await fetch(tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token!, resource: `${harness.publicBaseUrl}/mcp` }) });
    expect(refresh.status).toBe(200);
    const next = await refresh.json() as { access_token: string; refresh_token: string };
    expect(next.refresh_token).toEqual(expect.any(String));
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    const grant = decodeJwt(tokens.access_token).grant_id;
    expect(grant).toEqual(expect.any(String));
    expect(decodeJwt(next.access_token).grant_id).toBe(grant);
  }, 30_000);

  it('grants offline access after consent through PAR without an explicit prompt', async () => {
    const { tokens } = await authorizeDcr(true, true, undefined, true);
    expect(tokens.refresh_token).toEqual(expect.any(String));
  }, 30_000);

  it.each([false, true])('issues a refresh token with a Unicode login hint (PAR=%s)', async par => {
    const { tokens } = await authorizeDcr(true, true, undefined, par, 'josé@example.com');
    expect(tokens.refresh_token).toEqual(expect.any(String));
  }, 30_000);

  it('allows the configured retry grace, then rejects replay and revokes the rotated family', async () => {
    const { clientId, tokens, tokenEndpoint } = await authorizeDcr(true, true);
    const refresh = (token: string) => fetch(tokenEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token,
        resource: `${harness.publicBaseUrl}/mcp` }),
    });
    const rotatedResponse = await refresh(tokens.refresh_token!);
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json() as { refresh_token: string };
    const retry = await refresh(tokens.refresh_token!);
    expect(retry.status).toBe(200); // Default 30-second adapter retry grace is intentional.
    const retried = await retry.json() as { refresh_token: string };
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    try {
      for (const token of [tokens.refresh_token!, rotated.refresh_token, retried.refresh_token]) {
        const replay = await refresh(token);
        expect(replay.status).toBe(400);
        expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
      }
    } finally { clock.mockRestore(); }
  }, 30_000);

  it.each([[false, true], [true, false]])('does not issue refresh tokens without both requested scope and client grant (offline=%s, allowed=%s)', async (offline, allowed) => {
    const { tokens } = await authorizeDcr(offline, allowed);
    expect(tokens.refresh_token).toBeUndefined();
  }, 30_000);

  it.each(['disabled', 'revoked'] as const)('rejects refresh when the account is %s', async state => {
    const { clientId, tokens, tokenEndpoint } = await authorizeDcr(true, true);
    if (state === 'disabled') jest.spyOn(storage, 'isAccountAllowed').mockResolvedValue(false);
    else await storage.genericRevokeByGrantId(decodeJwt(tokens.access_token).grant_id as string);
    const response = await fetch(tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token!, resource: `${harness.publicBaseUrl}/mcp` }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  }, 30_000);

  it('advertises optional offline access in protected-resource metadata', async () => {
    const response = await fetch(`${harness.baseUrl}/.well-known/oauth-protected-resource`);
    expect(await response.json()).toMatchObject({ scopes_supported: ['mcp', 'offline_access'] });
  });

  it.each([false, true])('rejects code reuse or a pending account before exchange (pending=%s)', async (pending) => {
    const invite = method.issueInvite('local_replay', 'replay@example.com', REDIRECT_URI);
    const inviteToken = new URL(invite).searchParams.get('invite')!;

    const authServer = await fetchAuthServerMetadata(harness.baseUrl);
    const { interactionUrl, jar, verifier } = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`,
      scope: 'mcp',
    });
    const consentPost = await postConsentForm(interactionUrl, jar, {
      action: 'set-password', invite: inviteToken, password: 'a-very-long-password',
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

    const exchange = (): Promise<Response> =>
      fetch(authServer.token_endpoint, {
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

    if (pending) jest.spyOn(storage, 'isAccountAllowed').mockResolvedValue(false);
    const first = await exchange();
    if (pending) {
      expect(first.status).toBe(400);
      const body = await first.json() as { error?: string; access_token?: string };
      expect(body.error).toBe('invalid_grant');
      expect(body.access_token).toBeUndefined();
      return;
    }
    expect(first.status).toBe(200);

    // Replay must be rejected with invalid_grant. oidc-provider treats the
    // code as consumed and revokes the issuance family.
    const second = await exchange();
    expect(second.status).toBe(400);
    const body = await second.json() as { error?: string };
    expect(body.error).toBe('invalid_grant');
  }, 30_000);
});
