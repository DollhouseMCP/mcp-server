import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import {
  assembleSecuredConsoleRouter,
  ConsoleAuthenticationDependencyUnavailableError,
  ConsoleModuleRegistry,
  HmacConsoleOpaqueValueService,
  InMemoryConsoleIdentityResolver,
  InMemoryAdminAuditWriter,
  InMemoryConsoleSessionStore,
  InMemoryConsoleAuthPolicyStore,
  InMemoryIdempotencyStore,
  InMemoryRuntimeSessionControlStore,
  ConsoleStoreValidationError,
  ConsoleProtectedCorrelationRateLimitDependencyError,
  ConsoleProtectedCorrelationRateLimiter,
  requireConsoleAuthentication,
  type ConsoleModuleDescriptor,
} from '../../../../src/web-console/index.js';
import { InMemoryRateLimitStore } from '../../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import type { ConsoleSessionRecord } from '../../../../src/web-console/stores/IConsoleSessionStore.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const AUTH_SUB = 'github_user-7';
const SESSION_VALUE = 'opaque-browser-session';
const CSRF_VALUE = 'opaque-csrf-token';
const ORIGIN = 'https://console.example.test';
const NOW = new Date('2026-05-26T12:00:00.000Z');
const IDLE_EXPIRY = new Date('2026-05-26T13:00:00.000Z');
const ABSOLUTE_EXPIRY = new Date('2026-05-27T12:00:00.000Z');
const OPAQUE_VALUES = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 7));
const SELF_CAPABILITY = 'console:self' as const;
const AUDIT_CAPABILITY = 'console:admin:audit' as const;
const CONTEXT_PATH = '/api/v1/me/context';
const CHANGE_PATH = '/api/v1/me/change';
const UNICODE_CHANGE_PREFIX = '/api/v1/me/unicode-change';
const HEALTH_PATH = '/api/v1/health/ready';
const OWNED_SESSION_ID = 'mcp-session-owned';
const OTHER_SESSION_ID = 'mcp-session-other';
const OWNED_SESSION_PATH = `/api/v1/me/sessions/${OWNED_SESSION_ID}/owned-fixture`;
const OTHER_SESSION_PATH = `/api/v1/me/sessions/${OTHER_SESSION_ID}/owned-fixture`;
const ADMIN_AUDIT_PATH = '/api/v1/admin/audit';
const ADMIN_EXPORT_PATH = '/api/v1/admin/audit/export';
const ADMIN_STREAM_PATH = '/api/v1/admin/audit/stream';
const ADMIN_FAILURE_PATH = '/api/v1/admin/audit/failure';
const ADMIN_MUTATION_PATH = '/api/v1/admin/audit/retry';
const ADMIN_TRANSACTION_MUTATION_PATH = '/api/v1/admin/audit/transaction-retry';
const ADMIN_FRESH_PATH = '/api/v1/admin/audit/fresh';
const ADMIN_CORRELATION_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb2';
const ADMIN_CORRELATION_PATH = `/api/v1/admin/audit/correlations/${ADMIN_CORRELATION_ID}`;
const INVALID_REQUEST_PATH = '/api/v1/me/invalid-request';
const ADMIN_ACR = 'urn:dollhouse:acr:admin-stepup';
const ELEVATED_EXPIRES = new Date('2026-05-26T12:30:00.000Z');
const RECENT_AUTH_TIME = new Date('2026-05-26T11:55:00.000Z');
const SESSION_CREATED = new Date('2026-05-26T10:00:00.000Z');
const CSRF_HEADER = 'X-CSRF-Token';
const CONSOLE_REQUEST_HEADER = 'X-Console-Request';
const IDEMPOTENCY_HEADER = 'Idempotency-Key';
const IDEMPOTENCY_KEY = 'a51d7564-c85e-4e11-b319-dbc156d26f70';

