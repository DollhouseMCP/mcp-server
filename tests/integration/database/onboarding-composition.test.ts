import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import express from 'express';
import request, { type Response as HttpResponse } from 'supertest';
import { jest } from '@jest/globals';
import { eq, sql } from 'drizzle-orm';
import { users } from '../../../src/database/schema/users.js';
import { authAccounts, authKv } from '../../../src/database/schema/auth.js';
import { userAdminRoles } from '../../../src/database/schema/webConsole.js';
import { PostgresRateLimitStore } from '../../../src/auth/embedded-as/storage/PostgresRateLimitStore.js';
import type { TransactionalEmail } from '../../../src/auth/embedded-as/methods/TransactionalEmailSender.js';
import { createOnboardingComposition } from '../../../src/invitations/onboarding/createOnboardingComposition.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import { HmacConsoleOpaqueValueService } from '../../../src/web-console/security/ConsoleOpaqueValues.js';
import { PostgresConsoleIdentityResolver } from '../../../src/web-console/identity/PostgresConsoleIdentityResolver.js';
import { PostgresConsoleAccountAllowlistStore } from '../../../src/web-console/stores/PostgresConsoleAccountAllowlistStore.js';
import { ONBOARDING_OWNER_COOKIE, ONBOARDING_SESSION_COOKIE } from '../../../src/invitations/onboarding/OnboardingBrowserPolicy.js';
import { invitationAdminHarness, invitationAuditKey } from '../../helpers/web-console/durableInvitationAdmin.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

const origin = 'https://console.example.test';
let available = false;
beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required PostgreSQL unavailable');
});
afterAll(closeTestDb);
function cookie(response: HttpResponse, name: string): string {
  const value = (response.headers['set-cookie'] as unknown as string[]).find(value => value.startsWith(`${name}=`));
  expect(value).toBeDefined(); return value!.split(';')[0];
}

