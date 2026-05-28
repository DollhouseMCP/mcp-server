import { describe, expect, it } from '@jest/globals';

import {
  createSelfSecurityModule,
  encodeSessionId,
  InMemoryConsoleFactorStore,
  InMemoryConsoleSessionStore,
  projectSelfSecurityFactors,
  projectSelfSecuritySessions,
  type ConsoleRequest,
  type ConsoleRouteDefinition,
  type ConsoleSessionRecord,
} from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const OTHER_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const FACTOR_ID = '218f3d47-73ae-7f10-a0de-0742618d4fb3';
const PRIMARY_SUB = 'github_user-7';
const ENROLLED_AT = new Date('2026-05-28T09:00:00.000Z');
const SELF_CAPABILITY = 'console:self';
const FACTORS_PATH = '/api/v1/me/security/factors';
const SECURITY_SESSIONS_PATH = '/api/v1/me/security/sessions';
const SECURITY_SESSION_PATH = '/api/v1/me/security/sessions/:session_id';
const REVOKE_OTHERS_PATH = '/api/v1/me/security/sessions/revoke-all-others';
const ENROLL_PATH = '/api/v1/me/security/factors/enroll/totp';
const DISABLE_PATH = '/api/v1/me/security/factors/disable/totp';
const CREATED_AT_ISO = '2026-05-28T08:00:00.000Z';
const LAST_USED_AT_ISO = '2026-05-28T09:00:00.000Z';
const IDLE_EXPIRES_AT_ISO = '2026-05-29T09:00:00.000Z';
const ABSOLUTE_EXPIRES_AT_ISO = '2026-06-28T09:00:00.000Z';
const LAST_IP = '203.0.113.10';
const NOW = new Date('2026-05-28T10:00:00.000Z');
const ELEVATED_UNTIL = new Date('2026-05-28T10:05:00.000Z');
const AUTH_MIDDLEWARE_ERROR = 'Console authentication middleware has not run';

function authenticatedContext(userId = USER_ID): NonNullable<ConsoleRequest['consoleAuthentication']> {
  return {
    sessionIdHash: Buffer.alloc(32, 7),
    userId,
    authSub: PRIMARY_SUB,
    authzVersion: 3,
    grantedCapabilities: [SELF_CAPABILITY],
    elevation: null,
  };
}

function consoleRequest(overrides: Partial<ConsoleRequest> = {}): ConsoleRequest {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    consoleAuthentication: authenticatedContext(),
    ...overrides,
  } as ConsoleRequest;
}

