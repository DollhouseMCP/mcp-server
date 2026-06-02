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
  createInteractionRouter,
  renderClientConsentForIdentity,
  type OidcProviderForInteractions,
  type OidcInteractionDetails,
} from '../../../../src/auth/embedded-as/InteractionRouter.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import type {
  IAuthMethod,
  AuthenticatedIdentity,
  InteractionResult,
  InteractionStep,
} from '../../../../src/auth/embedded-as/IAuthMethod.js';
import type { AuthMethodId } from '../../../../src/auth/embedded-as/AuthMethodFactory.js';

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

interface FakeProviderOptions {
  details: OidcInteractionDetails;
  interactionFinished?: jest.MockedFunction<OidcProviderForInteractions['interactionFinished']>;
}

function fakeProvider(opts: FakeProviderOptions): OidcProviderForInteractions {
  class FakeGrant {
    addOIDCScope(): void { /* no-op */ }
    addResourceScope(): void { /* no-op */ }
    async save(): Promise<string> { return 'fake-grant-id'; }
    static async find(): Promise<undefined> { return undefined; }
  }

  return {
    async interactionDetails() { return opts.details; },
    interactionFinished: opts.interactionFinished ?? (async (_req, res) => {
      if (!res.headersSent) res.redirect(303, '/finished');
    }),
    Grant: FakeGrant as unknown as OidcProviderForInteractions['Grant'],
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
  providerOverride?: OidcProviderForInteractions,
): Promise<HarnessResult> {
  const app = express();
  app.disable('x-powered-by');
  const router = createInteractionRouter({
    provider: providerOverride ?? fakeProvider({ details }),
    methods,
    storage,
    defaultResource: 'https://mcp.example.com/mcp',
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
      const html = await consent.text();
      expect(html).toContain('Authorize Test Client');
      expect(html).toContain('client.example.com');
      expect(html).toContain('openid');
      expect(html).toContain('mcp');
      expect(html).toContain('https://mcp.example.com/mcp');
      expect(html).toContain('@mickdarling');
      expect(html).toContain('mick@example.com');
      expect(html).toContain('First time this identity is authorizing this client');
      expect(html).toContain('This client will receive OAuth tokens');
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
        consent: { grantId: 'fake-grant-id' },
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

      const secondConsent = await fetch(`${baseUrl}/seed-consent`);
      const secondHtml = await secondConsent.text();
      expect(secondHtml).toContain('Previously authorized by this identity');
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
