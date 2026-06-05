/**
 * InteractionRouter dispatch tests.
 *
 * Single-method deployments dispatch directly; multi-method deployments
 * render a chooser when no method is selected, persist the choice on
 * `?method=<id>`, and dispatch on subsequent requests.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  ADMIN_STEP_UP_CLAIMS_MODEL,
  createInteractionRouter,
  renderClientConsentForIdentity,
  type AdminStepUpInteractionDeps,
  type OidcProviderForInteractions,
  type OidcInteractionDetails,
} from '../../../../src/auth/embedded-as/InteractionRouter.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { InMemoryRateLimitStore } from '../../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import { InMemoryConsoleIdentityResolver } from '../../../../src/web-console/identity/InMemoryConsoleIdentityResolver.js';
import type {
  IAuthMethod,
  AuthenticatedIdentity,
  InteractionResult,
  InteractionStep,
} from '../../../../src/auth/embedded-as/IAuthMethod.js';
import type { AuthMethodId } from '../../../../src/auth/embedded-as/AuthMethodFactory.js';
import { securityHeaders } from '../../../../src/auth/embedded-as/securityHeaders.js';

const TRIVIAL_CONSENT_ID = 'trivial-consent';
const MAGIC_LINK_ID = 'magic-link';
const MAGIC_LINK_DISPLAY = 'Email magic link';
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

interface FakeMethodOptions {
  id: AuthMethodId;
  displayName: string;
  step?: InteractionStep;
  identity?: AuthenticatedIdentity;
}

function fakeMethod(opts: FakeMethodOptions): IAuthMethod {
  const step: InteractionStep = opts.step ?? {
    kind: 'render-html',
    html: `<form method="post"><button>OK from ${opts.id}</button></form>`,
    csrfToken: '',
  };
  return {
    id: opts.id,
    displayName: opts.displayName,
    async beginInteraction() { return step; },
    async completeInteraction(): Promise<InteractionResult> {
      return opts.identity
        ? { kind: 'authenticated', identity: opts.identity }
        : { kind: 'denied', reason: 'no identity in fake' };
    },
    async findAccount() { return null; },
  };
}

function clientConsentSeenTestKey(accountId: string, clientId: string): string {
  return `cc_${Buffer.from(JSON.stringify([accountId, clientId]), 'utf8').toString('base64url')}`;
}

interface FakeProviderOptions {
  details: OidcInteractionDetails;
  interactionFinished?: jest.MockedFunction<OidcProviderForInteractions['interactionFinished']>;
}

function fakeProvider(opts: FakeProviderOptions): OidcProviderForInteractions {
  class Grant {
    accountId?: string;
    clientId?: string;
    scopes: string[] = [];
    constructor(init: { accountId: string; clientId: string }) {
      this.accountId = init.accountId;
      this.clientId = init.clientId;
    }
    addOIDCScope(scope: string) { this.scopes.push(scope); }
    addResourceScope(_resource: string, scope: string) { this.scopes.push(scope); }
    async save() { return 'grant-for-test'; }
    static async find() { return undefined; }
  }

  return {
    async interactionDetails() { return opts.details; },
    interactionFinished: opts.interactionFinished ?? (async (_req, res) => {
      if (!res.headersSent) res.redirect(303, '/finished');
    }),
    Grant,
    Client: {
      async find() {
        return {
          clientId: 'c',
          clientName: 'Test Client',
          redirectUris: ['https://client.example.com/oauth/callback'],
          applicationType: 'web',
          scope: 'openid mcp',
          metadata() {
            return {
              client_id: 'c',
              client_name: 'Test Client',
              redirect_uris: ['https://client.example.com/oauth/callback'],
              application_type: 'web',
              scope: 'openid mcp',
            };
          },
        };
      },
    },
  };
}

interface HarnessResult {
  url: string;
  close: () => Promise<void>;
}

async function startHarness(
  methods: readonly IAuthMethod[],
  storage: InMemoryAuthStorageLayer,
  details: OidcInteractionDetails,
  adminStepUp?: AdminStepUpInteractionDeps,
  providerOverride?: OidcProviderForInteractions,
): Promise<HarnessResult> {
  const app = express();
  app.disable('x-powered-by');
  const router = createInteractionRouter({
    provider: providerOverride ?? fakeProvider({ details }),
    methods,
    storage,
    defaultResource: 'https://mcp.example.com/mcp',
    adminStepUp,
  });
  app.use('/interaction', router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('InteractionRouter — multi-method dispatch', () => {
  let storage: InMemoryAuthStorageLayer;
  const details: OidcInteractionDetails = {
    uid: 'i-test-uid',
    params: { client_id: 'c', scope: 'openid' },
    prompt: { name: 'login', details: {} },
  };

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
  });

  it('single-method deployment dispatches directly without a chooser', async () => {
    const method = fakeMethod({ id: TRIVIAL_CONSENT_ID, displayName: 'Trivial' });
    const h = await startHarness([method], storage, details);
    try {
      const res = await fetch(`${h.url}/interaction/${details.uid}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('OK from trivial-consent');
      expect(body).not.toContain('Choose how to sign in');
    } finally {
      await h.close();
    }
  });

  it('multi-method GET renders the chooser when no method selected', async () => {
    const methods = [
      fakeMethod({ id: 'github', displayName: 'GitHub' }),
      fakeMethod({ id: MAGIC_LINK_ID, displayName: MAGIC_LINK_DISPLAY }),
    ];
    const h = await startHarness(methods, storage, details);
    try {
      const res = await fetch(`${h.url}/interaction/${details.uid}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Choose how to sign in');
      expect(body).toContain('GitHub');
      expect(body).toContain(MAGIC_LINK_DISPLAY);
      expect(body).toContain(`/interaction/${details.uid}?method=github`);
      expect(body).toContain(`/interaction/${details.uid}?method=magic-link`);
    } finally {
      await h.close();
    }
  });

  it('multi-method ?method=<id> persists the choice and dispatches', async () => {
    const methods = [
      fakeMethod({ id: 'github', displayName: 'GitHub' }),
      fakeMethod({ id: MAGIC_LINK_ID, displayName: MAGIC_LINK_DISPLAY }),
    ];
    const h = await startHarness(methods, storage, details);
    try {
      const res = await fetch(`${h.url}/interaction/${details.uid}?method=magic-link`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('OK from magic-link');

      // Choice persisted: a subsequent GET without ?method= dispatches
      // to magic-link instead of rendering the chooser.
      const second = await fetch(`${h.url}/interaction/${details.uid}`);
      const secondBody = await second.text();
      expect(secondBody).toContain('OK from magic-link');
    } finally {
      await h.close();
    }
  });

  it('multi-method ?method=<unknown> falls through to the chooser', async () => {
    const methods = [
      fakeMethod({ id: 'github', displayName: 'GitHub' }),
      fakeMethod({ id: MAGIC_LINK_ID, displayName: MAGIC_LINK_DISPLAY }),
    ];
    const h = await startHarness(methods, storage, details);
    try {
      const res = await fetch(`${h.url}/interaction/${details.uid}?method=not-a-real-method`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Choose how to sign in');
    } finally {
      await h.close();
    }
  });

  it('POST without prior method choice returns invalid_interaction', async () => {
    const methods = [
      fakeMethod({ id: 'github', displayName: 'GitHub' }),
      fakeMethod({ id: MAGIC_LINK_ID, displayName: MAGIC_LINK_DISPLAY }),
    ];
    const h = await startHarness(methods, storage, details);
    try {
      const res = await fetch(`${h.url}/interaction/${details.uid}`, {
        method: 'POST',
        headers: { 'content-type': FORM_CONTENT_TYPE },
        body: '',
      });
      expect(res.status).toBe(400);
      const json = await res.json() as { error: string };
      expect(json.error).toBe('invalid_interaction');
    } finally {
      await h.close();
    }
  });

  it('authenticated method POST renders client consent before finishing interaction', async () => {
    const localDetails: OidcInteractionDetails = {
      uid: 'method-client-consent-uid',
      params: {
        client_id: 'c',
        scope: 'openid mcp',
        redirect_uri: 'https://client.example.com/oauth/callback',
        resource: 'https://mcp.example.com/mcp',
      },
      prompt: { name: 'login', details: {} },
    };
    const interactionFinished = jest.fn<OidcProviderForInteractions['interactionFinished']>(
      async (_req, res) => {
        if (!res.headersSent) res.redirect(303, '/finished');
      },
    );
    const provider = fakeProvider({ details: localDetails, interactionFinished });
    const method = fakeMethod({
      id: TRIVIAL_CONSENT_ID,
      displayName: 'Trivial',
      identity: {
        sub: 'local_alice',
        displayName: 'Alice Example',
        email: 'alice@example.com',
        emailVerified: true,
      },
    });
    const h = await startHarness([method], storage, localDetails, undefined, provider);
    try {
      const getRes = await fetch(`${h.url}/interaction/${localDetails.uid}`);
      const getBody = await getRes.text();
      const initialCsrf = /name="csrf_token"\s+value="([^"]+)"/.exec(getBody)?.[1];
      expect(initialCsrf).toBeTruthy();

      const consent = await fetch(`${h.url}/interaction/${localDetails.uid}`, {
        method: 'POST',
        headers: { 'content-type': FORM_CONTENT_TYPE },
        body: new URLSearchParams({ csrf_token: initialCsrf ?? '', action: 'approve' }),
      });

      expect(consent.status).toBe(200);
      const consentHtml = await consent.text();
      expect(consentHtml).toContain('Authorize Test Client');
      expect(consentHtml).toContain('Signed in with Trivial consent');
      expect(consentHtml).toContain('Alice Example');
      expect(consentHtml).toContain('alice@example.com');
      expect(interactionFinished).not.toHaveBeenCalled();

      const consentCsrf = /name="csrf_token"\s+value="([^"]+)"/.exec(consentHtml)?.[1];
      expect(consentCsrf).toBeTruthy();
      const approve = await fetch(`${h.url}/interaction/${localDetails.uid}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': FORM_CONTENT_TYPE },
        body: new URLSearchParams({
          csrf_token: consentCsrf ?? '',
          action: 'authorize_oauth_client',
        }),
      });

      expect(approve.status).toBe(303);
      expect(interactionFinished).toHaveBeenCalledTimes(1);
      expect(interactionFinished.mock.calls[0][2]).toMatchObject({
        login: { accountId: 'local_alice' },
        consent: { grantId: 'grant-for-test' },
      });
    } finally {
      await h.close();
    }
  });

  it('chooser HTML escapes method displayName', async () => {
    const methods = [
      fakeMethod({ id: 'github', displayName: '<script>alert(1)</script>' }),
      fakeMethod({ id: MAGIC_LINK_ID, displayName: 'Magic & Link' }),
    ];
    const h = await startHarness(methods, storage, details);
    try {
      const res = await fetch(`${h.url}/interaction/${details.uid}`);
      const body = await res.text();
      expect(body).not.toContain('<script>alert(1)</script>');
      expect(body).toContain('&lt;script&gt;');
      expect(body).toContain('Magic &amp; Link');
    } finally {
      await h.close();
    }
  });

  it('client-consent approval finishes a pending callback identity', async () => {
    const localDetails: OidcInteractionDetails = {
      uid: 'client-consent-uid',
      params: {
        client_id: 'c',
        scope: 'openid mcp',
        redirect_uri: 'https://client.example.com/oauth/callback',
        resource: 'https://mcp.example.com/mcp',
      },
      prompt: { name: 'login', details: {} },
    };
    const interactionFinished = jest.fn<OidcProviderForInteractions['interactionFinished']>(
      async (_req, res) => {
        if (!res.headersSent) res.redirect(303, '/finished');
      },
    );
    const provider = fakeProvider({ details: localDetails, interactionFinished });
    const method = fakeMethod({ id: 'github', displayName: 'GitHub' });

    const app = express();
    app.disable('x-powered-by');
    app.use(securityHeaders());
    app.get('/seed-consent', (_req, res, next) => {
      renderClientConsentForIdentity(
        res,
        provider,
        localDetails,
        'github_42',
        storage,
        'https://mcp.example.com/mcp',
        {
          sub: 'github_42',
          displayName: 'Mick Darling',
          email: 'mick@example.com',
          provider: 'github',
          providerUsername: 'mickdarling',
        },
      ).catch(next);
    });
    app.use('/interaction', createInteractionRouter({
      provider,
      methods: [method],
      storage,
      defaultResource: 'https://mcp.example.com/mcp',
    }));
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const consent = await fetch(`${baseUrl}/seed-consent`);
      expect(consent.status).toBe(200);
      expect(consent.headers.get('content-security-policy')).toContain("form-action 'self' https://client.example.com");
      const html = await consent.text();
      expect(html).toContain('Authorize Test Client');
      expect(html).toContain('DollhouseMCP Authorization');
      expect(html).toContain('OAuth client authorization');
      expect(html).toContain('client.example.com');
      expect(html).toContain('openid');
      expect(html).toContain('mcp');
      expect(html).toContain('Use DollhouseMCP tools');
      expect(html).toContain('https://mcp.example.com/mcp');
      expect(html).toContain('Signed in with GitHub');
      expect(html).toContain('@mickdarling');
      expect(html).toContain('mick@example.com');
      expect(html).toContain('New client for this account');
      expect(html).toContain('DollhouseMCP will issue OAuth tokens');
      expect(interactionFinished).not.toHaveBeenCalled();

      const csrfMatch = /name="csrf_token"\s+value="([^"]+)"/.exec(html);
      expect(csrfMatch).not.toBeNull();
      const approve = await fetch(`${baseUrl}/interaction/${localDetails.uid}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': FORM_CONTENT_TYPE },
        body: new URLSearchParams({
          csrf_token: csrfMatch![1],
          action: 'authorize_oauth_client',
        }),
      });
      expect(approve.status).toBe(303);
      expect(interactionFinished).toHaveBeenCalledTimes(1);
      expect(interactionFinished.mock.calls[0][2]).toMatchObject({
        login: { accountId: 'github_42' },
        consent: { grantId: 'grant-for-test' },
      });

      const events = await storage.listIdentityEvents({ type: 'auth.client_consent.approved' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        sub: 'github_42',
        details: {
          clientId: 'c',
          clientFirstSeenForIdentity: true,
          callbackHost: 'client.example.com',
          resource: 'https://mcp.example.com/mcp',
          scopes: ['openid', 'mcp'],
        },
      });
      const seen = await storage.genericGet('ClientConsentSeen', clientConsentSeenTestKey('github_42', 'c'));
      expect(seen).toMatchObject({
        accountId: 'github_42',
        clientId: 'c',
      });

      const secondConsent = await fetch(`${baseUrl}/seed-consent`);
      const secondHtml = await secondConsent.text();
      expect(secondHtml).toContain('Previously authorized by this account');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('client-consent denial records an audit event and aborts authorization', async () => {
    const localDetails: OidcInteractionDetails = {
      uid: 'client-consent-deny-uid',
      params: {
        client_id: 'c',
        scope: 'openid mcp',
        redirect_uri: 'https://client.example.com/oauth/callback',
        resource: 'https://mcp.example.com/mcp',
      },
      prompt: { name: 'login', details: {} },
    };
    const interactionFinished = jest.fn<OidcProviderForInteractions['interactionFinished']>(
      async (_req, res) => {
        if (!res.headersSent) res.status(200).end('denied');
      },
    );
    const provider = fakeProvider({ details: localDetails, interactionFinished });
    const method = fakeMethod({ id: 'github', displayName: 'GitHub' });
    const app = express();
    app.disable('x-powered-by');
    app.get('/seed-consent', (_req, res, next) => {
      renderClientConsentForIdentity(
        res,
        provider,
        localDetails,
        'github_42',
        storage,
        'https://mcp.example.com/mcp',
        { sub: 'github_42', provider: 'github', providerUsername: 'mickdarling' },
      ).catch(next);
    });
    app.use('/interaction', createInteractionRouter({
      provider,
      methods: [method],
      storage,
      defaultResource: 'https://mcp.example.com/mcp',
    }));
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const consent = await fetch(`${baseUrl}/seed-consent`);
      const html = await consent.text();
      const csrfMatch = /name="csrf_token"\s+value="([^"]+)"/.exec(html);
      expect(csrfMatch).not.toBeNull();

      const deny = await fetch(`${baseUrl}/interaction/${localDetails.uid}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': FORM_CONTENT_TYPE },
        body: new URLSearchParams({
          csrf_token: csrfMatch![1],
          action: 'deny_oauth_client',
        }),
      });

      expect(deny.status).toBe(200);
      expect(interactionFinished).toHaveBeenCalledTimes(1);
      expect(interactionFinished.mock.calls[0][2]).toMatchObject({
        error: 'access_denied',
      });
      const events = await storage.listIdentityEvents({ type: 'auth.client_consent.denied' });
      expect(events).toHaveLength(1);
      expect(events[0].sub).toBe('github_42');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe('H8: throws in method calls become structured 500', () => {
    it('beginInteraction throw yields 500 server_error (no hung request)', async () => {
      const throwing: IAuthMethod = {
        id: TRIVIAL_CONSENT_ID,
        displayName: 'Trivial',
        async beginInteraction() { throw new Error('method blew up'); },
        async completeInteraction() { return { kind: 'denied', reason: 'never' }; },
        async findAccount() { return null; },
      };
      const h = await startHarness([throwing], storage, details);
      try {
        const res = await fetch(`${h.url}/interaction/${details.uid}`);
        expect(res.status).toBe(500);
        const body = await res.json() as { error: string };
        expect(body.error).toBe('server_error');
      } finally {
        await h.close();
      }
    });

    it('completeInteraction throw yields 500 server_error', async () => {
      const throwing: IAuthMethod = {
        id: TRIVIAL_CONSENT_ID,
        displayName: 'Trivial',
        async beginInteraction(): Promise<InteractionStep> {
          return { kind: 'render-html', html: '<form method="post"></form>', csrfToken: '' };
        },
        async completeInteraction() { throw new Error('completion blew up'); },
        async findAccount() { return null; },
      };
      const h = await startHarness([throwing], storage, details);
      try {
        // GET to render-html (stamps CSRF).
        const getRes = await fetch(`${h.url}/interaction/${details.uid}`);
        const getBody = await getRes.text();
        const csrfMatch = /name="csrf_token"\s+value="([^"]+)"/.exec(getBody);
        const csrfToken = csrfMatch![1];
        // POST with valid CSRF — completeInteraction throws.
        const postRes = await fetch(`${h.url}/interaction/${details.uid}`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: new URLSearchParams({ csrf_token: csrfToken }),
        });
        expect(postRes.status).toBe(500);
        const body = await postRes.json() as { error: string };
        expect(body.error).toBe('server_error');
      } finally {
        await h.close();
      }
    });
  });

  describe('administrative ACR TOTP step-up', () => {
    const adminDetails: OidcInteractionDetails = {
      uid: 'admin-step-up-uid',
      params: {
        client_id: 'console',
        scope: 'openid',
        acr_values: 'urn:dollhouse:acr:admin-stepup',
      },
      prompt: { name: 'login', details: {} },
    };

    function adminDeps(overrides: {
      hasFactor?: boolean;
      proofOk?: boolean;
      proofMethod?: 'totp' | 'backup';
      rateLimitStore?: InMemoryRateLimitStore;
    } = {}): AdminStepUpInteractionDeps {
      const totpService = {
        hasActiveFactor: async () => overrides.hasFactor ?? true,
        prove: async () => (overrides.proofOk ?? true)
          ? { ok: true as const, method: overrides.proofMethod ?? 'totp', authTime: new Date('2026-05-27T12:00:00.000Z') }
          : { ok: false as const },
      } satisfies AdminStepUpInteractionDeps['totpService'];
      return {
        totpService,
        identityResolver: new InMemoryConsoleIdentityResolver([{
          sub: 'local_admin',
          userId: '018f3d47-73ae-7f10-a0de-0742618d4fb1',
          disabledAt: null,
          authzVersion: 1,
        }]),
        rateLimitStore: overrides.rateLimitStore,
      };
    }

    it('fails requested admin ACR when the principal has no active TOTP factor', async () => {
      const method = fakeMethod({
        id: TRIVIAL_CONSENT_ID,
        displayName: 'Trivial',
        identity: { sub: 'local_admin', emailVerified: true },
      });
      const h = await startHarness([method], storage, adminDetails, adminDeps({ hasFactor: false }));
      try {
        const getRes = await fetch(`${h.url}/interaction/${adminDetails.uid}`);
        const csrfToken = /name="csrf_token"\s+value="([^"]+)"/.exec(await getRes.text())![1];
        const postRes = await fetch(`${h.url}/interaction/${adminDetails.uid}`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: new URLSearchParams({ csrf_token: csrfToken }),
        });

        expect(postRes.status).toBe(400);
        const body = await postRes.json() as { error: string };
        expect(body.error).toBe('access_denied');
      } finally {
        await h.close();
      }
    });

    it('requires TOTP proof and stores AS-issued admin ACR claims for token issuance', async () => {
      const method = fakeMethod({
        id: TRIVIAL_CONSENT_ID,
        displayName: 'Trivial',
        identity: { sub: 'local_admin', emailVerified: true },
      });
      const h = await startHarness([method], storage, adminDetails, adminDeps());
      try {
        const getRes = await fetch(`${h.url}/interaction/${adminDetails.uid}`);
        const firstCsrf = /name="csrf_token"\s+value="([^"]+)"/.exec(await getRes.text())![1];
        const primaryPost = await fetch(`${h.url}/interaction/${adminDetails.uid}`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: new URLSearchParams({ csrf_token: firstCsrf }),
        });
        const proofPage = await primaryPost.text();
        expect(proofPage).toContain('Administrative verification');
        const proofCsrf = /name="csrf_token"\s+value="([^"]+)"/.exec(proofPage)![1];

        const proofPost = await fetch(`${h.url}/interaction/${adminDetails.uid}`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: new URLSearchParams({ csrf_token: proofCsrf, code: '123456' }),
          redirect: 'manual',
        });

        expect(proofPost.status).toBe(303);
        await expect(storage.genericGet(ADMIN_STEP_UP_CLAIMS_MODEL, 'grant-for-test'))
          .resolves.toEqual({
            accountId: 'local_admin',
            acr: 'urn:dollhouse:acr:admin-stepup',
            amr: ['otp'],
            authTime: 1779883200,
          });
      } finally {
        await h.close();
      }
    });

    it('re-renders the proof step after failed proof without issuing admin claims', async () => {
      const method = fakeMethod({
        id: TRIVIAL_CONSENT_ID,
        displayName: 'Trivial',
        identity: { sub: 'local_admin', emailVerified: true },
      });
      const h = await startHarness([method], storage, adminDetails, adminDeps({ proofOk: false }));
      try {
        const getRes = await fetch(`${h.url}/interaction/${adminDetails.uid}`);
        const firstCsrf = /name="csrf_token"\s+value="([^"]+)"/.exec(await getRes.text())![1];
        const primaryPost = await fetch(`${h.url}/interaction/${adminDetails.uid}`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: new URLSearchParams({ csrf_token: firstCsrf }),
        });
        const proofCsrf = /name="csrf_token"\s+value="([^"]+)"/.exec(await primaryPost.text())![1];

        const failedProof = await fetch(`${h.url}/interaction/${adminDetails.uid}`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: new URLSearchParams({ csrf_token: proofCsrf, code: '000000' }),
        });

        expect(failedProof.status).toBe(200);
        expect(await failedProof.text()).toContain('Invalid authentication code.');
        await expect(storage.genericGet(ADMIN_STEP_UP_CLAIMS_MODEL, 'grant-for-test')).resolves.toBeNull();
      } finally {
        await h.close();
      }
    });

    it('locks out administrative proof after repeated failures', async () => {
      const method = fakeMethod({
        id: TRIVIAL_CONSENT_ID,
        displayName: 'Trivial',
        identity: { sub: 'local_admin', emailVerified: true },
      });
      const h = await startHarness([method], storage, adminDetails, adminDeps({
        proofOk: false,
        rateLimitStore: new InMemoryRateLimitStore(),
      }));
      try {
        const getRes = await fetch(`${h.url}/interaction/${adminDetails.uid}`);
        let csrf = /name="csrf_token"\s+value="([^"]+)"/.exec(await getRes.text())![1];
        const primaryPost = await fetch(`${h.url}/interaction/${adminDetails.uid}`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: new URLSearchParams({ csrf_token: csrf }),
        });
        csrf = /name="csrf_token"\s+value="([^"]+)"/.exec(await primaryPost.text())![1];

        for (let attempt = 0; attempt < 5; attempt += 1) {
          const failed = await fetch(`${h.url}/interaction/${adminDetails.uid}`, {
            method: 'POST',
            headers: { 'content-type': FORM_CONTENT_TYPE },
            body: new URLSearchParams({ csrf_token: csrf, code: '000000' }),
          });
          const body = await failed.text();
          csrf = /name="csrf_token"\s+value="([^"]+)"/.exec(body)?.[1] ?? csrf;
        }

        const locked = await fetch(`${h.url}/interaction/${adminDetails.uid}`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: new URLSearchParams({ csrf_token: csrf, code: '000000' }),
        });

        expect(locked.status).toBe(429);
        await expect(storage.genericGet(ADMIN_STEP_UP_CLAIMS_MODEL, 'grant-for-test')).resolves.toBeNull();
      } finally {
        await h.close();
      }
    });

    it('accepts backup-code proof and records admin claims', async () => {
      const method = fakeMethod({
        id: TRIVIAL_CONSENT_ID,
        displayName: 'Trivial',
        identity: { sub: 'local_admin', emailVerified: true },
      });
      const h = await startHarness([method], storage, adminDetails, adminDeps({ proofMethod: 'backup' }));
      try {
        const getRes = await fetch(`${h.url}/interaction/${adminDetails.uid}`);
        const firstCsrf = /name="csrf_token"\s+value="([^"]+)"/.exec(await getRes.text())![1];
        const primaryPost = await fetch(`${h.url}/interaction/${adminDetails.uid}`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: new URLSearchParams({ csrf_token: firstCsrf }),
        });
        const proofCsrf = /name="csrf_token"\s+value="([^"]+)"/.exec(await primaryPost.text())![1];

        const proofPost = await fetch(`${h.url}/interaction/${adminDetails.uid}`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: new URLSearchParams({ csrf_token: proofCsrf, code: 'BACKUP' }),
          redirect: 'manual',
        });

        expect(proofPost.status).toBe(303);
        await expect(storage.listIdentityEvents({ type: 'auth.admin_step_up.backup_code_consumed' }))
          .resolves.toHaveLength(1);
      } finally {
        await h.close();
      }
    });

    it('does not issue admin claims when acr_values does not request admin step-up', async () => {
      const method = fakeMethod({
        id: TRIVIAL_CONSENT_ID,
        displayName: 'Trivial',
        identity: { sub: 'local_admin', emailVerified: true },
      });
      const normalDetails = { ...adminDetails, params: { client_id: 'console', scope: 'openid', acr_values: 'urn:other' } };
      const h = await startHarness([method], storage, normalDetails, adminDeps());
      try {
        const getRes = await fetch(`${h.url}/interaction/${normalDetails.uid}`);
        const csrf = /name="csrf_token"\s+value="([^"]+)"/.exec(await getRes.text())![1];
        const post = await fetch(`${h.url}/interaction/${normalDetails.uid}`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: new URLSearchParams({ csrf_token: csrf }),
          redirect: 'manual',
        });

        // Non-admin logins go through client consent rather than finishing
        // directly; approving consent completes the interaction with no admin claims.
        expect(post.status).toBe(200);
        const consentCsrf = /name="csrf_token"\s+value="([^"]+)"/.exec(await post.text())![1];
        const approve = await fetch(`${h.url}/interaction/${normalDetails.uid}`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: new URLSearchParams({ csrf_token: consentCsrf, action: 'authorize_oauth_client' }),
          redirect: 'manual',
        });

        expect(approve.status).toBe(303);
        await expect(storage.genericGet(ADMIN_STEP_UP_CLAIMS_MODEL, 'grant-for-test')).resolves.toBeNull();
      } finally {
        await h.close();
      }
    });
  });

  describe('H13: CSRF required on every POST (no missing-record bypass)', () => {
    it('POST without prior render-html GET (no CSRF record) returns 403', async () => {
      const method = fakeMethod({ id: TRIVIAL_CONSENT_ID, displayName: 'Trivial' });
      const h = await startHarness([method], storage, details);
      try {
        // POST without ever GETting the render-html step.
        const res = await fetch(`${h.url}/interaction/${details.uid}`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: 'action=approve',
        });
        expect(res.status).toBe(403);
        const body = await res.json() as { error: string };
        expect(body.error).toBe('invalid_csrf');
      } finally {
        await h.close();
      }
    });

    it('replay (back-button) after consumed CSRF returns 403, not silent bypass', async () => {
      const method = fakeMethod({
        id: TRIVIAL_CONSENT_ID, displayName: 'Trivial',
        identity: { sub: 'local_alice', emailVerified: false },
      });
      const h = await startHarness([method], storage, details);
      try {
        // GET → render-html stamps CSRF.
        const getRes = await fetch(`${h.url}/interaction/${details.uid}`);
        const getBody = await getRes.text();
        const csrfMatch = /name="csrf_token"\s+value="([^"]+)"/.exec(getBody);
        const csrfToken = csrfMatch![1];
        // First POST consumes the CSRF. May 200/302/303 on success or
        // 500 if interactionFinished mock doesn't drive a real redirect;
        // either way it MUST NOT be 403 (CSRF was accepted).
        const firstPost = await fetch(`${h.url}/interaction/${details.uid}`, {
          method: 'POST', redirect: 'manual',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: new URLSearchParams({ csrf_token: csrfToken, action: 'approve' }),
        });
        expect(firstPost.status).not.toBe(403);
        // Second POST replays the same token (back-button); record is gone.
        const replayPost = await fetch(`${h.url}/interaction/${details.uid}`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: new URLSearchParams({ csrf_token: csrfToken, action: 'approve' }),
        });
        expect(replayPost.status).toBe(403);
        const body = await replayPost.json() as { error: string };
        expect(body.error).toBe('invalid_csrf');
      } finally {
        await h.close();
      }
    });

    it('POST with mismatched CSRF token returns 403', async () => {
      const method = fakeMethod({ id: TRIVIAL_CONSENT_ID, displayName: 'Trivial' });
      const h = await startHarness([method], storage, details);
      try {
        await fetch(`${h.url}/interaction/${details.uid}`); // GET to stamp CSRF
        const res = await fetch(`${h.url}/interaction/${details.uid}`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: new URLSearchParams({ csrf_token: 'totally-wrong-token' }),
        });
        expect(res.status).toBe(403);
      } finally {
        await h.close();
      }
    });

    // Cycle-13 HIGH regression: InteractionRouter body parsers now
    // cap at 4kb. A revert to the express default 100kb (or removal
    // of the limit option) would let a 50kb body POST through to the
    // route handler — the cycle-13 fix existed without a test until
    // now.
    it('cycle-13: urlencoded body > 4kb is rejected with 413', async () => {
      const localStorage = new InMemoryAuthStorageLayer();
      const method = fakeMethod({ id: TRIVIAL_CONSENT_ID, displayName: 'Test' });
      const h = await startHarness([method], localStorage, {
        uid: 'body-limit-test-uid',
        prompt: { name: 'login' },
        params: { client_id: 'c', scope: 'mcp' },
      });
      try {
        // Build a urlencoded body comfortably over 4kb — pad a single
        // field with 5kb of 'a'.
        const oversized = new URLSearchParams({
          csrf_token: 'doesnt-matter',
          padding: 'a'.repeat(5_120),
        });
        const res = await fetch(`${h.url}/interaction/body-limit-test-uid`, {
          method: 'POST',
          headers: { 'content-type': FORM_CONTENT_TYPE },
          body: oversized.toString(),
        });
        expect(res.status).toBe(413);
      } finally {
        await h.close();
      }
    });

    // Cycle-10 HIGH regression: methods that render multiple <form>
    // elements on the same page (LocalAccountMethod renders two — one
    // for sign-in, one for invite redemption) used to get the CSRF
    // token injected into ONLY the first form. The second form's
    // POST was rejected with 403 because no csrf_token field. Pin
    // the fix: ensureCsrfInForm runs on every form on the page.
    it('multi-form pages: CSRF token is injected into EVERY <form>, not just the first', async () => {
      const localStorage = new InMemoryAuthStorageLayer();
      const localDetails: OidcInteractionDetails = {
        uid: 'multi-form-uid',
        prompt: { name: 'login' },
        params: { client_id: 'c', scope: 'mcp' },
      };
      // Method that renders two forms — the bug case.
      const multiFormMethod: IAuthMethod = {
        id: 'local-password',
        displayName: 'Sign in or set password',
        async beginInteraction() {
          return {
            kind: 'render-html',
            html: `
              <form method="post" id="login">
                <button name="action" value="login">Sign in</button>
              </form>
              <form method="post" id="invite">
                <button name="action" value="set-password">Redeem invite</button>
              </form>
            `,
            csrfToken: '',
          } satisfies InteractionStep;
        },
        async completeInteraction(): Promise<InteractionResult> {
          return { kind: 'denied', reason: 'not exercised' };
        },
        async findAccount() { return null; },
      };
      const h = await startHarness([multiFormMethod], localStorage, localDetails);
      try {
        const getRes = await fetch(`${h.url}/interaction/multi-form-uid`);
        expect(getRes.status).toBe(200);
        const getBody = await getRes.text();
        // Count csrf_token inputs — must be 2, one per <form>.
        const csrfInputCount = (getBody.match(/name="csrf_token"/g) ?? []).length;
        expect(csrfInputCount).toBe(2);
        // Both must have the SAME value (single per-render token).
        const csrfMatches = [...getBody.matchAll(/name="csrf_token"\s+value="([^"]+)"/g)];
        expect(csrfMatches).toHaveLength(2);
        expect(csrfMatches[0][1]).toBe(csrfMatches[1][1]);
      } finally {
        await h.close();
      }
    });
  });
});
