import { describe, expect, it, jest } from '@jest/globals';

import type { IAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/IAuthStorageLayer.js';
import { AccountAdminRoleMutationService } from '../../../../src/web-console/modules/account-admin/AccountAdminRoleMutationService.js';
import {
  ConsoleModuleRegistry,
  InMemoryAccountAdminMutationTransactionRunner,
  InMemoryAdminAuditWriter,
  InMemoryConsoleAccountAllowlistStore,
  InMemoryConsoleAccountAdminStore,
  InMemoryConsoleAuthPolicyStore,
  InMemoryConsoleFactorStore,
  InMemoryConsoleSessionStore,
  InMemoryConsoleSecurityInvalidationStore,
  InMemoryRuntimeSessionControlStore,
  createAccountAdminModule,
  type ConsoleRouteDefinition,
  type ConsoleRequest,
  type ConsoleSessionRecord,
  type ConsoleAdminRole,
  type IAccountAdminMutationTransactionRunner,
  type IConsoleAccountInviteIssuer,
  type IConsoleAccountAdminStore,
  type LinkedIdentity,
  type IOAuthGrantRevocationService,
} from '../../../../src/web-console/index.js';
import { InMemorySigningKeyStore } from '../../../../src/storage/signingKeys/InMemorySigningKeyStore.js';
import type { ConsoleAdminAuditEvent } from '../../../../src/web-console/audit/IAdminAuditWriter.js';
import { InMemoryUserIntegrationStore } from '../../../../src/web-console/stores/InMemoryUserIntegrationStore.js';
import { InMemoryLoginTransactionStore } from '../../../../src/web-console/stores/InMemoryLoginTransactionStore.js';

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
const ADMIN_USERS_PATH = '/api/v1/admin/accounts/users';
const ALICE_EMAIL = 'alice@example.test';
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
const FACTOR_ID = 'cd8f6d0e-7294-42bc-9e01-094890a820a8';
const TARGET_PRIMARY_SUB = 'github_target-primary';
const TARGET_SECONDARY_SUB = 'github_target-secondary';
const UNLINKED_SUB = 'github_unlinked-login';

function store(): InMemoryConsoleAccountAdminStore {
  return new InMemoryConsoleAccountAdminStore([{
    userId: USER_ID,
    primarySub: PRIMARY_SUB,
    username: 'alice',
    displayName: 'Alice Example',
    email: ALICE_EMAIL,
    emailVerified: true,
    authMethods: ['github'],
    roles: [ACCOUNT_ADMIN_ROLE],
    disabledAt: null,
    createdAt: NOW,
    lastLoginAt: LAST_LOGIN,
    adminFactorEnrolled: true,
    accountCorrelationId: ACCOUNT_CORRELATION_ID,
    authzVersion: 3,
  }, {
    userId: SECOND_USER_ID,
    primarySub: 'github_admin-operator',
    username: 'admin-operator',
    displayName: 'Admin Operator',
    email: 'admin-operator@example.test',
    emailVerified: true,
    authMethods: ['github'],
    roles: ['operator'],
    disabledAt: null,
    createdAt: NOW,
    lastLoginAt: LAST_LOGIN,
    adminFactorEnrolled: true,
    accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
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

async function secondaryActorFixture() {
  const summary = await store().findPrincipal(SECOND_USER_ID);
  if (!summary) throw new Error('missing secondary actor fixture');
  return summary;
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
  const inviteIssuer = accountInviteIssuer();
  const module = createAccountAdminModule({
    accountAdminStore: principals,
    accountAllowlistStore,
    sessionStore,
    authStorage: authStorageFixture({ adminSub: PRIMARY_SUB }),
    accountInviteIssuer: inviteIssuer,
    oauthGrantRevocationService: oauthGrantRevocationService(),
    enableAccountAllowlistRoutes: true,
    accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
      accountAdminStore: principals,
      accountAllowlistStore,
      securityInvalidationStore: invalidationStore,
      adminAuditWriter,
      inviteIssuer,
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
}> = {}): IConsoleAccountInviteIssuer & {
  createTransactionSnapshot(): unknown;
  restoreTransactionSnapshot(snapshot: unknown): void;
} {
  const issueInvite = async (input: Parameters<IConsoleAccountInviteIssuer['issueInvite']>[0]) => {
    await Promise.resolve();
    return {
      inviteUrl: overrides.inviteUrl ?? `https://console.example.test/invite/${input.username}`,
      expiresAt: new Date(input.issuedAt.getTime() + input.ttlMinutes * 60_000),
      userId: overrides.userId ?? SECOND_USER_ID,
      primarySub: overrides.primarySub ?? `local_${input.username}`,
    };
  };
  return {
    createTransactionSnapshot() {
      return null;
    },
    restoreTransactionSnapshot(_snapshot: unknown) {
      // Fixture has no mutable issuance state.
    },
    issueInvite,
    async prepareIssueInvite(input) {
      return {
        result: await issueInvite(input),
        async commit() {
          await Promise.resolve();
        },
      };
    },
  };
}

function stagedAccountInviteIssuer(options: { readonly commitError?: Error } = {}) {
  const pendingUserIds: string[] = [];
  const deliveredUserIds: string[] = [];
  const base = accountInviteIssuer();
  return {
    pendingUserIds,
    deliveredUserIds,
    createTransactionSnapshot() {
      return [...pendingUserIds];
    },
    restoreTransactionSnapshot(snapshot: unknown) {
      pendingUserIds.splice(0, pendingUserIds.length, ...(snapshot as readonly string[]));
    },
    issueInvite: base.issueInvite.bind(base),
    async prepareIssueInvite(input: Parameters<IConsoleAccountInviteIssuer['issueInvite']>[0]) {
      const result = await base.issueInvite(input);
      pendingUserIds.push(result.userId);
      return {
        result,
        async commit() {
          if (options.commitError) throw options.commitError;
          deliveredUserIds.push(result.userId);
        },
      };
    },
  };
}

function adminAuditEvent(overrides: Partial<ConsoleAdminAuditEvent> = {}): ConsoleAdminAuditEvent {
  return {
    occurredAt: NOW,
    actorUserId: USER_ID,
    actorSub: PRIMARY_SUB,
    actorRole: ACCOUNT_ADMIN_ROLE,
    actorCapabilityRole: ACCOUNT_ADMIN_ROLE,
    actorConsoleSessionHash: Buffer.alloc(32, 7),
    capability: ACCOUNT_ADMIN_CAPABILITY,
    elevationAcr: 'urn:dollhouse:acr:admin-stepup',
    elevationAmr: ['otp'],
    elevationAuthTime: NOW,
    correlationId: '94017d3c-7b7a-4e28-a3c2-701e0ea5471d',
    endpoint: 'POST /api/v1/admin/accounts/test',
    operation: 'accounts.test',
    resourceKind: 'account_principal',
    resourceId: USER_ID,
    targetUserId: USER_ID,
    argsRedacted: {},
    result: 'approved',
    errorCode: null,
    resultDetailRedacted: null,
    clientIp: '127.0.0.1',
    userAgent: 'jest',
    ...overrides,
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
    async revokeSubjectGrants(sub) {
      await Promise.resolve();
      if (overrides.fail) throw new Error('oauth unavailable');
      return {
        sub,
        grantsDiscovered: overrides.grantsDiscovered ?? overrides.grantsRevoked ?? 2,
        grantsRevoked: overrides.grantsRevoked ?? 2,
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

  override async listAllPresenceByUser(): ReturnType<InMemoryRuntimeSessionControlStore['listAllPresenceByUser']> {
    await Promise.resolve();
    throw new Error('runtime store unavailable');
  }
}

class ToggleFailingSessionStore extends InMemoryConsoleSessionStore {
  failRevocation = true;

  override async revokeForUser(
    userId: string,
    revokedAt?: Date,
  ): ReturnType<InMemoryConsoleSessionStore['revokeForUser']> {
    if (this.failRevocation) throw new Error('session store unavailable');
    return super.revokeForUser(userId, revokedAt);
  }
}

class DeferredAcknowledgementStore extends InMemoryConsoleSecurityInvalidationStore {
  private releaseAcknowledgements!: (replicaIds: string[]) => void;
  private signalWaitStarted!: () => void;
  private readonly acknowledgementResult = new Promise<string[]>(resolve => {
    this.releaseAcknowledgements = resolve;
  });
  readonly waitStarted = new Promise<void>(resolve => {
    this.signalWaitStarted = resolve;
  });

  override async listLiveReplicaIds(): Promise<string[]> {
    return ['replica-a', 'replica-b'];
  }

  override async listAcknowledgedReplicaIds(): Promise<string[]> {
    this.signalWaitStarted();
    return this.acknowledgementResult;
  }

  acknowledgeAll(): void {
    this.releaseAcknowledgements(['replica-a', 'replica-b']);
  }
}

class MissingAcknowledgementStore extends InMemoryConsoleSecurityInvalidationStore {
  override async listLiveReplicaIds(): Promise<string[]> {
    return ['replica-a'];
  }

  override async listAcknowledgedReplicaIds(): Promise<string[]> {
    return [];
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

function consoleRequestAsOperatorAdmin(overrides: Partial<ConsoleRequest> = {}): ConsoleRequest {
  const authentication = consoleRequest().consoleAuthentication;
  if (!authentication) throw new Error(MISSING_AUTHENTICATION_FIXTURE);
  return consoleRequest({
    ...overrides,
    consoleAuthentication: {
      ...authentication,
      grantedCapabilities: [...authentication.grantedCapabilities, OPERATE_CAPABILITY],
    },
  });
}

function consoleRequestAsSeparateAccountAdmin(overrides: Partial<ConsoleRequest> = {}): ConsoleRequest {
  const authentication = consoleRequest().consoleAuthentication;
  if (!authentication) throw new Error(MISSING_AUTHENTICATION_FIXTURE);
  return consoleRequest({
    ...overrides,
    consoleAuthentication: {
      ...authentication,
      userId: SECOND_USER_ID,
      authSub: 'github_admin-operator',
      grantedCapabilities: [...authentication.grantedCapabilities, OPERATE_CAPABILITY],
    },
  });
}

function identityFixture(
  sub: string,
  linkedUserId: string | null,
): LinkedIdentity {
  return {
    sub,
    provider: 'github',
    externalSub: sub.replace('github_', ''),
    email: `${sub}@example.test`,
    emailVerified: true,
    displayName: sub,
    linkedUserId,
    createdAt: NOW,
    lastAuthAt: LAST_LOGIN,
  };
}

function sessionRecord(overrides: Partial<ConsoleSessionRecord> = {}): ConsoleSessionRecord {
  return {
    idHash: Buffer.alloc(32, 9),
    userId: USER_ID,
    authSub: PRIMARY_SUB,
    authzVersion: 3,
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
        path: ADMIN_USERS_PATH,
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
        path: '/api/v1/admin/accounts/identities/unlinked',
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        ownership: 'none',
        elevation: 'admin_30m',
        privacyClass: ACCOUNT_METADATA_PRIVACY,
        idempotency: IDEMPOTENCY_NOT_APPLICABLE,
        auditOperation: 'accounts.identities.unlinked.list',
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
    const route = findRoute(module.routes, ADMIN_USERS_PATH);

    const result = await route.handler(consoleRequest({
      query: { limit: '20', sub: PRIMARY_SUB },
    }));
    const rawBody = result.body as Record<string, unknown>;
    const firstUser = (rawBody.items as Record<string, unknown>[])[0];
    firstUser.authz_version = 3;
    firstUser.account_correlation_id = ACCOUNT_CORRELATION_ID;
    firstUser.private_settings = { leaked: true };

    expect(route.privacyProjector?.(result.body)).toEqual({
      items: [{
        user_id: USER_ID,
        primary_sub: PRIMARY_SUB,
        username: 'alice',
        display_name: 'Alice Example',
        email: ALICE_EMAIL,
        email_verified: true,
        auth_methods: ['github'],
        roles: [ACCOUNT_ADMIN_ROLE],
        disabled_at: null,
        created_at: NOW.toISOString(),
        last_login_at: LAST_LOGIN.toISOString(),
        admin_factor_enrolled: true,
      }],
      page: { limit: 20, cursor: null, next_cursor: null },
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
      normalized_value: ALICE_EMAIL,
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
    await expect(add.handler(consoleRequest({ body: { kind: 'email', value: ALICE_EMAIL } })))
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

  it('preserves distinct allowlist principals before storage', async () => {
    const { module } = mutationFixture();
    const add = findRoute(module.routes, ACCOUNT_ALLOWLIST_PATH, 'POST');
    const cyrillicAlice = '\u0430lice@example.test';

    await expect(add.handler(consoleRequest({
      body: { kind: 'github_username', value: 'ｍick' },
    }))).resolves.toMatchObject({
      status: 400,
      body: { code: 'invalid_request' },
    });
    await expect(add.handler(consoleRequest({
      body: { kind: 'email', value: cyrillicAlice },
    }))).resolves.toMatchObject({
      status: 201,
      body: { kind: 'email', value: cyrillicAlice },
    });
    await expect(add.handler(consoleRequest({
      body: { kind: 'email', value: 'alice@example.test' },
    }))).resolves.toMatchObject({
      status: 201,
      body: { kind: 'email', value: 'alice@example.test' },
    });
  });

  it('rejects malformed list query parameters before hitting the store', async () => {
    const { module } = mutationFixture();
    const route = findRoute(module.routes, ADMIN_USERS_PATH);

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
      argsRedacted: { operation: 'revoke', role: 'operator' },
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

  it.each<ConsoleAdminRole>(['admin', 'security_admin', 'operator', 'auditor'])(
    're-checks locked target authority and blocks account_admin mutations after a concurrent %s grant',
    async protectedRole => {
      const operations = [
        {
          name: 'link',
          path: '/api/v1/admin/accounts/users/:user_id/identities/link',
          method: 'POST' as const,
          body: { sub: UNLINKED_SUB },
        },
        {
          name: 'unlink',
          path: '/api/v1/admin/accounts/users/:user_id/identities/unlink',
          method: 'POST' as const,
          body: { sub: TARGET_SECONDARY_SUB },
        },
        { name: 'disable', path: ACCOUNT_DISABLE_PATH, method: 'POST' as const, body: {} },
        { name: 'enable', path: ACCOUNT_ENABLE_PATH, method: 'POST' as const, body: {} },
        {
          name: 'delete',
          path: '/api/v1/admin/accounts/users/:user_id',
          method: 'DELETE' as const,
          body: {},
        },
      ] as const;

      for (const operation of operations) {
        const targetDisabledAt = operation.name === 'enable' ? LAST_LOGIN : null;
        const actor = await principalFixture();
        const target = await principalFixture({
          userId: SECOND_USER_ID,
          primarySub: TARGET_PRIMARY_SUB,
          username: 'target',
          roles: [],
          disabledAt: targetDisabledAt,
          accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
        });
        const accountAdminStore = new InMemoryConsoleAccountAdminStore(
          [actor, target],
          [
            identityFixture(TARGET_PRIMARY_SUB, SECOND_USER_ID),
            identityFixture(TARGET_SECONDARY_SUB, SECOND_USER_ID),
            identityFixture(UNLINKED_SUB, null),
          ],
        );
        const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
        const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
        const adminAuditWriter = new InMemoryAdminAuditWriter();
        const baseRunner = new InMemoryAccountAdminMutationTransactionRunner({
          accountAdminStore,
          accountAllowlistStore,
          securityInvalidationStore: invalidationStore,
          adminAuditWriter,
        });
        let promoted = false;
        const transactionRunner: IAccountAdminMutationTransactionRunner = {
          async run<T>(transactionOperation): Promise<T> {
            if (!promoted) {
              promoted = true;
              await accountAdminStore.grantRole({
                userId: SECOND_USER_ID,
                role: protectedRole,
                grantedByUserId: USER_ID,
                grantedAt: NOW,
              });
            }
            return baseRunner.run(transactionOperation);
          },
          runInvite: transactionOperation => baseRunner.runInvite(transactionOperation),
        };
        const sessionStore = new InMemoryConsoleSessionStore();
        const revokeForUser = jest.spyOn(sessionStore, 'revokeForUser');
        const oauthRevocation = oauthGrantRevocationService();
        const revokePrincipalGrants = jest.spyOn(oauthRevocation, 'revokePrincipalGrants');
        const revokeSubjectGrants = jest.spyOn(oauthRevocation, 'revokeSubjectGrants');
        const module = createAccountAdminModule({
          accountAdminStore,
          accountAllowlistStore,
          sessionStore,
          authStorage: authStorageFixture({ adminSub: PRIMARY_SUB }),
          oauthGrantRevocationService: oauthRevocation,
          accountAdminMutationTransactionRunner: transactionRunner,
          enableAccountAllowlistRoutes: true,
          now: () => NOW,
        });
        const route = findRoute(module.routes, operation.path, operation.method);

        await expect(route.handler(consoleRequest({
          params: { user_id: SECOND_USER_ID },
          body: operation.body,
        }))).resolves.toMatchObject({
          status: 403,
          body: { code: 'insufficient_role_authority' },
        });

        const current = await accountAdminStore.findPrincipal(SECOND_USER_ID);
        expect(current).not.toBeNull();
        expect(current?.roles).toContain(protectedRole);
        expect(current?.disabledAt).toEqual(targetDisabledAt);
        await expect(accountAdminStore.findIdentityBySub(UNLINKED_SUB)).resolves.toMatchObject({
          linkedUserId: null,
        });
        await expect(accountAdminStore.findIdentityBySub(TARGET_SECONDARY_SUB)).resolves.toMatchObject({
          linkedUserId: SECOND_USER_ID,
        });
        await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
        expect(revokeForUser).not.toHaveBeenCalled();
        expect(revokePrincipalGrants).not.toHaveBeenCalled();
        expect(revokeSubjectGrants).not.toHaveBeenCalled();
        expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
          targetUserId: SECOND_USER_ID,
          result: 'rejected',
          errorCode: 'insufficient_role_authority',
          argsRedacted: expect.objectContaining({ roles: [protectedRole] }),
        })]);
      }
    },
  );

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

    const result = await disable.handler(consoleRequestAsOperatorAdmin({ params: { user_id: USER_ID } }));

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

    await expect(disable.handler(consoleRequestAsOperatorAdmin({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
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

    await expect(disable.handler(consoleRequestAsOperatorAdmin({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
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
      await secondaryActorFixture(),
    ]);
    const { module, invalidationStore, adminAuditWriter } = mutationFixture(accountAdminStore);
    const enable = findRoute(module.routes, ACCOUNT_ENABLE_PATH);

    await expect(enable.handler(consoleRequestAsSeparateAccountAdmin({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
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

  it('does not request runtime termination when locked role authority rejects enable', async () => {
    class RoleChangesBeforeLockStore extends InMemoryConsoleAccountAdminStore {
      private targetReads = 0;

      override async findPrincipal(userId: string) {
        const principal = await super.findPrincipal(userId);
        if (!principal || userId !== USER_ID) return principal;
        this.targetReads += 1;
        return {
          ...principal,
          roles: this.targetReads === 1 ? ['operator'] : ['security_admin'],
        };
      }
    }

    const accountAdminStore = new RoleChangesBeforeLockStore([
      await principalFixture({ disabledAt: LAST_LOGIN, roles: ['operator'] }),
      await secondaryActorFixture(),
    ]);
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const runtimeStore = new AutoAckRuntimeSessionControlStore();
    await registerRuntimePresence(runtimeStore);
    const createTerminationCommand = jest.spyOn(runtimeStore, 'createTerminationCommand');
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      oauthGrantRevocationService: oauthGrantRevocationService(),
      runtimeSessionControlStore: runtimeStore,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
        runtimeSessionControlStore: runtimeStore,
      }),
      now: () => NOW,
    });
    const enable = findRoute(module.routes, ACCOUNT_ENABLE_PATH);

    await expect(enable.handler(consoleRequestAsSeparateAccountAdmin({ params: { user_id: USER_ID } })))
      .resolves.toMatchObject({ status: 403, body: { code: 'insufficient_role_authority' } });

    expect(createTerminationCommand).not.toHaveBeenCalled();
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_USERS_ENABLE,
      result: 'rejected',
      errorCode: 'insufficient_role_authority',
      argsRedacted: expect.objectContaining({ phase: 'runtime_termination_request' }),
    })]);
  });

  it('keeps a principal disabled when pre-enable OAuth grant revocation fails', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore(
      [await principalFixture({ disabledAt: LAST_LOGIN, roles: ['operator'] }), await secondaryActorFixture()],
      [identityFixture(PRIMARY_SUB, USER_ID)],
    );
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const revokePrincipalGrants = jest.fn<IOAuthGrantRevocationService['revokePrincipalGrants']>();
    const revokeSubjectGrants = jest.fn<NonNullable<IOAuthGrantRevocationService['revokeSubjectGrants']>>()
      .mockRejectedValue(new Error('oauth unavailable'));
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      oauthGrantRevocationService: {
        revokePrincipalGrants,
        revokeSubjectGrants,
      },
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const enable = findRoute(module.routes, ACCOUNT_ENABLE_PATH);

    await expect(enable.handler(consoleRequestAsSeparateAccountAdmin({ params: { user_id: USER_ID } })))
      .resolves.toMatchObject({ status: 503, body: { code: 'service_unavailable' } });

    await expect(accountAdminStore.findPrincipal(USER_ID)).resolves.toMatchObject({ disabledAt: LAST_LOGIN });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
    expect(revokePrincipalGrants).not.toHaveBeenCalled();
    expect(revokeSubjectGrants).toHaveBeenCalledWith(PRIMARY_SUB, NOW);
    expect(adminAuditWriter.getEvents()).toEqual([expect.objectContaining({
      operation: AUDIT_USERS_ENABLE,
      result: 'failed',
      errorCode: 'service_unavailable',
      argsRedacted: { operation: 'enable', phase: 'oauth_grant_revocation' },
    })]);
  });

  it('does not re-enable after failed browser cleanup until a locked retry succeeds', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore(
      [await principalFixture({ roles: ['operator'] }), await secondaryActorFixture()],
      [identityFixture(PRIMARY_SUB, USER_ID)],
    );
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new DeferredAcknowledgementStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const sessionStore = new ToggleFailingSessionStore();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      securityInvalidationStore: invalidationStore,
      oauthGrantRevocationService: oauthGrantRevocationService(),
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const disable = findRoute(module.routes, ACCOUNT_DISABLE_PATH);
    const enable = findRoute(module.routes, ACCOUNT_ENABLE_PATH);
    const request = () => consoleRequestAsSeparateAccountAdmin({ params: { user_id: USER_ID } });

    let disableSettled = false;
    const disableResult = disable.handler(request()).finally(() => { disableSettled = true; });
    await invalidationStore.waitStarted;
    expect(disableSettled).toBe(false);
    invalidationStore.acknowledgeAll();
    await expect(disableResult).resolves.toMatchObject({
      status: 503,
      body: { code: 'service_unavailable' },
    });
    await expect(accountAdminStore.findPrincipal(USER_ID)).resolves.toMatchObject({ disabledAt: NOW });

    await expect(enable.handler(request())).resolves.toMatchObject({
      status: 503,
      body: { code: 'service_unavailable' },
    });
    await expect(accountAdminStore.findPrincipal(USER_ID)).resolves.toMatchObject({ disabledAt: NOW });

    sessionStore.failRevocation = false;
    await expect(enable.handler(request())).resolves.toMatchObject({
      status: 200,
      body: { user: { disabled_at: null } },
    });
    await expect(accountAdminStore.findPrincipal(USER_ID)).resolves.toMatchObject({ disabledAt: null });
  });

  it('keeps a principal disabled until stale MCP runtime termination succeeds', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([
      await principalFixture({ disabledAt: LAST_LOGIN, roles: ['operator'] }),
      await secondaryActorFixture(),
    ]);
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const runtimeStore = new FailedAckRuntimeSessionControlStore();
    await registerRuntimePresence(runtimeStore);
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      oauthGrantRevocationService: oauthGrantRevocationService(),
      runtimeSessionControlStore: runtimeStore,
      runtimeTerminationAcknowledgementTimeoutMs: 1,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter: new InMemoryAdminAuditWriter(),
        runtimeSessionControlStore: runtimeStore,
      }),
      now: () => NOW,
    });
    const enable = findRoute(module.routes, ACCOUNT_ENABLE_PATH);

    await expect(enable.handler(consoleRequestAsSeparateAccountAdmin({ params: { user_id: USER_ID } })))
      .resolves.toMatchObject({ status: 503, body: { code: 'service_unavailable' } });
    await expect(accountAdminStore.findPrincipal(USER_ID)).resolves.toMatchObject({ disabledAt: LAST_LOGIN });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
  });

  it('waits for every live replica before completing disable and reports revoked browser sessions', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([await principalFixture({ roles: [] })]);
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new DeferredAcknowledgementStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const sessionStore = new InMemoryConsoleSessionStore();
    await sessionStore.create(sessionRecord());
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      securityInvalidationStore: invalidationStore,
      oauthGrantRevocationService: oauthGrantRevocationService(),
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const disable = findRoute(module.routes, ACCOUNT_DISABLE_PATH);
    let settled = false;

    const result = disable.handler(consoleRequest({ params: { user_id: USER_ID } }))
      .finally(() => { settled = true; });
    await invalidationStore.waitStarted;

    expect(settled).toBe(false);
    await expect(accountAdminStore.findPrincipal(USER_ID)).resolves.toMatchObject({ disabledAt: NOW });
    await expect(sessionStore.findActiveByIdHash(Buffer.alloc(32, 9), NOW)).resolves.toBeNull();

    invalidationStore.acknowledgeAll();
    await expect(result).resolves.toMatchObject({
      status: 200,
      body: { revocation_summary: { browser_sessions_revoked: 1 } },
    });
  });

  it('keeps the principal disabled when acknowledged invalidation times out', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([await principalFixture({ roles: [] })]);
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new MissingAcknowledgementStore();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      securityInvalidationStore: invalidationStore,
      securityInvalidationAcknowledgementTimeoutMs: 0,
      oauthGrantRevocationService: oauthGrantRevocationService(),
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    const disable = findRoute(module.routes, ACCOUNT_DISABLE_PATH);

    await expect(disable.handler(consoleRequest({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
      status: 503,
      body: { code: 'service_unavailable' },
    });
    await expect(accountAdminStore.findPrincipal(USER_ID)).resolves.toMatchObject({ disabledAt: NOW });
  });

  it('keeps an unlinked subject fenced until OAuth grant cleanup succeeds before relinking', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore(
      [await principalFixture(), await secondaryActorFixture()],
      [
        identityFixture(PRIMARY_SUB, USER_ID),
        identityFixture(TARGET_SECONDARY_SUB, USER_ID),
        identityFixture(UNLINKED_SUB, null),
      ],
    );
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const transactionRunner = new InMemoryAccountAdminMutationTransactionRunner({
      accountAdminStore,
      accountAllowlistStore,
      securityInvalidationStore: invalidationStore,
      adminAuditWriter,
    });
    const failingSubjectRevocation = jest.fn<IOAuthGrantRevocationService['revokeSubjectGrants']>()
      .mockRejectedValue(new Error('oauth unavailable'));
    const failingModule = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      oauthGrantRevocationService: {
        revokePrincipalGrants: jest.fn<IOAuthGrantRevocationService['revokePrincipalGrants']>(),
        revokeSubjectGrants: failingSubjectRevocation,
      },
      accountAdminMutationTransactionRunner: transactionRunner,
      enableAccountAllowlistRoutes: true,
      now: () => NOW,
    });
    const unlink = findRoute(
      failingModule.routes,
      '/api/v1/admin/accounts/users/:user_id/identities/unlink',
    );

    await expect(unlink.handler(consoleRequestAsSeparateAccountAdmin({
      params: { user_id: USER_ID },
      body: { sub: TARGET_SECONDARY_SUB },
    }))).resolves.toMatchObject({ status: 503, body: { code: 'service_unavailable' } });
    await expect(accountAdminStore.findIdentityBySub(TARGET_SECONDARY_SUB)).resolves.toMatchObject({
      linkedUserId: null,
    });

    const successfulSubjectRevocation = jest.fn<IOAuthGrantRevocationService['revokeSubjectGrants']>()
      .mockResolvedValue({ sub: TARGET_SECONDARY_SUB, grantsDiscovered: 1, grantsRevoked: 1 });
    const healthyModule = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      oauthGrantRevocationService: {
        revokePrincipalGrants: jest.fn<IOAuthGrantRevocationService['revokePrincipalGrants']>(),
        revokeSubjectGrants: successfulSubjectRevocation,
      },
      accountAdminMutationTransactionRunner: transactionRunner,
      enableAccountAllowlistRoutes: true,
      now: () => NOW,
    });
    const link = findRoute(
      healthyModule.routes,
      '/api/v1/admin/accounts/users/:user_id/identities/link',
    );

    await expect(link.handler(consoleRequestAsSeparateAccountAdmin({
      params: { user_id: USER_ID },
      body: { sub: TARGET_SECONDARY_SUB },
    }))).resolves.toMatchObject({ status: 200 });
    expect(successfulSubjectRevocation).toHaveBeenCalledWith(TARGET_SECONDARY_SUB, NOW);
    await expect(accountAdminStore.findIdentityBySub(TARGET_SECONDARY_SUB)).resolves.toMatchObject({
      linkedUserId: USER_ID,
    });
  });

  it('waits for unlink acknowledgement and never revives the old browser session after same-user relink', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore(
      [await principalFixture(), await secondaryActorFixture()],
      [
        identityFixture(PRIMARY_SUB, USER_ID),
        identityFixture(TARGET_SECONDARY_SUB, USER_ID),
      ],
    );
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new DeferredAcknowledgementStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const sessionStore = new InMemoryConsoleSessionStore();
    const oldSession = sessionRecord({ authSub: TARGET_SECONDARY_SUB });
    await sessionStore.create(oldSession);
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      securityInvalidationStore: invalidationStore,
      oauthGrantRevocationService: oauthGrantRevocationService(),
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const unlink = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id/identities/unlink');
    const link = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id/identities/link');
    const request = { params: { user_id: USER_ID }, body: { sub: TARGET_SECONDARY_SUB } };
    let settled = false;

    const unlinkResult = unlink.handler(consoleRequestAsSeparateAccountAdmin(request)).finally(() => { settled = true; });
    await invalidationStore.waitStarted;

    expect(settled).toBe(false);
    await expect(accountAdminStore.findIdentityBySub(TARGET_SECONDARY_SUB)).resolves.toMatchObject({
      linkedUserId: null,
    });
    await expect(sessionStore.findActiveByIdHash(oldSession.idHash, NOW)).resolves.toBeNull();

    invalidationStore.acknowledgeAll();
    await expect(unlinkResult).resolves.toMatchObject({ status: 200 });
    await expect(link.handler(consoleRequestAsSeparateAccountAdmin(request))).resolves.toMatchObject({ status: 200 });
    await expect(accountAdminStore.findIdentityBySub(TARGET_SECONDARY_SUB)).resolves.toMatchObject({
      linkedUserId: USER_ID,
    });
    await expect(sessionStore.findActiveByIdHash(oldSession.idHash, NOW)).resolves.toBeNull();
  });

  it('terminates MCP runtime sessions after identity link and unlink mutations', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore(
      [await principalFixture(), await secondaryActorFixture()],
      [
        identityFixture(PRIMARY_SUB, USER_ID),
        identityFixture(TARGET_SECONDARY_SUB, USER_ID),
        identityFixture(UNLINKED_SUB, null),
      ],
    );
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const runtimeStore = new AutoAckRuntimeSessionControlStore();
    await registerRuntimePresence(runtimeStore);
    const createTerminationCommand = jest.spyOn(runtimeStore, 'createTerminationCommand');
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      securityInvalidationStore: invalidationStore,
      oauthGrantRevocationService: oauthGrantRevocationService(),
      runtimeSessionControlStore: runtimeStore,
      runtimeTerminationAcknowledgementTimeoutMs: 1,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    const link = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id/identities/link');
    const unlink = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id/identities/unlink');

    await expect(link.handler(consoleRequestAsSeparateAccountAdmin({
      params: { user_id: USER_ID },
      body: { sub: UNLINKED_SUB },
    }))).resolves.toMatchObject({ status: 200 });
    await expect(unlink.handler(consoleRequestAsSeparateAccountAdmin({
      params: { user_id: USER_ID },
      body: { sub: TARGET_SECONDARY_SUB },
    }))).resolves.toMatchObject({ status: 200 });

    expect(createTerminationCommand).toHaveBeenCalledTimes(2);
    expect(createTerminationCommand).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'credential_revoked',
      requestedBy: { kind: 'admin', userId: SECOND_USER_ID },
    }));
  });

  it('keeps a provisionally linked identity fenced when runtime cleanup fails', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore(
      [await principalFixture(), await secondaryActorFixture()],
      [identityFixture(PRIMARY_SUB, USER_ID), identityFixture(UNLINKED_SUB, null)],
    );
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const runtimeStore = new FailedAckRuntimeSessionControlStore();
    await registerRuntimePresence(runtimeStore);
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      securityInvalidationStore: invalidationStore,
      oauthGrantRevocationService: oauthGrantRevocationService(),
      runtimeSessionControlStore: runtimeStore,
      runtimeTerminationAcknowledgementTimeoutMs: 1,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    const link = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id/identities/link');

    await expect(link.handler(consoleRequestAsSeparateAccountAdmin({
      params: { user_id: USER_ID },
      body: { sub: UNLINKED_SUB },
    }))).resolves.toMatchObject({ status: 503, body: { code: 'service_unavailable' } });
    await expect(accountAdminStore.findIdentityBySub(UNLINKED_SUB)).resolves.toMatchObject({
      linkedUserId: USER_ID,
    });
    await expect(accountAdminStore.isIdentityRevocationFenced(UNLINKED_SUB)).resolves.toBe(true);

    const healthyRuntimeStore = new AutoAckRuntimeSessionControlStore();
    await registerRuntimePresence(healthyRuntimeStore);
    const retryModule = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      securityInvalidationStore: invalidationStore,
      oauthGrantRevocationService: oauthGrantRevocationService(),
      runtimeSessionControlStore: healthyRuntimeStore,
      runtimeTerminationAcknowledgementTimeoutMs: 1,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    const retryLink = findRoute(retryModule.routes, '/api/v1/admin/accounts/users/:user_id/identities/link');
    await expect(retryLink.handler(consoleRequestAsSeparateAccountAdmin({
      params: { user_id: USER_ID },
      body: { sub: UNLINKED_SUB },
    }))).resolves.toMatchObject({ status: 200 });
    await expect(accountAdminStore.isIdentityRevocationFenced(UNLINKED_SUB)).resolves.toBe(false);
  });

  it('does not revoke credentials when a stale retry discovers an already-finalized link under lock', async () => {
    class StaleFenceReadStore extends InMemoryConsoleAccountAdminStore {
      override async isIdentityRevocationFenced(sub: string): Promise<boolean> {
        if (sub === TARGET_SECONDARY_SUB) return true;
        return super.isIdentityRevocationFenced(sub);
      }
    }
    const accountAdminStore = new StaleFenceReadStore(
      [await principalFixture()],
      [
        identityFixture(PRIMARY_SUB, USER_ID),
        identityFixture(TARGET_SECONDARY_SUB, USER_ID),
      ],
    );
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const sessionStore = new InMemoryConsoleSessionStore();
    const revokeBrowserSessions = jest.spyOn(sessionStore, 'revokeForUser');
    const revokeSubjectGrants = jest.fn<IOAuthGrantRevocationService['revokeSubjectGrants']>();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      securityInvalidationStore: invalidationStore,
      oauthGrantRevocationService: {
        revokePrincipalGrants: jest.fn<IOAuthGrantRevocationService['revokePrincipalGrants']>(),
        revokeSubjectGrants,
      },
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    const link = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id/identities/link');

    await expect(link.handler(consoleRequest({
      params: { user_id: USER_ID },
      body: { sub: TARGET_SECONDARY_SUB },
    }))).resolves.toMatchObject({ status: 409, body: { code: 'already_linked' } });
    expect(revokeBrowserSessions).not.toHaveBeenCalled();
    expect(revokeSubjectGrants).not.toHaveBeenCalled();
  });

  it('keeps an identity unlinked and fenced when acknowledgement times out', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore(
      [await principalFixture()],
      [
        identityFixture(PRIMARY_SUB, USER_ID),
        identityFixture(TARGET_SECONDARY_SUB, USER_ID),
      ],
    );
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new MissingAcknowledgementStore();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      securityInvalidationStore: invalidationStore,
      securityInvalidationAcknowledgementTimeoutMs: 0,
      oauthGrantRevocationService: oauthGrantRevocationService(),
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    const unlink = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id/identities/unlink');

    await expect(unlink.handler(consoleRequest({
      params: { user_id: USER_ID },
      body: { sub: TARGET_SECONDARY_SUB },
    }))).resolves.toMatchObject({ status: 503, body: { code: 'service_unavailable' } });
    await expect(accountAdminStore.findIdentityBySub(TARGET_SECONDARY_SUB)).resolves.toMatchObject({
      linkedUserId: null,
    });
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
      // Simulate a state change committed by another transaction after this
      // transaction's snapshot. A real rollback cannot undo that external win.
      override restoreTransactionSnapshot(snapshot: unknown): void {
        void snapshot;
      }

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

    await expect(disable.handler(consoleRequestAsOperatorAdmin({
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

  it('rejects credential revoke-all against a full admin without any revocation side effects', async () => {
    const actor = await principalFixture();
    const target = await principalFixture({
      userId: SECOND_USER_ID,
      primarySub: TARGET_PRIMARY_SUB,
      username: 'target',
      roles: ['admin'],
      accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
    });
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([actor, target]);
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const sessionStore = new InMemoryConsoleSessionStore();
    const revokeForUser = jest.spyOn(sessionStore, 'revokeForUser');
    const oauthRevocation = oauthGrantRevocationService();
    const revokePrincipalGrants = jest.spyOn(oauthRevocation, 'revokePrincipalGrants');
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      securityInvalidationStore: invalidationStore,
      oauthGrantRevocationService: oauthRevocation,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);

    await expect(revokeAll.handler(consoleRequest({ params: { user_id: SECOND_USER_ID } })))
      .resolves.toMatchObject({ status: 403, body: { code: 'insufficient_role_authority' } });
    await expect(accountAdminStore.findPrincipal(SECOND_USER_ID)).resolves.toMatchObject({ authzVersion: 3 });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
    expect(revokeForUser).not.toHaveBeenCalled();
    expect(revokePrincipalGrants).not.toHaveBeenCalled();
  });

  it('re-checks credential authority under lock before concurrent admin promotion can trigger side effects', async () => {
    const actor = await principalFixture();
    const target = await principalFixture({
      userId: SECOND_USER_ID,
      primarySub: TARGET_PRIMARY_SUB,
      username: 'target',
      roles: [],
      accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
    });
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([actor, target]);
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const baseRunner = new InMemoryAccountAdminMutationTransactionRunner({
      accountAdminStore,
      accountAllowlistStore,
      securityInvalidationStore: invalidationStore,
      adminAuditWriter,
    });
    const transactionRunner: IAccountAdminMutationTransactionRunner = {
      async run<T>(operation): Promise<T> {
        await accountAdminStore.grantRole({
          userId: SECOND_USER_ID,
          role: 'admin',
          grantedByUserId: USER_ID,
          grantedAt: NOW,
        });
        return baseRunner.run(operation);
      },
      runInvite: operation => baseRunner.runInvite(operation),
    };
    const sessionStore = new InMemoryConsoleSessionStore();
    const revokeForUser = jest.spyOn(sessionStore, 'revokeForUser');
    const oauthRevocation = oauthGrantRevocationService();
    const revokePrincipalGrants = jest.spyOn(oauthRevocation, 'revokePrincipalGrants');
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      securityInvalidationStore: invalidationStore,
      oauthGrantRevocationService: oauthRevocation,
      accountAdminMutationTransactionRunner: transactionRunner,
      now: () => NOW,
    });
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);

    await expect(revokeAll.handler(consoleRequest({ params: { user_id: SECOND_USER_ID } })))
      .resolves.toMatchObject({ status: 403, body: { code: 'insufficient_role_authority' } });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
    expect(revokeForUser).not.toHaveBeenCalled();
    expect(revokePrincipalGrants).not.toHaveBeenCalled();
  });

  it('waits for every live replica before completing credential revoke-all', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([await principalFixture({ roles: [] })]);
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new DeferredAcknowledgementStore();
    const sessionStore = new InMemoryConsoleSessionStore();
    await sessionStore.create(sessionRecord());
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      securityInvalidationStore: invalidationStore,
      oauthGrantRevocationService: oauthGrantRevocationService(),
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);
    let settled = false;

    const result = revokeAll.handler(consoleRequest({ params: { user_id: USER_ID } }))
      .finally(() => { settled = true; });
    await invalidationStore.waitStarted;

    expect(settled).toBe(false);
    await expect(accountAdminStore.findPrincipal(USER_ID)).resolves.toMatchObject({ authzVersion: 4 });
    await expect(sessionStore.findActiveByIdHash(Buffer.alloc(32, 9), NOW)).resolves.toBeNull();

    invalidationStore.acknowledgeAll();
    await expect(result).resolves.toMatchObject({
      status: 200,
      body: { revocation_summary: { browser_sessions_revoked: 1, new_authz_version: 4 } },
    });
  });

  it('commits OAuth grant and browser-session revocation in the authority transaction when supported', async () => {
    const revocationCutoff = new Date(NOW.getTime() + 1_000);
    const now = jest.fn<() => Date>()
      .mockReturnValueOnce(NOW)
      .mockReturnValue(revocationCutoff);
    const accountAdminStore = new InMemoryConsoleAccountAdminStore(
      [await principalFixture({ roles: [] })],
      [identityFixture(PRIMARY_SUB, USER_ID)],
    );
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const baseRunner = new InMemoryAccountAdminMutationTransactionRunner({
      accountAdminStore,
      accountAllowlistStore,
      securityInvalidationStore: invalidationStore,
      adminAuditWriter,
    });
    const revokeOAuthSubjectGrants = jest.fn(async () => 2);
    const revokeBrowserSessionsForUser = jest.fn(async () => 3);
    const lockLinkedAuthSubjects = jest.fn(async (
      tx: Parameters<Parameters<IAccountAdminMutationTransactionRunner['run']>[0]>[0],
      userId: string,
    ) => tx.lockLinkedAuthSubjects(userId));
    const transactionRunner: IAccountAdminMutationTransactionRunner = {
      run: operation => baseRunner.run(tx => operation({
        ...tx,
        lockLinkedAuthSubjects: userId => lockLinkedAuthSubjects(tx, userId),
        revokeOAuthSubjectGrants,
        revokeBrowserSessionsForUser,
      })),
      runInvite: operation => baseRunner.runInvite(operation),
    };
    const sessionStore = new InMemoryConsoleSessionStore();
    const externalBrowserRevocation = jest.spyOn(sessionStore, 'revokeForUser');
    const oauthRevocation = oauthGrantRevocationService({ fail: true });
    const externalOAuthRevocation = jest.spyOn(oauthRevocation, 'revokePrincipalGrants');
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      securityInvalidationStore: invalidationStore,
      oauthGrantRevocationService: oauthRevocation,
      accountAdminMutationTransactionRunner: transactionRunner,
      now,
    });
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);

    await expect(revokeAll.handler(consoleRequest({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
      status: 200,
      body: {
        revocation_summary: {
          browser_sessions_revoked: 3,
          mcp_oauth_grants_revoked: 2,
          authz_version_bumped: true,
        },
      },
    });
    expect(revokeOAuthSubjectGrants).toHaveBeenCalledWith(PRIMARY_SUB);
    expect(revokeBrowserSessionsForUser).toHaveBeenCalledWith(USER_ID, revocationCutoff);
    expect(lockLinkedAuthSubjects.mock.invocationCallOrder[0])
      .toBeLessThan(now.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY);
    expect(externalOAuthRevocation).not.toHaveBeenCalled();
    expect(externalBrowserRevocation).not.toHaveBeenCalled();
  });

  it('keeps credentials invalidated when revoke-all acknowledgement times out', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([await principalFixture({ roles: [] })]);
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new MissingAcknowledgementStore();
    const sessionStore = new InMemoryConsoleSessionStore();
    await sessionStore.create(sessionRecord());
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      securityInvalidationStore: invalidationStore,
      securityInvalidationAcknowledgementTimeoutMs: 0,
      oauthGrantRevocationService: oauthGrantRevocationService(),
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);

    await expect(revokeAll.handler(consoleRequest({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
      status: 503,
      body: { code: 'service_unavailable' },
    });
    await expect(accountAdminStore.findPrincipal(USER_ID)).resolves.toMatchObject({ authzVersion: 4 });
    await expect(sessionStore.findActiveByIdHash(Buffer.alloc(32, 9), NOW)).resolves.toBeNull();
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
      await secondaryActorFixture(),
    ]);
    const { module, invalidationStore, adminAuditWriter } = mutationFixture(accountAdminStore);
    const revokeAll = findRoute(module.routes, ACCOUNT_CREDENTIALS_REVOKE_ALL_PATH);

    await expect(revokeAll.handler(consoleRequestAsSeparateAccountAdmin({ params: { user_id: USER_ID } }))).resolves.toMatchObject({
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
        argsRedacted: expect.objectContaining({
          operation: 'credentials_revoke_all',
          phase: 'post_commit_revocation',
          browserSessionRevocationFailed: true,
        }),
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
        argsRedacted: expect.objectContaining({
          operation: 'credentials_revoke_all',
          phase: 'post_commit_revocation',
          oauthGrantRevocationFailed: true,
        }),
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

    await expect(runner.run(() => Promise.resolve('committed'))).rejects.toThrow('exactly one admin audit event');
  });

  it('rejects an administrative mutation after the actor authorization generation changes', async () => {
    const accountAdminStore = store();
    const runner = new InMemoryAccountAdminMutationTransactionRunner({
      accountAdminStore,
      accountAllowlistStore: new InMemoryConsoleAccountAllowlistStore(),
      securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
      adminAuditWriter: new InMemoryAdminAuditWriter(),
    });
    await accountAdminStore.grantRole({
      userId: USER_ID,
      role: 'auditor',
      grantedByUserId: SECOND_USER_ID,
      grantedAt: NOW,
    });
    const operation = jest.fn(async () => 'committed');

    await expect(runner.run(operation, { userId: USER_ID, authzVersion: 3 }))
      .rejects.toThrow('actor authority changed');
    expect(operation).not.toHaveBeenCalled();
  });

  it('rolls back transactions that append more than one success audit event', async () => {
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const runner = new InMemoryAccountAdminMutationTransactionRunner({
      accountAdminStore: store(),
      accountAllowlistStore: new InMemoryConsoleAccountAllowlistStore(),
      securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
      adminAuditWriter,
    });
    const event = adminAuditEvent();

    await expect(runner.run(async tx => {
      await tx.writeAdminAuditEvent(event);
      await tx.writeAdminAuditEvent(event);
    })).rejects.toThrow('exactly one admin audit event');
    expect(adminAuditWriter.getEvents()).toEqual([]);
  });

  it('rolls back in-memory state when a mutation fails after writing', async () => {
    const accountAdminStore = store();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const securityInvalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const runner = new InMemoryAccountAdminMutationTransactionRunner({
      accountAdminStore,
      accountAllowlistStore,
      securityInvalidationStore,
      adminAuditWriter,
    });

    await expect(runner.run(async tx => {
      await tx.grantRole({
        userId: USER_ID,
        role: 'auditor',
        grantedAt: NOW,
        grantedByUserId: USER_ID,
      });
      throw new Error('simulated transaction failure');
    })).rejects.toThrow('simulated transaction failure');

    await expect(accountAdminStore.listActiveRoles(USER_ID)).resolves.toEqual([ACCOUNT_ADMIN_ROLE]);
    expect(adminAuditWriter.getEvents()).toEqual([]);
    await expect(securityInvalidationStore.listEventsAfter(0)).resolves.toEqual([]);
  });

  it('blocks all shared-store reads until a failing transaction has rolled back', async () => {
    const accountAdminStore = store();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const securityInvalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const signingKeyStore = new InMemorySigningKeyStore();
    const authPolicyStore = new InMemoryConsoleAuthPolicyStore();
    const factorStore = new InMemoryConsoleFactorStore();
    await factorStore.createTotpFactor({
      userId: USER_ID,
      factorId: FACTOR_ID,
      factorType: 'totp',
      secretCiphertext: Buffer.from('encrypted-secret'),
      enrolledAt: NOW,
      disabledAt: null,
      lastUsedAt: null,
    }, []);
    const originalPolicy = await authPolicyStore.load();
    const runner = new InMemoryAccountAdminMutationTransactionRunner({
      accountAdminStore,
      accountAllowlistStore,
      securityInvalidationStore,
      adminAuditWriter,
      signingKeyStore,
      authPolicyStore,
      factorStore,
    });
    let signalEntered!: () => void;
    let releaseTransaction!: () => void;
    const entered = new Promise<void>(resolve => { signalEntered = resolve; });
    const blocked = new Promise<void>(resolve => { releaseTransaction = resolve; });

    const transaction = runner.run(async tx => {
      await tx.grantRole({
        userId: USER_ID,
        role: 'auditor',
        grantedAt: NOW,
        grantedByUserId: USER_ID,
      });
      await tx.addAllowlistEntry({
        kind: 'email',
        value: 'staged@example.test',
        createdByUserId: USER_ID,
        createdAt: NOW,
      });
      await tx.appendSecurityInvalidationEvent({
        kind: 'principal_authz_changed',
        urgency: 'eventual',
        userId: USER_ID,
        authzVersion: 4,
        reason: 'forced rollback test',
        payload: { previousAuthzVersion: 3, newAuthzVersion: 4 },
        createdAt: NOW,
        createdByUserId: USER_ID,
      });
      await tx.rotateSigningKey({
        kid: 'staged-signing-key',
        kind: 'invite',
        payload: { secret: 'not-external' },
      });
      await tx.saveAuthPolicy({ maxAdminElevationSeconds: 600 });
      await tx.disableActiveTotp(USER_ID, NOW);
      await tx.writeAdminAuditEvent(adminAuditEvent());
      signalEntered();
      await blocked;
      throw new Error('forced rollback');
    });
    await entered;

    let externalReadsSettled = false;
    const externalReads = Promise.all([
      accountAdminStore.listActiveRoles(USER_ID),
      accountAllowlistStore.listActive(),
      securityInvalidationStore.listEventsAfter(0),
      signingKeyStore.getByKid('staged-signing-key'),
      authPolicyStore.load(),
      factorStore.getTotpStatus(USER_ID),
      adminAuditWriter.readEvents(),
    ]);
    void externalReads.then(
      () => { externalReadsSettled = true; },
      () => { externalReadsSettled = true; },
    );
    await Promise.resolve();
    expect(externalReadsSettled).toBe(false);

    releaseTransaction();
    await expect(transaction).rejects.toThrow('forced rollback');
    const [roles, allowlist, invalidations, signingKey, policy, factorStatus, auditEvents] = await externalReads;
    expect(roles).toEqual([ACCOUNT_ADMIN_ROLE]);
    expect(allowlist).toEqual([]);
    expect(invalidations).toEqual([]);
    expect(signingKey).toBeNull();
    expect(policy).toEqual(originalPolicy);
    expect(factorStatus).toMatchObject({ enrolled: true, disabledAt: null });
    expect(auditEvents).toEqual([]);
  });

  it('keeps non-invite mutations usable when a nontransactional invite issuer is configured', async () => {
    const accountAdminStore = store();
    const runner = new InMemoryAccountAdminMutationTransactionRunner({
      accountAdminStore,
      accountAllowlistStore: new InMemoryConsoleAccountAllowlistStore(),
      securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
      adminAuditWriter: new InMemoryAdminAuditWriter(),
      inviteIssuer: {
        issueInvite: jest.fn(() => Promise.reject(new Error('must not be called'))),
      },
    });

    await expect(runner.run(async tx => {
      await tx.grantRole({
        userId: USER_ID,
        role: 'auditor',
        grantedAt: NOW,
        grantedByUserId: USER_ID,
      });
      await tx.writeAdminAuditEvent(adminAuditEvent());
      return 'committed';
    })).resolves.toBe('committed');
    await expect(accountAdminStore.listActiveRoles(USER_ID)).resolves.toEqual([
      ACCOUNT_ADMIN_ROLE,
      'auditor',
    ]);
  });

  it('rolls back staged invite state without delivering a credential when audit fails', async () => {
    class FailFirstAuditWriter extends InMemoryAdminAuditWriter {
      private writes = 0;

      override async write(event: ConsoleAdminAuditEvent): Promise<void> {
        await super.write(event);
        this.writes += 1;
        if (this.writes === 1) throw new Error('forced audit failure');
      }
    }
    const accountAdminStore = store();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const adminAuditWriter = new FailFirstAuditWriter();
    const inviteIssuer = stagedAccountInviteIssuer();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      authStorage: authStorageFixture({ adminSub: PRIMARY_SUB }),
      accountInviteIssuer: inviteIssuer,
      oauthGrantRevocationService: oauthGrantRevocationService(),
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter,
        inviteIssuer,
      }),
      now: () => NOW,
    });
    const invite = findRoute(module.routes, ACCOUNT_INVITE_PATH, 'POST');

    await expect(invite.handler(consoleRequest({
      body: { username: 'bob', email: INVITE_EMAIL },
    }))).resolves.toMatchObject({ status: 503, body: { code: 'service_unavailable' } });
    expect(inviteIssuer.pendingUserIds).toEqual([]);
    expect(inviteIssuer.deliveredUserIds).toEqual([]);
    await expect(adminAuditWriter.readEvents()).resolves.toEqual([
      expect.objectContaining({ result: 'failed', errorCode: 'issuer_error' }),
    ]);
  });

  it('does not deliver a staged invite until its audit-backed transaction commits', async () => {
    let signalAuditWritten!: () => void;
    let releaseAudit!: () => void;
    const auditWritten = new Promise<void>(resolve => { signalAuditWritten = resolve; });
    const auditBlock = new Promise<void>(resolve => { releaseAudit = resolve; });
    class BlockingAuditWriter extends InMemoryAdminAuditWriter {
      override async write(event: ConsoleAdminAuditEvent): Promise<void> {
        await super.write(event);
        signalAuditWritten();
        await auditBlock;
      }
    }
    const accountAdminStore = store();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const adminAuditWriter = new BlockingAuditWriter();
    const inviteIssuer = stagedAccountInviteIssuer();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      authStorage: authStorageFixture({ adminSub: PRIMARY_SUB }),
      accountInviteIssuer: inviteIssuer,
      oauthGrantRevocationService: oauthGrantRevocationService(),
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter,
        inviteIssuer,
      }),
      now: () => NOW,
    });
    const invite = findRoute(module.routes, ACCOUNT_INVITE_PATH, 'POST');

    const result = invite.handler(consoleRequest({
      body: { username: 'bob', email: INVITE_EMAIL },
    }));
    await auditWritten;
    expect(inviteIssuer.pendingUserIds).toEqual([SECOND_USER_ID]);
    expect(inviteIssuer.deliveredUserIds).toEqual([]);

    releaseAudit();
    await expect(result).resolves.toMatchObject({ status: 201 });
    expect(inviteIssuer.deliveredUserIds).toEqual([SECOND_USER_ID]);
  });

  it('reports committed account state honestly when post-commit invite delivery fails', async () => {
    const accountAdminStore = store();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const inviteIssuer = stagedAccountInviteIssuer({ commitError: new Error('delivery unavailable') });
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      authStorage: authStorageFixture({ adminSub: PRIMARY_SUB }),
      accountInviteIssuer: inviteIssuer,
      oauthGrantRevocationService: oauthGrantRevocationService(),
      enableAccountAllowlistRoutes: true,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter,
        inviteIssuer,
      }),
      now: () => NOW,
    });
    const invite = findRoute(module.routes, ACCOUNT_INVITE_PATH, 'POST');

    await expect(invite.handler(consoleRequest({
      body: { username: 'bob', email: INVITE_EMAIL },
    }))).resolves.toMatchObject({
      status: 201,
      body: {
        user_id: SECOND_USER_ID,
        delivery_status: 'manual_required',
      },
    });
    expect(inviteIssuer.pendingUserIds).toEqual([SECOND_USER_ID]);
    expect(inviteIssuer.deliveredUserIds).toEqual([]);
    await expect(adminAuditWriter.readEvents()).resolves.toEqual([
      expect.objectContaining({ result: 'approved', operation: AUDIT_USERS_INVITE }),
    ]);
  });

  it('does not erase an unrelated mutation queued while an in-memory transaction rolls back', async () => {
    const accountAdminStore = store();
    const runner = new InMemoryAccountAdminMutationTransactionRunner({
      accountAdminStore,
      accountAllowlistStore: new InMemoryConsoleAccountAllowlistStore(),
      securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
      adminAuditWriter: new InMemoryAdminAuditWriter(),
    });
    let releaseTransaction!: () => void;
    let transactionEntered!: () => void;
    const entered = new Promise<void>(resolve => { transactionEntered = resolve; });
    const blocked = new Promise<void>(resolve => { releaseTransaction = resolve; });

    const transaction = runner.run(async tx => {
      await tx.grantRole({
        userId: USER_ID,
        role: 'auditor',
        grantedAt: NOW,
        grantedByUserId: USER_ID,
      });
      transactionEntered();
      await blocked;
      throw new Error('simulated transaction failure');
    });
    await entered;

    let externalSettled = false;
    const externalMutation = accountAdminStore.grantRole({
      userId: USER_ID,
      role: 'operator',
      grantedAt: NOW,
      grantedByUserId: USER_ID,
    }).finally(() => { externalSettled = true; });
    await Promise.resolve();
    expect(externalSettled).toBe(false);

    releaseTransaction();
    await expect(transaction).rejects.toThrow('simulated transaction failure');
    await externalMutation;

    await expect(accountAdminStore.listActiveRoles(USER_ID)).resolves.toEqual([
      ACCOUNT_ADMIN_ROLE,
      'operator',
    ]);
  });

  it('cleans non-transactional credentials only after account deletion commits', async () => {
    const actor = await principalFixture();
    const target = await principalFixture({
      userId: SECOND_USER_ID,
      primarySub: 'github_target',
      username: 'target',
      roles: ['operator'],
      accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
    });
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([actor, target]);
    const sessionStore = new InMemoryConsoleSessionStore();
    const revokeForUser = jest.spyOn(sessionStore, 'revokeForUser');
    const revokePrincipalGrants = jest.fn<IOAuthGrantRevocationService['revokePrincipalGrants']>();
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      oauthGrantRevocationService: { revokePrincipalGrants } as IOAuthGrantRevocationService,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter,
      }),
      now: () => NOW,
    });
    const route = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id', 'DELETE');

    await expect(route.handler(consoleRequestAsOperatorAdmin({ params: { user_id: SECOND_USER_ID } })))
      .resolves.toMatchObject({ status: 200 });
    await expect(accountAdminStore.findPrincipal(SECOND_USER_ID)).resolves.toBeNull();
    expect(revokeForUser).toHaveBeenCalledWith(SECOND_USER_ID, NOW);
    expect(revokePrincipalGrants).not.toHaveBeenCalled();
  });

  it('refuses account deletion while an external integration credential still exists', async () => {
    const actor = await principalFixture();
    const target = await principalFixture({
      userId: SECOND_USER_ID,
      primarySub: 'github_target',
      username: 'target',
      roles: ['operator'],
      accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
    });
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([actor, target]);
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const integrationStore = new InMemoryUserIntegrationStore();
    await integrationStore.connect({
      userId: SECOND_USER_ID,
      provider: 'github',
      integrationDescriptorId: null,
      externalAccountLabel: 'target',
      externalInstallationId: null,
      authorizedPermissions: {
        repository_selection: 'unknown',
        permissions: { contents: 'none' },
      },
      accessTokenCiphertext: Buffer.from('encrypted-provider-token'),
      refreshTokenCiphertext: null,
      connectedAt: NOW,
    });
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        integrationStore,
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    const route = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id', 'DELETE');

    await expect(route.handler(consoleRequestAsOperatorAdmin({ params: { user_id: SECOND_USER_ID } })))
      .resolves.toMatchObject({
        status: 409,
        body: { code: 'integration_credentials_present' },
      });
    await expect(accountAdminStore.findPrincipal(SECOND_USER_ID)).resolves.not.toBeNull();
    await expect(integrationStore.hasAnyCredentialMaterial(SECOND_USER_ID)).resolves.toBe(true);
  });

  it('refuses account deletion while a consumed integration callback is in flight', async () => {
    const actor = await principalFixture();
    const target = await principalFixture({
      userId: SECOND_USER_ID,
      primarySub: 'github_target',
      username: 'target',
      roles: ['operator'],
      accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
    });
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([actor, target]);
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const loginTransactionStore = new InMemoryLoginTransactionStore(() => NOW);
    const idHash = Buffer.alloc(32, 31);
    const stateHash = Buffer.alloc(32, 32);
    await loginTransactionStore.create({
      idHash,
      flowKind: 'integration_link',
      stateHash,
      pkceVerifierEnc: Buffer.from('encrypted-pkce'),
      userId: SECOND_USER_ID,
      consoleSessionIdHash: Buffer.alloc(32, 33),
      requestedCapability: null,
      integrationDescriptorId: null,
      integrationDescriptorFingerprint: null,
      returnTo: null,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
      consumedAt: null,
    });
    await loginTransactionStore.consume(idHash, stateHash, NOW);
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        loginTransactionStore,
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    const route = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id', 'DELETE');

    await expect(route.handler(consoleRequestAsOperatorAdmin({ params: { user_id: SECOND_USER_ID } })))
      .resolves.toMatchObject({
        status: 409,
        body: { code: 'integration_authorization_in_flight' },
      });
    await expect(accountAdminStore.findPrincipal(SECOND_USER_ID)).resolves.not.toBeNull();
  });

  it('cancels an unconsumed in-memory integration callback when its principal is deleted', async () => {
    const actor = await principalFixture();
    const target = await principalFixture({
      userId: SECOND_USER_ID,
      primarySub: 'github_target',
      username: 'target',
      roles: ['operator'],
      accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
    });
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([actor, target]);
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const loginTransactionStore = new InMemoryLoginTransactionStore(() => NOW);
    const idHash = Buffer.alloc(32, 34);
    const stateHash = Buffer.alloc(32, 35);
    await loginTransactionStore.create({
      idHash,
      flowKind: 'integration_link',
      stateHash,
      pkceVerifierEnc: Buffer.from('encrypted-pkce'),
      userId: SECOND_USER_ID,
      consoleSessionIdHash: Buffer.alloc(32, 36),
      requestedCapability: null,
      integrationDescriptorId: null,
      integrationDescriptorFingerprint: null,
      returnTo: null,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
      consumedAt: null,
    });
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        loginTransactionStore,
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    const route = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id', 'DELETE');

    await expect(route.handler(consoleRequestAsOperatorAdmin({ params: { user_id: SECOND_USER_ID } })))
      .resolves.toMatchObject({ status: 200 });
    await expect(loginTransactionStore.consume(idHash, stateHash, NOW)).resolves.toBeNull();
  });

  it('fences in-memory linked identities and revokes their browser and OAuth authority on deletion', async () => {
    const actor = await principalFixture();
    const target = await principalFixture({
      userId: SECOND_USER_ID,
      primarySub: TARGET_SECONDARY_SUB,
      username: 'target',
      roles: ['operator'],
      accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
    });
    const accountAdminStore = new InMemoryConsoleAccountAdminStore(
      [actor, target],
      [identityFixture(TARGET_SECONDARY_SUB, SECOND_USER_ID)],
    );
    const sessionStore = new InMemoryConsoleSessionStore();
    const targetSession = sessionRecord({
      idHash: Buffer.alloc(32, 21),
      csrfTokenHash: Buffer.alloc(32, 22),
      userId: SECOND_USER_ID,
      authSub: TARGET_SECONDARY_SUB,
    });
    await sessionStore.create(targetSession);
    const revokeSubjectGrants = jest.fn<NonNullable<IOAuthGrantRevocationService['revokeSubjectGrants']>>()
      .mockResolvedValue({ sub: TARGET_SECONDARY_SUB, grantsDiscovered: 2, grantsRevoked: 2 });
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore,
      oauthGrantRevocationService: {
        revokePrincipalGrants: jest.fn<IOAuthGrantRevocationService['revokePrincipalGrants']>(),
        revokeSubjectGrants,
      },
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
        adminAuditWriter: new InMemoryAdminAuditWriter(),
      }),
      now: () => NOW,
    });
    const route = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id', 'DELETE');

    await expect(route.handler(consoleRequestAsOperatorAdmin({ params: { user_id: SECOND_USER_ID } })))
      .resolves.toMatchObject({
        status: 200,
        body: { revocation_summary: { browser_sessions_revoked: 1, mcp_oauth_grants_revoked: 2 } },
      });
    await expect(accountAdminStore.findIdentityBySub(TARGET_SECONDARY_SUB)).resolves.toMatchObject({
      sub: TARGET_SECONDARY_SUB,
      linkedUserId: null,
    });
    await expect(accountAdminStore.linkIdentity({
      userId: SECOND_USER_ID,
      sub: TARGET_SECONDARY_SUB,
      linkedAt: NOW,
    })).resolves.toMatchObject({ outcome: 'subject_deleted', linkedUserId: null });
    await expect(sessionStore.findActiveByIdHash(targetSession.idHash, NOW)).resolves.toBeNull();
    expect(revokeSubjectGrants).toHaveBeenCalledWith(TARGET_SECONDARY_SUB, NOW);
  });

  it('does not commit account deletion unless runtime termination commands are durable', async () => {
    class RejectingCommandStore extends InMemoryRuntimeSessionControlStore {
      override createTerminationCommand(): ReturnType<InMemoryRuntimeSessionControlStore['createTerminationCommand']> {
        return Promise.reject(new Error('termination queue unavailable'));
      }
    }
    const actor = await principalFixture();
    const target = await principalFixture({
      userId: SECOND_USER_ID,
      primarySub: 'github_target',
      username: 'target',
      roles: ['operator'],
      accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
    });
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([actor, target]);
    const accountAllowlistStore = new InMemoryConsoleAccountAllowlistStore();
    const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
    const adminAuditWriter = new InMemoryAdminAuditWriter();
    const runtimeStore = new RejectingCommandStore();
    await registerRuntimePresence(runtimeStore, SECOND_USER_ID);
    const module = createAccountAdminModule({
      accountAdminStore,
      accountAllowlistStore,
      sessionStore: new InMemoryConsoleSessionStore(),
      oauthGrantRevocationService: oauthGrantRevocationService(),
      runtimeSessionControlStore: runtimeStore,
      accountAdminMutationTransactionRunner: new InMemoryAccountAdminMutationTransactionRunner({
        accountAdminStore,
        accountAllowlistStore,
        securityInvalidationStore: invalidationStore,
        adminAuditWriter,
        runtimeSessionControlStore: runtimeStore,
      }),
      now: () => NOW,
    });
    const route = findRoute(module.routes, '/api/v1/admin/accounts/users/:user_id', 'DELETE');

    await expect(route.handler(consoleRequestAsOperatorAdmin({ params: { user_id: SECOND_USER_ID } })))
      .rejects.toThrow('termination queue unavailable');
    await expect(accountAdminStore.findPrincipal(SECOND_USER_ID)).resolves.toMatchObject({ userId: SECOND_USER_ID });
    await expect(runtimeStore.listAllPresenceByUser(SECOND_USER_ID, NOW)).resolves.toHaveLength(1);
    expect(adminAuditWriter.getEvents()).toEqual([]);
  });

  it('computes role replacement from the principal locked inside the mutation transaction', async () => {
    const actor = await principalFixture();
    const target = await principalFixture({
      userId: SECOND_USER_ID,
      primarySub: 'github_target',
      username: 'target',
      roles: ['auditor'],
      accountCorrelationId: SECOND_ACCOUNT_CORRELATION_ID,
    });
    const actualStore = new InMemoryConsoleAccountAdminStore([actor, target]);
    const auditWriter = new InMemoryAdminAuditWriter();
    const transactionRunner = new InMemoryAccountAdminMutationTransactionRunner({
      accountAdminStore: actualStore,
      accountAllowlistStore: new InMemoryConsoleAccountAllowlistStore(),
      securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
      adminAuditWriter: auditWriter,
    });
    const staleReadStore = {
      findPrincipal: jest.fn(() => Promise.resolve({ ...target, roles: [] })),
    } as unknown as IConsoleAccountAdminStore;
    const service = new AccountAdminRoleMutationService({
      accountAdminStore: staleReadStore,
      transactionRunner,
      now: () => NOW,
    });
    const route = findRoute(mutationFixture().module.routes, ACCOUNT_ROLE_GRANT_PATH);

    await expect(service.grantRole(
      consoleRequest({ body: { role: ACCOUNT_ADMIN_ROLE } }),
      route,
      SECOND_USER_ID,
    )).resolves.toEqual({
      status: 200,
      body: { user_id: SECOND_USER_ID, roles: [ACCOUNT_ADMIN_ROLE, 'auditor'] },
    });
    await expect(actualStore.listActiveRoles(SECOND_USER_ID)).resolves.toEqual([ACCOUNT_ADMIN_ROLE, 'auditor']);
    expect(staleReadStore.findPrincipal).not.toHaveBeenCalled();
  });
});

