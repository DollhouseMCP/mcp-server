/**
 * Token reuse-detection (Phase 7).
 *
 * OAuth 2.1 §4.1.3: an authorization_code MUST be single-use; reusing
 * a consumed code MUST be rejected with `invalid_grant`. oidc-provider
 * 9.x revokes the entire issuance family on detection.
 *
 * The dashboard documented refresh-token rotation atomicity as DEFERRED
 * (must-fix #11) but had no positive test exercising the
 * single-use-then-revoke contract end-to-end. This test pins the
 * contract on the path that's actually exercised by the §8.1
 * happy-path flow (authorization_code), which shares the same
 * single-use storage semantics in oidc-provider as RefreshToken.
 *
 * Refresh-token replay is conceptually identical: rotateRefreshToken:
 * true + issueRefreshToken at EmbeddedAuthorizationServer.ts make the
 * old token a single-use record once rotated, and the same
 * genericDestroy + revokeByGrantId path drives the family revocation.
 * Once a consent-prompt UI lands and offline_access can flow through
 * the interaction policy, an additional refresh_token replay test
 * should pin the rotation flow specifically.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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
    harness = await startASHarness({ methods: [method], storage });
  });

  afterEach(async () => {
    if (harness) await harness.close();
  });

  it('replaying a consumed authorization_code returns invalid_grant', async () => {
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

    const first = await exchange();
    expect(first.status).toBe(200);

    // Replay must be rejected with invalid_grant. oidc-provider treats the
    // code as consumed and revokes the issuance family.
    const second = await exchange();
    expect(second.status).toBe(400);
    const body = await second.json() as { error?: string };
    expect(body.error).toBe('invalid_grant');
  }, 30_000);
});
