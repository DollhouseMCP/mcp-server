import { randomBytes, randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { InMemoryRateLimitStore } from '../../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import { generateInvitationToken } from '../../../../src/invitations/InvitationToken.js';
import { createOnboardingRouter, type OnboardingRouterOptions } from '../../../../src/invitations/onboarding/OnboardingRouter.js';
import { OnboardingCredentials } from '../../../../src/invitations/onboarding/OnboardingCredentials.js';
import type { OnboardingOwnerRecord, OnboardingSessionRecord } from '../../../../src/invitations/onboarding/OnboardingRecords.js';
import { ONBOARDING_OWNER_COOKIE, ONBOARDING_SESSION_COOKIE } from '../../../../src/invitations/onboarding/OnboardingBrowserPolicy.js';
import { HmacConsoleOpaqueValueService } from '../../../../src/web-console/security/ConsoleOpaqueValues.js';

const origin = 'https://console.example.test';
function fixture() {
  const now = new Date();
  const credentials = new OnboardingCredentials(new HmacConsoleOpaqueValueService(randomBytes(32)));
  const ownerCredential = credentials.issue('owner');
  const csrf = credentials.issue('csrf');
  const owner: OnboardingOwnerRecord = { ownerHash: ownerCredential.hash, csrfTokenHash: csrf.hash,
    createdAt: now, refreshedAt: now, expiresAt: new Date(now.getTime() + 900000), revokedAt: null };
  const token = generateInvitationToken(randomUUID(), 1);
  const store = {
    createOwner: jest.fn(async (ownerHash: Buffer, csrfTokenHash: Buffer) => ({ ...owner, ownerHash, csrfTokenHash })),
    findOwner: jest.fn(async () => owner as OnboardingOwnerRecord | null),
    findSession: jest.fn(async () => null as OnboardingSessionRecord | null),
    rotateOwnerCsrf: jest.fn(async (_hash: Buffer, csrfTokenHash: Buffer) => ({ ...owner, csrfTokenHash })),
    rotateSessionCsrf: jest.fn<OnboardingRouterOptions['store']['rotateSessionCsrf']>(),
    exchangeClaim: jest.fn<OnboardingRouterOptions['store']['exchangeClaim']>(async input => ({
      ownerHash: input.ownerHash, idHash: input.sessionHash, csrfTokenHash: input.csrfTokenHash,
      userId: randomUUID(), invitationId: input.invitationId, generation: input.generation, claimAssertionId: randomUUID(),
      emailVerifiedAt: now, scope: 'onboarding:github-enrollment', createdAt: now,
      expiresAt: new Date(now.getTime() + 120000), revokedAt: null,
    })),
    endSession: jest.fn(async () => true),
  };
  const rateLimits = new InMemoryRateLimitStore();
  const options: OnboardingRouterOptions = { store, credentials, rateLimits, trustedOrigin: origin,
    audit: { kind: 'system', appendSecurityEvent: async () => {} }, now: () => now };
  const app = express().use('/auth/onboarding', createOnboardingRouter(options));
  const cookie = `${ONBOARDING_OWNER_COOKIE}=${ownerCredential.value}`;
  const post = (path: string) => request(app).post(`/auth/onboarding/${path}`).set('Origin', origin).set('Cookie', cookie).set('X-Onboarding-CSRF', csrf.value);
  return { app, store, rateLimits, token, owner, csrf, cookie, post, options, credentials };
}
function safe(response: request.Response, forbidden: string[] = []) {
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(response.headers['content-security-policy']).toContain("script-src 'none'");
  for (const secret of forbidden) expect(response.text).not.toContain(secret);
}

it('sets the original 168h owner horizon before exchange, while retaining a 15min server record', async () => {
  const f = fixture();
  const res = await request(f.app).post('/auth/onboarding/bootstrap').set('Origin', origin).send({});
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ state: 'ready', expiresAt: f.owner.expiresAt.toISOString(), csrfToken: expect.any(String) });
  expect(res.headers['set-cookie'][0]).toMatch(/Max-Age=604800; Secure; HttpOnly; SameSite=Lax/);
  expect(f.store.createOwner).toHaveBeenCalledTimes(1);
  safe(res);
});
it('rotates owner CSRF on reload without replacing the owner or extending its TTL', async () => {
  const f = fixture();
  const res = await f.post('bootstrap').send({});
  expect(res.status).toBe(200);
  expect(f.store.createOwner).not.toHaveBeenCalled();
  expect(f.store.rotateOwnerCsrf.mock.calls[0][0]).toEqual(f.owner.ownerHash);
  expect(res.body.csrfToken).not.toBe(f.csrf.value);
  expect(res.body.expiresAt).toBe(f.owner.expiresAt.toISOString());
  expect(res.headers['set-cookie'].join('')).not.toContain(ONBOARDING_OWNER_COOKIE);
});
it('derives hashes only from cookies, exchanges POST credential, and caps cookie life to persisted remaining expiry', async () => {
  const f = fixture();
  const res = await f.post('exchange').send({ credential: f.token.token });
  expect(res.status).toBe(200);
  expect(res.headers['set-cookie'][0]).toMatch(/Max-Age=120; Secure; HttpOnly; SameSite=Lax/);
  const input = f.store.exchangeClaim.mock.calls[0][0];
  expect(input.ownerHash).toEqual(f.owner.ownerHash);
  expect(input.invitationId).toBe(f.token.invitationId);
  expect(input.credentialSecret).toEqual(Buffer.alloc(32)); // zeroed after the awaited call
  expect(Object.keys(res.body).sort()).toEqual(['csrfToken', 'expiresAt', 'state']);
  safe(res, [f.token.token, f.cookie, input.ownerHash.toString('hex')]);
});
it.each([undefined, 'null', 'https://evil.example'])('rejects Origin %s before any store or limiter mutation', async supplied => {
  const f = fixture();
  const update = jest.spyOn(f.rateLimits, 'update');
  const call = request(f.app).post('/auth/onboarding/bootstrap');
  if (supplied) call.set('Origin', supplied);
  const res = await call.send({});
  expect(res.status).toBe(403);
  expect(update).not.toHaveBeenCalled();
  expect(f.store.createOwner).not.toHaveBeenCalled();
  safe(res);
});
it.each(['ownerHash', 'sessionHash', 'invitationId', 'redirect'])('rejects injected %s request keys', async key => {
  const f = fixture();
  expect((await f.post('exchange').send({ credential: f.token.token, [key]: 'injected' })).status).toBe(400);
  expect(f.store.exchangeClaim).not.toHaveBeenCalled();
});
it('rejects missing/wrong CSRF and never consumes a token on GET or query parameters', async () => {
  const f = fixture();
  expect((await f.post('exchange').unset('X-Onboarding-CSRF').send({ credential: f.token.token })).status).toBe(403);
  expect((await f.post('exchange').set('X-Onboarding-CSRF', f.credentials.issue('csrf').value).send({ credential: f.token.token })).status).toBe(403);
  const query = await request(f.app).get('/auth/onboarding/status').query({ token: f.token.token });
  expect(query.status).toBe(400);
  safe(query, [f.token.token]);
  expect((await request(f.app).get('/auth/onboarding/exchange')).status).toBe(404);
  expect(f.store.exchangeClaim).not.toHaveBeenCalled();
});
it('rejects duplicate cookies and security headers before selecting a binding', async () => {
  const f = fixture();
  expect((await f.post('bootstrap').set('Cookie', `${f.cookie}; ${f.cookie}`).send({})).status).toBe(400);
  expect((await f.post('bootstrap').set('Origin', [origin, origin] as unknown as string).send({})).status).toBe(400);
  expect((await f.post('exchange').set('X-Onboarding-CSRF', [f.csrf.value, f.csrf.value] as unknown as string).send({ credential: f.token.token })).status).toBe(400);
  expect(f.store.exchangeClaim).not.toHaveBeenCalled();
});
it('contains malformed JSON, oversized, compressed, and non-JSON bodies in sanitized no-store responses', async () => {
  const f = fixture();
  const cases = [
    f.post('exchange').set('Content-Type', 'application/json').send(`{"credential":"${f.token.token}"`),
    f.post('exchange').send({ credential: f.token.token + 'x'.repeat(2000) }),
    f.post('exchange').set('Content-Encoding', 'gzip').send({ credential: f.token.token }),
    f.post('exchange').type('form').send({ credential: f.token.token }),
  ];
  for (const [index, call] of cases.entries()) {
    const res = await call;
    expect(res.status).toBe([400, 413, 415, 415][index]);
    safe(res, [f.token.token]);
  }
  expect(f.store.exchangeClaim).not.toHaveBeenCalled();
});
it('fails closed on limiter/store outage without echoing credentials or errors', async () => {
  const f = fixture();
  jest.spyOn(f.rateLimits, 'update').mockRejectedValueOnce(new Error(f.token.token));
  const limited = await f.post('bootstrap').send({});
  expect(limited.status).toBe(503);
  expect(f.store.rotateOwnerCsrf).not.toHaveBeenCalled();
  safe(limited, [f.token.token]);
  f.store.exchangeClaim.mockRejectedValueOnce(new Error(f.token.token));
  const failed = await f.post('exchange').send({ credential: f.token.token });
  expect(failed.status).toBe(503);
  expect(failed.headers['set-cookie']).toBeUndefined();
  safe(failed, [f.token.token]);
});
it('limits admission using Express IP rather than a credential or arbitrary forwarded header', async () => {
  const f = fixture();
  const update = jest.spyOn(f.rateLimits, 'update');
  for (let index = 0; index < 30; index++) expect((await f.post('bootstrap').set('X-Forwarded-For', `spoof-${index}`).send({})).status).toBe(200);
  const blocked = await f.post('exchange').send({ credential: f.token.token });
  expect(blocked.status).toBe(429);
  expect(new Set(update.mock.calls.map(call => call[1])).size).toBe(1);
  expect(JSON.stringify(update.mock.calls)).not.toContain(f.token.token);
  expect(f.store.exchangeClaim).not.toHaveBeenCalled();
  safe(blocked);
});
it('returns only sanitized read-only status and logs out a session while retaining its owner', async () => {
  const f = fixture();
  const status = await request(f.app).get('/auth/onboarding/status').set('Cookie', f.cookie);
  expect(status.body).toEqual({ state: 'ready', expiresAt: f.owner.expiresAt.toISOString() });
  expect(f.store.rotateOwnerCsrf).not.toHaveBeenCalled();
  safe(status);
  const session = f.credentials.issue('session');
  f.store.findSession.mockResolvedValue({ ...f.owner, idHash: session.hash, userId: randomUUID(),
    invitationId: f.token.invitationId, generation: 1, claimAssertionId: randomUUID(),
    emailVerifiedAt: f.owner.createdAt, scope: 'onboarding:github-enrollment' });
  const logout = await f.post('logout').set('Cookie', `${f.cookie}; ${ONBOARDING_SESSION_COOKIE}=${session.value}`).send({});
  expect(logout.status).toBe(204);
  expect(f.store.endSession).toHaveBeenCalledWith(f.owner.ownerHash, session.hash);
  expect(logout.headers['set-cookie'].join('')).not.toContain(ONBOARDING_OWNER_COOKIE);
});
it('returns neutral409 without a session cookie when persisted session life is exhausted before the response', async () => {
  const f = fixture();
  const original = f.store.exchangeClaim.getMockImplementation()!;
  f.store.exchangeClaim.mockImplementationOnce(async (input, audit) => ({
    ...await original(input, audit), expiresAt: new Date(f.options.now!().getTime() - 1),
  }));
  const rejected = await f.post('exchange').send({ credential: f.token.token });
  expect(rejected.status).toBe(409);
  expect(rejected.headers['set-cookie']).toBeUndefined();
  safe(rejected, [f.token.token]);
  expect(f.store.createOwner).not.toHaveBeenCalled();
  // The boundary leaves the original owner binding untouched. The store owns
  // authoritative same-claim recovery when the caller retries the credential.
  const retry = await f.post('exchange').send({ credential: f.token.token });
  expect(retry.status).toBe(200);
  expect(f.store.exchangeClaim.mock.calls[1][0].ownerHash).toEqual(f.owner.ownerHash);
});

it('rejects any unauthenticated presented session without downgrading or clearing its cookie', async () => {
  const f = fixture();
  const cookies = `${f.cookie}; ${ONBOARDING_SESSION_COOKIE}=${f.credentials.issue('session').value}`;
  for (const path of ['bootstrap', 'exchange', 'logout']) {
    const response = await f.post(path).set('Cookie', cookies).send(path === 'exchange' ? { credential: f.token.token } : {});
    expect(response.status).toBe(409);
    expect(response.headers['set-cookie']).toBeUndefined();
    safe(response, [f.token.token, f.csrf.value]);
  }
  expect((await request(f.app).get('/auth/onboarding/status').set('Cookie', cookies)).status).toBe(409);
  for (const operation of [f.store.createOwner, f.store.rotateOwnerCsrf, f.store.rotateSessionCsrf,
    f.store.exchangeClaim, f.store.endSession]) expect(operation).not.toHaveBeenCalled();
});
