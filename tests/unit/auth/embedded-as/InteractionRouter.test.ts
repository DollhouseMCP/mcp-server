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
import { createInteractionRouter, type OidcProviderForInteractions, type OidcInteractionDetails } from '../../../../src/auth/embedded-as/InteractionRouter.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import type {
  IAuthMethod,
  AuthenticatedIdentity,
  InteractionResult,
  InteractionStep,
} from '../../../../src/auth/embedded-as/IAuthMethod.js';
import type { AuthMethodId } from '../../../../src/auth/embedded-as/AuthMethodFactory.js';

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
}

function fakeProvider(opts: FakeProviderOptions): OidcProviderForInteractions {
  return {
    async interactionDetails() { return opts.details; },
    async interactionFinished() { /* no-op for these dispatch tests */ },
    Grant: jest.fn() as unknown as OidcProviderForInteractions['Grant'],
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
): Promise<HarnessResult> {
  const app = express();
  const router = createInteractionRouter({
    provider: fakeProvider({ details }),
    methods,
    storage,
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
    const method = fakeMethod({ id: 'trivial-consent', displayName: 'Trivial' });
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
      fakeMethod({ id: 'magic-link', displayName: 'Email magic link' }),
    ];
    const h = await startHarness(methods, storage, details);
    try {
      const res = await fetch(`${h.url}/interaction/${details.uid}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Choose how to sign in');
      expect(body).toContain('GitHub');
      expect(body).toContain('Email magic link');
      expect(body).toContain(`/interaction/${details.uid}?method=github`);
      expect(body).toContain(`/interaction/${details.uid}?method=magic-link`);
    } finally {
      await h.close();
    }
  });

  it('multi-method ?method=<id> persists the choice and dispatches', async () => {
    const methods = [
      fakeMethod({ id: 'github', displayName: 'GitHub' }),
      fakeMethod({ id: 'magic-link', displayName: 'Email magic link' }),
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
      fakeMethod({ id: 'magic-link', displayName: 'Email magic link' }),
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
      fakeMethod({ id: 'magic-link', displayName: 'Email magic link' }),
    ];
    const h = await startHarness(methods, storage, details);
    try {
      const res = await fetch(`${h.url}/interaction/${details.uid}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
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
      fakeMethod({ id: 'magic-link', displayName: 'Magic & Link' }),
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

  describe('H8: throws in method calls become structured 500', () => {
    it('beginInteraction throw yields 500 server_error (no hung request)', async () => {
      const throwing: IAuthMethod = {
        id: 'trivial-consent',
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
        id: 'trivial-consent',
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
        const csrfMatch = getBody.match(/name="csrf_token"\s+value="([^"]+)"/);
        const csrfToken = csrfMatch![1]!;
        // POST with valid CSRF — completeInteraction throws.
        const postRes = await fetch(`${h.url}/interaction/${details.uid}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
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
      const method = fakeMethod({ id: 'trivial-consent', displayName: 'Trivial' });
      const h = await startHarness([method], storage, details);
      try {
        // POST without ever GETting the render-html step.
        const res = await fetch(`${h.url}/interaction/${details.uid}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
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
        id: 'trivial-consent', displayName: 'Trivial',
        identity: { sub: 'local_alice', emailVerified: false },
      });
      const h = await startHarness([method], storage, details);
      try {
        // GET → render-html stamps CSRF.
        const getRes = await fetch(`${h.url}/interaction/${details.uid}`);
        const getBody = await getRes.text();
        const csrfMatch = getBody.match(/name="csrf_token"\s+value="([^"]+)"/);
        const csrfToken = csrfMatch![1]!;
        // First POST consumes the CSRF. May 200/302/303 on success or
        // 500 if interactionFinished mock doesn't drive a real redirect;
        // either way it MUST NOT be 403 (CSRF was accepted).
        const firstPost = await fetch(`${h.url}/interaction/${details.uid}`, {
          method: 'POST', redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf_token: csrfToken, action: 'approve' }),
        });
        expect(firstPost.status).not.toBe(403);
        // Second POST replays the same token (back-button); record is gone.
        const replayPost = await fetch(`${h.url}/interaction/${details.uid}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
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
      const method = fakeMethod({ id: 'trivial-consent', displayName: 'Trivial' });
      const h = await startHarness([method], storage, details);
      try {
        await fetch(`${h.url}/interaction/${details.uid}`); // GET to stamp CSRF
        const res = await fetch(`${h.url}/interaction/${details.uid}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf_token: 'totally-wrong-token' }),
        });
        expect(res.status).toBe(403);
      } finally {
        await h.close();
      }
    });
  });
});
