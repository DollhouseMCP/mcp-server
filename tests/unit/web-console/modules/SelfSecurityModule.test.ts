import { describe, expect, it } from '@jest/globals';

import {
  createSelfSecurityModule,
  InMemoryConsoleFactorStore,
  projectSelfSecurityFactors,
  type ConsoleRequest,
  type ConsoleRouteDefinition,
} from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const OTHER_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const FACTOR_ID = '218f3d47-73ae-7f10-a0de-0742618d4fb3';
const PRIMARY_SUB = 'github_user-7';
const ENROLLED_AT = new Date('2026-05-28T09:00:00.000Z');
const SELF_CAPABILITY = 'console:self';
const FACTORS_PATH = '/api/v1/me/security/factors';
const ENROLL_PATH = '/api/v1/me/security/factors/enroll/totp';
const DISABLE_PATH = '/api/v1/me/security/factors/disable/totp';

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

describe('SelfSecurityModule', () => {
  it('registers self-security factor descriptors', () => {
    const module = createSelfSecurityModule({ factorStore: new InMemoryConsoleFactorStore() });

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
    const module = createSelfSecurityModule({ factorStore: new InMemoryConsoleFactorStore() });
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
    const module = createSelfSecurityModule({ factorStore: await enrolledFactorStore() });
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
    const module = createSelfSecurityModule({ factorStore: await enrolledFactorStore() });
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
    const module = createSelfSecurityModule({ factorStore: new InMemoryConsoleFactorStore() });

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
    const module = createSelfSecurityModule({ factorStore: new InMemoryConsoleFactorStore() });
    const req = consoleRequest({ consoleAuthentication: undefined });

    await expect(findRoute(module.routes, FACTORS_PATH).handler(req))
      .rejects.toThrow('Console authentication middleware has not run');
    expect(() => {
      void findRoute(module.routes, ENROLL_PATH).handler(req);
    })
      .toThrow('Console authentication middleware has not run');
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
});