function findRoute(
  routes: readonly ConsoleRouteDefinition[],
  path: string,
  method = 'GET',
): ConsoleRouteDefinition {
  const route = routes.find(candidate => candidate.path === path && candidate.method === method);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

async function enrolledFactorStore(): Promise<InMemoryConsoleFactorStore> {
  const factorStore = new InMemoryConsoleFactorStore();
  await factorStore.createTotpFactor({
    userId: USER_ID,
    factorId: FACTOR_ID,
    factorType: 'totp',
    secretCiphertext: Buffer.from('encrypted-secret'),
    enrolledAt: ENROLLED_AT,
    disabledAt: null,
    lastUsedAt: null,
  }, [
    Buffer.alloc(32, 1),
    Buffer.alloc(32, 2),
    Buffer.alloc(32, 3),
  ]);
  await factorStore.consumeBackupCode(USER_ID, FACTOR_ID, Buffer.alloc(32, 2), ENROLLED_AT);
  return factorStore;
}

function moduleFixture(options: {
  readonly factorStore?: InMemoryConsoleFactorStore;
  readonly sessionStore?: InMemoryConsoleSessionStore;
} = {}) {
  const factorStore = options.factorStore ?? new InMemoryConsoleFactorStore();
  const sessionStore = options.sessionStore ?? new InMemoryConsoleSessionStore();
  const module = createSelfSecurityModule({
    factorStore,
    sessionStore,
    now: () => NOW,
  });
  return { module, factorStore, sessionStore };
}

function sessionRecord(overrides: Partial<ConsoleSessionRecord> = {}): ConsoleSessionRecord {
  return {
    idHash: Buffer.alloc(32, 7),
    userId: USER_ID,
    authSub: PRIMARY_SUB,
    csrfTokenHash: Buffer.alloc(32, 17),
    grantedCapabilities: [SELF_CAPABILITY],
    elevation: null,
    createdAt: new Date(CREATED_AT_ISO),
    lastUsedAt: new Date(LAST_USED_AT_ISO),
    idleExpiresAt: new Date(IDLE_EXPIRES_AT_ISO),
    absoluteExpiresAt: new Date(ABSOLUTE_EXPIRES_AT_ISO),
    revokedAt: null,
    lastIp: LAST_IP,
    userAgent: 'Mozilla/5.0 test',
    ...overrides,
  };
}

describe('SelfSecurityModule', () => {
  it('registers self-security factor descriptors', () => {
    const { module } = moduleFixture();

    expect(module).toMatchObject({
      id: 'selfSecurity',
      apiVersion: 'v1',
      capabilities: [SELF_CAPABILITY],
    });
    expect(module.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'GET',
        path: FACTORS_PATH,
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        privacyClass: 'self_security',
        idempotency: 'not_applicable',
      }),
      expect.objectContaining({
        method: 'GET',
        path: SECURITY_SESSIONS_PATH,
        idempotency: 'not_applicable',
      }),
      expect.objectContaining({
        method: 'DELETE',
        path: SECURITY_SESSION_PATH,
        idempotency: 'required',
      }),
      expect.objectContaining({
        method: 'POST',
        path: REVOKE_OTHERS_PATH,
        idempotency: 'required',
      }),
      expect.objectContaining({
        method: 'GET',
        path: ENROLL_PATH,
        idempotency: 'not_applicable',
      }),
      expect.objectContaining({
        method: 'GET',
        path: DISABLE_PATH,
        idempotency: 'not_applicable',
      }),
    ]));
  });

  it('returns inactive factor status for the authenticated principal', async () => {
    const { module } = moduleFixture();
    const getFactors = findRoute(module.routes, FACTORS_PATH);

    const result = await getFactors.handler(consoleRequest());

    expect(result).toEqual({
      status: 200,
      body: {
        totp: {
          enrolled: false,
          enrolled_at: null,
          last_used_at: null,
          backup_codes_remaining: 0,
        },
        webauthn: { enrolled: false },
      },
    });
  });

  it('returns active TOTP factor status with remaining backup-code count', async () => {
    const { module } = moduleFixture({ factorStore: await enrolledFactorStore() });
    const getFactors = findRoute(module.routes, FACTORS_PATH);

    const result = await getFactors.handler(consoleRequest());

    expect(result.body).toEqual({
      totp: {
        enrolled: true,
        enrolled_at: ENROLLED_AT.toISOString(),
        last_used_at: null,
        backup_codes_remaining: 2,
      },
      webauthn: { enrolled: false },
    });
  });

  it('derives factor status from the session user id only', async () => {
    const { module } = moduleFixture({ factorStore: await enrolledFactorStore() });
    const getFactors = findRoute(module.routes, FACTORS_PATH);

    const result = await getFactors.handler(consoleRequest({
      params: { userId: USER_ID },
      consoleAuthentication: authenticatedContext(OTHER_USER_ID),
    }));

    expect(result.body).toEqual({
      totp: {
        enrolled: false,
        enrolled_at: null,
        last_used_at: null,
        backup_codes_remaining: 0,
      },
      webauthn: { enrolled: false },
    });
  });

  it('redirects to AS-owned TOTP enrollment and disablement routes', () => {
    const { module } = moduleFixture();

    expect(findRoute(module.routes, ENROLL_PATH).handler(consoleRequest())).toEqual({
      status: 302,
      redirectTo: '/auth/totp/enroll',
    });
    expect(findRoute(module.routes, DISABLE_PATH).handler(consoleRequest())).toEqual({
      status: 302,
      redirectTo: '/auth/totp/disable',
    });
  });

  it('requires console authentication for factor routes', async () => {
    const { module } = moduleFixture();
    const req = consoleRequest({ consoleAuthentication: undefined });

    await expect(findRoute(module.routes, FACTORS_PATH).handler(req))
      .rejects.toThrow(AUTH_MIDDLEWARE_ERROR);
    expect(() => {
      void findRoute(module.routes, ENROLL_PATH).handler(req);
    })
      .toThrow(AUTH_MIDDLEWARE_ERROR);
  });

  it('requires console authentication for browser session routes', async () => {
    const { module } = moduleFixture();
    const req = consoleRequest({ consoleAuthentication: undefined });

    await expect(findRoute(module.routes, SECURITY_SESSIONS_PATH).handler(req))
      .rejects.toThrow(AUTH_MIDDLEWARE_ERROR);
    await expect(findRoute(module.routes, SECURITY_SESSION_PATH, 'DELETE').handler(consoleRequest({
      consoleAuthentication: undefined,
      params: { session_id: encodeSessionId(Buffer.alloc(32, 7)) },
    }))).rejects.toThrow(AUTH_MIDDLEWARE_ERROR);
    await expect(findRoute(module.routes, REVOKE_OTHERS_PATH, 'POST').handler(req))
      .rejects.toThrow(AUTH_MIDDLEWARE_ERROR);
  });

  it('privacy-projects factor status through an allowlist', () => {
    expect(projectSelfSecurityFactors({
      totp: {
        enrolled: true,
        enrolled_at: ENROLLED_AT.toISOString(),
        last_used_at: null,
        backup_codes_remaining: 9,
        secret: 'must-not-leak',
      },
      webauthn: { enrolled: true },
      extra: 'must-not-leak',
    })).toEqual({
      totp: {
        enrolled: true,
        enrolled_at: ENROLLED_AT.toISOString(),
        last_used_at: null,
        backup_codes_remaining: 9,
      },
      webauthn: { enrolled: false },
    });
  });

  it('lists active browser sessions for the authenticated principal', async () => {
    const sessionStore = new InMemoryConsoleSessionStore();
    await sessionStore.create(sessionRecord());
    await sessionStore.create(sessionRecord({
      idHash: Buffer.alloc(32, 8),
      lastUsedAt: new Date('2026-05-28T09:30:00.000Z'),
      elevation: {
        capabilities: ['console:admin:security'],
        expiresAt: ELEVATED_UNTIL,
        acr: 'urn:dollhouse:acr:admin',
        amr: ['otp'],
        authTime: NOW,
      },
      grantedCapabilities: [SELF_CAPABILITY, 'console:admin:security'],
      userAgent: null,
    }));
    await sessionStore.create(sessionRecord({
      idHash: Buffer.alloc(32, 9),
      userId: OTHER_USER_ID,
    }));
    const { module } = moduleFixture({ sessionStore });

    const result = await findRoute(module.routes, SECURITY_SESSIONS_PATH).handler(consoleRequest());

    expect(result.body).toEqual({
      sessions: [{
        session_id: encodeSessionId(Buffer.alloc(32, 8)),
        current: false,
        created_at: CREATED_AT_ISO,
        last_used_at: '2026-05-28T09:30:00.000Z',
        idle_expires_at: IDLE_EXPIRES_AT_ISO,
        absolute_expires_at: ABSOLUTE_EXPIRES_AT_ISO,
        elevated_until: ELEVATED_UNTIL.toISOString(),
        last_ip: LAST_IP,
        user_agent: null,
      }, {
        session_id: encodeSessionId(Buffer.alloc(32, 7)),
        current: true,
        created_at: CREATED_AT_ISO,
        last_used_at: LAST_USED_AT_ISO,
        idle_expires_at: IDLE_EXPIRES_AT_ISO,
        absolute_expires_at: ABSOLUTE_EXPIRES_AT_ISO,
        elevated_until: null,
        last_ip: LAST_IP,
        user_agent: 'Mozilla/5.0 test',
      }],
      truncated: false,
      limit: 100,
    });
  });

  it('returns an empty browser session list when no active sessions exist', async () => {
    const { module } = moduleFixture();

    const result = await findRoute(module.routes, SECURITY_SESSIONS_PATH).handler(consoleRequest());

    expect(result.body).toEqual({
      sessions: [],
      truncated: false,
      limit: 100,
    });
  });

  it('signals truncated browser session lists', async () => {
    const sessionStore = new InMemoryConsoleSessionStore();
    for (let i = 0; i < 101; i += 1) {
      await sessionStore.create(sessionRecord({
        idHash: Buffer.alloc(32, i + 1),
        lastUsedAt: new Date(NOW.getTime() - i),
      }));
    }
    const { module } = moduleFixture({ sessionStore });

    const result = await findRoute(module.routes, SECURITY_SESSIONS_PATH).handler(consoleRequest());

    expect(result.body).toMatchObject({
      truncated: true,
      limit: 100,
    });
    expect((result.body as { sessions: unknown[] }).sessions).toHaveLength(100);
  });

  it('revokes one owned browser session by encoded session id', async () => {
    const sessionStore = new InMemoryConsoleSessionStore();
    const targetHash = Buffer.alloc(32, 8);
    await sessionStore.create(sessionRecord());
    await sessionStore.create(sessionRecord({ idHash: targetHash }));
    const { module } = moduleFixture({ sessionStore });
    const route = findRoute(module.routes, SECURITY_SESSION_PATH, 'DELETE');

    const result = await route.handler(consoleRequest({
      params: { session_id: encodeSessionId(targetHash) },
    }));

    expect(result).toEqual({
      status: 200,
      body: {
        session_id: encodeSessionId(targetHash),
        revoked: true,
        current_session_revoked: false,
      },
      cookies: undefined,
    });
    await expect(sessionStore.findActiveByIdHash(targetHash, NOW)).resolves.toBeNull();
    await expect(sessionStore.findActiveByIdHash(Buffer.alloc(32, 7), NOW)).resolves.not.toBeNull();
  });

  it('clears browser cookies when revoking the current browser session', async () => {
    const sessionStore = new InMemoryConsoleSessionStore();
    await sessionStore.create(sessionRecord());
    const { module } = moduleFixture({ sessionStore });
    const route = findRoute(module.routes, SECURITY_SESSION_PATH, 'DELETE');

    const result = await route.handler(consoleRequest({
      params: { session_id: encodeSessionId(Buffer.alloc(32, 7)) },
    }));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ current_session_revoked: true });
    expect(result.cookies).toEqual([
      { operation: 'clear', name: 'dh_session' },
      { operation: 'clear', name: 'dh_csrf' },
      { operation: 'clear', name: 'dh_login_state' },
    ]);
  });

  it('returns 404 for another user browser session', async () => {
    const sessionStore = new InMemoryConsoleSessionStore();
    const targetHash = Buffer.alloc(32, 9);
    await sessionStore.create(sessionRecord({ idHash: targetHash, userId: OTHER_USER_ID }));
    const { module } = moduleFixture({ sessionStore });
    const route = findRoute(module.routes, SECURITY_SESSION_PATH, 'DELETE');

    const result = await route.handler(consoleRequest({
      params: { session_id: encodeSessionId(targetHash) },
    }));

    expect(result).toMatchObject({
      status: 404,
      body: { code: 'session_not_found' },
    });
  });

  it('returns 404 for an already-revoked browser session', async () => {
    const sessionStore = new InMemoryConsoleSessionStore();
    const targetHash = Buffer.alloc(32, 8);
    await sessionStore.create(sessionRecord({ idHash: targetHash, revokedAt: NOW }));
    const { module } = moduleFixture({ sessionStore });
    const route = findRoute(module.routes, SECURITY_SESSION_PATH, 'DELETE');

    const result = await route.handler(consoleRequest({
      params: { session_id: encodeSessionId(targetHash) },
    }));

    expect(result).toMatchObject({
      status: 404,
      body: { code: 'session_not_found' },
    });
  });

  it('rejects malformed browser session ids', async () => {
    const { module } = moduleFixture();
    const route = findRoute(module.routes, SECURITY_SESSION_PATH, 'DELETE');

    const result = await route.handler(consoleRequest({ params: { session_id: 'not-base64url' } }));

    expect(result).toMatchObject({
      status: 400,
      body: { code: 'invalid_session_id' },
    });
  });

  it('revokes all other browser sessions and keeps current active', async () => {
    const sessionStore = new InMemoryConsoleSessionStore();
    await sessionStore.create(sessionRecord());
    await sessionStore.create(sessionRecord({ idHash: Buffer.alloc(32, 8) }));
    await sessionStore.create(sessionRecord({ idHash: Buffer.alloc(32, 9) }));
    const { module } = moduleFixture({ sessionStore });
    const route = findRoute(module.routes, REVOKE_OTHERS_PATH, 'POST');

    const result = await route.handler(consoleRequest());

    expect(result).toEqual({
      status: 200,
      body: { revoked: 2 },
    });
    await expect(sessionStore.findActiveByIdHash(Buffer.alloc(32, 7), NOW)).resolves.not.toBeNull();
    await expect(sessionStore.findActiveByIdHash(Buffer.alloc(32, 8), NOW)).resolves.toBeNull();
  });

  it('returns zero when revoking other sessions from a single active session', async () => {
    const sessionStore = new InMemoryConsoleSessionStore();
    await sessionStore.create(sessionRecord());
    const { module } = moduleFixture({ sessionStore });
    const route = findRoute(module.routes, REVOKE_OTHERS_PATH, 'POST');

    const result = await route.handler(consoleRequest());

    expect(result).toEqual({
      status: 200,
      body: { revoked: 0 },
    });
    await expect(sessionStore.findActiveByIdHash(Buffer.alloc(32, 7), NOW)).resolves.not.toBeNull();
  });

  it('privacy-projects browser sessions through an allowlist', () => {
    expect(projectSelfSecuritySessions({
      sessions: [{
        session_id: 'abc',
        current: true,
        created_at: CREATED_AT_ISO,
        last_used_at: LAST_USED_AT_ISO,
        idle_expires_at: IDLE_EXPIRES_AT_ISO,
        absolute_expires_at: ABSOLUTE_EXPIRES_AT_ISO,
        elevated_until: null,
        last_ip: LAST_IP,
        user_agent: 'UA',
        csrf_token_hash: 'must-not-leak',
      }],
      extra: 'must-not-leak',
    })).toEqual({
      sessions: [{
        session_id: 'abc',
        current: true,
        created_at: CREATED_AT_ISO,
        last_used_at: LAST_USED_AT_ISO,
        idle_expires_at: IDLE_EXPIRES_AT_ISO,
        absolute_expires_at: ABSOLUTE_EXPIRES_AT_ISO,
        elevated_until: null,
        last_ip: LAST_IP,
        user_agent: 'UA',
      }],
      truncated: false,
      limit: 0,
    });
  });
});
