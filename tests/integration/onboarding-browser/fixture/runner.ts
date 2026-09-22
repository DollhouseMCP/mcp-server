import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest,
  type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
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
import { buildContentSecurityPolicy } from '../../../../dist/auth/embedded-as/securityHeaders.js';
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
    const requestUrl = fetchRequestUrl(url);
    if (requestUrl === 'https://github.com/login/oauth/access_token') {
      const body = init?.body as URLSearchParams;
      if (body.get('code') !== oauthCode || body.get('redirect_uri') !== `${origin}/auth/onboarding/github/callback` ||
          !authorization || createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== authorization.searchParams.get('code_challenge')) {
        return jsonResponse({ error: 'invalid_grant' }, 400);
      }
      return jsonResponse({ access_token: oauthToken, token_type: 'bearer' });
    }
    if (requestUrl !== 'https://api.github.com/user' || new Headers(init?.headers).get('Authorization') !== `Bearer ${oauthToken}`) {
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
  const origin = new URL(required('ONBOARDING_BROWSER_ORIGIN'));
  const first = loopbackEndpoint('ONBOARDING_BROWSER_REPLICA_A');
  const second = loopbackEndpoint('ONBOARDING_BROWSER_REPLICA_B');
  const server = createHttpsServer({ key: readFileSync(required('ONBOARDING_BROWSER_TLS_KEY')),
    cert: readFileSync(required('ONBOARDING_BROWSER_TLS_CERT')) }, (req, res) => {
    const destination = proxyDestination(req.method, req.url);
    if (!destination) { res.writeHead(404).end(); return; }
    if (destination.kind === 'login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': buildContentSecurityPolicy('AAAAAAAAAAAAAAAAAAAAAA') });
      res.end('<!doctype html><html lang="en"><title>Sign in</title><body><h1>Account activated</h1></body></html>'); return;
    }
    const target = destination.replica === 'second' ? second : first;
    const forwarded = httpRequest({ protocol: 'http:', hostname: '127.0.0.1', port: target.port,
      method: destination.method, path: destination.path, headers: proxyRequestHeaders(req.headers, origin) }, upstream => {
      const status = safeUpstreamStatus(upstream.statusCode, upstream.headers.location);
      if (status === 502) {
        upstream.resume();
        res.writeHead(502).end();
        return;
      }
      const responseHeaders = proxyResponseHeaders(upstream.headers, status);
      if (!responseHeaders) {
        upstream.resume();
        res.writeHead(502).end();
        return;
      }
      res.writeHead(status, responseHeaders);
      upstream.pipe(res);
    });
    forwarded.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(forwarded);
  });
  await listen(server, port);
  installShutdown(() => closeServer(server));
  process.stdout.write('READY proxy\n');
}

