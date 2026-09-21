import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { InMemoryRateLimitStore } from '../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import { authKv } from '../../../src/database/schema/auth.js';
import { users } from '../../../src/database/schema/users.js';
import { accountInvitationGenerations } from '../../../src/database/schema/invitations.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import { PostgresInvitationClaimStore } from '../../../src/invitations/PostgresInvitationClaimStore.js';
import { generateInvitationToken } from '../../../src/invitations/InvitationToken.js';
import { PostgresOnboardingStore } from '../../../src/invitations/onboarding/PostgresOnboardingStore.js';
import { OnboardingCredentials } from '../../../src/invitations/onboarding/OnboardingCredentials.js';
import { createOnboardingRouter } from '../../../src/invitations/onboarding/OnboardingRouter.js';
import { ONBOARDING_OWNER_COOKIE, ONBOARDING_SESSION_COOKIE } from '../../../src/invitations/onboarding/OnboardingBrowserPolicy.js';
import { HmacConsoleOpaqueValueService } from '../../../src/web-console/security/ConsoleOpaqueValues.js';
import { appendSecurityAuditEventWithTx } from '../../../src/security/auditSink.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

const origin = 'https://console.example.test';
const audit = { kind: 'system' as const, appendSecurityEvent: appendSecurityAuditEventWithTx };
let available = false;
beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required PostgreSQL unavailable');
});
afterAll(closeTestDb);
function cookie(response: request.Response, name: string): string {
  const values = response.headers['set-cookie'] as unknown as string[];
  return values.find(value => value.startsWith(`${name}=`))!.split(';')[0];
}
async function fixture(failAudit = false) {
  const db = getTestAdminDb();
  const id = randomUUID();
  const inviterUserId = randomUUID();
  await db.insert(users).values({ id: inviterUserId, username: `http-admin-${inviterUserId}` });
  const token = generateInvitationToken(id, 1);
  await new PostgresInvitationManagementStore(db).runMutation(audit, mutation => mutation.issue({
    invitationId: id, userId: randomUUID(), username: `http-${id}`, displayName: 'HTTP journey',
    emailOriginal: `${id}@example.test`, emailNormalized: `${id}@example.test`, inviterUserId,
    intendedRoles: [], generation: 1, credentialSecret: token.secret, ttlHours: 24, correlationId: randomUUID(),
  }));
  const credentials = new OnboardingCredentials(new HmacConsoleOpaqueValueService(randomBytes(32)));
  const store = new PostgresOnboardingStore(db, new PostgresInvitationClaimStore(db));
  const app = express().use('/auth/onboarding', createOnboardingRouter({ store, credentials,
    rateLimits: new InMemoryRateLimitStore(), trustedOrigin: origin,
    audit: failAudit ? { kind: 'system', appendSecurityEvent: async () => { throw new Error(token.token); } } : audit,
  }));
  const post = (path: string, cookies?: string, csrf?: string) => {
    const call = request(app).post(`/auth/onboarding/${path}`).set('Origin', origin);
    if (cookies) call.set('Cookie', cookies);
    if (csrf) call.set('X-Onboarding-CSRF', csrf);
    return call;
  };
  return { db, id, token, credentials, store, app, post };
}

