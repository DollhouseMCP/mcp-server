/**
 * Cycle 24 smoke-test regression tests.
 *
 * Pins the three real bugs the first end-to-end run against Gemini CLI
 * uncovered. None of the prior 23 cycles' tests caught these — they
 * exercise behavior that only fires for OAuth clients that use auto-
 * DCR and don't pass `resource=...` (or pass it but request scopes
 * that live in both the OIDC and resource-server dimensions). Claude
 * Desktop and Claude Code use the pre-registered `DEFAULT_CLIENT_ID`
 * and a different scope shape, so all three bugs flew below the radar
 * until a non-Anthropic MCP client actually drove the flow.
 *
 * The three regressions:
 *
 *   1. DCR open-via-env-var escape hatch. Production-shape DCR requires
 *      an Initial Access Token (IAT) — no IAT issuance path exists yet
 *      (deferred dashboard work). Setting `DOLLHOUSE_AUTH_OPEN_DCR=true`
 *      OR passing `openDCR: true` to the constructor lets MCP clients
 *      self-register without an IAT. Default stays closed.
 *
 *   2. Scope validation passes for the OIDC-standard + mcp + profile + email
 *      set Gemini CLI sends. Earlier shape only listed `openid offline_access
 *      mcp` in oidc-provider's `scopes` config, so DCR with
 *      `scope: "openid mcp profile email"` was rejected as "scope must
 *      only contain Authorization Server supported scope values".
 *
 *   3. finishInteractionWithIdentity adds every requested scope to BOTH
 *      the OIDC dimension AND the resource dimension. Earlier shape used
 *      splitScopes to put each scope in exactly one bucket, but when a
 *      scope appears in both `scopes` config AND `getResourceServerInfo.scope`
 *      (our `mcp` and `openid` are in both), oidc-provider checks BOTH
 *      grant dimensions and re-prompts on missing values — causing an
 *      infinite consent loop that every Approve click would visibly
 *      restart.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { TrivialConsentMethod } from '../../../src/auth/embedded-as/methods/TrivialConsentMethod.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import {
  type ASHarness,
  followToCodeRedirect,
  startASHarness,
  startAuthorizeFlow,
} from './oauth-flow-helpers.js';

async function fetchAuthServerMetadata(baseUrl: string) {
  const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  return res.json() as Promise<{
    authorization_endpoint: string;
    token_endpoint: string;
    issuer: string;
    scopes_supported?: string[];
  }>;
}

describe('Cycle 24 smoke-test regressions', () => {
  let harness: ASHarness | null = null;

  afterEach(async () => {
    if (harness) await harness.close();
    harness = null;
  });

  // -------------------------------------------------------------------
  // 1. DCR open-via-env-var escape hatch
  // -------------------------------------------------------------------

  describe('Cycle 24 / DCR open-via-env-var escape hatch', () => {
    it('default (openDCR=false): /reg without IAT returns 401', async () => {
      const storage = new InMemoryAuthStorageLayer();
      harness = await startASHarness({
        methods: [new TrivialConsentMethod({ defaultSubject: 'test-user' })],
        storage,
        // openDCR omitted → falls back to env.X which is false in tests.
      });

      const res = await fetch(`${harness.baseUrl}/reg`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['http://127.0.0.1:9999/cb'],
          scope: 'openid',
        }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('invalid_token');
    });

    it('openDCR=true: /reg without IAT returns 201 with a client_id', async () => {
      const storage = new InMemoryAuthStorageLayer();
      harness = await startASHarness({
        methods: [new TrivialConsentMethod({ defaultSubject: 'test-user' })],
        storage,
        openDCR: true,
      });

      const res = await fetch(`${harness.baseUrl}/reg`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['http://127.0.0.1:9999/cb'],
          scope: 'openid offline_access mcp profile email',
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { client_id?: string };
      expect(typeof body.client_id).toBe('string');
      expect(body.client_id?.length ?? 0).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------
  // 2. Expanded scopes accepted at DCR + authorize
  // -------------------------------------------------------------------

  describe('Cycle 24 / expanded scope support (mcp + profile + email)', () => {
    it('DCR accepts every scope shape Gemini CLI sends', async () => {
      const storage = new InMemoryAuthStorageLayer();
      harness = await startASHarness({
        methods: [new TrivialConsentMethod({ defaultSubject: 'test-user' })],
        storage,
        openDCR: true,
      });

      // The full set of scope strings Gemini CLI's DCR payload contains
      // across different versions. All must pass DCR validation.
      const cases = ['mcp', 'openid mcp', 'openid offline_access mcp profile email'];
      for (const scope of cases) {
        const res = await fetch(`${harness.baseUrl}/reg`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['http://127.0.0.1:9999/cb'],
            scope,
          }),
        });
        expect(res.status).toBe(201);
      }
    });

    it('/.well-known advertises mcp + profile + email in scopes_supported', async () => {
      const storage = new InMemoryAuthStorageLayer();
      harness = await startASHarness({
        methods: [new TrivialConsentMethod({ defaultSubject: 'test-user' })],
        storage,
        openDCR: true,
      });

      const meta = await fetchAuthServerMetadata(harness.baseUrl);
      expect(meta.scopes_supported).toEqual(
        expect.arrayContaining(['openid', 'offline_access', 'mcp', 'profile', 'email']),
      );
    });
  });

  // -------------------------------------------------------------------
  // 3. Dual-dimension grant binding (the consent-loop fix)
  // -------------------------------------------------------------------

  describe('Cycle 24 / dual-dimension grant binding (consent-loop regression)', () => {
    it('approve completes the flow in ONE round-trip (no consent-prompt loop)', async () => {
      // This is the load-bearing end-to-end test. Pre-cycle-24 shape:
      //   POST /interaction/:uid → 303 to /auth/:uid
      //   GET  /auth/:uid       → 303 to /interaction/:NEW_uid    ← LOOP
      // Because the grant satisfied only half of each dimension's check.
      //
      // Post-cycle-24 shape:
      //   POST /interaction/:uid → 303 to /auth/:uid
      //   GET  /auth/:uid       → 302 to <client_redirect>?code=...  ← DONE
      //
      // followToCodeRedirect walks redirects until it hits the client's
      // redirect URI. If the loop returns, it never lands on the URI and
      // throws "Did not land on client redirect_uri with code".
      const storage = new InMemoryAuthStorageLayer();
      const REDIRECT_URI = 'http://localhost:35419/oauth/callback';
      harness = await startASHarness({
        methods: [new TrivialConsentMethod({ defaultSubject: 'cycle24-user' })],
        storage,
        openDCR: true,
      });

      // Register a client via DCR (mirrors Gemini CLI's auto-registration).
      const regRes = await fetch(`${harness.baseUrl}/reg`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [REDIRECT_URI],
          scope: 'openid offline_access mcp profile email',
          token_endpoint_auth_method: 'none',
          application_type: 'native',
        }),
      });
      expect(regRes.status).toBe(201);
      const { client_id: clientId } = (await regRes.json()) as { client_id: string };

      // Start the authorize flow.
      const authServer = await fetchAuthServerMetadata(harness.baseUrl);
      const { interactionUrl, jar } = await startAuthorizeFlow({
        baseUrl: harness.baseUrl,
        authServerMetadata: authServer,
        clientId,
        redirectUri: REDIRECT_URI,
        resource: `${harness.publicBaseUrl}/mcp`,
        scope: 'openid offline_access mcp profile email',
      });

      // Render the consent page and extract the CSRF token.
      const consentGet = await fetch(interactionUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: { Cookie: jar.header() },
      });
      jar.ingest(consentGet.headers);
      const html = await consentGet.text();
      const csrfMatch = html.match(/name="csrf_token"\s+value="([^"]+)"/);
      expect(csrfMatch).not.toBeNull();
      const csrfToken = csrfMatch![1]!;

      // POST consent — this is what the user clicking "Approve" does.
      const postConsent = await fetch(interactionUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: jar.header(),
        },
        body: new URLSearchParams({ csrf_token: csrfToken, action: 'approve' }),
      });
      expect(postConsent.status).toBe(303);
      jar.ingest(postConsent.headers);

      // Walk the post-consent redirect chain. With the cycle-24 dual-
      // dimension grant binding, this lands on REDIRECT_URI?code=... in
      // 1-2 hops. Without it, the chain loops back into a fresh
      // /interaction and the helper throws.
      const code = await followToCodeRedirect({
        baseUrl: harness.baseUrl,
        start: postConsent.headers.get('location'),
        jar,
        redirectUriPrefix: REDIRECT_URI,
      });
      expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    });

  });
});