function fixtureModules(
  onChange?: () => void,
  onAdminMutation?: () => void,
  onProtectedCorrelation?: () => void,
): readonly ConsoleModuleDescriptor[] {
  return [{
    id: 'health_fixture',
    apiVersion: 'v1',
    capabilities: [],
    routes: [{
      method: 'GET',
      path: HEALTH_PATH,
      audience: 'public',
      requiredCapability: 'none',
      ownership: 'none',
      elevation: 'none',
      privacyClass: 'operational_allowlist',
      idempotency: 'not_applicable',
      handler: () => ({
        status: 503,
        body: {
          status: 'not_ready',
          ready: false,
          checked_at: NOW.toISOString(),
        },
      }),
    }],
  }, {
    id: 'me_fixture',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    routes: [{
      method: 'GET',
      path: CONTEXT_PATH,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      handler: req => {
        const authentication = requireConsoleAuthentication(req);
        return {
          status: 200,
          body: {
            userId: authentication.userId,
            authSub: authentication.authSub,
            capabilities: authentication.grantedCapabilities,
            hasRawSession: 'rawSession' in authentication,
            hasCsrfHash: 'csrfTokenHash' in authentication,
          },
        };
      },
    }, {
      method: 'GET',
      path: '/api/v1/me/sessions/:session_id/owned-fixture',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'owned_session',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      handler: req => ({
        status: 200,
        body: { session_id: req.params.session_id },
      }),
    }, {
      method: 'POST',
      path: CHANGE_PATH,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      handler: () => {
        onChange?.();
        return { status: 200, body: { changed: true } };
      },
    }, {
      method: 'POST',
      path: `${UNICODE_CHANGE_PREFIX}/:name`,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      pathParamValueNormalization: { name: 'nfc' },
      handler: req => {
        onChange?.();
        return { status: 200, body: { changed: true, name: req.params.name, query: req.query.q } };
      },
    }],
  }, {
    id: 'validation_fixture',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    routes: [{
      method: 'GET',
      path: INVALID_REQUEST_PATH,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      handler: () => {
        throw new ConsoleStoreValidationError('limit must be between 1 and 200');
      },
    }],
  }, {
    id: 'admin_fixture',
    apiVersion: 'v1',
    capabilities: [AUDIT_CAPABILITY],
    auditOperations: [
      { id: 'admin.audit.read' },
      { id: 'admin.audit.export' },
      { id: 'admin.audit.stream' },
      { id: 'admin.audit.failure' },
      { id: 'admin.audit.mutate' },
      { id: 'admin.audit.transaction_mutate' },
      { id: 'admin.audit.correlation' },
      { id: 'admin.audit.fresh' },
    ],
    routes: [{
      method: 'GET',
      path: ADMIN_AUDIT_PATH,
      audience: 'admin',
      requiredCapability: AUDIT_CAPABILITY,
      elevation: 'admin_30m',
      privacyClass: 'admin_audit',
      idempotency: 'not_applicable',
      auditOperation: 'admin.audit.read',
      privacyProjector: value => ({ audit: (value as { audit: boolean }).audit }),
      handler: () => ({ status: 200, body: { audit: true, rawPrivateDetail: 'never disclose' } }),
    }, {
      method: 'GET',
      path: ADMIN_EXPORT_PATH,
      audience: 'admin',
      requiredCapability: AUDIT_CAPABILITY,
      elevation: 'admin_5m',
      privacyClass: 'admin_audit',
      idempotency: 'not_applicable',
      auditOperation: 'admin.audit.export',
      privacyProjector: value => value,
      handler: () => ({ status: 200, body: { exported: true } }),
    }, {
      method: 'GET',
      path: ADMIN_FRESH_PATH,
      audience: 'admin',
      requiredCapability: AUDIT_CAPABILITY,
      elevation: 'admin_fresh',
      privacyClass: 'admin_audit',
      idempotency: 'not_applicable',
      auditOperation: 'admin.audit.fresh',
      privacyProjector: value => value,
      handler: () => ({ status: 200, body: { fresh: true } }),
    }, {
      method: 'GET',
      path: ADMIN_STREAM_PATH,
      audience: 'admin',
      requiredCapability: AUDIT_CAPABILITY,
      elevation: 'admin_5m',
      privacyClass: 'admin_audit',
      idempotency: 'not_applicable',
      auditOperation: 'admin.audit.stream',
      responseKind: 'sse',
      streamPolicy: {
        lastEventId: 'bounded',
        heartbeatMs: 60_000,
        revalidateMs: 10,
        maxLifetimeMs: 15 * 60_000,
        backpressureDrainTimeoutMs: 30_000,
        maxEventBytes: 65_536,
        maxLastEventIdBytes: 512,
      },
      privacyProjector: value => ({ visible: (value as { visible: boolean }).visible }),
      handler: () => ({
        status: 200,
        stream: {
          init: { visible: true, rawPrivate: 'hidden' },
          events: delayedStreamEvents([{ event: 'update', data: { visible: true, rawPrivate: 'hidden' } }], 50),
        },
      }),
    }, {
      method: 'GET',
      path: ADMIN_FAILURE_PATH,
      audience: 'admin',
      requiredCapability: AUDIT_CAPABILITY,
      elevation: 'admin_30m',
      privacyClass: 'admin_audit',
      idempotency: 'not_applicable',
      auditOperation: 'admin.audit.failure',
      privacyProjector: value => value,
      handler: () => {
        throw new Error('fixture admin execution failure');
      },
    }, {
      method: 'POST',
      path: ADMIN_MUTATION_PATH,
      audience: 'admin',
      requiredCapability: AUDIT_CAPABILITY,
      elevation: 'admin_30m',
      privacyClass: 'admin_audit',
      idempotency: 'required',
      auditOperation: 'admin.audit.mutate',
      privacyProjector: value => value,
      handler: () => {
        onAdminMutation?.();
        return { status: 200, body: { changed: true } };
      },
    }, {
      method: 'POST',
      path: ADMIN_TRANSACTION_MUTATION_PATH,
      audience: 'admin',
      requiredCapability: AUDIT_CAPABILITY,
      elevation: 'admin_30m',
      privacyClass: 'admin_audit',
      idempotency: 'required',
      auditOperation: 'admin.audit.transaction_mutate',
      auditExecution: 'handler_transaction',
      privacyProjector: value => value,
      handler: () => {
        onAdminMutation?.();
        return { status: 200, body: { changed: true } };
      },
    }, {
      method: 'GET',
      path: '/api/v1/admin/audit/correlations/:account_correlation_id',
      audience: 'admin',
      requiredCapability: AUDIT_CAPABILITY,
      elevation: 'admin_5m',
      privacyClass: 'admin_audit',
      idempotency: 'not_applicable',
      rateLimit: 'protected_correlation_resolution',
      auditOperation: 'admin.audit.correlation',
      privacyProjector: value => value,
      handler: () => {
        onProtectedCorrelation?.();
        return { status: 200, body: { resolved: true } };
      },
    }],
  }];
}

function record(overrides: Partial<ConsoleSessionRecord> = {}): ConsoleSessionRecord {
  return {
    idHash: OPAQUE_VALUES.hashOpaqueValue(SESSION_VALUE),
    userId: USER_ID,
    authSub: AUTH_SUB,
    csrfTokenHash: OPAQUE_VALUES.hashOpaqueValue(CSRF_VALUE),
    grantedCapabilities: [SELF_CAPABILITY],
    elevation: null,
    createdAt: NOW,
    lastUsedAt: NOW,
    idleExpiresAt: IDLE_EXPIRY,
    absoluteExpiresAt: ABSOLUTE_EXPIRY,
    revokedAt: null,
    lastIp: null,
    userAgent: null,
    ...overrides,
  };
}

async function buildApp(
  session: ConsoleSessionRecord | null = record(),
  resolver = new InMemoryConsoleIdentityResolver([{
    sub: AUTH_SUB,
    userId: USER_ID,
    disabledAt: null,
    authzVersion: 2,
  }]),
  reportInternalError?: (error: unknown, correlationId: string) => void,
  protectedCorrelationRateLimiter: ConsoleProtectedCorrelationRateLimiter | null = protectedCorrelationLimiter(),
  authPolicyStore = new InMemoryConsoleAuthPolicyStore(),
  nowProvider: () => Date = () => NOW,
) {
  const sessionStore = new InMemoryConsoleSessionStore();
  const runtimeStore = new InMemoryRuntimeSessionControlStore();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const onChange = jest.fn();
  const onAdminMutation = jest.fn();
  const onProtectedCorrelation = jest.fn();
  if (session) await sessionStore.create(session);
  await runtimeStore.registerPresence({
    sessionId: OWNED_SESSION_ID,
    userId: USER_ID,
    accountCorrelationId: '018f3d47-73ae-7f10-a0de-0742618d4fb3',
    replicaId: 'replica-a',
    transport: 'streamable-http',
    startedAt: NOW,
    lastActiveAt: NOW,
    leaseUntil: IDLE_EXPIRY,
  });
  await runtimeStore.registerPresence({
    sessionId: OTHER_SESSION_ID,
    userId: '118f3d47-73ae-7f10-a0de-0742618d4fb4',
    accountCorrelationId: '118f3d47-73ae-7f10-a0de-0742618d4fb5',
    replicaId: 'replica-b',
    transport: 'streamable-http',
    startedAt: NOW,
    lastActiveAt: NOW,
    leaseUntil: IDLE_EXPIRY,
  });
  const registry = new ConsoleModuleRegistry();
  fixtureModules(onChange, onAdminMutation, onProtectedCorrelation).forEach(module => registry.register(module));
  const adminAuditWriter = new InMemoryAdminAuditWriter();
  const app = express();
  app.use(express.json());
  app.use(assembleSecuredConsoleRouter(registry, {
    sessionStore,
    identityResolver: resolver,
    opaqueValues: OPAQUE_VALUES,
    consoleOrigin: ORIGIN,
    adminAuditWriter,
    idempotencyStore,
    runtimeStore,
    authPolicyStore,
    protectedCorrelationRateLimiter,
    idleTimeoutMs: 60 * 60 * 1000,
    now: nowProvider,
    reportInternalError,
  }));
  return {
    app,
    sessionStore,
    runtimeStore,
    adminAuditWriter,
    idempotencyStore,
    onChange,
    onAdminMutation,
    onProtectedCorrelation,
    authPolicyStore,
  };
}

