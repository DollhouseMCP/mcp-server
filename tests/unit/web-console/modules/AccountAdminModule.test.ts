import { describe, expect, it } from '@jest/globals';

import type { IAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/IAuthStorageLayer.js';
import {
  ConsoleModuleRegistry,
  InMemoryAccountAdminMutationTransactionRunner,
  InMemoryAdminAuditWriter,
  InMemoryConsoleAccountAllowlistStore,
  InMemoryConsoleAccountAdminStore,
  InMemoryConsoleSessionStore,
  InMemoryConsoleSecurityInvalidationStore,
  InMemoryRuntimeSessionControlStore,
  createAccountAdminModule,
  type ConsoleRouteDefinition,
  type ConsoleRequest,
  type ConsoleSessionRecord,
  type IConsoleAccountInviteIssuer,
  type IOAuthGrantRevocationService,
} from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SECOND_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const UNKNOWN_USER_ID = '11df9917-b534-4014-a03f-e2eb1f0c6fef';
const ACCOUNT_CORRELATION_ID = '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8';
const SECOND_ACCOUNT_CORRELATION_ID = '0344c33e-8776-46fc-9547-e5282ce167fa';
const PRIMARY_SUB = 'github_user-7';
const ACCOUNT_ADMIN_ROLE = 'account_admin';
const ACCOUNT_DISABLE_PATH = '/api/v1/admin/accounts/users/:user_id/disable';
const ACCOUNT_ENABLE_PATH = '/api/v1/admin/accounts/users/:user_id/enable';
const ACCOUNT_INVITE_PATH = '/api/v1/admin/accounts/users/invite';
const ACCOUNT_ROLES_PATH = '/api/v1/admin/accounts/users/:user_id/roles';
const ACCOUNT_ROLE_GRANT_PATH = '/api/v1/admin/accounts/users/:user_id/roles/grant';
const ACCOUNT_ROLE_REVOKE_PATH = '/api/v1/admin/accounts/users/:user_id/roles/revoke';
const ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH = '/api/v1/admin/accounts/users/:user_id/credentials/revoke-all';
const ACCOUNT_ALLOWLIST_PATH = '/api/v1/admin/accounts/allowlist';
const ACCOUNT_ALLOWLIST_ITEM_PATH = '/api/v1/admin/accounts/allowlist/:id';
const ACCOUNT_BOOTSTRAP_PATH = '/api/v1/admin/accounts/bootstrap';
const SELF_CAPABILITY = 'console:self';
const ACCOUNT_ADMIN_CAPABILITY = 'console:admin:accounts';
const OPERATE_CAPABILITY = 'console:admin:operate';
const ACCOUNT_METADATA_PRIVACY = 'account_metadata';
const ADMIN_5M_ELEVATION = 'admin_5m';
const IDEMPOTENCY_REQUIRED = 'required';
const IDEMPOTENCY_NOT_APPLICABLE = 'not_applicable';
const AUDIT_USERS_DISABLE = 'accounts.users.disable';
const AUDIT_USERS_ENABLE = 'accounts.users.enable';
const AUDIT_USERS_INVITE = 'accounts.users.invite';
const AUDIT_USERS_CREDENTIALS_REVOKE_ALL = 'accounts.users.credentials.revoke_all';
const AUDIT_ALLOWLIST_ADD = 'accounts.allowlist.add';
const AUDIT_ROLES_GRANT = 'accounts.roles.grant';
const NOW = new Date('2026-05-27T14:00:00.000Z');
const LAST_LOGIN = new Date('2026-05-27T13:00:00.000Z');
const INVITE_EMAIL = 'bob@example.test';
const RUNTIME_SESSION_ID = 'mcp-session-incident';
const RUNTIME_REPLICA_ID = 'replica-a';
const MISSING_AUTHENTICATION_FIXTURE = 'missing authenticated fixture';

function store(): InMemoryConsoleAccountAdminStore {
  return new InMemoryConsoleAccountAdminStore([{
    userId: USER_ID,
    primarySub: PRIMARY_SUB,
    username: 'alice',
    displayName: 'Alice Example',
    email: 'alice@example.test',
    emailVerified: true,
    authMethods: ['github'],
    roles: [ACCOUNT_ADMIN_ROLE],
    disabledAt: null,
    createdAt: NOW,
    lastLoginAt: LAST_LOGIN,
    adminFactorEnrolled: true,
    accountCorrelationId: ACCOUNT_CORRELATION_ID,
    authzVersion: 3,
  }]);
}

async function principalFixture(
  overrides: Partial<NonNullable<Awaited<ReturnType<InMemoryConsoleAccountAdminStore['findPrincipal']>>>> = {},
) {
  const summary = await store().findPrincipal(USER_ID);
  if (!summary) throw new Error('missing principal fixture');
  return { ...summary, ...overrides };
}

function mutationFixture(
  principals = store(),
): {
  readonly accountAdminStore: InMemoryConsoleAccountAdminStore;
  readonly sessionStore: InMemoryConsoleSessionStore;
  readonly invalidationStore: InMemoryConsoleSecurityInvalidationStore;
  readonly adminAuditWriter: InMemoryAdminAuditWriter;
  readonly module: ReturnType<typeof createAccountAdminModule>;
} {
  const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
  const adminAuditWriter = new InMemoryAdminAuditWriter();
  const sessionStore = new InMemoryConsoleSessionStore();
  const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
  const module = createAccountAdminModule({
    accountAdminStore: principals,
    accountAllowlistStore,
    sessionStore,
    authStorage: authStorageFixture({ adminSub: PRIMARY_SUB }),
    accountInviteIssuer: accountInviteIssuer(),
    oauthGrantRevocationService: oauthGrantRevocationService(),
    enableAccountAllowlistRoutes: true,
    accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
      accountAdminStore: principals,
      accountAllowlistStore,
      securityInvalidationStore: invalidationStore,
      adminAuditWriter,
    }),
    now: () => NOW,
  });
  return { accountAdminStore: principals, sessionStore, invalidationStore, adminAuditWriter, module };
}

function authStorageFixture(overrides: {
  readonly completed?: boolean;
  readonly adminSub?: string;
  readonly completedAt?: number;
} = {}): IAuthStorageLayer {
  return {
    getBootstrapState() {
      return Promise.resolve({
        completed: overrides.completed ?? true,
        adminSub: overrides.adminSub,
        adminMethod: 'local-password',
        completedAt: overrides.completedAt ?? ((overrides.completed ?? true) ? NOW.getTime() : undefined),
      });
    },
  } as IAuthStorageLayer;
}

function accountInviteIssuer(overrides: Partial<{
  readonly userId: string;
  readonly primarySub: string;
  readonly inviteUrl: string;
}> = {}): IConsoleAccountInviteIssuer {
  return {
    async issueInvite(input) {
      await Promise.resolve();
      return {
        inviteUrl: overrides.inviteUrl ?? `https://console.example.test/invite/${input.username}`,
        expiresAt: new Date(input.issuedAt.getTime() + input.ttlMinutes * 60_000),
        userId: overrides.userId ?? SECOND_USER_ID,
        primarySub: overrides.primarySub ?? `local_${input.username}`,
      };
    },
  };
}

function oauthGrantRevocationService(overrides: {
  readonly fail?: boolean;
  readonly grantsRevoked?: number;
  readonly grantsDiscovered?: number;
  readonly subjectsProcessed?: number;
} = {}): IOAuthGrantRevocationService {
  return {
    async revokePrincipalGrants(input) {
      await Promise.resolve();
      if (overrides.fail) throw new Error('oauth unavailable');
      return {
        userId: input.userId,
        revokedAt: input.revokedAt,
        linkedSubjectsProcessed: overrides.subjectsProcessed ?? 1,
        oauthGrantFamiliesDiscovered: overrides.grantsDiscovered ?? overrides.grantsRevoked ?? 2,
        oauthGrantFamiliesRevoked: overrides.grantsRevoked ?? 2,
        subjects: [],
      };
    },
  };
}

class AutoAckRuntimeSessionControlStore extends InMemoryRuntimeSessionControlStore {
  override async createTerminationCommand(
    input: Parameters<InMemoryRuntimeSessionControlStore['createTerminationCommand']>[0],
  ): ReturnType<InMemoryRuntimeSessionControlStore['createTerminationCommand']> {
    const command = await super.createTerminationCommand(input);
    await this.acknowledgeCommand({
      commandId: command.commandId,
      replicaId: command.targetReplicaId,
      acknowledgedAt: NOW,
      result: 'terminated',
    });
    return command;
  }
}

