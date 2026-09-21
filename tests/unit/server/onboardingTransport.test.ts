import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createStreamableHttpApp } from '../../../src/server/createStreamableHttpApp.js';
import { createStreamableHttpRuntime } from '../../../src/server/StreamableHttpServer.js';
import { createOnboardingRouter, type OnboardingRouterOptions } from '../../../src/invitations/onboarding/OnboardingRouter.js';
import { OnboardingCredentials } from '../../../src/invitations/onboarding/OnboardingCredentials.js';
import { HmacConsoleOpaqueValueService } from '../../../src/web-console/security/ConsoleOpaqueValues.js';
import { InMemoryRateLimitStore } from '../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';

const origin = 'https://console.example.test';
function fixture(allowedHosts?: string[], host = '127.0.0.1') {
  const now = new Date();
  const store = {
    createOwner: jest.fn<OnboardingRouterOptions['store']['createOwner']>(async (ownerHash, csrfTokenHash) => ({
      ownerHash, csrfTokenHash, createdAt: now, refreshedAt: now, expiresAt: new Date(now.getTime() + 900000), revokedAt: null,
    })),
    findOwner: jest.fn<OnboardingRouterOptions['store']['findOwner']>(),
    findSession: jest.fn<OnboardingRouterOptions['store']['findSession']>(),
    rotateOwnerCsrf: jest.fn<OnboardingRouterOptions['store']['rotateOwnerCsrf']>(),
    rotateSessionCsrf: jest.fn<OnboardingRouterOptions['store']['rotateSessionCsrf']>(),
    exchangeClaim: jest.fn<OnboardingRouterOptions['store']['exchangeClaim']>(),
    endSession: jest.fn<OnboardingRouterOptions['store']['endSession']>(),
  };
  const rateLimits = new InMemoryRateLimitStore();
  const admission = jest.spyOn(rateLimits, 'update');
  const futureDependencies = {
    metadataReader: { read: async () => null },
    githubEnrollment: { start: async () => { throw new Error('unused'); }, complete: async () => { throw new Error('unused'); } },
  };
  const apiRouter = createOnboardingRouter({ store, rateLimits, trustedOrigin: origin, ...futureDependencies,
    credentials: new OnboardingCredentials(new HmacConsoleOpaqueValueService(randomBytes(32))),
    audit: { kind: 'system', appendSecurityEvent: async () => { throw new Error('No credential mutation expected'); } },
  });
  const unparsed: unknown[] = [];
  const observedApi = express.Router().use((req, _res, next) => { unparsed.push(req.body); next(); }).use(apiRouter);
  const page = jest.fn((_req: express.Request, res: express.Response) => {
    res.set('Content-Security-Policy', "script-src 'nonce-test-page'").end('claim page');
  });
  const claimPageRouter = express.Router().get('/auth/onboarding/invitation', page);
  const onboarding = { claimPageRouter, apiRouter: observedApi };
  const app = createStreamableHttpApp({ host, allowedHosts, onboarding });
  app.post('/mcp', (req, res) => res.json({ received: req.body }));
  const post = (path = 'bootstrap') => request(app).post(`/auth/onboarding/${path}`).set('Origin', origin);
  return { app, store, admission, unparsed, page, post, onboarding };
}

it('runs explicit host validation before onboarding, admission and malformed JSON parsing', async () => {
  const f = fixture(['console.example.test']);
  const denied = await f.post().set('Host', 'attacker.example').set('Content-Type', 'application/json').send('{');
  expect(denied.status).toBe(403);
  expect(f.admission).not.toHaveBeenCalled();
  expect(f.unparsed).toEqual([]);
  expect((await request(f.app).get('/auth/onboarding/invitation').set('Host', 'attacker.example')).status).toBe(403);
  expect(f.page).not.toHaveBeenCalled();
  const accepted = await f.post().set('Host', 'console.example.test:443').send({});
  expect(accepted.status).toBe(200);
  expect(f.unparsed).toEqual([undefined]);
});

it.each(['127.0.0.1', 'localhost', '::1'])('preserves automatic loopback host validation for %s', async host => {
  const f = fixture(undefined, host);
  expect((await f.post().set('Host', 'attacker.example').send({})).status).toBe(403);
  expect((await f.post().set('Host', '[::1]:1234').send({})).status).toBe(200);
});

