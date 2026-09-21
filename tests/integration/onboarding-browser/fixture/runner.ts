import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import express from 'express';
import { eq, sql } from 'drizzle-orm';
import { createDatabaseConnection } from '../../../../dist/database/connection.js';
import { authAccounts } from '../../../../dist/database/schema/auth.js';
import { users } from '../../../../dist/database/schema/users.js';
import { userAdminRoles } from '../../../../dist/database/schema/webConsole.js';
import { PostgresRateLimitStore } from '../../../../dist/auth/embedded-as/storage/PostgresRateLimitStore.js';
import type { TransactionalEmail } from '../../../../dist/auth/embedded-as/methods/TransactionalEmailSender.js';
import { createOnboardingComposition } from '../../../../dist/invitations/onboarding/createOnboardingComposition.js';
import { PostgresInvitationManagementStore } from '../../../../dist/invitations/PostgresInvitationManagementStore.js';
import { HmacConsoleOpaqueValueService } from '../../../../dist/web-console/security/ConsoleOpaqueValues.js';
import { PostgresConsoleIdentityResolver } from '../../../../dist/web-console/identity/PostgresConsoleIdentityResolver.js';
import { PostgresConsoleAccountAllowlistStore } from '../../../../dist/web-console/stores/PostgresConsoleAccountAllowlistStore.js';
import { createStreamableHttpApp } from '../../../../dist/server/createStreamableHttpApp.js';
import { invitationAdminHarness, invitationAuditKey } from '../../../helpers/web-console/durableInvitationAdmin.js';

const mode = required('ONBOARDING_BROWSER_FIXTURE_MODE');
if (mode === 'replica') await runReplica();
else if (mode === 'proxy') await runProxy();
else if (mode === 'forced-failure') {
  process.stderr.write(required('ONBOARDING_BROWSER_FAILURE_MARKER'));
  throw new Error('Forced browser fixture failure');
}
else throw new Error('Unknown browser fixture mode');