class FailedAckRuntimeSessionControlStore extends InMemoryRuntimeSessionControlStore {
  override async createTerminationCommand(
    input: Parameters<InMemoryRuntimeSessionControlStore['createTerminationCommand']>[0],
  ): ReturnType<InMemoryRuntimeSessionControlStore['createTerminationCommand']> {
    const command = await super.createTerminationCommand(input);
    await this.acknowledgeCommand({
      commandId: command.commandId,
      replicaId: command.targetReplicaId,
      acknowledgedAt: NOW,
      result: 'failed',
      errorCode: 'local_termination_failed',
    });
    return command;
  }
}

class ThrowingRuntimeSessionControlStore extends InMemoryRuntimeSessionControlStore {
  override async listPresenceByUser(): ReturnType<InMemoryRuntimeSessionControlStore['listPresenceByUser']> {
    await Promise.resolve();
    throw new Error('runtime store unavailable');
  }
}

async function registerRuntimePresence(
  runtimeStore: InMemoryRuntimeSessionControlStore,
  userId = USER_ID,
  sessionId = RUNTIME_SESSION_ID,
): Promise<void> {
  await runtimeStore.registerPresence({
    sessionId,
    userId,
    accountCorrelationId: userId === USER_ID ? ACCOUNT_CORRELATION_ID : SECOND_ACCOUNT_CORRELATION_ID,
    replicaId: RUNTIME_REPLICA_ID,
    transport: 'streamable-http',
    startedAt: NOW,
    lastActiveAt: NOW,
    leaseUntil: new Date(NOW.getTime() + 300_000),
  });
}

function findRoute(
  routes: readonly ConsoleRouteDefinition[],
  path: string,
  method?: ConsoleRouteDefinition['method'],
): ConsoleRouteDefinition {
  const route = routes.find(candidate => candidate.path === path && (!method || candidate.method === method));
  if (!route) throw new Error(`missing test route ${path}`);
  return route;
}

function consoleRequest(overrides: Partial<ConsoleRequest> = {}): ConsoleRequest {
  return {
    params: {},
    query: {},
    body: {},
    ip: '127.0.0.1',
    get: (name: string) => name.toLowerCase() === 'user-agent' ? 'jest' : undefined,
    consoleContext: {
      correlationId: '94017d3c-7b7a-4e28-a3c2-701e0ea5471d',
      receivedAt: NOW,
    },
    consoleAuthentication: {
      sessionIdHash: Buffer.alloc(32, 7),
      userId: USER_ID,
      authSub: PRIMARY_SUB,
      authzVersion: 3,
      grantedCapabilities: [SELF_CAPABILITY, ACCOUNT_ADMIN_CAPABILITY],
      elevation: {
        capabilities: [ACCOUNT_ADMIN_CAPABILITY],
        expiresAt: new Date(NOW.getTime() + 300_000),
        acr: 'urn:dollhouse:acr:admin-stepup',
        amr: ['otp'],
        authTime: NOW,
      },
    },
    ...overrides,
  } as ConsoleRequest;
}

function sessionRecord(overrides: Partial<ConsoleSessionRecord> = {}): ConsoleSessionRecord {
  return {
    idHash: Buffer.alloc(32, 9),
    userId: USER_ID,
    authSub: PRIMARY_SUB,
    csrfTokenHash: Buffer.alloc(32, 8),
    grantedCapabilities: [SELF_CAPABILITY],
    elevation: null,
    createdAt: NOW,
    lastUsedAt: NOW,
    idleExpiresAt: new Date(NOW.getTime() + 86_400_000),
    absoluteExpiresAt: new Date(NOW.getTime() + 86_400_000 * 30),
    revokedAt: null,
    lastIp: '127.0.0.1',
    userAgent: 'jest',
    ...overrides,
  };
}