type ProxyDestination = { kind: 'login' } | {
  kind: 'upstream'; replica: 'first' | 'second'; method: 'GET' | 'POST'; path: string;
};
const STATIC_PROXY_DESTINATIONS = new Map<string, ProxyDestination>([
  ['GET /api/v1/auth/login', { kind: 'login' }],
  ['GET /auth/onboarding/invitation', { kind: 'upstream', replica: 'first', method: 'GET', path: '/auth/onboarding/invitation' }],
  ['GET /auth/onboarding/context', { kind: 'upstream', replica: 'first', method: 'GET', path: '/auth/onboarding/context' }],
  ['GET /auth/onboarding/status', { kind: 'upstream', replica: 'first', method: 'GET', path: '/auth/onboarding/status' }],
  ['POST /auth/onboarding/bootstrap', { kind: 'upstream', replica: 'first', method: 'POST', path: '/auth/onboarding/bootstrap' }],
  ['POST /auth/onboarding/logout', { kind: 'upstream', replica: 'first', method: 'POST', path: '/auth/onboarding/logout' }],
  ['POST /auth/onboarding/exchange', { kind: 'upstream', replica: 'second', method: 'POST', path: '/auth/onboarding/exchange' }],
  ['POST /auth/onboarding/github/start', { kind: 'upstream', replica: 'second', method: 'POST', path: '/auth/onboarding/github/start' }],
]);
function proxyDestination(method: string | undefined, rawPath: string | undefined): ProxyDestination | null {
  if (!rawPath || rawPath.length > 4_096 || !rawPath.startsWith('/')) return null;
  let url: URL;
  try { url = new URL(rawPath, 'https://onboarding.fixture.invalid'); } catch { return null; }
  if (url.origin !== 'https://onboarding.fixture.invalid' || url.hash || url.username || url.password) return null;
  const destination = url.search === '' ? STATIC_PROXY_DESTINATIONS.get(`${method} ${url.pathname}`) : undefined;
  if (destination) return destination;
  return method === 'GET' && url.pathname === '/auth/onboarding/github/callback' ? callbackDestination(url) : null;
}
function callbackDestination(url: URL): ProxyDestination | null {
  const states = url.searchParams.getAll('state');
  const codes = url.searchParams.getAll('code');
  const errors = url.searchParams.getAll('error');
  const issuers = url.searchParams.getAll('iss');
  if (issuers.length > 1 || (issuers.length === 1 && issuers[0] !== 'https://github.com/login/oauth')) return null;
  if ([...url.searchParams].length !== 2 + issuers.length || states.length !== 1 || states[0].length === 0 || states[0].length > 512 ||
      (codes.length === 1) === (errors.length === 1) || codes.length > 1 || errors.length > 1) return null;
  const parameter = codes.length === 1 ? 'code' : 'error';
  const value = codes[0] ?? errors[0];
  const maximum = parameter === 'code' ? 2_048 : 256;
  if (!value || value.length > maximum || /[\s\p{Cc}\p{Cf}]/u.test(value)) return null;
  const path = `/auth/onboarding/github/callback?state=${encodeURIComponent(states[0])}&${parameter}=${encodeURIComponent(value)}${issuers.length ? `&iss=${encodeURIComponent(issuers[0])}` : ''}`;
  return { kind: 'upstream', replica: 'first', method: 'GET', path };
}
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function numberEnv(name: string): number {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}
function authorized(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const left = Buffer.from(presented), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function fetchRequestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
function loopbackEndpoint(name: string): URL {
  const endpoint = new URL(required(name));
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
      endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error(`Invalid ${name}`);
  }
  return endpoint;
}
function proxyRequestHeaders(source: IncomingHttpHeaders, origin: URL): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { host: origin.host };
  const accept = boundedHeader(source.accept, 512);
  const contentType = boundedHeader(source['content-type'], 128);
  const cookie = boundedHeader(source.cookie, 8_192);
  const csrf = boundedHeader(source['x-onboarding-csrf'], 256);
  const contentLength = boundedHeader(source['content-length'], 16);
  if (accept) headers.accept = accept;
  if (contentType) headers['content-type'] = contentType;
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-onboarding-csrf'] = csrf;
  if (source.origin === origin.origin) headers.origin = origin.origin;
  if (contentLength && /^\d{1,4}$/.test(contentLength) && Number(contentLength) <= 2_048) {
    headers['content-length'] = contentLength;
  }
  return headers;
}
function proxyResponseHeaders(source: IncomingHttpHeaders, status: number): OutgoingHttpHeaders | null {
  const headers: OutgoingHttpHeaders = {};
  const contentType = boundedHeader(source['content-type'], 256);
  const cacheControl = boundedHeader(source['cache-control'], 256);
  const contentSecurityPolicy = rebuildContentSecurityPolicy(source['content-security-policy']);
  const referrerPolicy = boundedHeader(source['referrer-policy'], 256);
  const contentTypeOptions = boundedHeader(source['x-content-type-options'], 64);
  const frameOptions = boundedHeader(source['x-frame-options'], 64);
  const permissionsPolicy = boundedHeader(source['permissions-policy'], 2_048);
  if (contentType) headers['content-type'] = contentType;
  if (cacheControl) headers['cache-control'] = cacheControl;
  if (!contentSecurityPolicy) return null;
  headers['content-security-policy'] = contentSecurityPolicy;
  if (referrerPolicy) headers['referrer-policy'] = referrerPolicy;
  if (contentTypeOptions) headers['x-content-type-options'] = contentTypeOptions;
  if (frameOptions) headers['x-frame-options'] = frameOptions;
  if (permissionsPolicy) headers['permissions-policy'] = permissionsPolicy;
  const cookies = source['set-cookie']?.filter(value => boundedHeader(value, 4_096) !== undefined).slice(0, 8);
  if (cookies?.length) headers['set-cookie'] = cookies;
  if (status === 303) headers.location = '/api/v1/auth/login';
  return headers;
}
function rebuildContentSecurityPolicy(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) return undefined;
  const match = /(?:^|; )style-src 'self' 'nonce-([A-Za-z0-9_-]{22})'$/.exec(value);
  if (!match) return undefined;
  const bytes = Buffer.from(match[1], 'base64url');
  const canonicalNonce = bytes.toString('base64url');
  if (bytes.length !== 16 || canonicalNonce !== match[1]) return undefined;
  const expected = buildContentSecurityPolicy(canonicalNonce);
  const expectedWithScriptNonce = expected.replace("script-src 'none'", `script-src 'nonce-${canonicalNonce}'`);
  if (value === expected) return expected;
  return value === expectedWithScriptNonce ? expectedWithScriptNonce : undefined;
}
function boundedHeader(value: string | string[] | undefined, maximum: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\r\n]/.test(value)) return undefined;
  return value;
}
function safeUpstreamStatus(status: number | undefined, location: string | undefined): number {
  if (!status || status < 200 || status > 599) return 502;
  if ([301, 302, 303, 307, 308].includes(status)) {
    return status === 303 && location === '/api/v1/auth/login' ? 303 : 502;
  }
  return location === undefined ? status : 502;
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