function sessionCookie(): string {
  return `dh_session=${SESSION_VALUE}`;
}

function csrfCookies(): string[] {
  return [sessionCookie(), `dh_csrf=${CSRF_VALUE}`];
}

async function* delayedStreamEvents(
  events: readonly { readonly event: string; readonly data: unknown }[],
  delayMs: number,
): AsyncIterable<{ readonly event: string; readonly data: unknown }> {
  await new Promise(resolve => setTimeout(resolve, delayMs));
  for (const event of events) yield event;
}

function elevatedAuditSession(): ConsoleSessionRecord {
  return record({
    createdAt: SESSION_CREATED,
    grantedCapabilities: [SELF_CAPABILITY, AUDIT_CAPABILITY],
    elevation: {
      capabilities: [AUDIT_CAPABILITY],
      expiresAt: ELEVATED_EXPIRES,
      acr: ADMIN_ACR,
      amr: ['otp'],
      authTime: RECENT_AUTH_TIME,
    },
  });
}

function freshlyElevatedAuditSession(): ConsoleSessionRecord {
  return record({
    createdAt: SESSION_CREATED,
    grantedCapabilities: [SELF_CAPABILITY, AUDIT_CAPABILITY],
    elevation: {
      capabilities: [AUDIT_CAPABILITY],
      expiresAt: ELEVATED_EXPIRES,
      acr: ADMIN_ACR,
      amr: ['otp'],
      authTime: new Date('2026-05-26T11:56:00.000Z'),
    },
  });
}

function protectedCorrelationLimiter(): ConsoleProtectedCorrelationRateLimiter {
  return new ConsoleProtectedCorrelationRateLimiter({
    store: new InMemoryRateLimitStore(),
    selectorHmacKey: Buffer.alloc(32, 24),
    now: () => NOW,
  });
}

function adminMutationRequest(app: express.Express, key: string = IDEMPOTENCY_KEY) {
  return request(app).post(ADMIN_MUTATION_PATH)
    .set('Cookie', csrfCookies())
    .set(CSRF_HEADER, CSRF_VALUE)
    .set('Origin', ORIGIN)
    .set(CONSOLE_REQUEST_HEADER, '1')
    .set(IDEMPOTENCY_HEADER, key);
}

function adminTransactionMutationRequest(app: express.Express, key: string = IDEMPOTENCY_KEY) {
  return request(app).post(ADMIN_TRANSACTION_MUTATION_PATH)
    .set('Cookie', csrfCookies())
    .set(CSRF_HEADER, CSRF_VALUE)
    .set('Origin', ORIGIN)
    .set(CONSOLE_REQUEST_HEADER, '1')
    .set(IDEMPOTENCY_HEADER, key);
}

function nestedJson(depth: number): string {
  return '{"child":'.repeat(depth) + 'null' + '}'.repeat(depth);
}