it('composes admin issuance and delivery through cross-instance claim, OAuth, activation and fresh account resolution', async () => {
  if (!available) return;
  const db = getTestAdminDb();
  const inviterId = randomUUID(), otherId = randomUUID();
  const providerEmail = `${randomUUID()}@provider.test`;
  await db.insert(users).values([{ id: inviterId, username: `composition-admin-${inviterId}` },
    { id: otherId, username: `unrelated-${otherId}`, email: providerEmail }]);
  await db.insert(userAdminRoles).values({ userId: inviterId, role: 'admin', grantedByUserId: inviterId });
  const otherSub = `local_${randomUUID()}`;
  await db.insert(authAccounts).values({ sub: otherSub, provider: 'local', externalSub: otherSub, userId: otherId, email: providerEmail, emailVerified: true });
  const githubId = String(randomInt(1, 2 ** 48 - 1));
  const githubToken = `test-token-${randomUUID()}`, oauthCode = `test-code-${randomUUID()}`;
  let authorization: URL;
  const provider = jest.fn<typeof fetch>(async (url, init) => {
    if (String(url) === 'https://github.com/login/oauth/access_token') {
      const body = init!.body as URLSearchParams;
      expect(body.get('code')).toBe(oauthCode);
      expect(body.get('redirect_uri')).toBe(`${origin}/auth/onboarding/github/callback`);
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'));
      return new Response(JSON.stringify({ access_token: githubToken, token_type: 'bearer' }));
    }
    expect(String(url)).toBe('https://api.github.com/user');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${githubToken}`);
    return new Response(JSON.stringify({ id: Number(githubId), login: 'composition-user', email: providerEmail }));
  });
  const sent: TransactionalEmail[] = [];
  const sender = { sendTransactionalEmail: async (message: TransactionalEmail) => {
    sent.push(message); return { state: 'submitted' as const, providerMessageId: null };
  } };
  const options = { database: db, opaqueValues: new HmacConsoleOpaqueValueService(randomBytes(32)),
    rateLimits: new PostgresRateLimitStore(db), adminAuditKeys: { resolve: async () => invitationAuditKey },
    publicBaseUrl: origin, supportEmail: 'support@example.test', github: { clientId: 'test-client', clientSecret: 'test-client-secret' }, sender, githubFetch: provider };
  const first = createOnboardingComposition(options), second = createOnboardingComposition({ ...options, rateLimits: new PostgresRateLimitStore(db) });
  expect(provider).not.toHaveBeenCalled(); expect(sent).toHaveLength(0);
  const admin = await invitationAdminHarness({ store: new PostgresInvitationManagementStore(db) }, 'admin', true, inviterId, undefined, first.adminModule);
  const firstApp = express().use(first.claimPageRouter).use('/auth/onboarding', first.apiRouter).use(admin.app);
  const secondApp = express().use(second.claimPageRouter).use('/auth/onboarding', second.apiRouter);
  const id = randomUUID();
  const issued = await admin.send('post', '', { username: ` Tester-${id} `, display_name: ' Renée 李 ', email: `${id}@Invite.test`, intended_roles: ['operator'], ttl_hours: 24 });
  expect(issued.status).toBe(201); expect(issued.body.delivery).toEqual({ status: 'recorded', state: 'submitted' });
  const invitation = issued.body.invitation, claimUrl = new URL(issued.body.claim_url);
  const credential = new URLSearchParams(claimUrl.hash.slice(1)).get('token')!;
  expect(sent).toHaveLength(1); expect(sent[0].text).toContain(issued.body.claim_url);
  expect(claimUrl.origin).toBe(origin); expect(claimUrl.search).toBe('');
  expect(Date.parse(invitation.expires_at) - Date.parse(invitation.issued_at)).toBe(24 * 3600000);
  const shell = await request(firstApp).get(claimUrl.pathname);
  expect(shell.status).toBe(200); expect(shell.headers['set-cookie']).toBeUndefined();
  expect(shell.text).not.toContain(credential); expect(shell.headers['content-security-policy']).toContain("script-src 'nonce-");
  const post = (app: typeof firstApp, path: string, cookies = '', csrf?: string) => {
    const value = request(app).post('/auth/onboarding/' + path).set('Origin', origin).set('Cookie', cookies);
    return csrf ? value.set('X-Onboarding-CSRF', csrf) : value;
  };
  const bootstrap = await post(firstApp, 'bootstrap').send({});
  expect(bootstrap.status).toBe(200);
  const owner = cookie(bootstrap, ONBOARDING_OWNER_COOKIE);
  const exchange = await post(secondApp, 'exchange', owner, bootstrap.body.csrfToken).send({ credential });
  expect(exchange.status).toBe(200);
  const session = cookie(exchange, ONBOARDING_SESSION_COOKIE), cookies = `${owner}; ${session}`;
  expect((await request(firstApp).get('/auth/onboarding/context').set('Cookie', cookies)).body.account).toMatchObject({ username: `tester-${id}`, displayName: 'Renée 李' });
  const resolver = new PostgresConsoleIdentityResolver(db), sub = `github_${githubId}`;
  expect(await resolver.resolveEnabledPrincipal(sub)).toBeNull();
  const started = await post(firstApp, 'github/start', cookies, exchange.body.csrfToken).send({});
  expect(started.status).toBe(200); expect(Object.keys(started.body).sort()).toEqual(['authorizationUrl', 'expiresAt']);
  authorization = new URL(started.body.authorizationUrl);
  expect(authorization.searchParams.get('scope')).toBe('read:user');
  expect(authorization.searchParams.get('redirect_uri')).toBe(`${origin}/auth/onboarding/github/callback`);
  const state = authorization.searchParams.get('state')!;
  expect(provider).not.toHaveBeenCalled();
  const callback = `/auth/onboarding/github/callback?state=${state}&code=${oauthCode}`;
  const complete = await request(secondApp).get(callback).set('Cookie', cookies);
  expect(complete.status).toBe(303); expect(complete.headers.location).toBe('/api/v1/auth/login');
  expect(cookie(complete, ONBOARDING_OWNER_COOKIE)).toBe(`${ONBOARDING_OWNER_COOKIE}=`);
  expect(cookie(complete, ONBOARDING_SESSION_COOKIE)).toBe(`${ONBOARDING_SESSION_COOKIE}=`);
  expect(provider).toHaveBeenCalledTimes(2);
  const replay = await request(firstApp).get(callback).set('Cookie', cookies);
  expect(replay.status).toBe(400); expect(provider).toHaveBeenCalledTimes(2);
  expect(replay.text).toContain('href="/auth/onboarding/invitation"');
  expect((await request(firstApp).get('/auth/onboarding/context').set('Cookie', cookies)).status).toBe(409);
  expect(await new PostgresConsoleAccountAllowlistStore(db).provisionAccountIfAllowed({ required: true,
    identity: { sub, method: 'github', provider: 'github', externalSub: githubId, githubId, githubUsername: 'renamed', email: providerEmail },
    account: { provider: 'github', externalSub: githubId, sub, email: providerEmail, emailVerified: false, createdAt: Date.now(), updatedAt: Date.now() },
  })).toEqual({ allowed: true });
  await resolver.linkAccount(sub, 'GitHub display');
  expect(await resolver.resolveEnabledPrincipal(sub)).toMatchObject({ userId: invitation.user_id, roles: ['operator'] });
  expect((await db.select().from(authAccounts).where(eq(authAccounts.sub, otherSub)))[0].userId).toBe(otherId);
  const inspect = await admin.send('get', `/${invitation.id}`);
  expect(inspect.status).toBe(200); expect(inspect.body.invitation.state).toBe('accepted');
  expect(inspect.body.claim_url).toBeUndefined(); expect(inspect.body.delivery).toBeUndefined();
  const records = await db.execute(sql`SELECT jsonb_build_object(
    'security', (SELECT jsonb_agg(e) FROM security_audit_events e WHERE target_id = ${invitation.id}),
    'admin', (SELECT jsonb_agg(e) FROM admin_audit_events e WHERE resource_id = ${invitation.id}),
    'generations', (SELECT jsonb_agg(g) FROM account_invitation_generations g WHERE invitation_id = ${invitation.id}::uuid),
    'claims', (SELECT jsonb_agg(c) FROM account_invitation_claim_assertions c WHERE invitation_id = ${invitation.id}::uuid),
    'delivery', (SELECT jsonb_agg(d) FROM account_invitation_delivery_attempts d WHERE invitation_id = ${invitation.id}::uuid)
  ) AS records`);
  const serialized = JSON.stringify({ records, kv: await db.select().from(authKv), replay: replay.text, inspect: inspect.body });
  for (const secret of [credential, credential.split('.')[3], owner.split('=')[1], session.split('=')[1], bootstrap.body.csrfToken,
    exchange.body.csrfToken, state, oauthCode, githubToken, options.github.clientSecret]) expect(serialized).not.toContain(secret);
});