describe('AccountAdminModule', () => {
  it('registers read-only account-admin routes with account metadata privacy policy', () => {
    const registry = new ConsoleModuleRegistry();

    registry.register(mutationFixture().module);

    expect(registry.createRouteManifest().routes).toEqual([
      {
        moduleId: 'accountAdmin',
        method: 'GET',
        path: '/api/v1/admin/accounts/users',
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_NOT_APPLICABLE,
        auditOperation: 'accounts.users.list',
      },
      {
        moduleId: 'accountAdmin',
        method: 'GET',
        path: '/api/v1/admin/accounts/users/:user_id',
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_NOT_APPLICABLE,
        auditOperation: 'accounts.users.show',
      },
      {
        moduleId: 'accountAdmin',
        method: 'POST',
        path: ACCOUNT_INVITE_PATH,
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_REQUIRED,
        auditOperation: AUDIT_USERS_INVITE,
      },
      {
        moduleId: 'accountAdmin',
        method: 'POST',
        path: ACCOUNT_DISABLE_PATH,
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_REQUIRED,
        auditOperation: AUDIT_USERS_DISABLE,
      },
      {
        moduleId: 'accountAdmin',
        method: 'POST',
        path: ACCOUNT_ENABLE_PATH,
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_REQUIRED,
        auditOperation: AUDIT_USERS_ENABLE,
      },
      {
        moduleId: 'accountAdmin',
        method: 'DELETE',
        path: '/api/v1/admin/accounts/users/:user_id',
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: ADMIN_5M_ELEVATION,
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_REQUIRED,
        auditOperation: 'accounts.users.delete',
      },
      {
        moduleId: 'accountAdmin',
        method: 'GET',
        path: ACCOUNT_ROLES_PATH,
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_NOT_APPLICABLE,
        auditOperation: 'accounts.roles.list',
      },
      {
        moduleId: 'accountAdmin',
        method: 'PUT',
        path: ACCOUNT_ROLES_PATH,
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_REQUIRED,
        auditOperation: 'accounts.roles.replace',
      },
      {
        moduleId: 'accountAdmin',
        method: 'POST',
        path: ACCOUNT_ROLE_GRANT_PATH,
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_REQUIRED,
        auditOperation: AUDIT_ROLES_GRANT,
      },
      {
        moduleId: 'accountAdmin',
        method: 'POST',
        path: ACCOUNT_ROLE_REVOKE_PATH,
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_REQUIRED,
        auditOperation: 'accounts.roles.revoke',
      },
      {
        moduleId: 'accountAdmin',
        method: 'POST',
        path: ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH,
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: ADMIN_5M_ELEVATION,
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_REQUIRED,
        auditOperation: AUDIT_USERS_CREDENTIALS_REVOKE_ALL,
      },
      {
        moduleId: 'accountAdmin',
        method: 'GET',
        path: '/api/v1/admin/accounts/users/:user_id/identities',
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_NOT_APPLICABLE,
        auditOperation: 'accounts.identities.list',
      },
      {
        moduleId: 'accountAdmin',
        method: 'POST',
        path: '/api/v1/admin/accounts/users/:user_id/identities/link',
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: ADMIN_5M_ELEVATION,
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_REQUIRED,
        auditOperation: 'accounts.identities.link',
      },
      {
        moduleId: 'accountAdmin',
        method: 'POST',
        path: '/api/v1/admin/accounts/users/:user_id/identities/unlink',
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: ADMIN_5M_ELEVATION,
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_REQUIRED,
        auditOperation: 'accounts.identities.unlink',
      },
      {
        moduleId: 'accountAdmin',
        method: 'GET',
        path: ACCOUNT_ALLOWLIST_PATH,
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_NOT_APPLICABLE,
        auditOperation: 'accounts.allowlist.list',
      },
      {
        moduleId: 'accountAdmin',
        method: 'GET',
        path: ACCOUNT_ALLOWLIST_ITEM_PATH,
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_NOT_APPLICABLE,
        auditOperation: 'accounts.allowlist.show',
      },
      {
        moduleId: 'accountAdmin',
        method: 'POST',
        path: ACCOUNT_ALLOWLIST_PATH,
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_REQUIRED,
        auditOperation: AUDIT_ALLOWLIST_ADD,
      },
      {
        moduleId: 'accountAdmin',
        method: 'PATCH',
        path: ACCOUNT_ALLOWLIST_ITEM_PATH,
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_REQUIRED,
        auditOperation: 'accounts.allowlist.update',
      },
      {
        moduleId: 'accountAdmin',
        method: 'DELETE',
        path: ACCOUNT_ALLOWLIST_ITEM_PATH,
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_REQUIRED,
        auditOperation: 'accounts.allowlist.remove',
      },
      {
        moduleId: 'accountAdmin',
        method: 'GET',
        path: ACCOUNT_BOOTSTRAP_PATH,
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_NOT_APPLICABLE,
        auditOperation: 'accounts.bootstrap.show',
      },
      {
        moduleId: 'accountAdmin',
        method: 'GET',
        path: '/api/v1/admin/accounts/correlations/:account_correlation_id',
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: ADMIN_5M_ELEVATION,
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_NOT_APPLICABLE,
        rateLimit: 'protected_correlation_resolution',
        auditOperation: 'accounts.correlation.resolve',
      },
    ]);
  });

  it('serializes principal directory DTOs through the metadata allowlist', async () => {
    const { module } = mutationFixture();
    const route = findRoute(module.routes, '/api/v1/admin/accounts/users');

    const result = await route.handler(consoleRequest({
      query: { limit: '20', sub: PRIMARY_SUB },
    }));
    const rawBody = result.body as Record<string, unknown>;
    const firstUser = (rawBody.users as Record<string, unknown>[])[0];
    firstUser.authz_version = 3;
    firstUser.account_correlation_id = ACCOUNT_CORRELATION_ID;
    firstUser.private_settings = { leaked: true };

    expect(route.privacyProjector?.(result.body)).toEqual({
      users: [{
        user_id: USER_ID,
        primary_sub: PRIMARY_SUB,
        username: 'alice',
        display_name: 'Alice Example',
        email: 'alice@example.test',
        email_verified: true,
        auth_methods: ['github'],
        roles: [ACCOUNT_ADMIN_ROLE],
        disabled_at: null,
        created_at: NOW.toISOString(),
        last_login_at: LAST_LOGIN.toISOString(),
        admin_factor_enrolled: true,
      }],
    });
  });

  it('supports get user, role list, correlation resolution, and not-found responses', async () => {
    const { module } = mutationFixture();
    const getUser = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id');
    const roles = findRoute(module.routes, ACCOUNT_ROLES_PATH);
    const correlation = findRoute(module.routes, '/api/v1/admin/accounts/correlations/:account_correlation_id');

    await expect(getUser.handler(consoleRequest({ params: { user_id: USER_ID } })))
      .resolves.toMatchObject({ status: 200, body: { user_id: USER_ID } });
    const rolesResult = await roles.handler(consoleRequest({ params: { user_id: USER_ID } }));
    expect(rolesResult).toEqual({ status: 200, body: { user_id: USER_ID, roles: [ACCOUNT_ADMIN_ROLE] } });
    expect(roles.privacyProjector?.({
      ...(rolesResult.body as Record<string, unknown>),
      username: 'should-not-select-a-principal-branch',
      authz_version: 3,
    })).toEqual({ user_id: USER_ID, roles: [ACCOUNT_ADMIN_ROLE] });
    await expect(correlation.handler(consoleRequest({
      params: { account_correlation_id: ACCOUNT_CORRELATION_ID },
    }))).resolves.toMatchObject({ status: 200, body: { user_id: USER_ID } });
    await expect(correlation.handler(consoleRequest({
      params: { account_correlation_id: UNKNOWN_USER_ID },
    }))).resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
    await expect(getUser.handler(consoleRequest({
      params: { user_id: UNKNOWN_USER_ID },
    }))).resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
  });

  it('issues account invites after bootstrap with transaction audit and privacy projection', async () => {
    const { module, adminAuditWriter } = mutationFixture();
    const invite = findRoute(module.routes, ACCOUNT_INVITE_PATH, 'POST');
    const authentication = consoleRequest().consoleAuthentication;
    if (!authentication) throw new Error(MISSING_AUTHENTICATION_FIXTURE);

    const result = await invite.handler(consoleRequest({
      body: {
        username: 'bob_2',
        email: INVITE_EMAIL,
        ttl_minutes: 15,
        roles: ['operator'],
      },
      consoleAuthentication: {
        ...authentication,
        grantedCapabilities: [SELF_CAPABILITY, ACCOUNT_ADMIN_CAPABILITY, OPERATE_CAPABILITY],
      },
    }));

    expect(result).toEqual({
      status: 201,
      body: {
        invite_url: 'https://console.example.test/invite/bob_2',
        expires_at: new Date(NOW.getTime() + 900_000).toISOString(),
        user_id: SECOND_USER_ID,
        primary_sub: 'local_bob_2',
      },
    });
    expect(invite.privacyProjector?.({
      ...(result.body as Record<string, unknown>),
      raw_invite_token: 'secret',
      credential_material: { leaked: true },
    })).toEqual(result.body);
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_USERS_INVITE,
      targetUserId: SECOND_USER_ID,
      resourceKind: 'account_principal',
      resourceId: SECOND_USER_ID,
      argsRedacted: { operation: 'invite', roles: ['operator'], ttlMinutes: 15 },
      result: 'approved',
    })]);
  });

  it('requires matching higher-tier capability before inviting higher-tier roles', async () => {
    const { module, adminAuditWriter } = mutationFixture();
    const invite = findRoute(module.routes, ACCOUNT_INVITE_PATH, 'POST');

    await expect(invite.handler(consoleRequest({
      body: {
        username: 'security_admin_invitee',
        email: 'security-admin@example.test',
        roles: ['security_admin'],
      },
    }))).resolves.toMatchObject({
      status: 403,
      body: { code: 'insufficient_role_authority' },
    });

    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_USERS_INVITE,
      result: 'rejected',
      errorCode: 'insufficient_role_authority',
      argsRedacted: { operation: 'invite', roles: ['security_admin'] },
    })]);
  });

  it('audits invite issuer failures with dependency context', async () => {
    const accountAdminStore = store();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      authStorage: authStorageFixture({ adminSub: PRIMARY_SUB }),
      accountInviteIssuer: {
        async issueInvite() {
          await Promise.resolve();
          throw new Error('issuer unavailable');
        },
      },
      oauthGrantRevocationService: oauthGrantRevocationService(),
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const invite = findRoute(module.routes, ACCOUNT_INVITE_PATH, 'POST');

    await expect(invite.handler(consoleRequest({
      body: { username: 'bob', email: INVITE_EMAIL },
    }))).resolves.toMatchObject({
      status: 503,
      body: { code: 'service_unavailable' },
    });
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_USERS_INVITE,
      result: 'failed',
      errorCode: 'issuer_error',
      argsRedacted: { operation: 'invite', dependency: 'account_invite_issuer' },
    })]);
  });

  it('fails account invites closed before bootstrap and when the issuer dependency is missing', async () => {
    const accountAdminStore = store();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const sessionStore = new InMemoryConsoleSessionStore();
    const firstAuditWriter = new InMemoryAdminAuditWriter();
    const firstModule = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      authStorage: authStorageFixture({ completed: false }),
      accountInviteIssuer: accountInviteIssuer(),
      oauthGrantRevocationService: oauthGrantRevocationService(),
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter: firstAuditWriter,
      }),
      now: () => NOW,
    });
    const firstInvite = findRoute(firstModule.routes, ACCOUNT_INVITE_PATH, 'POST');

    await expect(firstInvite.handler(consoleRequest({
      body: { username: 'bob', email: INVITE_EMAIL },
    }))).resolves.toMatchObject({
      status: 412,
      body: { code: 'no_admin_yet' },
    });
    expect(firstAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_USERS_INVITE,
      result: 'rejected',
      errorCode: 'no_admin_yet',
      argsRedacted: { operation: 'invite' },
    })]);

    const secondAuditWriter = new InMemoryAdminAuditWriter();
    const secondModule = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      authStorage: authStorageFixture({ adminSub: PRIMARY_SUB }),
      accountInviteIssuer: null,
      oauthGrantRevocationService: oauthGrantRevocationService(),
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter: secondAuditWriter,
      }),
      now: () => NOW,
    });
    const secondInvite = findRoute(secondModule.routes, ACCOUNT_INVITE_PATH, 'POST');

    await expect(secondInvite.handler(consoleRequest({
      body: { username: 'bob', email: INVITE_EMAIL },
    }))).resolves.toMatchObject({
      status: 503,
      body: { code: 'service_unavailable' },
    });
    expect(secondAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_USERS_INVITE,
      result: 'failed',
      errorCode: 'service_unavailable',
      argsRedacted: { operation: 'invite', dependency: 'account_invite_issuer' },
    })]);

    const thirdAuditWriter = new InMemoryAdminAuditWriter();
    const thirdModule = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      authStorage: null,
      accountInviteIssuer: accountInviteIssuer(),
      oauthGrantRevocationService: oauthGrantRevocationService(),
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter: thirdAuditWriter,
      }),
      now: () => NOW,
    });
    const thirdInvite = findRoute(thirdModule.routes, ACCOUNT_INVITE_PATH, 'POST');

    await expect(thirdInvite.handler(consoleRequest({
      body: { username: 'bob', email: INVITE_EMAIL },
    }))).resolves.toMatchObject({
      status: 503,
      body: { code: 'service_unavailable' },
    });
    expect(thirdAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_USERS_INVITE,
      result: 'failed',
      errorCode: 'service_unavailable',
      argsRedacted: { operation: 'invite', dependency: 'auth_storage' },
    })]);
  });

  it('rejects malformed account invite requests before issuing an invite', async () => {
    let issueCalls = 0;
    const accountAdminStore = store();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      authStorage: authStorageFixture({ adminSub: PRIMARY_SUB }),
      accountInviteIssuer: {
        async issueInvite(input) {
          issueCalls += 1;
          return accountInviteIssuer().issueInvite(input);
        },
      },
      oauthGrantRevocationService: oauthGrantRevocationService(),
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const invite = findRoute(module.routes, ACCOUNT_INVITE_PATH, 'POST');

    await expect(invite.handler(consoleRequest({
      body: { username: 'bob', email: 'not-an-email' },
    }))).resolves.toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    await expect(invite.handler(consoleRequest({
      body: { username: 'bob', email: INVITE_EMAIL, ttl_minutes: 0 },
    }))).resolves.toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    await expect(invite.handler(consoleRequest({
      body: { username: 'bob', email: INVITE_EMAIL, roles: ['definitely_not_a_role'] },
    }))).resolves.toMatchObject({ status: 400, body: { code: 'invalid_request' } });

    expect(issueCalls).toBe(0);
    expect(adminAuditWriter.getEvents()).toHaveLength(3);
    expect(adminAuditWriter.getEvents()).toEqual([
      expect.objectContaining({
        operation: AUDIT_USERS_INVITE,
        result: 'rejected',
        errorCode: 'invalid_request',
        argsRedacted: { operation: 'invite', invalid_body: true },
      }),
      expect.objectContaining({
        operation: AUDIT_USERS_INVITE,
        result: 'rejected',
        errorCode: 'invalid_request',
        argsRedacted: { operation: 'invite', invalid_body: true },
      }),
      expect.objectContaining({
        operation: AUDIT_USERS_INVITE,
        result: 'rejected',
        errorCode: 'invalid_request',
        argsRedacted: { operation: 'invite', invalid_body: true },
      }),
    ]);
  });

  it('returns bootstrap status without exposing bootstrap subject material', async () => {
    const { module } = mutationFixture();
    const bootstrap = findRoute(module.routes, ACCOUNT_BOOTSTRAP_PATH, 'GET');

    const result = await bootstrap.handler(consoleRequest());

    expect(result).toEqual({
      status: 200,
      body: {
        completed: true,
        completed_at: NOW.toISOString(),
        admin_user_id: USER_ID,
      },
    });
    expect(bootstrap.privacyProjector?.({
      ...(result.body as Record<string, unknown>),
      admin_auth_sub: PRIMARY_SUB,
      bootstrap_secret: 'secret',
    })).toEqual(result.body);

    const incompleteModule = createAccountAdminModule({
      accountAdminStore: store(),
      accountAllowlistStore: new InMemoryConsoleAccountAllowlistStore(),
      sessionStore: new InMemoryConsoleSessionStore(),
      authStorage: authStorageFixture({ completed: false }),
      accountInviteIssuer: accountInviteIssuer(),
      oauthGrantRevocationService: oauthGrantRevocationService(),
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore: store(),
        accountAllowlistStore: new InMemoryConsoleAccountAllowlistStore(),
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    await expect(findRoute(incompleteModule.routes, ACCOUNT_BOOTSTRAP_PATH, 'GET').handler(consoleRequest()))
      .resolves.toEqual({
        status: 200,
        body: {
          completed: false,
          completed_at: null,
          admin_user_id: null,
        },
      });

    const missingPrincipalModule = createAccountAdminModule({
      accountAdminStore: store(),
      accountAllowlistStore: new InMemoryConsoleAccountAllowlistStore(),
      sessionStore: new InMemoryConsoleSessionStore(),
      authStorage: authStorageFixture({ adminSub: 'github_missing' }),
      accountInviteIssuer: accountInviteIssuer(),
      oauthGrantRevocationService: oauthGrantRevocationService(),
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore: store(),
        accountAllowlistStore: new InMemoryConsoleAccountAllowlistStore(),
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    await expect(findRoute(missingPrincipalModule.routes, ACCOUNT_BOOTSTRAP_PATH, 'GET').handler(consoleRequest()))
      .resolves.toEqual({
        status: 200,
        body: {
          completed: true,
          completed_at: NOW.toISOString(),
          admin_user_id: null,
        },
      });

    const unavailableModule = createAccountAdminModule({
      accountAdminStore: store(),
      accountAllowlistStore: new InMemoryConsoleAccountAllowlistStore(),
      sessionStore: new InMemoryConsoleSessionStore(),
      authStorage: null,
      accountInviteIssuer: accountInviteIssuer(),
      oauthGrantRevocationService: oauthGrantRevocationService(),
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore: store(),
        accountAllowlistStore: new InMemoryConsoleAccountAllowlistStore(),
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    await expect(findRoute(unavailableModule.routes, ACCOUNT_BOOTSTRAP_PATH, 'GET').handler(consoleRequest()))
      .resolves.toMatchObject({
        status: 503,
        body: { code: 'service_unavailable' },
      });
  });

  it('manages account allowlist entries with mutation audit and privacy projection', async () => {
    const { module, adminAuditWriter } = mutationFixture();
    const add = findRoute(module.routes, ACCOUNT_ALLOWLIST_PATH, 'POST');
    const list = findRoute(module.routes, ACCOUNT_ALLOWLIST_PATH, 'GET');
    const get = findRoute(module.routes, ACCOUNT_ALLOWLIST_ITEM_PATH, 'GET');
    const update = findRoute(module.routes, ACCOUNT_ALLOWLIST_ITEM_PATH, 'PATCH');
    const remove = findRoute(module.routes, ACCOUNT_ALLOWLIST_ITEM_PATH, 'DELETE');

    const created = await add.handler(consoleRequest({
      body: { kind: 'email', value: ' Alice@Example.Test ', note: 'break-glass admin' },
    }));
    const entryId = (created.body as { id: string }).id;

    expect(created).toMatchObject({
      status: 201,
      body: {
        id: expect.any(String),
        kind: 'email',
        value: 'Alice@Example.Test',
        note: 'break-glass admin',
        created_by_user_id: USER_ID,
        created_at: NOW.toISOString(),
      },
    });
    expect(add.privacyProjector?.({
      ...(created.body as Record<string, unknown>),
      normalized_value: 'alice@example.test',
      revoked_at: NOW.toISOString(),
      raw_secret: 'nope',
    })).toEqual(created.body);
    await expect(list.handler(consoleRequest())).resolves.toMatchObject({
      status: 200,
      body: { entries: [created.body] },
    });
    await expect(get.handler(consoleRequest({ params: { id: entryId } }))).resolves.toEqual({
      status: 200,
      body: created.body,
    });

    await expect(update.handler(consoleRequest({
      params: { id: entryId },
      body: { note: null },
    }))).resolves.toMatchObject({
      status: 200,
      body: { id: entryId, note: null },
    });
    await expect(remove.handler(consoleRequest({ params: { id: entryId } }))).resolves.toEqual({
      status: 204,
      body: null,
    });
    await expect(get.handler(consoleRequest({ params: { id: entryId } })))
      .resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
    await expect(add.handler(consoleRequest({ body: { kind: 'email', value: 'alice@example.test' } })))
      .resolves.toMatchObject({ status: 201 });

    expect(adminAuditWriter.getEvents().map(event => [event.operation, event.result, event.errorCode])).toEqual([
      [AUDIT_ALLOWLIST_ADD, 'approved', null],
      ['accounts.allowlist.update', 'approved', null],
      ['accounts.allowlist.remove', 'approved', null],
      [AUDIT_ALLOWLIST_ADD, 'approved', null],
    ]);
    expect(adminAuditWriter.getEvents()[0]).toMatchObject({
      targetUserId: null,
      resourceKind: 'account_allowlist_entry',
      resourceId: entryId,
      argsRedacted: { operation: 'allowlist_add', kind: 'email' },
    });
  });

  it('audits allowlist validation, duplicate, and not-found outcomes', async () => {
    const { module, adminAuditWriter } = mutationFixture();
    const add = findRoute(module.routes, ACCOUNT_ALLOWLIST_PATH, 'POST');
    const update = findRoute(module.routes, ACCOUNT_ALLOWLIST_ITEM_PATH, 'PATCH');
    const remove = findRoute(module.routes, ACCOUNT_ALLOWLIST_ITEM_PATH, 'DELETE');

    await expect(add.handler(consoleRequest({ body: { kind: 'email', value: '' } })))
      .resolves.toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    await expect(add.handler(consoleRequest({ body: { kind: 'email', value: 'not-an-email' } })))
      .resolves.toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    await expect(add.handler(consoleRequest({ body: { kind: 'github_id', value: 'abc def' } })))
      .resolves.toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    await expect(add.handler(consoleRequest({ body: { kind: 'github_username', value: 'Alice' } })))
      .resolves.toMatchObject({ status: 201 });
    await expect(add.handler(consoleRequest({ body: { kind: 'github_username', value: 'alice' } })))
      .resolves.toMatchObject({ status: 409, body: { code: 'conflict' } });
    await expect(update.handler(consoleRequest({
      params: { id: UNKNOWN_USER_ID },
      body: { note: 'missing' },
    }))).resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
    await expect(remove.handler(consoleRequest({ params: { id: UNKNOWN_USER_ID } })))
      .resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });

    expect(adminAuditWriter.getEvents().map(event => [
      event.operation,
      event.result,
      event.errorCode,
      event.argsRedacted,
    ])).toEqual([
      [AUDIT_ALLOWLIST_ADD, 'rejected', 'invalid_request', { operation: 'allowlist_add', invalid_body: true }],
      [AUDIT_ALLOWLIST_ADD, 'rejected', 'invalid_request', { operation: 'allowlist_add', invalid_body: true }],
      [AUDIT_ALLOWLIST_ADD, 'rejected', 'invalid_request', { operation: 'allowlist_add', invalid_body: true }],
      [AUDIT_ALLOWLIST_ADD, 'approved', null, { operation: 'allowlist_add', kind: 'github_username' }],
      [AUDIT_ALLOWLIST_ADD, 'conflict', 'conflict', { operation: 'allowlist_add', kind: 'github_username' }],
      ['accounts.allowlist.update', 'failed', 'not_found', { operation: 'allowlist_update' }],
      ['accounts.allowlist.remove', 'failed', 'not_found', { operation: 'allowlist_remove' }],
    ]);
  });

  it('rejects malformed list query parameters before hitting the store', async () => {
    const { module } = mutationFixture();
    const route = findRoute(module.routes, '/api/v1/admin/accounts/users');

    await expect(route.handler(consoleRequest({ query: { limit: 'NaN' } })))
      .resolves.toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    await expect(route.handler(consoleRequest({ query: { sub: [PRIMARY_SUB] } })))
      .resolves.toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    await expect(route.handler(consoleRequest({ query: { limit: '0' } })))
      .rejects.toThrow('principal directory limit must be between 1 and 200');
  });

  it('lets kernel mapping handle malformed UUID path parameters', async () => {
    const { module } = mutationFixture();
    const getUser = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id');
    const correlation = findRoute(module.routes, '/api/v1/admin/accounts/correlations/:account_correlation_id');
    const allowlist = findRoute(module.routes, ACCOUNT_ALLOWLIST_ITEM_PATH, 'GET');

    await expect(getUser.handler(consoleRequest({ params: { user_id: 'alice' } })))
      .rejects.toThrow('userId must be a UUID');
    await expect(correlation.handler(consoleRequest({ params: { account_correlation_id: 'alice' } })))
      .rejects.toThrow('accountCorrelationId must be a UUID');
    await expect(allowlist.handler(consoleRequest({ params: { id: 'alice' } })))
      .rejects.toThrow('id must be a UUID');
  });

  it('grants a role with transaction audit, invalidation, and privacy projection', async () => {
    const { module, invalidationStore, adminAuditWriter } = mutationFixture();
    const grant = findRoute(module.routes, ACCOUNT_ROLE_GRANT_PATH);
    const authentication = consoleRequest().consoleAuthentication;
    if (!authentication) throw new Error(MISSING_AUTHENTICATION_FIXTURE);

    const result = await grant.handler(consoleRequest({
      params: { user_id: USER_ID },
      body: { role: 'operator' },
      consoleAuthentication: {
        ...authentication,
        userId: SECOND_USER_ID,
        grantedCapabilities: [SELF_CAPABILITY, ACCOUNT_ADMIN_CAPABILITY, OPERATE_CAPABILITY],
      },
    }));

    expect(result).toEqual({
      status: 200,
      body: {
        user_id: USER_ID,
        roles: [ACCOUNT_ADMIN_ROLE, 'operator'],
      },
    });
    expect(grant.privacyProjector?.({
      ...(result.body as Record<string, unknown>),
      account_correlation_id: ACCOUNT_CORRELATION_ID,
    })).toEqual({ user_id: USER_ID, roles: [ACCOUNT_ADMIN_ROLE, 'operator'] });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toMatchObject([{
      kind: 'principal_authz_changed',
      userId: USER_ID,
      authzVersion: 4,
      payload: { previousAuthzVersion: 3, newAuthzVersion: 4 },
    }]);
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_ROLES_GRANT,
      targetUserId: USER_ID,
      argsRedacted: {
        operation: 'grant',
        grants: ['operator'],
        revokes: [],
        roles: [ACCOUNT_ADMIN_ROLE, 'operator'],
      },
      result: 'approved',
    })]);
  });

  it('rejects self-grants before expanding the next step-up role set', async () => {
    const { module, invalidationStore, adminAuditWriter } = mutationFixture();
    const grant = findRoute(module.routes, ACCOUNT_ROLE_GRANT_PATH);

    await expect(grant.handler(consoleRequest({
      params: { user_id: USER_ID },
      body: { role: 'security_admin' },
    }))).resolves.toMatchObject({
      status: 403,
      body: { code: 'self_escalation_denied' },
    });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      result: 'rejected',
      errorCode: 'self_escalation_denied',
      argsRedacted: { operation: 'grant', grants: ['security_admin'] },
    })]);
  });

  it('requires matching higher-tier capability before granting higher-tier roles', async () => {
    const { module, invalidationStore, adminAuditWriter } = mutationFixture();
    const grant = findRoute(module.routes, ACCOUNT_ROLE_GRANT_PATH);
    const authentication = consoleRequest().consoleAuthentication;
    if (!authentication) throw new Error(MISSING_AUTHENTICATION_FIXTURE);

    await expect(grant.handler(consoleRequest({
      params: { user_id: USER_ID },
      body: { role: 'security_admin' },
      consoleAuthentication: {
        ...authentication,
        userId: SECOND_USER_ID,
      },
    }))).resolves.toMatchObject({
      status: 403,
      body: { code: 'insufficient_role_authority' },
    });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_ROLES_GRANT,
      result: 'rejected',
      errorCode: 'insufficient_role_authority',
      argsRedacted: { operation: 'grant', grants: ['security_admin'] },
    })]);
  });

  it('requires matching higher-tier capability before revoking higher-tier roles', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([
      await principalFixture({ roles: [ACCOUNT_ADMIN_ROLE, 'security_admin'] }),
      await principalFixture({
        userId: SECOND_USER_ID,
        username: 'bob',
        roles: [ACCOUNT_ADMIN_ROLE],
        accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
      }),
    ]);
    const { module, invalidationStore, adminAuditWriter } = mutationFixture(accountAdminStore);
    const revoke = findRoute(module.routes, ACCOUNT_ROLE_REVOKE_PATH);
    const authentication = consoleRequest().consoleAuthentication;
    if (!authentication) throw new Error(MISSING_AUTHENTICATION_FIXTURE);

    await expect(revoke.handler(consoleRequest({
      params: { user_id: USER_ID },
      body: { role: 'security_admin' },
      consoleAuthentication: {
        ...authentication,
        userId: SECOND_USER_ID,
      },
    }))).resolves.toMatchObject({
      status: 403,
      body: { code: 'insufficient_role_authority' },
    });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      result: 'rejected',
      errorCode: 'insufficient_role_authority',
      argsRedacted: { operation: 'revoke', revokes: ['security_admin'] },
    })]);
  });

  it('requires matching higher-tier capability before replacing roles to remove higher-tier roles', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([
      await principalFixture({ roles: [ACCOUNT_ADMIN_ROLE, 'security_admin', 'operator'] }),
      await principalFixture({
        userId: SECOND_USER_ID,
        username: 'bob',
        roles: [ACCOUNT_ADMIN_ROLE],
        accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
      }),
    ]);
    const { module, invalidationStore, adminAuditWriter } = mutationFixture(accountAdminStore);
    const replace = findRoute(module.routes, ACCOUNT_ROLES_PATH, 'PUT');
    const authentication = consoleRequest().consoleAuthentication;
    if (!authentication) throw new Error(MISSING_AUTHENTICATION_FIXTURE);

    await expect(replace.handler(consoleRequest({
      params: { user_id: USER_ID },
      body: { roles: [ACCOUNT_ADMIN_ROLE, 'operator'] },
      consoleAuthentication: {
        ...authentication,
        userId: SECOND_USER_ID,
        grantedCapabilities: [SELF_CAPABILITY, ACCOUNT_ADMIN_CAPABILITY, OPERATE_CAPABILITY],
      },
    }))).resolves.toMatchObject({
      status: 403,
      body: { code: 'insufficient_role_authority' },
    });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      result: 'rejected',
      errorCode: 'insufficient_role_authority',
      argsRedacted: { operation: 'replace', revokes: ['security_admin'] },
    })]);
  });

  it('replaces roles without orphaning when another accounts admin remains', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([
      await principalFixture({ roles: [ACCOUNT_ADMIN_ROLE, 'operator'] }),
      await principalFixture({
        userId: SECOND_USER_ID,
        username: 'bob',
        roles: ['admin', 'security_admin'],
        accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
      }),
    ]);
    const { module } = mutationFixture(accountAdminStore);
    const replace = findRoute(module.routes, ACCOUNT_ROLES_PATH, 'PUT');

    await expect(replace.handler(consoleRequest({
      params: { user_id: USER_ID },
      body: { roles: ['operator'] },
    }))).resolves.toEqual({
      status: 200,
      body: { user_id: USER_ID, roles: ['operator'] },
    });
  });

  it('rejects role mutations that would orphan the last account administrator', async () => {
    const { module, invalidationStore, adminAuditWriter } = mutationFixture();
    const revoke = findRoute(module.routes, ACCOUNT_ROLE_REVOKE_PATH);

    await expect(revoke.handler(consoleRequest({
      params: { user_id: USER_ID },
      body: { role: ACCOUNT_ADMIN_ROLE },
    }))).resolves.toMatchObject({
      status: 422,
      body: { code: 'would_orphan_accounts_admin' },
    });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      result: 'rejected',
      errorCode: 'would_orphan_accounts_admin',
      targetUserId: USER_ID,
    })]);
  });

  it('audits validation and conflict outcomes without appending invalidation', async () => {
    const { module, invalidationStore, adminAuditWriter } = mutationFixture();
    const grant = findRoute(module.routes, ACCOUNT_ROLE_GRANT_PATH);

    await expect(grant.handler(consoleRequest({
      params: { user_id: USER_ID },
      body: { role: 'x'.repeat(10_000) },
    }))).resolves.toMatchObject({ status: 422, body: { code: 'validation_failed' } });
    await expect(grant.handler(consoleRequest({
      params: { user_id: USER_ID },
      body: { role: ACCOUNT_ADMIN_ROLE },
    }))).resolves.toMatchObject({ status: 409, body: { code: 'conflict' } });

    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
    expect(adminAuditWriter.getEvents().map(event => [event.result, event.errorCode])).toEqual([
      ['rejected', 'validation_failed'],
      ['conflict', 'conflict'],
    ]);
    expect(adminAuditWriter.getEvents()[0]?.argsRedacted).toEqual({
      role_invalid: true,
      role_length: 10_000,
    });
  });

  it('returns not found when revoking a role that is not held', async () => {
    const { module, invalidationStore, adminAuditWriter } = mutationFixture();
    const revoke = findRoute(module.routes, ACCOUNT_ROLE_REVOKE_PATH);

    await expect(revoke.handler(consoleRequest({
      params: { user_id: USER_ID },
      body: { role: 'operator' },
    }))).resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      result: 'failed',
      errorCode: 'not_found',
      argsRedacted: { role: 'operator' },
    })]);
  });

  it('allows direct revoke of one accounts-admin role when the target keeps another', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([
      await principalFixture({ roles: ['admin', ACCOUNT_ADMIN_ROLE] }),
    ]);
    const { module } = mutationFixture(accountAdminStore);
    const revoke = findRoute(module.routes, ACCOUNT_ROLE_REVOKE_PATH);

    await expect(revoke.handler(consoleRequest({
      params: { user_id: USER_ID },
      body: { role: ACCOUNT_ADMIN_ROLE },
    }))).resolves.toEqual({
      status: 200,
      body: { user_id: USER_ID, roles: ['admin'] },
    });
  });

  it('disables a principal with transaction audit, invalidation, and privacy projection', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([
      await principalFixture({ roles: ['operator'] }),
      await principalFixture({
        userId: SECOND_USER_ID,
        username: 'bob',
        roles: [ACCOUNT_ADMIN_ROLE],
        accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
      }),
    ]);
    const { module, invalidationStore, adminAuditWriter } = mutationFixture(accountAdminStore);
    const disable = findRoute(module.routes, ACCOUNT_DISABLE_PATH);

    const result = await disable.handler(consoleRequest({ params: { user_id: USER_ID } }));

    expect(result).toMatchObject({
      status: 200,
      body: {
        user: {
          user_id: USER_ID,
          disabled_at: NOW.toISOString(),
          roles: ['operator'],
        },
      },
    });
    expect(disable.privacyProjector?.({
      ...(result.body as Record<string, unknown>),
      user: {
        ...((result.body as { user: Record<string, unknown> }).user),
        account_correlation_id: ACCOUNT_CORRELATION_ID,
        private_settings: { leaked: true },
      },
      raw_oauth_revocation: { leaked: true },
    })).toMatchObject({
      user: {
        user_id: USER_ID,
        disabled_at: NOW.toISOString(),
        roles: ['operator'],
      },
    });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toMatchObject([{
      kind: 'principal_disabled',
      userId: USER_ID,
      authzVersion: 4,
      urgency: 'acknowledged',
      payload: { terminatedRuntimeSessions: false },
    }]);
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_USERS_DISABLE,
      targetUserId: USER_ID,
      argsRedacted: { operation: 'disable' },
      result: 'approved',
      resultDetailRedacted: expect.objectContaining({
        previousAuthzVersion: 3,
        newAuthzVersion: 4,
      }),
    })]);
  });

  it('terminates active runtime sessions when disabling a principal', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([
      await principalFixture({ roles: ['operator'] }),
      await principalFixture({
        userId: SECOND_USER_ID,
        username: 'bob',
        roles: [ACCOUNT_ADMIN_ROLE],
        accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
      }),
    ]);
    const runtimeStore = new AutoAckRuntimeSessionControlStore();
    await registerRuntimePresence(runtimeStore);
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      oauthGrantRevocationService: oauthGrantRevocationService(),
      runtimeSessionControlStore: runtimeStore,
      runtimeTerminationAcknowledgementTimeoutMs: 1,
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const disable = findRoute(module.routes, ACCOUNT_DISABLE_PATH);

    await expect(disable.handler(consoleRequest({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
      status: 200,
      body: {
        revocation_summary: {
          mcp_sessions_terminated: 1,
          mcp_sessions_termination_requested: 1,
          mcp_sessions_termination_acknowledged: 1,
          mcp_sessions_termination_timed_out: 0,
          new_authz_version: 4,
        },
      },
    });
    await expect(runtimeStore.listPendingCommandsForReplica(RUNTIME_REPLICA_ID)).resolves.toEqual([]);
    await expect(invalidationStore.listEventsAfter(0)).resolves.toMatchObject([{
      kind: 'principal_disabled',
      urgency: 'acknowledged',
      payload: { terminatedRuntimeSessions: true },
    }]);
    expect(adminAuditWriter.getEvents()).toEqual([
      expect.objectContaining({
        operation: AUDIT_USERS_DISABLE,
        result: 'approved',
        argsRedacted: { operation: 'disable' },
      }),
      expect.objectContaining({
        operation: AUDIT_USERS_DISABLE,
        result: 'approved',
        argsRedacted: { operation: 'disable', phase: 'post_commit_runtime_termination' },
      }),
    ]);
  });

  it('reports service unavailable when disable runtime termination acknowledgement times out', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([
      await principalFixture({ roles: ['operator'] }),
      await principalFixture({
        userId: SECOND_USER_ID,
        username: 'bob',
        roles: [ACCOUNT_ADMIN_ROLE],
        accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
      }),
    ]);
    const runtimeStore = new InMemoryRuntimeSessionControlStore();
    await registerRuntimePresence(runtimeStore);
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      oauthGrantRevocationService: oauthGrantRevocationService(),
      runtimeSessionControlStore: runtimeStore,
      runtimeTerminationAcknowledgementTimeoutMs: 1,
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const disable = findRoute(module.routes, ACCOUNT_DISABLE_PATH);

    await expect(disable.handler(consoleRequest({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
      status: 503,
      body: {
        revocation_summary: {
          mcp_sessions_termination_requested: 1,
          mcp_sessions_termination_acknowledged: 0,
          mcp_sessions_termination_timed_out: 1,
        },
      },
    });
    expect(adminAuditWriter.getEvents()[1]).toMatchObject({
      operation: AUDIT_USERS_DISABLE,
      result: 'failed',
      errorCode: 'runtime_termination_ack_timeout',
      argsRedacted: { operation: 'disable', phase: 'post_commit_runtime_termination' },
    });
  });

  it('enables a disabled principal with transaction audit and invalidation', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([
      await principalFixture({
        disabledAt: new Date('2026-05-27T13:30:00.000Z'),
        roles: ['operator'],
      }),
    ]);
    const { module, invalidationStore, adminAuditWriter } = mutationFixture(accountAdminStore);
    const enable = findRoute(module.routes, ACCOUNT_ENABLE_PATH);

    await expect(enable.handler(consoleRequest({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
      status: 200,
      body: {
        user: {
          user_id: USER_ID,
          disabled_at: null,
          roles: ['operator'],
        },
      },
    });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toMatchObject([{
      kind: 'principal_reenabled',
      userId: USER_ID,
      authzVersion: 4,
      payload: {},
    }]);
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_USERS_ENABLE,
      targetUserId: USER_ID,
      argsRedacted: { operation: 'enable' },
      result: 'approved',
    })]);
  });

  it('rejects disabling the last enabled account administrator', async () => {
    const { module, invalidationStore, adminAuditWriter } = mutationFixture();
    const disable = findRoute(module.routes, ACCOUNT_DISABLE_PATH);

    await expect(disable.handler(consoleRequest({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
      status: 422,
      body: { code: 'would_orphan_accounts_admin' },
    });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      result: 'rejected',
      errorCode: 'would_orphan_accounts_admin',
      targetUserId: USER_ID,
    })]);
  });

  it('audits lifecycle not-found and state conflicts without invalidation', async () => {
    const { module, invalidationStore, adminAuditWriter } = mutationFixture();
    const disable = findRoute(module.routes, ACCOUNT_DISABLE_PATH);
    const enable = findRoute(module.routes, ACCOUNT_ENABLE_PATH);

    await expect(disable.handler(consoleRequest({
      params: { user_id: UNKNOWN_USER_ID },
    }))).resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
    await expect(enable.handler(consoleRequest({
      params: { user_id: USER_ID },
    }))).resolves.toMatchObject({ status: 409, body: { code: 'conflict' } });
    await expect(enable.handler(consoleRequest({
      params: { user_id: UNKNOWN_USER_ID },
    }))).resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });

    const disabledStore = new InMemoryConsoleAccountAdminStore([
      await principalFixture({ disabledAt: new Date('2026-05-27T13:30:00.000Z') }),
    ]);
    const disabled = mutationFixture(disabledStore);
    const disabledDisable = findRoute(disabled.module.routes, ACCOUNT_DISABLE_PATH);
    await expect(disabledDisable.handler(consoleRequest({
      params: { user_id: USER_ID },
    }))).resolves.toMatchObject({ status: 409, body: { code: 'conflict' } });

    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
    expect(adminAuditWriter.getEvents().map(event => [event.operation, event.result, event.errorCode])).toEqual([
      [AUDIT_USERS_DISABLE, 'failed', 'not_found'],
      [AUDIT_USERS_ENABLE, 'conflict', 'conflict'],
      [AUDIT_USERS_ENABLE, 'failed', 'not_found'],
    ]);
    expect(disabled.adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_USERS_DISABLE,
      result: 'conflict',
      errorCode: 'conflict',
    })]);
  });

  it('maps a raced disable no-change to conflict when the principal is already disabled', async () => {
    class DisableRaceStore extends InMemoryConsoleAccountAdminStore {
      override async disablePrincipal(
        input: Parameters<InMemoryConsoleAccountAdminStore['disablePrincipal']>[0],
      ): ReturnType<InMemoryConsoleAccountAdminStore['disablePrincipal']> {
        await super.disablePrincipal(input);
        return null;
      }
    }
    const raceStore = new DisableRaceStore([
      await principalFixture({ roles: ['operator'] }),
      await principalFixture({
        userId: SECOND_USER_ID,
        username: 'bob',
        roles: [ACCOUNT_ADMIN_ROLE],
        accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
      }),
    ]);
    const { module, invalidationStore, adminAuditWriter } = mutationFixture(raceStore);
    const disable = findRoute(module.routes, ACCOUNT_DISABLE_PATH);

    await expect(disable.handler(consoleRequest({
      params: { user_id: USER_ID },
    }))).resolves.toMatchObject({ status: 409, body: { code: 'conflict' } });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_USERS_DISABLE,
      result: 'conflict',
      errorCode: 'conflict',
      argsRedacted: { operation: 'disable', already_disabled: true },
    })]);
  });

  it('revokes credentials with authz-version invalidation, browser-session revocation, and bounded counts', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([await principalFixture({ roles: ['operator'] })]);
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const sessionStore = new InMemoryConsoleSessionStore();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      oauthGrantRevocationService: oauthGrantRevocationService({
        grantsRevoked: 2,
        grantsDiscovered: 3,
        subjectsProcessed: 2,
      }),
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    await sessionStore.create(sessionRecord());
    await sessionStore.create(sessionRecord({
      idHash: Buffer.alloc(32, 10),
      csrfTokenHash: Buffer.alloc(32, 11),
      userId: SECOND_USER_ID,
      authSub: 'github_other',
    }));
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);

    const result = await revokeAll.handler(consoleRequest({ params: { user_id: USER_ID } }));

    expect(result).toMatchObject({
      status: 200,
      body: {
        user: {
          user_id: USER_ID,
          roles: ['operator'],
        },
        revocation_summary: {
          browser_sessions_revoked: 1,
          mcp_oauth_grants_revoked: 2,
          mcp_sessions_terminated: 0,
          authz_version_bumped: true,
          new_authz_version: 4,
        },
      },
    });
    expect(revokeAll.privacyProjector?.({
      ...(result.body as Record<string, unknown>),
      raw_oauth_revocation: { subject: PRIMARY_SUB, grant: 'secret' },
    })).toMatchObject({
      revocation_summary: {
        browser_sessions_revoked: 1,
        mcp_oauth_grants_revoked: 2,
        new_authz_version: 4,
      },
    });
    await expect(sessionStore.findActiveByIdHash(Buffer.alloc(32, 9), NOW)).resolves.toBeNull();
    await expect(sessionStore.findActiveByIdHash(Buffer.alloc(32, 10), NOW)).resolves.toMatchObject({
      userId: SECOND_USER_ID,
    });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toMatchObject([{
      kind: 'principal_credentials_revoked',
      urgency: 'acknowledged',
      userId: USER_ID,
      authzVersion: 4,
      payload: { revokedGrants: true, authzVersionBumped: true },
    }]);
    expect(adminAuditWriter.getEvents()).toEqual([
      expect.objectContaining({
        operation: AUDIT_USERS_CREDENTIALS_REVOKE_ALL,
        targetUserId: USER_ID,
        argsRedacted: { operation: 'credentials_revoke_all', phase: 'state_committed' },
        result: 'approved',
        resultDetailRedacted: expect.objectContaining({
          previousAuthzVersion: 3,
          newAuthzVersion: 4,
        }),
      }),
      expect.objectContaining({
        operation: AUDIT_USERS_CREDENTIALS_REVOKE_ALL,
        targetUserId: USER_ID,
        argsRedacted: { operation: 'credentials_revoke_all', phase: 'post_commit_revocation' },
        result: 'approved',
        resultDetailRedacted: expect.objectContaining({
          browserSessionsRevoked: 1,
          oauthSubjectsProcessed: 2,
          oauthGrantFamiliesDiscovered: 3,
          oauthGrantFamiliesRevoked: 2,
        }),
      }),
      expect.objectContaining({
        operation: AUDIT_USERS_CREDENTIALS_REVOKE_ALL,
        targetUserId: USER_ID,
        argsRedacted: { operation: 'credentials_revoke_all', phase: 'post_commit_runtime_termination' },
        result: 'approved',
        resultDetailRedacted: expect.objectContaining({
          runtimeSessionsRequested: 0,
          runtimeSessionsAcknowledged: 0,
          runtimeSessionsTimedOut: 0,
          runtimeSessionsFailed: 0,
        }),
      }),
    ]);
  });

  it('revokes credentials and reports acknowledged runtime termination counts', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([await principalFixture({ roles: ['operator'] })]);
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const sessionStore = new InMemoryConsoleSessionStore();
    const runtimeStore = new AutoAckRuntimeSessionControlStore();
    await registerRuntimePresence(runtimeStore);
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      oauthGrantRevocationService: oauthGrantRevocationService({ grantsRevoked: 1 }),
      runtimeSessionControlStore: runtimeStore,
      runtimeTerminationAcknowledgementTimeoutMs: 1,
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);

    await expect(revokeAll.handler(consoleRequest({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
      status: 200,
      body: {
        revocation_summary: {
          mcp_oauth_grants_revoked: 1,
          mcp_sessions_terminated: 1,
          mcp_sessions_termination_requested: 1,
          mcp_sessions_termination_acknowledged: 1,
          mcp_sessions_termination_timed_out: 0,
          new_authz_version: 4,
        },
      },
    });
    expect(adminAuditWriter.getEvents()).toHaveLength(3);
    expect(adminAuditWriter.getEvents()[2]).toMatchObject({
      operation: AUDIT_USERS_CREDENTIALS_REVOKE_ALL,
      result: 'approved',
      argsRedacted: { operation: 'credentials_revoke_all', phase: 'post_commit_runtime_termination' },
      resultDetailRedacted: expect.objectContaining({
        runtimeSessionsRequested: 1,
        runtimeSessionsAcknowledged: 1,
        runtimeSessionsTimedOut: 0,
      }),
    });
  });

  it('reports runtime termination failed acknowledgements distinctly from timeouts', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([await principalFixture({ roles: ['operator'] })]);
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const runtimeStore = new FailedAckRuntimeSessionControlStore();
    await registerRuntimePresence(runtimeStore);
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      oauthGrantRevocationService: oauthGrantRevocationService(),
      runtimeSessionControlStore: runtimeStore,
      runtimeTerminationAcknowledgementTimeoutMs: 1,
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);

    await expect(revokeAll.handler(consoleRequest({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
      status: 503,
      body: {
        revocation_summary: {
          mcp_sessions_termination_requested: 1,
          mcp_sessions_termination_acknowledged: 1,
          mcp_sessions_termination_failed: 1,
          mcp_sessions_termination_timed_out: 0,
        },
      },
    });
    expect(adminAuditWriter.getEvents()[2]).toMatchObject({
      operation: AUDIT_USERS_CREDENTIALS_REVOKE_ALL,
      result: 'failed',
      errorCode: 'runtime_termination_failed',
      argsRedacted: { operation: 'credentials_revoke_all', phase: 'post_commit_runtime_termination' },
    });
  });

  it('reports runtime service failures through the post-commit runtime phase', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([await principalFixture({ roles: ['operator'] })]);
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      oauthGrantRevocationService: oauthGrantRevocationService(),
      runtimeSessionControlStore: new ThrowingRuntimeSessionControlStore(),
      runtimeTerminationAcknowledgementTimeoutMs: 1,
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);

    await expect(revokeAll.handler(consoleRequest({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
      status: 503,
      body: {
        revocation_summary: {
          mcp_sessions_termination_requested: 0,
          mcp_sessions_termination_acknowledged: 0,
          mcp_sessions_termination_failed: 1,
          mcp_sessions_termination_timed_out: 0,
        },
      },
    });
    expect(adminAuditWriter.getEvents()[2]).toMatchObject({
      operation: AUDIT_USERS_CREDENTIALS_REVOKE_ALL,
      result: 'failed',
      errorCode: 'service_unavailable',
      argsRedacted: { operation: 'credentials_revoke_all', phase: 'post_commit_runtime_termination' },
    });
  });

  it('reports service unavailable when runtime termination acknowledgement times out after credential invalidation', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([await principalFixture({ roles: ['operator'] })]);
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const runtimeStore = new InMemoryRuntimeSessionControlStore();
    await registerRuntimePresence(runtimeStore);
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      oauthGrantRevocationService: oauthGrantRevocationService(),
      runtimeSessionControlStore: runtimeStore,
      runtimeTerminationAcknowledgementTimeoutMs: 1,
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);

    await expect(revokeAll.handler(consoleRequest({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
      status: 503,
      body: {
        revocation_summary: {
          mcp_sessions_termination_requested: 1,
          mcp_sessions_termination_acknowledged: 0,
          mcp_sessions_termination_timed_out: 1,
        },
      },
    });
    await expect(runtimeStore.listPendingCommandsForReplica(RUNTIME_REPLICA_ID)).resolves.toHaveLength(1);
    expect(adminAuditWriter.getEvents()[2]).toMatchObject({
      operation: AUDIT_USERS_CREDENTIALS_REVOKE_ALL,
      result: 'failed',
      errorCode: 'runtime_termination_ack_timeout',
      argsRedacted: { operation: 'credentials_revoke_all', phase: 'post_commit_runtime_termination' },
    });
  });

  it('fails credential revoke-all closed when OAuth grant revocation is unavailable', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([await principalFixture({ roles: ['operator'] })]);
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      oauthGrantRevocationService: null,
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);

    await expect(revokeAll.handler(consoleRequest({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
      status: 503,
      body: { code: 'service_unavailable' },
    });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_USERS_CREDENTIALS_REVOKE_ALL,
      result: 'failed',
      errorCode: 'service_unavailable',
      argsRedacted: { dependency: 'oauth_grant_revocation' },
    })]);
  });

  it('audits credential revoke-all not-found without invalidation', async () => {
    const { module, invalidationStore, adminAuditWriter } = mutationFixture();
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);

    await expect(revokeAll.handler(consoleRequest({
      params: { user_id: UNKNOWN_USER_ID },
    }))).resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });

    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_USERS_CREDENTIALS_REVOKE_ALL,
      result: 'failed',
      errorCode: 'not_found',
      targetUserId: UNKNOWN_USER_ID,
    })]);
  });

  it('allows credential revoke-all for a disabled principal with stale grants', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([
      await principalFixture({
        disabledAt: new Date('2026-05-27T13:30:00.000Z'),
        roles: ['operator'],
      }),
    ]);
    const { module, invalidationStore, adminAuditWriter } = mutationFixture(accountAdminStore);
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);

    await expect(revokeAll.handler(consoleRequest({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
      status: 200,
      body: {
        user: {
          user_id: USER_ID,
          disabled_at: '2026-05-27T13:30:00.000Z',
        },
        revocation_summary: {
          authz_version_bumped: true,
          new_authz_version: 4,
        },
      },
    });

    await expect(invalidationStore.listEventsAfter(0)).resolves.toMatchObject([{
      kind: 'principal_credentials_revoked',
      authzVersion: 4,
    }]);
    expect(adminAuditWriter.getEvents()).toHaveLength(3);
  });

  it('returns service_unavailable when post-commit browser-session revocation fails after invalidating credentials', async () => {
    class FailingSessionStore extends InMemoryConsoleSessionStore {
      override async revokeForUser(): Promise<number> {
        await Promise.resolve();
        throw new Error('session store unavailable');
      }
    }
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([await principalFixture({ roles: ['operator'] })]);
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new FailingSessionStore(),
      oauthGrantRevocationService: oauthGrantRevocationService(),
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);

    await expect(revokeAll.handler(consoleRequest({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
      status: 503,
      body: { code: 'service_unavailable' },
    });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toMatchObject([{
      kind: 'principal_credentials_revoked',
      authzVersion: 4,
    }]);
    expect(adminAuditWriter.getEvents()).toEqual([
      expect.objectContaining({
        operation: AUDIT_USERS_CREDENTIALS_REVOKE_ALL,
        result: 'approved',
        argsRedacted: { operation: 'credentials_revoke_all', phase: 'state_committed' },
      }),
      expect.objectContaining({
        operation: AUDIT_USERS_CREDENTIALS_REVOKE_ALL,
        result: 'failed',
        errorCode: 'service_unavailable',
        argsRedacted: { operation: 'credentials_revoke_all', phase: 'post_commit_revocation' },
      }),
    ]);
  });

  it('returns service_unavailable when post-commit OAuth revocation fails after invalidating credentials', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([await principalFixture({ roles: ['operator'] })]);
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      oauthGrantRevocationService: oauthGrantRevocationService({ fail: true }),
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);

    await expect(revokeAll.handler(consoleRequest({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
      status: 503,
      body: { code: 'service_unavailable' },
    });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toMatchObject([{
      kind: 'principal_credentials_revoked',
      authzVersion: 4,
    }]);
    expect(adminAuditWriter.getEvents()).toEqual([
      expect.objectContaining({
        operation: AUDIT_USERS_CREDENTIALS_REVOKE_ALL,
        result: 'approved',
        argsRedacted: { operation: 'credentials_revoke_all', phase: 'state_committed' },
      }),
      expect.objectContaining({
        operation: AUDIT_USERS_CREDENTIALS_REVOKE_ALL,
        result: 'failed',
        errorCode: 'service_unavailable',
        argsRedacted: { operation: 'credentials_revoke_all', phase: 'post_commit_revocation' },
      }),
    ]);
  });

  it('requires transaction callbacks to write admin audit before reporting success', async () => {
    const runner = new InMemoryAccountAdminMutationTransactionRunner({
      accountAdminStore: store(),
      accountAllowlistStore: new InMemoryConsoleAccountAllowlistStore(),
      securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
      adminAuditWriter: new InMemoryAdminAuditWriter(),
    });

    await expect(runner.run(() => Promise.resolve('committed'))).rejects.toThrow('without admin audit');
  });
});