describe('AccountAdminModule principal directory filters and pagination', () => {
  const DIR_ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const DIR_ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const DIR_ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const DIR_ID_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const DIR_CORR_A = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
  const DIR_CORR_B = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
  const DIR_CORR_C = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
  const DIR_CORR_D = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';

  type DirectoryPrincipalFixture = ConstructorParameters<typeof InMemoryConsoleAccountAdminStore>[0][number];

  function directoryPrincipal(overrides: Partial<DirectoryPrincipalFixture> = {}): DirectoryPrincipalFixture {
    return {
      userId: USER_ID,
      primarySub: `sub-${overrides.userId ?? USER_ID}`,
      username: 'user',
      displayName: null,
      email: null,
      emailVerified: false,
      authMethods: ['local-password'],
      roles: [],
      disabledAt: null,
      createdAt: NOW,
      lastLoginAt: null,
      adminFactorEnrolled: false,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      authzVersion: 1,
      ...overrides,
    };
  }

  it('narrows the directory by search prefix, role, and enabled status', async () => {
    const principals = new InMemoryConsoleAccountAdminStore([
      directoryPrincipal({
        userId: DIR_ID_A,
        username: 'alice',
        email: ALICE_EMAIL,
        displayName: 'Alice Example',
        accountCorrelationId: DIR_CORR_A,
        roles: ['account_admin'],
        createdAt: NOW,
      }),
      directoryPrincipal({
        userId: DIR_ID_B,
        username: 'bob',
        email: 'bob@example.test',
        displayName: 'Bob Example',
        accountCorrelationId: DIR_CORR_B,
        roles: ['operator'],
        createdAt: new Date(NOW.getTime() + 1000),
      }),
      directoryPrincipal({
        userId: DIR_ID_C,
        username: 'carol',
        email: 'carol@example.test',
        displayName: 'Carol Example',
        accountCorrelationId: DIR_CORR_C,
        roles: [],
        disabledAt: NOW,
        createdAt: new Date(NOW.getTime() + 2000),
      }),
    ]);
    const { module } = mutationFixture(principals);
    const route = findRoute(module.routes, ADMIN_USERS_PATH);

    const bySearch = await route.handler(consoleRequest({ query: { search: 'ali' } }));
    expect((bySearch.body as { items: Array<{ user_id: string }> }).items.map(item => item.user_id))
      .toEqual([DIR_ID_A]);

    const byRole = await route.handler(consoleRequest({ query: { role: 'operator' } }));
    expect((byRole.body as { items: Array<{ user_id: string }> }).items.map(item => item.user_id))
      .toEqual([DIR_ID_B]);

    const byDisabled = await route.handler(consoleRequest({ query: { enabled: 'false' } }));
    expect((byDisabled.body as { items: Array<{ user_id: string }> }).items.map(item => item.user_id))
      .toEqual([DIR_ID_C]);

    const byEnabled = await route.handler(consoleRequest({ query: { enabled: 'true' } }));
    expect((byEnabled.body as { items: Array<{ user_id: string }> }).items.map(item => item.user_id).sort((a, b) => a.localeCompare(b)))
      .toEqual([DIR_ID_A, DIR_ID_B].sort((a, b) => a.localeCompare(b)));
  });

  it('paginates the directory with a stable (created_at, user_id) cursor, tiebreaking equal timestamps, and restarts on a garbage cursor', async () => {
    const principals = new InMemoryConsoleAccountAdminStore([
      // A and B share createdAt: the keyset tiebreaker (ascending user_id) must
      // place A before B, or a page boundary would skip or duplicate a row.
      directoryPrincipal({ userId: DIR_ID_A, username: 'user-a', accountCorrelationId: DIR_CORR_A, createdAt: NOW }),
      directoryPrincipal({ userId: DIR_ID_B, username: 'user-b', accountCorrelationId: DIR_CORR_B, createdAt: NOW }),
      directoryPrincipal({
        userId: DIR_ID_C,
        username: 'user-c',
        accountCorrelationId: DIR_CORR_C,
        createdAt: new Date(NOW.getTime() + 1000),
      }),
      directoryPrincipal({
        userId: DIR_ID_D,
        username: 'user-d',
        accountCorrelationId: DIR_CORR_D,
        createdAt: new Date(NOW.getTime() + 2000),
      }),
    ]);
    const { module } = mutationFixture(principals);
    const route = findRoute(module.routes, ADMIN_USERS_PATH);

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await route.handler(consoleRequest({ query: { limit: '1', ...(cursor ? { cursor } : {}) } }));
      const body = result.body as {
        items: Array<{ user_id: string }>;
        page: { next_cursor: string | null };
      };
      expect(body.items).toHaveLength(1);
      collected.push(...body.items.map(item => item.user_id));
      if (!body.page.next_cursor) break;
      cursor = body.page.next_cursor;
    }

    expect(collected).toEqual([DIR_ID_A, DIR_ID_B, DIR_ID_C, DIR_ID_D]);
    expect(new Set(collected).size).toBe(4);

    const garbage = await route.handler(consoleRequest({ query: { cursor: 'not-a-real-cursor' } }));
    expect((garbage.body as { items: Array<{ user_id: string }> }).items.map(item => item.user_id)[0])
      .toBe(DIR_ID_A);
  });
});