async function runReplica(): Promise<void> {
  const port = numberEnv('ONBOARDING_BROWSER_PORT');
  const origin = required('ONBOARDING_BROWSER_ORIGIN');
  const controlSecret = required('ONBOARDING_BROWSER_CONTROL_SECRET');
  const replica = required('ONBOARDING_BROWSER_REPLICA');
  const inviterId = required('ONBOARDING_BROWSER_INVITER_ID');
  const unrelatedId = required('ONBOARDING_BROWSER_UNRELATED_ID');
  const providerEmail = required('ONBOARDING_BROWSER_PROVIDER_EMAIL');
  const githubId = required('ONBOARDING_BROWSER_GITHUB_ID');
  const oauthCode = required('ONBOARDING_BROWSER_OAUTH_CODE');
  const oauthToken = required('ONBOARDING_BROWSER_OAUTH_TOKEN');
  const connection = createDatabaseConnection({ connectionUrl: required('ONBOARDING_BROWSER_DATABASE_URL'), ssl: 'disable' });
  const db = connection.db;
  if (replica === 'a') {
    await db.insert(users).values([
      { id: inviterId, username: `browser-admin-${inviterId}` },
      { id: unrelatedId, username: `same-email-${unrelatedId}`, email: providerEmail },
    ]);
    await db.insert(userAdminRoles).values({ userId: inviterId, role: 'admin', grantedByUserId: inviterId });
    const unrelatedSub = `local_${randomUUID()}`;
    await db.insert(authAccounts).values({ provider: 'local', externalSub: unrelatedSub, sub: unrelatedSub,
      userId: unrelatedId, email: providerEmail, emailVerified: true });
  }

  let providerCalls = 0;
  let deliveryCalls = 0;
  let authorization: URL | undefined;
  const provider: typeof fetch = async (url, init) => {
    providerCalls++;
    if (String(url) === 'https://github.com/login/oauth/access_token') {
      const body = init?.body as URLSearchParams;
      if (body.get('code') !== oauthCode || body.get('redirect_uri') !== `${origin}/auth/onboarding/github/callback` ||
          !authorization || createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== authorization.searchParams.get('code_challenge')) {
        return jsonResponse({ error: 'invalid_grant' }, 400);
      }
      return jsonResponse({ access_token: oauthToken, token_type: 'bearer' });
    }
    if (String(url) !== 'https://api.github.com/user' || new Headers(init?.headers).get('Authorization') !== `Bearer ${oauthToken}`) {
      return jsonResponse({ message: 'unavailable' }, 500);
    }
    return jsonResponse({ id: Number(githubId), login: 'browser-github-user', name: 'Browser GitHub User', email: providerEmail });
  };
  const sender = { sendTransactionalEmail: async (_message: TransactionalEmail) => {
    deliveryCalls++; return { state: 'submitted' as const, providerMessageId: null };
  } };
  const composition = createOnboardingComposition({ database: db,
    opaqueValues: new HmacConsoleOpaqueValueService(Buffer.from(required('ONBOARDING_BROWSER_OPAQUE_KEY'), 'base64url')),
    rateLimits: new PostgresRateLimitStore(db), adminAuditKeys: { resolve: async () => invitationAuditKey },
    publicBaseUrl: origin, supportEmail: 'support@example.test',
    github: { clientId: 'browser-client', clientSecret: required('ONBOARDING_BROWSER_GITHUB_SECRET') }, sender, githubFetch: provider });
  const admin = replica === 'a'
    ? await invitationAdminHarness({ store: new PostgresInvitationManagementStore(db) }, 'admin', true, inviterId, undefined, composition.adminModule)
    : undefined;
  const app = createStreamableHttpApp({ host: '127.0.0.1', allowedHosts: [new URL(origin).hostname], onboarding: composition });
  app.use(express.json({ limit: '2kb' }));
  app.post('/__fixture/issue', async (req, res) => {
    if (!authorized(req.get('X-Fixture-Control'), controlSecret) || !admin) { res.sendStatus(404); return; }
    const id = randomUUID();
    const response = await admin.send('post', '', { username: `browser-user-${id}`, display_name: 'Browser Invitee',
      email: `${id}@invite.test`, intended_roles: ['operator'], ttl_hours: 24 });
    res.status(response.status).json(response.body);
  });
  app.post('/__fixture/authorization', (req, res) => {
    if (!authorized(req.get('X-Fixture-Control'), controlSecret) || typeof req.body?.url !== 'string') { res.sendStatus(404); return; }
    authorization = new URL(req.body.url); res.sendStatus(204);
  });
  app.get('/__fixture/stats', async (req, res) => {
    if (!authorized(req.get('X-Fixture-Control'), controlSecret)) { res.sendStatus(404); return; }
    res.json({ providerCalls, deliveryCalls });
  });
  app.post('/__fixture/resolve', async (req, res) => {
    if (!authorized(req.get('X-Fixture-Control'), controlSecret) || typeof req.body?.invitationId !== 'string') { res.sendStatus(404); return; }
    const sub = `github_${githubId}`;
    const resolver = new PostgresConsoleIdentityResolver(db);
    const provisioned = await new PostgresConsoleAccountAllowlistStore(db).provisionAccountIfAllowed({ required: true,
      identity: { sub, method: 'github', provider: 'github', externalSub: githubId, githubId,
        githubUsername: 'browser-github-user', email: providerEmail },
      account: { provider: 'github', externalSub: githubId, sub, email: providerEmail, emailVerified: false,
        createdAt: Date.now(), updatedAt: Date.now() },
    });
    if (provisioned.allowed) await resolver.linkAccount(sub, 'Browser GitHub User');
    const principal = await resolver.resolveEnabledPrincipal(sub);
    const records = await db.execute(sql`SELECT
      (SELECT state FROM account_invitations WHERE id = ${req.body.invitationId}::uuid) AS invitation_state,
      (SELECT user_id FROM account_invitations WHERE id = ${req.body.invitationId}::uuid) AS invited_user_id,
      (SELECT activation_state FROM users WHERE id = (SELECT user_id FROM account_invitations WHERE id = ${req.body.invitationId}::uuid)) AS activation_state,
      (SELECT count(*)::int FROM users WHERE lower(email) = lower(${providerEmail})) AS matching_email_users`);
    const unrelated = await db.select({ id: users.id }).from(users).where(eq(users.id, unrelatedId));
    res.json({ provisioned, principal, record: records[0], unrelatedUserId: unrelated[0]?.id });
  });
  const server = createHttpServer(app);
  await listen(server, port);
  installShutdown(async () => { await closeServer(server); await connection.close(); });
  process.stdout.write(`READY replica-${replica}\n`);
}

async function runProxy(): Promise<void> {
  const port = numberEnv('ONBOARDING_BROWSER_PORT');
  const first = new URL(required('ONBOARDING_BROWSER_REPLICA_A'));
  const second = new URL(required('ONBOARDING_BROWSER_REPLICA_B'));
  const server = createHttpsServer({ key: readFileSync(required('ONBOARDING_BROWSER_TLS_KEY')),
    cert: readFileSync(required('ONBOARDING_BROWSER_TLS_CERT')) }, (req, res) => {
    if (req.url?.startsWith('/__fixture')) { res.writeHead(404).end(); return; }
    if (req.url === '/api/v1/auth/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<!doctype html><html lang="en"><title>Sign in</title><body><h1>Account activated</h1></body></html>'); return;
    }
    const target = route(req.url ?? '/') ? second : first;
    const forwarded = httpRequest({ protocol: target.protocol, hostname: target.hostname, port: target.port,
      method: req.method, path: req.url, headers: req.headers }, upstream => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(res);
    });
    forwarded.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(forwarded);
  });
  await listen(server, port);
  installShutdown(() => closeServer(server));
  process.stdout.write('READY proxy\n');
}

function route(path: string): boolean {
  return path === '/auth/onboarding/exchange' || path === '/auth/onboarding/github/start';
}
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }
function numberEnv(name: string): number { const value = Number(required(name)); if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${name}`); return value; }
function authorized(presented: string | undefined, expected: string): boolean {
  if (!presented) return false; const left = Buffer.from(presented), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function listen(server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
}
function closeServer(server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}
function installShutdown(close: () => Promise<void>): void {
  const shutdown = () => { void close().finally(() => process.exit(0)); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}
