import { describe, expect, it } from '@jest/globals';

import {
  ConsoleModuleRegistry,
  InMemoryConsoleAccountAdminStore,
  createAccountAdminModule,
  type ConsoleRouteDefinition,
  type ConsoleRequest,
} from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const ACCOUNT_CORRELATION_ID = '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8';
const NOW = new Date('2026-05-27T14:00:00.000Z');
const LAST_LOGIN = new Date('2026-05-27T13:00:00.000Z');

function store(): InMemoryConsoleAccountAdminStore {
  return new InMemoryConsoleAccountAdminStore([{
    userId: USER_ID,
    primarySub: 'github_user-7',
    username: 'alice',
    displayName: 'Alice Example',
    email: 'alice@example.test',
    emailVerified: true,
    authMethods: ['github'],
    roles: ['account_admin'],
    disabledAt: null,
    createdAt: NOW,
    lastLoginAt: LAST_LOGIN,
    adminFactorEnrolled: true,
    accountCorrelationId: ACCOUNT_CORRELATION_ID,
    authzVersion: 3,
  }]);
}

function findRoute(routes: readonly ConsoleRouteDefinition[], path: string): ConsoleRouteDefinition {
  const route = routes.find(candidate => candidate.path === path);
  if (!route) throw new Error(`missing test route ${path}`);
  return route;
}

function consoleRequest(overrides: Partial<Pick<ConsoleRequest, 'params' | 'query'>> = {}): ConsoleRequest {
  return {
    params: {},
    query: {},
    ...overrides,
  } as ConsoleRequest;
}

describe('AccountAdminModule', () => {
  it('registers read-only account-admin routes with account metadata privacy policy', () => {
    const registry = new ConsoleModuleRegistry();

    registry.register(createAccountAdminModule({ accountAdminStore: store() }));

    expect(registry.createRouteManifest().routes).toEqual([
      {
        moduleId: 'accountAdmin',
        method: 'GET',
        path: '/api/v1/admin/accounts/users',
        audience: 'admin',
        requiredCapability: 'console:admin:accounts',
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: 'account_metadata',
        idempotency: 'not_applicable',
        auditOperation: 'accounts.users.list',
      },
      {
        moduleId: 'accountAdmin',
        method: 'GET',
        path: '/api/v1/admin/accounts/users/:user_id',
        audience: 'admin',
        requiredCapability: 'console:admin:accounts',
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: 'account_metadata',
        idempotency: 'not_applicable',
        auditOperation: 'accounts.users.show',
      },
      {
        moduleId: 'accountAdmin',
        method: 'GET',
        path: '/api/v1/admin/accounts/users/:user_id/roles',
        audience: 'admin',
        requiredCapability: 'console:admin:accounts',
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: 'account_metadata',
        idempotency: 'not_applicable',
        auditOperation: 'accounts.roles.list',
      },
      {
        moduleId: 'accountAdmin',
        method: 'GET',
        path: '/api/v1/admin/accounts/correlations/:account_correlation_id',
        audience: 'admin',
        requiredCapability: 'console:admin:accounts',
        ownership: 'none',
        elevation: 'admin_5m',
        privacyClass: 'account_metadata',
        idempotency: 'not_applicable',
        auditOperation: 'accounts.correlation.resolve',
      },
    ]);
  });

  it('serializes principal directory DTOs through the metadata allowlist', async () => {
    const module = createAccountAdminModule({ accountAdminStore: store() });
    const route = findRoute(module.routes, '/api/v1/admin/accounts/users');

    const result = await route.handler(consoleRequest({
      query: { limit: '20', sub: 'github_user-7' },
    }));
    const rawBody = result.body as Record<string, unknown>;
    const firstUser = (rawBody.users as Record<string, unknown>[])[0];
    firstUser.authz_version = 3;
    firstUser.account_correlation_id = ACCOUNT_CORRELATION_ID;
    firstUser.private_settings = { leaked: true };

    expect(route.privacyProjector?.(result.body)).toEqual({
      users: [{
        user_id: USER_ID,
        primary_sub: 'github_user-7',
        username: 'alice',
        display_name: 'Alice Example',
        email: 'alice@example.test',
        email_verified: true,
        auth_methods: ['github'],
        roles: ['account_admin'],
        disabled_at: null,
        created_at: NOW.toISOString(),
        last_login_at: LAST_LOGIN.toISOString(),
        admin_factor_enrolled: true,
      }],
    });
  });

  it('supports get user, role list, correlation resolution, and not-found responses', async () => {
    const module = createAccountAdminModule({ accountAdminStore: store() });
    const getUser = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id');
    const roles = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id/roles');
    const correlation = findRoute(module.routes, '/api/v1/admin/accounts/correlations/:account_correlation_id');

    await expect(getUser.handler(consoleRequest({ params: { user_id: USER_ID } })))
      .resolves.toMatchObject({ status: 200, body: { user_id: USER_ID } });
    const rolesResult = await roles.handler(consoleRequest({ params: { user_id: USER_ID } }));
    expect(rolesResult).toEqual({ status: 200, body: { user_id: USER_ID, roles: ['account_admin'] } });
    expect(roles.privacyProjector?.({
      ...(rolesResult.body as Record<string, unknown>),
      username: 'should-not-select-a-principal-branch',
      authz_version: 3,
    })).toEqual({ user_id: USER_ID, roles: ['account_admin'] });
    await expect(correlation.handler(consoleRequest({
      params: { account_correlation_id: ACCOUNT_CORRELATION_ID },
    }))).resolves.toMatchObject({ status: 200, body: { user_id: USER_ID } });
    await expect(correlation.handler(consoleRequest({
      params: { account_correlation_id: '11df9917-b534-4014-a03f-e2eb1f0c6fef' },
    }))).resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
    await expect(getUser.handler(consoleRequest({
      params: { user_id: '11df9917-b534-4014-a03f-e2eb1f0c6fef' },
    }))).resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
  });

  it('rejects malformed list query parameters before hitting the store', async () => {
    const module = createAccountAdminModule({ accountAdminStore: store() });
    const route = findRoute(module.routes, '/api/v1/admin/accounts/users');

    await expect(route.handler(consoleRequest({ query: { limit: 'NaN' } })))
      .resolves.toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    await expect(route.handler(consoleRequest({ query: { sub: ['github_user-7'] } })))
      .resolves.toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    await expect(route.handler(consoleRequest({ query: { limit: '0' } })))
      .rejects.toThrow('principal directory limit must be between 1 and 200');
  });

  it('lets kernel mapping handle malformed UUID path parameters', async () => {
    const module = createAccountAdminModule({ accountAdminStore: store() });
    const getUser = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id');
    const correlation = findRoute(module.routes, '/api/v1/admin/accounts/correlations/:account_correlation_id');

    await expect(getUser.handler(consoleRequest({ params: { user_id: 'alice' } })))
      .rejects.toThrow('userId must be a UUID');
    await expect(correlation.handler(consoleRequest({ params: { account_correlation_id: 'alice' } })))
      .rejects.toThrow('accountCorrelationId must be a UUID');
  });
});