it('preserves explicit empty-host denial and unrestricted non-loopback SDK behavior', async () => {
  expect((await fixture([]).post().send({})).status).toBe(403);
  expect((await fixture(undefined, '192.0.2.1').post().set('Host', 'custom.example').send({})).status).toBe(200);
});

it('leaves the onboarding 1KB, no-inflate and admission-before-body protections authoritative', async () => {
  const f = fixture();
  const tooLarge = await f.post('exchange').send({ credential: 's'.repeat(1100) });
  expect(tooLarge.status).toBe(413);
  expect(tooLarge.headers['cache-control']).toBe('no-store');
  expect(f.admission).toHaveBeenCalledTimes(1);
  const compressed = await f.post().set('Content-Type', 'application/json').set('Content-Encoding', 'gzip').send(gzipSync('{}'));
  expect(compressed.status).toBe(415);
  expect(f.admission).toHaveBeenCalledTimes(2);
  const malformed = await f.post().set('Content-Type', 'application/json').send('{');
  expect(malformed.status).toBe(400);
  expect(f.admission).toHaveBeenCalledTimes(3);
  expect(f.unparsed).toEqual([undefined, undefined, undefined]);
  expect(f.store.createOwner).not.toHaveBeenCalled();
  expect(f.store.exchangeClaim).not.toHaveBeenCalled();
  f.admission.mockResolvedValueOnce({ state: null, result: false });
  expect((await f.post().set('Content-Type', 'application/json').send('{')).status).toBe(429);
});

it('preserves exact claim-page CSP and terminal API routes ahead of fallback middleware', async () => {
  const f = fixture();
  f.app.use((_req, res) => res.status(418).set('Content-Security-Policy', "script-src 'none'").end('fallback'));
  const page = await request(f.app).get('/auth/onboarding/invitation');
  expect(page.status).toBe(200);
  expect(page.headers['content-security-policy']).toBe("script-src 'nonce-test-page'");
  const api = await request(f.app).get('/auth/onboarding/status');
  expect(api.status).toBe(200);
  expect(api.headers['content-security-policy']).toContain("script-src 'none'");
  expect((await request(f.app).get('/auth/onboarding/unknown')).status).toBe(404);
  expect((await request(f.app).get('/unrelated')).status).toBe(418);
  expect(f.page).toHaveBeenCalledTimes(1);
});

it.each([false, true])('retains generic MCP JSON parsing with onboarding=%s', async enabled => {
  const f = fixture();
  const app = enabled ? f.app : createStreamableHttpApp({ host: '127.0.0.1' });
  if (!enabled) app.post('/mcp', (req, res) => res.json({ received: req.body }));
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { text: 'x'.repeat(2048) } };
  expect((await request(app).post('/mcp').send(message)).body).toEqual({ received: message });
  if (!enabled) expect((await request(app).get('/auth/onboarding/invitation')).status).toBe(404);
});

it('passes the optional routers through the listening runtime before console and OAuth catch-alls', async () => {
  const f = fixture();
  const fallback = express.Router().use((_req, res) => res.status(418).end('fallback'));
  const consoleMiddleware = jest.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) => next());
  const consoleRouter = express.Router().use(consoleMiddleware);
  const runtime = await createStreamableHttpRuntime(async () => ({ dispose: async () => {} }), {
    host: '127.0.0.1', port: 0, sessionPoolSize: 0, registerSignalHandlers: false, onboarding: f.onboarding,
    authMiddleware: (req, res) => { res.json({ received: req.body }); },
    oauthProvider: { createRouter: () => fallback },
    webConsoleApiV1: { router: consoleRouter, markMounted: () => {} },
  });
  try {
    expect((await request(runtime.httpServer).post('/auth/onboarding/bootstrap').set('Origin', origin).send({})).status).toBe(200);
    expect((await request(runtime.httpServer).get('/auth/onboarding/invitation')).text).toBe('claim page');
    expect(consoleMiddleware).not.toHaveBeenCalled();
    expect((await request(runtime.httpServer).post('/mcp').send({ jsonrpc: '2.0', id: 1 })).body.received.id).toBe(1);
    expect((await request(runtime.httpServer).get('/unrelated')).status).toBe(418);
  } finally { await runtime.close(); }
});