it('recovers a lost exchange response with the pre-existing owner, rotates reload CSRF and ends only the restricted session', async () => {
  if (!available) return;
  const f = await fixture();
  const bootstrap = await f.post('bootstrap').send({});
  expect(bootstrap.status).toBe(200);
  const ownerCookie = cookie(bootstrap, ONBOARDING_OWNER_COOKIE);
  const ownerHash = f.credentials.hash('owner', ownerCookie.split('=')[1]);
  const originalOwner = await f.store.findOwner(ownerHash);
  const first = await f.post('exchange', ownerCookie, bootstrap.body.csrfToken).send({ credential: f.token.token });
  expect(first.status).toBe(200);
  const firstSessionCookie = cookie(first, ONBOARDING_SESSION_COOKIE);
  const firstHash = f.credentials.hash('session', firstSessionCookie.split('=')[1]);
  const firstRecord = await f.store.findSession(ownerHash, firstHash);
  expect(firstRecord).not.toBeNull();

  // Simulate a committed exchange whose Set-Cookie/JSON response was lost.
  const reload = await f.post('bootstrap', ownerCookie).send({});
  expect(reload.status).toBe(200);
  expect(reload.body.state).toBe('ready');
  expect(reload.headers['set-cookie'].join('')).not.toContain(ONBOARDING_OWNER_COOKIE);
  const recovered = await f.post('exchange', ownerCookie, reload.body.csrfToken).send({ credential: f.token.token });
  expect(recovered.status).toBe(200);
  const sessionCookie = cookie(recovered, ONBOARDING_SESSION_COOKIE);
  const sessionHash = f.credentials.hash('session', sessionCookie.split('=')[1]);
  const live = await f.store.findSession(ownerHash, sessionHash);
  expect(live!.claimAssertionId).toBe(firstRecord!.claimAssertionId);
  expect(await f.store.findSession(ownerHash, firstHash)).toBeNull();
  expect((await f.store.findOwner(ownerHash))!.createdAt).toEqual(originalOwner!.createdAt);
  const combined = `${ownerCookie}; ${sessionCookie}`;
  const sessionReload = await f.post('bootstrap', combined).send({});
  expect(sessionReload.body).toMatchObject({ state: 'claimed', expiresAt: live!.expiresAt.toISOString() });
  expect(sessionReload.body.csrfToken).not.toBe(recovered.body.csrfToken);
  expect((await f.store.findSession(ownerHash, sessionHash))!.expiresAt).toEqual(live!.expiresAt);
  expect((await f.post('logout', combined, recovered.body.csrfToken).send({})).status).toBe(403);
  const status = await request(f.app).get('/auth/onboarding/status').set('Cookie', combined);
  expect(Object.keys(status.body).sort()).toEqual(['expiresAt', 'state']);
  const logout = await f.post('logout', combined, sessionReload.body.csrfToken).send({});
  expect(logout.status).toBe(204);
  expect(await f.store.findSession(ownerHash, sessionHash)).toBeNull();
  expect(await f.store.findOwner(ownerHash)).not.toBeNull();
  const claims = await f.db.execute(sql`SELECT * FROM account_invitation_claim_assertions WHERE invitation_id = ${f.id}::uuid`);
  const events = await f.db.execute(sql`SELECT * FROM security_audit_events WHERE target_id = ${f.id}`);
  expect(claims).toHaveLength(1);
  expect(events.filter(event => event.event_type === 'invitation.claimed')).toHaveLength(1);
  const kv = await f.db.select().from(authKv).where(eq(authKv.id, ownerHash.toString('hex')));
  const serialized = JSON.stringify({ kv, claims, events });
  for (const secret of [f.token.token, f.token.secret.toString('base64url'), ownerCookie.split('=')[1],
    sessionCookie.split('=')[1], bootstrap.body.csrfToken, sessionReload.body.csrfToken]) expect(serialized).not.toContain(secret);
});

it('sanitizes an atomic exchange failure and leaves the invitation unconsumed without a session cookie', async () => {
  if (!available) return;
  const f = await fixture(true);
  const bootstrap = await f.post('bootstrap').send({});
  const ownerCookie = cookie(bootstrap, ONBOARDING_OWNER_COOKIE);
  const response = await f.post('exchange', ownerCookie, bootstrap.body.csrfToken).send({ credential: f.token.token });
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ error: 'onboarding_unavailable' });
  expect(response.headers['set-cookie']).toBeUndefined();
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.text).not.toContain(f.token.token);
  const [generation] = await f.db.select().from(accountInvitationGenerations).where(eq(accountInvitationGenerations.invitationId, f.id));
  expect(generation.credentialConsumedAt).toBeNull();
  expect(await f.db.execute(sql`SELECT id FROM account_invitation_claim_assertions WHERE invitation_id = ${f.id}::uuid`)).toHaveLength(0);
});
