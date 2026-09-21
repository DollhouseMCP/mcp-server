import { afterEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { ContributeRoutesDeps } from '../../../../../src/auth/embedded-as/IAuthMethod.js';
import { GithubSocialMethod } from '../../../../../src/auth/embedded-as/methods/GithubSocialMethod.js';
import { InMemoryAuthStorageLayer } from '../../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { logger } from '../../../../../src/utils/logger.js';

const secrets = ['private-code', 'private-state', 'private-provider-token', 'private-client-secret'];
const callback = `/auth/social/github/callback?code=${secrets[0]}&state=${secrets[1]}`;
const error = () => new Error(secrets.join(' '), { cause: new Error('private-cause') });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
afterEach(() => jest.restoreAllMocks());

function fixture(emailFailure = false) {
  const storage = new InMemoryAuthStorageLayer();
  const fetchImpl = jest.fn<typeof fetch>().mockImplementation(async input => {
    const url = String(input);
    if (url.endsWith('/access_token')) return json({ access_token: secrets[2] });
    if (url.endsWith('/user/emails')) {
      if (emailFailure) throw error();
      return json([{ email: 'verified@example.com', verified: true, primary: true }]);
    }
    return json({ id: 42, login: 'octocat', name: 'Octocat' });
  });
  const method = new GithubSocialMethod({ storage, clientId: 'test-client', clientSecret: secrets[3],
    callbackUrl: 'https://example.com/auth/social/github/callback', fetchImpl });
  return { storage, fetchImpl, method };
}

function assertPrivate(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const secret of [...secrets, 'private-cause', callback]) expect(serialized).not.toContain(secret);
}

describe('ordinary GitHub callback credential redaction', () => {
  it.each(['application/json', 'text/html'])('sanitizes initialization failures for %s', async accept => {
    const { storage, method, fetchImpl } = fixture();
    const logged = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const app = express(); const router = express.Router();
    method.contributeRoutes(router, { storage, ensureInitialized: async () => { throw error(); } });
    app.use(router);
    const downstream = jest.fn();
    app.use((failure: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      downstream(failure); res.status(500).end();
    });
    const response = await request(app).get(callback).set('Accept', accept);
    expect(response.status).toBe(503);
    expect(response.text).toContain('github_callback_failed');
    expect(logged).toHaveBeenCalledWith('[GithubSocialMethod] callback unavailable', { category: 'callback_unavailable' });
    expect(downstream).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
    assertPrivate([response.text, logged.mock.calls]);
  });

  it('aborts an already-started response without forwarding the credential-bearing exception', async () => {
    const { storage, method, fetchImpl } = fixture();
    const logged = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const key = 'test-cookie-signing-key';
    // Fixed Keygrip fixture: _interaction=private-state under test-cookie-signing-key.
    // Real verification below must pass before the three provider calls and late failure.
    const sig = 'L1NnG9ncVXl7lII8E6UR7DZi3oc';
    const provider = { interactionDetails: async (_req: express.Request, res: express.Response) => {
      res.write('safe prefix'); throw error();
    } } as unknown as Awaited<ReturnType<ContributeRoutesDeps['ensureInitialized']>>['provider'];
    const app = express(); const router = express.Router();
    method.contributeRoutes(router, { storage, ensureInitialized: async () => ({ provider, cookieKeys: [key] }) });
    app.use(router);
    const downstream = jest.fn();
    app.use((failure: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      downstream(failure); res.status(500).end();
    });
    await expect(request(app).get(callback).set('Cookie', `_interaction=${secrets[1]}; _interaction.sig=${sig}`))
      .rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(downstream).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(logged).toHaveBeenCalledTimes(1); assertPrivate(logged.mock.calls);
  });

  it('logs only a fixed category for an email-provider transport exception', async () => {
    const { method, fetchImpl } = fixture(true);
    const logged = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const result = await method.processCallback({ code: secrets[0], state: secrets[1] });
    expect(result).toEqual({ kind: 'error', reason: 'github emails fetch failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(logged).toHaveBeenCalledWith('[GithubSocialMethod] email lookup unavailable', { category: 'github_emails_unavailable' });
    assertPrivate([result, logged.mock.calls]);
  });
});