describe('secured console router authentication', () => {
  it('serves public readiness without browser authentication', async () => {
    const { app, sessionStore } = await buildApp(null);
    const lookup = jest.spyOn(sessionStore, 'findActiveByIdHash');

    const response = await request(app).get(HEALTH_PATH);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: 'not_ready',
      ready: false,
      checked_at: NOW.toISOString(),
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('does not recursively normalize JSON bodies for public readiness routes', async () => {
    const { app, sessionStore } = await buildApp(null);
    const lookup = jest.spyOn(sessionStore, 'findActiveByIdHash');

    const response = await request(app).get(HEALTH_PATH)
      .set('Content-Type', 'application/json')
      .send(nestedJson(80));

    expect(response.status).toBe(503);
    expect(response.body.code).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('resolves an opaque session to canonical user context and sets security headers', async () => {
    const { app, sessionStore, adminAuditWriter } = await buildApp();
    const touch = jest.spyOn(sessionStore, 'touch');
    const lookup = jest.spyOn(sessionStore, 'findActiveByIdHash');

    const response = await request(app).get(CONTEXT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      userId: USER_ID,
      authSub: AUTH_SUB,
      capabilities: [SELF_CAPABILITY],
      hasRawSession: false,
      hasCsrfHash: false,
    });
    expect(lookup.mock.calls[0][0]).toEqual(OPAQUE_VALUES.hashOpaqueValue(SESSION_VALUE));
    expect(lookup.mock.calls[0][0]).not.toEqual(SESSION_VALUE);
    expect(touch).toHaveBeenCalledTimes(1);
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['permissions-policy']).toBe('geolocation=(), microphone=(), camera=()');
    expect(adminAuditWriter.getEvents()).toEqual([]);
  });

  it('allows owned-session routes only for sessions owned by the caller', async () => {
    const { app, runtimeStore } = await buildApp();
    const lookup = jest.spyOn(runtimeStore, 'findPresence');

    const accepted = await request(app).get(OWNED_SESSION_PATH).set('Cookie', sessionCookie());
    const rejected = await request(app).get(OTHER_SESSION_PATH).set('Cookie', sessionCookie());

    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ session_id: OWNED_SESSION_ID });
    expect(rejected.status).toBe(404);
    expect(rejected.body.code).toBe('not_found');
    expect(lookup).toHaveBeenCalledWith(OWNED_SESSION_ID, NOW);
    expect(lookup).toHaveBeenCalledWith(OTHER_SESSION_ID, NOW);
  });

  it('rejects owned-session routes for an unknown session with no presence', async () => {
    const { app } = await buildApp();

    const response = await request(app)
      .get('/api/v1/me/sessions/mcp-session-does-not-exist/owned-fixture')
      .set('Cookie', sessionCookie());

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('not_found');
  });

  it.each([
    ['missing cookie', null, undefined],
    ['unknown cookie', null, 'dh_session=not-known'],
    ['revoked session', record({ revokedAt: NOW }), sessionCookie()],
    ['expired idle session', record({ idleExpiresAt: NOW }), sessionCookie()],
    ['absolute-expired session', record({
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      lastUsedAt: new Date('2026-05-25T11:00:00.000Z'),
      idleExpiresAt: NOW,
      absoluteExpiresAt: NOW,
    }), sessionCookie()],
  ])('returns unauthenticated for %s', async (_label, session, cookie) => {
    const { app } = await buildApp(session);
    const call = request(app).get(CONTEXT_PATH);
    const response = cookie ? await call.set('Cookie', cookie) : await call;

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthenticated');
  });

  it('applies all security headers to authentication error responses', async () => {
    const { app } = await buildApp();

    const response = await request(app).get(CONTEXT_PATH);

    expect(response.status).toBe(401);
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['permissions-policy']).toBe('geolocation=(), microphone=(), camera=()');
  });

  it('authenticates protected routes before walking JSON request bodies', async () => {
    const { app } = await buildApp();

    const response = await request(app).post(CHANGE_PATH)
      .set('Content-Type', 'application/json')
      .send(nestedJson(80));

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthenticated');
  });

  it('fails closed when the login subject maps to a disabled principal', async () => {
    const resolver = new InMemoryConsoleIdentityResolver([{
      sub: AUTH_SUB,
      userId: USER_ID,
      disabledAt: NOW,
      authzVersion: 3,
    }]);
    const { app } = await buildApp(record(), resolver);

    const response = await request(app).get(CONTEXT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthenticated');
  });

  it.each([
    ['unmapped principal', new InMemoryConsoleIdentityResolver()],
    ['different canonical principal', new InMemoryConsoleIdentityResolver([{
      sub: AUTH_SUB,
      userId: '4a2ba146-14e5-427c-a279-7c15661254df',
      disabledAt: null,
      authzVersion: 2,
    }])],
  ])('fails closed for %s without touching the session', async (_label, resolver) => {
    const { app, sessionStore } = await buildApp(record(), resolver);
    const touch = jest.spyOn(sessionStore, 'touch');

    const response = await request(app).get(CONTEXT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(401);
    expect(touch).not.toHaveBeenCalled();
  });

  it('returns service unavailable only for an explicitly classified authentication dependency failure', async () => {
    const { app, sessionStore } = await buildApp();
    jest.spyOn(sessionStore, 'findActiveByIdHash').mockRejectedValue(
      new ConsoleAuthenticationDependencyUnavailableError('database unavailable'),
    );

    const response = await request(app).get(CONTEXT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(503);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body.code).toBe('service_unavailable');
    expect(response.body.instance).toBe(response.headers['x-correlation-id']);
  });

  it('routes unexpected authentication exceptions through the internal problem handler', async () => {
    const { app, sessionStore } = await buildApp();
    jest.spyOn(sessionStore, 'findActiveByIdHash').mockRejectedValue(new Error('broken invariant'));

    const response = await request(app).get(CONTEXT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('internal_error');
  });

  it('maps console validation errors to invalid-request problems without internal diagnostics', async () => {
    const reportInternalError = jest.fn();
    const { app } = await buildApp(record(), undefined, reportInternalError);

    const response = await request(app).get(INVALID_REQUEST_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).toMatchObject({
      code: 'invalid_request',
      detail: 'limit must be between 1 and 200',
    });
    expect(reportInternalError).not.toHaveBeenCalled();
  });

  it('fails closed if a session becomes inactive before its request touch completes', async () => {
    const { app, sessionStore } = await buildApp();
    jest.spyOn(sessionStore, 'touch').mockResolvedValue(false);
    jest.spyOn(sessionStore, 'findActiveByIdHash')
      .mockResolvedValueOnce(record())
      .mockResolvedValueOnce(null);

    const response = await request(app).get(CONTEXT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthenticated');
  });

  it('accepts a rejected stale touch when the session remains active after revalidation', async () => {
    const { app, sessionStore } = await buildApp();
    jest.spyOn(sessionStore, 'touch').mockResolvedValue(false);

    const response = await request(app).get(CONTEXT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(200);
  });
});

describe('secured console router browser protections', () => {
  it('accepts a protected mutation with CSRF binding, origin, and custom header', async () => {
    const { app, onChange } = await buildApp();
    const response = await request(app).post(CHANGE_PATH)
      .set('Cookie', csrfCookies())
      .set(CSRF_HEADER, CSRF_VALUE)
      .set('Origin', ORIGIN)
      .set(CONSOLE_REQUEST_HEADER, '1')
      .set(IDEMPOTENCY_HEADER, IDEMPOTENCY_KEY);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ changed: true });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing CSRF header', undefined, ORIGIN, '1', csrfCookies()],
    ['wrong CSRF value', 'wrong', ORIGIN, '1', csrfCookies()],
    ['unbound CSRF value', 'wrong', ORIGIN, '1', [sessionCookie(), 'dh_csrf=wrong']],
    ['wrong origin', CSRF_VALUE, 'https://evil.example', '1', csrfCookies()],
    ['missing custom header', CSRF_VALUE, ORIGIN, undefined, csrfCookies()],
    ['incorrect custom header', CSRF_VALUE, ORIGIN, 'true', csrfCookies()],
    ['duplicate CSRF cookie', CSRF_VALUE, ORIGIN, '1', [...csrfCookies(), `dh_csrf=${CSRF_VALUE}`]],
  ])('rejects %s', async (_label, csrf, origin, customHeader, cookies) => {
    const { app } = await buildApp();
    let call = request(app).post(CHANGE_PATH).set('Cookie', cookies);
    if (csrf) call = call.set(CSRF_HEADER, csrf);
    if (origin) call = call.set('Origin', origin);
    if (customHeader) call = call.set(CONSOLE_REQUEST_HEADER, customHeader);
    const response = await call;

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('csrf_failed');
  });

  it('accepts the same-origin fetch fallback only when Origin is absent', async () => {
    const { app } = await buildApp();
    const response = await request(app).post(CHANGE_PATH)
      .set('Cookie', csrfCookies())
      .set(CSRF_HEADER, CSRF_VALUE)
      .set('Sec-Fetch-Site', 'same-origin')
      .set(CONSOLE_REQUEST_HEADER, '1')
      .set(IDEMPOTENCY_HEADER, IDEMPOTENCY_KEY);

    expect(response.status).toBe(200);
  });

  it('fails closed when both Origin and same-origin fetch metadata are absent', async () => {
    const { app } = await buildApp();
    const response = await request(app).post(CHANGE_PATH)
      .set('Cookie', csrfCookies())
      .set(CSRF_HEADER, CSRF_VALUE)
      .set(CONSOLE_REQUEST_HEADER, '1');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('csrf_failed');
  });

  it('rejects folded multiple Origin header values', async () => {
    const { app } = await buildApp();
    const response = await request(app).post(CHANGE_PATH)
      .set('Cookie', csrfCookies())
      .set(CSRF_HEADER, CSRF_VALUE)
      .set('Origin', [ORIGIN, ORIGIN])
      .set(CONSOLE_REQUEST_HEADER, '1');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('csrf_failed');
  });

  it('does not require CSRF mutation headers for authenticated GET requests', async () => {
    const { app } = await buildApp();

    const response = await request(app).get(CONTEXT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(200);
  });

  it.each([
    ['wrong origin', 'https://evil.example', ''],
    ['query bearer token', ORIGIN, '?token=secret'],
  ])('rejects SSE stream requests with %s', async (_label, origin, suffix) => {
    const { app } = await buildApp(freshlyElevatedAuditSession());
    let call = request(app).get(`${ADMIN_STREAM_PATH}${suffix}`).set('Cookie', sessionCookie());
    if (origin) call = call.set('Origin', origin);

    const response = await call;

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('csrf_failed');
  });

  it('accepts SSE stream requests without Origin only for same-origin fetch metadata', async () => {
    const { app } = await buildApp(freshlyElevatedAuditSession());

    const response = await request(app).get(ADMIN_STREAM_PATH)
      .set('Cookie', sessionCookie())
      .set('Sec-Fetch-Site', 'same-origin');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
  });

  it('rejects SSE stream requests without Origin and same-origin fetch metadata', async () => {
    const { app } = await buildApp(freshlyElevatedAuditSession());

    const response = await request(app).get(ADMIN_STREAM_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('csrf_failed');
  });

  it('rejects folded multiple Origin values on SSE stream requests', async () => {
    const { app } = await buildApp(freshlyElevatedAuditSession());

    const response = await request(app).get(ADMIN_STREAM_PATH)
      .set('Cookie', sessionCookie())
      .set('Origin', [ORIGIN, ORIGIN])
      .set('Sec-Fetch-Site', 'same-origin');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('csrf_failed');
  });

  it('rejects duplicate session cookie values during authentication', async () => {
    const { app } = await buildApp();
    const response = await request(app).get(CONTEXT_PATH)
      .set('Cookie', [sessionCookie(), sessionCookie()]);

    expect(response.status).toBe(401);
  });

  it('requires one valid idempotency key on routes declaring required enforcement', async () => {
    const { app, onChange } = await buildApp();
    const response = await request(app).post(CHANGE_PATH)
      .set('Cookie', csrfCookies())
      .set(CSRF_HEADER, CSRF_VALUE)
      .set('Origin', ORIGIN)
      .set(CONSOLE_REQUEST_HEADER, '1');

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('validation_failed');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects a malformed idempotency key without invoking its handler', async () => {
    const { app, onChange } = await buildApp();
    const response = await request(app).post(CHANGE_PATH)
      .set('Cookie', csrfCookies())
      .set(CSRF_HEADER, CSRF_VALUE)
      .set('Origin', ORIGIN)
      .set(CONSOLE_REQUEST_HEADER, '1')
      .set(IDEMPOTENCY_HEADER, 'not-a-uuid');

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('validation_failed');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects an identical retry while its original idempotency claim remains in progress', async () => {
    const { app, idempotencyStore, onChange } = await buildApp();
    jest.spyOn(idempotencyStore, 'claim').mockResolvedValue({ kind: 'in_progress' });
    const response = await request(app).post(CHANGE_PATH)
      .set('Cookie', csrfCookies())
      .set(CSRF_HEADER, CSRF_VALUE)
      .set('Origin', ORIGIN)
      .set(CONSOLE_REQUEST_HEADER, '1')
      .set(IDEMPOTENCY_HEADER, IDEMPOTENCY_KEY);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('conflict');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('replays a completed canonical-equivalent mutation without invoking its handler twice', async () => {
    const { app, onChange } = await buildApp();
    const headers = {
      Cookie: csrfCookies(),
      [CSRF_HEADER]: CSRF_VALUE,
      Origin: ORIGIN,
      [CONSOLE_REQUEST_HEADER]: '1',
      [IDEMPOTENCY_HEADER]: IDEMPOTENCY_KEY,
    };

    const first = await request(app).post(`${CHANGE_PATH}?b=2&a=2&a=1`).set(headers).send({ b: 2, a: 1 });
    const replay = await request(app).post(`${CHANGE_PATH}?a=1&a=2&b=2`).set(headers).send({ a: 1, b: 2 });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ changed: true });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('replays Unicode-equivalent normalized targets without reporting idempotency mismatch', async () => {
    const { app, onChange } = await buildApp();
    const headers = {
      Cookie: csrfCookies(),
      [CSRF_HEADER]: CSRF_VALUE,
      Origin: ORIGIN,
      [CONSOLE_REQUEST_HEADER]: '1',
      [IDEMPOTENCY_HEADER]: IDEMPOTENCY_KEY,
    };
    const decomposedName = 'α-cafe\u0301';
    const composedName = 'α-café';
    const target = (name: string) =>
      `${UNICODE_CHANGE_PREFIX}/${encodeURIComponent(name)}?q=${encodeURIComponent(name)}`;

    const first = await request(app).post(target(decomposedName)).set(headers).send({ value: 1 });
    const replay = await request(app).post(target(composedName)).set(headers).send({ value: 1 });

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ changed: true, name: composedName, query: 'a-café' });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('rejects reused idempotency keys with a different body fingerprint', async () => {
    const { app, onChange } = await buildApp();
    const call = (body: unknown) => request(app).post(CHANGE_PATH)
      .set('Cookie', csrfCookies())
      .set(CSRF_HEADER, CSRF_VALUE)
      .set('Origin', ORIGIN)
      .set(CONSOLE_REQUEST_HEADER, '1')
      .set(IDEMPOTENCY_HEADER, IDEMPOTENCY_KEY)
      .send(body);

    expect((await call({ value: 1 })).status).toBe(200);
    const mismatched = await call({ value: 2 });

    expect(mismatched.status).toBe(422);
    expect(mismatched.body).toMatchObject({
      code: 'idempotency_key_mismatch',
      mismatch_field: 'request_body_fingerprint',
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('secured console router elevation', () => {
  it('returns step-up instructions when an admin route has no elevation', async () => {
    const { app } = await buildApp();
    const response = await request(app).get(ADMIN_AUDIT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: 'step_up_required',
      required_capability: AUDIT_CAPABILITY,
      required_acr: ADMIN_ACR,
      max_auth_age_seconds: 1800,
    });
  });

  it('projects and audit-writes an authorized administrative response', async () => {
    const { app, adminAuditWriter } = await buildApp(elevatedAuditSession());

    const response = await request(app).get(ADMIN_AUDIT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ audit: true });
    expect(response.body.rawPrivateDetail).toBeUndefined();
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      actorUserId: USER_ID,
      actorSub: AUTH_SUB,
      capability: AUDIT_CAPABILITY,
      elevationAcr: ADMIN_ACR,
      elevationAmr: ['otp'],
      elevationAuthTime: RECENT_AUTH_TIME,
      endpoint: `GET ${ADMIN_AUDIT_PATH}`,
      operation: 'admin.audit.read',
      argsRedacted: {},
      result: 'approved',
      errorCode: null,
    })]);
    expect(adminAuditWriter.getEvents()[0]?.actorConsoleSessionHash)
      .toEqual(OPAQUE_VALUES.hashOpaqueValue(SESSION_VALUE));
  });

  it('projects administrative SSE init and event payloads through the route allowlist', async () => {
    const { app } = await buildApp(freshlyElevatedAuditSession());

    const response = await request(app).get(ADMIN_STREAM_PATH).set('Cookie', sessionCookie()).set('Origin', ORIGIN);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('event: init');
    expect(response.text).toContain('data: {"visible":true}');
    expect(response.text).not.toContain('rawPrivate');
  });

  it('closes administrative SSE streams when periodic revalidation fails', async () => {
    const { app, sessionStore } = await buildApp(freshlyElevatedAuditSession());
    setTimeout(() => {
      void sessionStore.revoke(OPAQUE_VALUES.hashOpaqueValue(SESSION_VALUE), NOW);
    }, 25);

    const response = await request(app).get(ADMIN_STREAM_PATH).set('Cookie', sessionCookie()).set('Origin', ORIGIN);

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('"code":"unauthenticated"');
    expect(response.text).not.toContain('"rawPrivate"');
  });

  it('audit-writes an administrative idempotency replay without executing twice', async () => {
    const { app, adminAuditWriter, onAdminMutation } = await buildApp(elevatedAuditSession());

    expect((await adminMutationRequest(app).send({ request: true })).status).toBe(200);
    expect((await adminMutationRequest(app).send({ request: true })).status).toBe(200);

    expect(onAdminMutation).toHaveBeenCalledTimes(1);
    expect(adminAuditWriter.getEvents().map(event => event.result)).toEqual(['approved', 'replayed']);
  });

  it('leaves approved handler-transaction audit to the handler but audits idempotency replay', async () => {
    const { app, adminAuditWriter, onAdminMutation } = await buildApp(elevatedAuditSession());

    expect((await adminTransactionMutationRequest(app).send({ request: true })).status).toBe(200);
    expect(adminAuditWriter.getEvents()).toEqual([]);
    expect((await adminTransactionMutationRequest(app).send({ request: true })).status).toBe(200);

    expect(onAdminMutation).toHaveBeenCalledTimes(1);
    expect(adminAuditWriter.getEvents()).toEqual([
      expect.objectContaining({
        operation: 'admin.audit.transaction_mutate',
        result: 'replayed',
      }),
    ]);
  });

  it('audit-writes rejected and in-progress administrative idempotency attempts', async () => {
    const first = await buildApp(elevatedAuditSession());
    expect((await adminMutationRequest(first.app).send({ request: true })).status).toBe(200);
    expect((await adminMutationRequest(first.app).send({ request: false })).status).toBe(422);
    expect(first.adminAuditWriter.getEvents()).toEqual([
      expect.objectContaining({ result: 'approved', errorCode: null }),
      expect.objectContaining({ result: 'rejected', errorCode: 'idempotency_key_mismatch' }),
    ]);

    const pending = await buildApp(elevatedAuditSession());
    jest.spyOn(pending.idempotencyStore, 'claim').mockResolvedValue({ kind: 'in_progress' });
    expect((await adminMutationRequest(pending.app).send({ request: true })).status).toBe(409);
    expect(pending.onAdminMutation).not.toHaveBeenCalled();
    expect(pending.adminAuditWriter.getEvents()).toEqual([
      expect.objectContaining({ result: 'conflict', errorCode: 'conflict' }),
    ]);
  });

  it('requires new step-up when elevation authentication is stale', async () => {
    const { app } = await buildApp(record({
      createdAt: SESSION_CREATED,
      grantedCapabilities: [SELF_CAPABILITY, AUDIT_CAPABILITY],
      elevation: {
        capabilities: [AUDIT_CAPABILITY],
        expiresAt: ELEVATED_EXPIRES,
        acr: ADMIN_ACR,
        amr: ['otp'],
        authTime: new Date('2026-05-26T11:00:00.000Z'),
      },
    }));

    const response = await request(app).get(ADMIN_AUDIT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('step_up_required');
  });

  it.each([
    ['wrong ACR', {
      capabilities: [AUDIT_CAPABILITY],
      expiresAt: ELEVATED_EXPIRES,
      acr: 'urn:dollhouse:acr:ordinary',
      amr: ['otp'],
      authTime: RECENT_AUTH_TIME,
    }],
    ['expired elevation', {
      capabilities: [AUDIT_CAPABILITY],
      expiresAt: NOW,
      acr: ADMIN_ACR,
      amr: ['otp'],
      authTime: RECENT_AUTH_TIME,
    }],
  ])('requires step-up for %s evidence', async (_label, elevation) => {
    const { app } = await buildApp(record({
      createdAt: SESSION_CREATED,
      grantedCapabilities: [SELF_CAPABILITY, AUDIT_CAPABILITY],
      elevation,
    }));

    const response = await request(app).get(ADMIN_AUDIT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('step_up_required');
  });

  it('requires step-up when an elevation does not cover the routed capability', async () => {
    const { app } = await buildApp(record({
      createdAt: SESSION_CREATED,
      grantedCapabilities: [SELF_CAPABILITY, AUDIT_CAPABILITY, 'console:admin:security'],
      elevation: {
        capabilities: ['console:admin:security'],
        expiresAt: ELEVATED_EXPIRES,
        acr: ADMIN_ACR,
        amr: ['otp'],
        authTime: RECENT_AUTH_TIME,
      },
    }));

    const response = await request(app).get(ADMIN_AUDIT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('step_up_required');
  });

  it('fails closed if upstream session state provides elevation without OTP evidence', async () => {
    const { app, sessionStore } = await buildApp();
    jest.spyOn(sessionStore, 'findActiveByIdHash').mockResolvedValue(record({
      createdAt: SESSION_CREATED,
      grantedCapabilities: [SELF_CAPABILITY, AUDIT_CAPABILITY],
      elevation: {
        capabilities: [AUDIT_CAPABILITY],
        expiresAt: ELEVATED_EXPIRES,
        acr: ADMIN_ACR,
        amr: [],
        authTime: RECENT_AUTH_TIME,
      },
    }));
    jest.spyOn(sessionStore, 'touch').mockResolvedValue(true);

    const response = await request(app).get(ADMIN_AUDIT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('step_up_required');
  });

  it('enforces the five-minute elevation freshness policy for sensitive reads', async () => {
    const { app } = await buildApp(record({
      createdAt: SESSION_CREATED,
      grantedCapabilities: [SELF_CAPABILITY, AUDIT_CAPABILITY],
      elevation: {
        capabilities: [AUDIT_CAPABILITY],
        expiresAt: ELEVATED_EXPIRES,
        acr: ADMIN_ACR,
        amr: ['otp'],
        authTime: new Date('2026-05-26T11:54:00.000Z'),
      },
    }));

    const response = await request(app).get(ADMIN_EXPORT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(401);
    expect(response.body.max_auth_age_seconds).toBe(300);
  });

  it('enforces the configured admin elevation freshness ceiling', async () => {
    const authPolicyStore = new InMemoryConsoleAuthPolicyStore();
    await authPolicyStore.save({ maxAdminElevationSeconds: 120 });
    const { app } = await buildApp(record({
      createdAt: SESSION_CREATED,
      grantedCapabilities: [SELF_CAPABILITY, AUDIT_CAPABILITY],
      elevation: {
        capabilities: [AUDIT_CAPABILITY],
        expiresAt: ELEVATED_EXPIRES,
        acr: ADMIN_ACR,
        amr: ['otp'],
        authTime: new Date('2026-05-26T11:57:30.000Z'),
      },
    }), undefined, undefined, protectedCorrelationLimiter(), authPolicyStore);

    const response = await request(app).get(ADMIN_EXPORT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(401);
    expect(response.body.max_auth_age_seconds).toBe(120);
  });

  it('passes an admin_fresh route when the OTP proof is within sixty seconds', async () => {
    const { app } = await buildApp(record({
      createdAt: SESSION_CREATED,
      grantedCapabilities: [SELF_CAPABILITY, AUDIT_CAPABILITY],
      elevation: {
        capabilities: [AUDIT_CAPABILITY],
        expiresAt: ELEVATED_EXPIRES,
        acr: ADMIN_ACR,
        amr: ['otp'],
        authTime: new Date('2026-05-26T11:59:30.000Z'),
      },
    }));

    const response = await request(app).get(ADMIN_FRESH_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(200);
    expect(response.body.fresh).toBe(true);
  });

  it('enforces the sixty-second freshness policy for irreversible admin operations', async () => {
    const { app } = await buildApp(record({
      createdAt: SESSION_CREATED,
      grantedCapabilities: [SELF_CAPABILITY, AUDIT_CAPABILITY],
      elevation: {
        capabilities: [AUDIT_CAPABILITY],
        expiresAt: ELEVATED_EXPIRES,
        acr: ADMIN_ACR,
        amr: ['otp'],
        authTime: new Date('2026-05-26T11:58:00.000Z'),
      },
    }));

    const response = await request(app).get(ADMIN_FRESH_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('step_up_required');
    expect(response.body.max_auth_age_seconds).toBe(60);
  });

  it('slides the session idle window on an admin action but never refreshes the elevation freshness clock', async () => {
    const initialIdleExpiry = new Date('2026-05-26T12:10:00.000Z');
    const elevationAuthTime = new Date('2026-05-26T11:56:00.000Z');
    const { app, sessionStore } = await buildApp(record({
      createdAt: SESSION_CREATED,
      idleExpiresAt: initialIdleExpiry,
      grantedCapabilities: [SELF_CAPABILITY, AUDIT_CAPABILITY],
      elevation: {
        capabilities: [AUDIT_CAPABILITY],
        expiresAt: ELEVATED_EXPIRES,
        acr: ADMIN_ACR,
        amr: ['otp'],
        authTime: elevationAuthTime,
      },
    }));

    const response = await request(app).get(ADMIN_EXPORT_PATH).set('Cookie', sessionCookie());
    expect(response.status).toBe(200);

    const stored = await sessionStore.findActiveByIdHash(OPAQUE_VALUES.hashOpaqueValue(SESSION_VALUE), NOW);
    // The action slides the session idle window forward to now + idleTimeoutMs.
    expect(stored?.idleExpiresAt).toEqual(new Date('2026-05-26T13:00:00.000Z'));
    expect(stored?.idleExpiresAt.getTime()).toBeGreaterThan(initialIdleExpiry.getTime());
    // ...but leaves the elevation freshness clock (authTime) untouched — activity
    // must never extend a step-up proof.
    expect(stored?.elevation?.authTime).toEqual(elevationAuthTime);
  });

  it('lets elevation expire on schedule despite an intervening successful action', async () => {
    let clock = new Date('2026-05-26T12:00:00.000Z');
    const { app } = await buildApp(
      freshlyElevatedAuditSession(),
      undefined,
      undefined,
      undefined,
      undefined,
      () => clock,
    );

    // The OTP proof (11:56) is within the five-minute window at 12:00.
    const first = await request(app).get(ADMIN_EXPORT_PATH).set('Cookie', sessionCookie());
    expect(first.status).toBe(200);

    // Six minutes after the proof the elevation is stale; the earlier success did
    // not extend it. The session itself is still authenticated (idle slid forward),
    // so the failure is a step-up requirement, not an unauthenticated rejection.
    clock = new Date('2026-05-26T12:02:00.000Z');
    const second = await request(app).get(ADMIN_EXPORT_PATH).set('Cookie', sessionCookie());
    expect(second.status).toBe(401);
    expect(second.body.code).toBe('step_up_required');
  });

  it('audit-writes an authorized administrative handler failure without private output', async () => {
    const { app, adminAuditWriter } = await buildApp(record({
      createdAt: SESSION_CREATED,
      grantedCapabilities: [SELF_CAPABILITY, AUDIT_CAPABILITY],
      elevation: {
        capabilities: [AUDIT_CAPABILITY],
        expiresAt: ELEVATED_EXPIRES,
        acr: ADMIN_ACR,
        amr: ['otp'],
        authTime: RECENT_AUTH_TIME,
      },
    }));

    const response = await request(app).get(ADMIN_FAILURE_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('internal_error');
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: 'admin.audit.failure',
      argsRedacted: {},
      result: 'failed',
      errorCode: 'internal_error',
    })]);
  });

  it('does not return administrative success when its required audit write fails', async () => {
    const { app, adminAuditWriter } = await buildApp(record({
      createdAt: SESSION_CREATED,
      grantedCapabilities: [SELF_CAPABILITY, AUDIT_CAPABILITY],
      elevation: {
        capabilities: [AUDIT_CAPABILITY],
        expiresAt: ELEVATED_EXPIRES,
        acr: ADMIN_ACR,
        amr: ['otp'],
        authTime: RECENT_AUTH_TIME,
      },
    }));
    jest.spyOn(adminAuditWriter, 'write').mockRejectedValue(new Error('audit persistence unavailable'));

    const response = await request(app).get(ADMIN_AUDIT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('internal_error');
  });

  it('reports both the handler error and audit error when failure auditing also fails', async () => {
    const auditError = new Error('audit persistence unavailable');
    const reportInternalError = jest.fn();
    const { app, adminAuditWriter } = await buildApp(record({
      createdAt: SESSION_CREATED,
      grantedCapabilities: [SELF_CAPABILITY, AUDIT_CAPABILITY],
      elevation: {
        capabilities: [AUDIT_CAPABILITY],
        expiresAt: ELEVATED_EXPIRES,
        acr: ADMIN_ACR,
        amr: ['otp'],
        authTime: RECENT_AUTH_TIME,
      },
    }), undefined, reportInternalError);
    jest.spyOn(adminAuditWriter, 'write').mockRejectedValue(auditError);

    const response = await request(app).get(ADMIN_FAILURE_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(500);
    const reported = reportInternalError.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(AggregateError);
    expect((reported as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'fixture admin execution failure' }),
      auditError,
    ]);
  });
});

describe('secured console router rate limiting', () => {
  it('invokes protected correlation limiter before executing a protected route', async () => {
    const limiter = protectedCorrelationLimiter();
    const consume = jest.spyOn(limiter, 'consume');
    const { app, onProtectedCorrelation } = await buildApp(
      freshlyElevatedAuditSession(),
      undefined,
      undefined,
      limiter,
    );

    const response = await request(app).get(ADMIN_CORRELATION_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ resolved: true });
    expect(onProtectedCorrelation).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith({
      consoleSessionIdHash: OPAQUE_VALUES.hashOpaqueValue(SESSION_VALUE),
      ip: expect.any(String),
      accountCorrelationId: ADMIN_CORRELATION_ID,
    });
  });

  it('returns rate-limited problem details and does not invoke the handler when denied', async () => {
    const limiter = protectedCorrelationLimiter();
    jest.spyOn(limiter, 'consume').mockResolvedValue({
      allowed: false,
      attemptsRemaining: 7,
      windowResetsAt: new Date('2026-05-26T13:00:00.000Z'),
      retryAfterSeconds: 3600,
      exceededScopes: ['session'],
    });
    const { app, onProtectedCorrelation } = await buildApp(
      freshlyElevatedAuditSession(),
      undefined,
      undefined,
      limiter,
    );

    const response = await request(app).get(ADMIN_CORRELATION_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('3600');
    expect(response.body).toMatchObject({
      code: 'rate_limited',
      attempts_remaining: 7,
      window_resets_at: '2026-05-26T13:00:00.000Z',
      exceeded_scopes: ['session'],
    });
    expect(onProtectedCorrelation).not.toHaveBeenCalled();
  });

  it('does not consume protected budget before authentication succeeds', async () => {
    const limiter = protectedCorrelationLimiter();
    const consume = jest.spyOn(limiter, 'consume');
    const { app, onProtectedCorrelation } = await buildApp(
      freshlyElevatedAuditSession(),
      undefined,
      undefined,
      limiter,
    );

    const response = await request(app).get(ADMIN_CORRELATION_PATH);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthenticated');
    expect(consume).not.toHaveBeenCalled();
    expect(onProtectedCorrelation).not.toHaveBeenCalled();
  });

  it('authenticates protected routes before walking deeply nested JSON bodies', async () => {
    const { app, onChange } = await buildApp(record());
    const deepBody = `${'{"nested":'.repeat(80)}null${'}'.repeat(80)}`;

    const response = await request(app)
      .post(CHANGE_PATH)
      .set('Content-Type', 'application/json')
      .set(CSRF_HEADER, CSRF_VALUE)
      .set(CONSOLE_REQUEST_HEADER, '1')
      .set(IDEMPOTENCY_HEADER, IDEMPOTENCY_KEY)
      .send(deepBody);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthenticated');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('fails closed on protected rate-limit dependency errors', async () => {
    const limiter = protectedCorrelationLimiter();
    jest.spyOn(limiter, 'consume').mockRejectedValue(
      new ConsoleProtectedCorrelationRateLimitDependencyError('store unavailable'),
    );
    const { app, onProtectedCorrelation } = await buildApp(
      freshlyElevatedAuditSession(),
      undefined,
      undefined,
      limiter,
    );

    const response = await request(app).get(ADMIN_CORRELATION_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('service_unavailable');
    expect(onProtectedCorrelation).not.toHaveBeenCalled();
  });

  it('routes unexpected protected limiter errors through the kernel error handler', async () => {
    const limiter = protectedCorrelationLimiter();
    const error = new Error('unexpected limiter failure');
    jest.spyOn(limiter, 'consume').mockRejectedValue(error);
    const reportInternalError = jest.fn();
    const { app, onProtectedCorrelation } = await buildApp(
      freshlyElevatedAuditSession(),
      undefined,
      reportInternalError,
      limiter,
    );

    const response = await request(app).get(ADMIN_CORRELATION_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('internal_error');
    expect(reportInternalError).toHaveBeenCalledWith(error, expect.any(String));
    expect(onProtectedCorrelation).not.toHaveBeenCalled();
  });

  it('does not invoke the protected limiter for routes without a rate-limit policy', async () => {
    const limiter = protectedCorrelationLimiter();
    const consume = jest.spyOn(limiter, 'consume');
    const { app } = await buildApp(elevatedAuditSession(), undefined, undefined, limiter);

    const response = await request(app).get(ADMIN_AUDIT_PATH).set('Cookie', sessionCookie());

    expect(response.status).toBe(200);
    expect(consume).not.toHaveBeenCalled();
  });

  it('fails router assembly when a protected policy is declared without its limiter', async () => {
    await expect(buildApp(elevatedAuditSession(), undefined, undefined, null))
      .rejects.toThrow('protected_correlation_resolution route requires a protected correlation rate limiter');
  });
});