describe('AccountAdminModule unlinked identities', () => {
  const SUB_LINKED = 'github_linked-1';
  const SUB_UNLINKED_A = 'github_unlinked-a';
  const SUB_UNLINKED_B = 'github_unlinked-b';
  const SUB_UNLINKED_C = 'github_unlinked-c';
  const SUB_UNLINKED_D = 'github_unlinked-d';

  type IdentityFixture = ConstructorParameters<typeof InMemoryConsoleAccountAdminStore>[1][number];

  function identityFixture(overrides: Partial<IdentityFixture> = {}): IdentityFixture {
    return {
      sub: 'github_default',
      provider: 'github',
      externalSub: 'default',
      email: null,
      emailVerified: false,
      displayName: null,
      linkedUserId: null,
      createdAt: NOW,
      lastAuthAt: null,
      ...overrides,
    };
  }

  it('excludes linked identities from the unlinked directory', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([], [
      identityFixture({ sub: SUB_LINKED, linkedUserId: USER_ID, createdAt: NOW }),
      identityFixture({ sub: SUB_UNLINKED_A, createdAt: new Date(NOW.getTime() + 1000) }),
      identityFixture({ sub: SUB_UNLINKED_B, createdAt: new Date(NOW.getTime() + 2000) }),
    ]);
    const { module } = mutationFixture(accountAdminStore);
    const route = findRoute(module.routes, '/api/v1/admin/accounts/identities/unlinked');

    const result = await route.handler(consoleRequest());
    const subs = (result.body as { items: Array<{ sub: string; linked_user_id: string | null }> }).items;

    expect(subs.map(item => item.sub)).toEqual([SUB_UNLINKED_A, SUB_UNLINKED_B]);
    expect(subs.every(item => item.linked_user_id === null)).toBe(true);
  });

  it('paginates unlinked identities with a stable (created_at, sub) cursor, tiebreaking equal timestamps, and restarts on a garbage cursor', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([], [
      identityFixture({ sub: SUB_LINKED, linkedUserId: USER_ID, createdAt: NOW }),
      // A and B share createdAt: the (created_at, sub) tiebreaker (ascending sub)
      // must place A before B.
      identityFixture({ sub: SUB_UNLINKED_A, createdAt: NOW }),
      identityFixture({ sub: SUB_UNLINKED_B, createdAt: NOW }),
      identityFixture({ sub: SUB_UNLINKED_C, createdAt: new Date(NOW.getTime() + 1000) }),
      identityFixture({ sub: SUB_UNLINKED_D, createdAt: new Date(NOW.getTime() + 2000) }),
    ]);
    const { module } = mutationFixture(accountAdminStore);
    const route = findRoute(module.routes, '/api/v1/admin/accounts/identities/unlinked');

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await route.handler(consoleRequest({ query: { limit: '1', ...(cursor ? { cursor } : {}) } }));
      const body = result.body as {
        items: Array<{ sub: string }>;
        page: { next_cursor: string | null };
      };
      expect(body.items).toHaveLength(1);
      collected.push(...body.items.map(item => item.sub));
      if (!body.page.next_cursor) break;
      cursor = body.page.next_cursor;
    }

    expect(collected).toEqual([SUB_UNLINKED_A, SUB_UNLINKED_B, SUB_UNLINKED_C, SUB_UNLINKED_D]);
    expect(collected).not.toContain(SUB_LINKED);
    expect(new Set(collected).size).toBe(4);

    const garbage = await route.handler(consoleRequest({ query: { cursor: 'not-a-real-cursor' } }));
    expect((garbage.body as { items: Array<{ sub: string }> }).items.map(item => item.sub)[0])
      .toBe(SUB_UNLINKED_A);
  });
});
