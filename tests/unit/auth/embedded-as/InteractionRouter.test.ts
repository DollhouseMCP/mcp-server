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
});
