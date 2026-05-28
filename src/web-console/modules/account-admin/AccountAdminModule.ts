import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import type { IAuthStorageLayer } from '../../../auth/embedded-as/storage/IAuthStorageLayer.js';
import type { IOAuthGrantRevocationService } from '../../services/oauth/IConsoleOAuthGrantRevocationService.js';
import type { IRuntimeSessionControlStore } from '../../services/runtime/IRuntimeSessionControlStore.js';
import type { IConsoleAccountAllowlistStore } from '../../stores/IConsoleAccountAllowlistStore.js';
import type { IConsoleAccountAdminStore } from '../../stores/IConsoleAccountAdminStore.js';
import type { IConsoleSessionStore } from '../../stores/IConsoleSessionStore.js';
import type { IAccountAdminMutationTransactionRunner } from './AccountAdminMutationTransaction.js';
import { AccountAdminAllowlistService } from './AccountAdminAllowlistService.js';
import { AccountAdminBootstrapService } from './AccountAdminBootstrapService.js';
import { AccountAdminCredentialRevocationService } from './AccountAdminCredentialRevocationService.js';
import {
  AccountAdminInviteService,
  type IConsoleAccountInviteIssuer,
} from './AccountAdminInviteService.js';
import { AccountAdminLifecycleMutationService } from './AccountAdminLifecycleMutationService.js';
import { AccountAdminReadService } from './AccountAdminReadService.js';
import { AccountAdminRoleMutationService } from './AccountAdminRoleMutationService.js';
import { AccountAdminRuntimeTerminationService } from './AccountAdminRuntimeTerminationService.js';
import {
  projectAccountPrincipal,
  projectAccountAllowlistEntry,
  projectAccountAllowlistList,
  projectAccountBootstrapStatus,
  projectAccountInvite,
  projectAccountPrincipalLifecycle,
  projectAccountPrincipalList,
  projectAccountRoleList,
} from './AccountAdminPrivacyProjectors.js';

const ACCOUNT_ADMIN_AUDIT = {
  usersList: 'accounts.users.list',
  usersShow: 'accounts.users.show',
  usersInvite: 'accounts.users.invite',
  usersDisable: 'accounts.users.disable',
  usersEnable: 'accounts.users.enable',
  usersCredentialsRevokeAll: 'accounts.users.credentials.revoke_all',
  rolesList: 'accounts.roles.list',
  rolesReplace: 'accounts.roles.replace',
  rolesGrant: 'accounts.roles.grant',
  rolesRevoke: 'accounts.roles.revoke',
  correlationResolve: 'accounts.correlation.resolve',
  allowlistList: 'accounts.allowlist.list',
  allowlistShow: 'accounts.allowlist.show',
  allowlistAdd: 'accounts.allowlist.add',
  allowlistUpdate: 'accounts.allowlist.update',
  allowlistRemove: 'accounts.allowlist.remove',
  bootstrapShow: 'accounts.bootstrap.show',
} as const;
const ACCOUNT_ADMIN_CAPABILITY = 'console:admin:accounts';
const USER_ID_PARAM = 'user_id';
const USER_ID_REQUIRED_DETAIL = 'user_id path parameter is required.';

export interface AccountAdminModuleOptions {
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly accountAllowlistStore: IConsoleAccountAllowlistStore;
  readonly sessionStore: IConsoleSessionStore;
  readonly authStorage?: IAuthStorageLayer | null;
  readonly accountInviteIssuer?: IConsoleAccountInviteIssuer | null;
  readonly oauthGrantRevocationService?: IOAuthGrantRevocationService | null;
  readonly runtimeSessionControlStore?: IRuntimeSessionControlStore | null;
  readonly runtimeTerminationAcknowledgementTimeoutMs?: number;
  readonly accountAdminMutationTransactionRunner: IAccountAdminMutationTransactionRunner;
  readonly enableAccountAllowlistRoutes?: boolean;
  readonly now?: () => Date;
}

export function createAccountAdminModule(options: AccountAdminModuleOptions): ConsoleModuleDescriptor {
  const { accountAdminStore } = options;
  const service = new AccountAdminReadService(accountAdminStore);
  const transactionRunner = options.accountAdminMutationTransactionRunner;
  const runtimeTerminationService = options.runtimeSessionControlStore
    ? new AccountAdminRuntimeTerminationService({
      runtimeStore: options.runtimeSessionControlStore,
      acknowledgementTimeoutMs: options.runtimeTerminationAcknowledgementTimeoutMs,
      now: options.now,
    })
    : null;
  const roleMutationService = new AccountAdminRoleMutationService({
    accountAdminStore,
    transactionRunner,
    now: options.now,
  });
  const lifecycleMutationService = new AccountAdminLifecycleMutationService({
    accountAdminStore,
    transactionRunner,
    runtimeTerminationService,
    now: options.now,
  });
  const credentialRevocationService = new AccountAdminCredentialRevocationService({
    accountAdminStore,
    sessionStore: options.sessionStore,
    oauthGrantRevocationService: options.oauthGrantRevocationService ?? null,
    transactionRunner,
    runtimeTerminationService,
    now: options.now,
  });
  const allowlistService = new AccountAdminAllowlistService({
    allowlistStore: options.accountAllowlistStore,
    transactionRunner,
    now: options.now,
  });
  const inviteService = new AccountAdminInviteService({
    authStorage: options.authStorage ?? null,
    inviteIssuer: options.accountInviteIssuer ?? null,
    transactionRunner,
    now: options.now,
  });
  const bootstrapService = new AccountAdminBootstrapService({
    authStorage: options.authStorage ?? null,
    accountAdminStore,
  });
  const disableUserRoute: ConsoleModuleDescriptor['routes'][number] = {
    method: 'POST',
    path: '/api/v1/admin/accounts/users/:user_id/disable',
    audience: 'admin',
    requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
    elevation: 'admin_5m',
    privacyClass: 'account_metadata',
    idempotency: 'required',
    auditOperation: ACCOUNT_ADMIN_AUDIT.usersDisable,
    auditExecution: 'handler_transaction',
    privacyProjector: projectAccountPrincipalLifecycle,
    handler: req => disableUser(req, lifecycleMutationService, disableUserRoute),
  };
  const enableUserRoute: ConsoleModuleDescriptor['routes'][number] = {
    method: 'POST',
    path: '/api/v1/admin/accounts/users/:user_id/enable',
    audience: 'admin',
    requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
    elevation: 'admin_5m',
    privacyClass: 'account_metadata',
    idempotency: 'required',
    auditOperation: ACCOUNT_ADMIN_AUDIT.usersEnable,
    auditExecution: 'handler_transaction',
    privacyProjector: projectAccountPrincipalLifecycle,
    handler: req => enableUser(req, lifecycleMutationService, enableUserRoute),
  };
  const replaceRolesRoute: ConsoleModuleDescriptor['routes'][number] = {
    method: 'PUT',
    path: '/api/v1/admin/accounts/users/:user_id/roles',
    audience: 'admin',
    requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
    elevation: 'admin_5m',
    privacyClass: 'account_metadata',
    idempotency: 'required',
    auditOperation: ACCOUNT_ADMIN_AUDIT.rolesReplace,
    auditExecution: 'handler_transaction',
    privacyProjector: projectAccountRoleList,
    handler: req => replaceRoles(req, roleMutationService, replaceRolesRoute),
  };
  const grantRoleRoute: ConsoleModuleDescriptor['routes'][number] = {
    method: 'POST',
    path: '/api/v1/admin/accounts/users/:user_id/roles/grant',
    audience: 'admin',
    requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
    elevation: 'admin_5m',
    privacyClass: 'account_metadata',
    idempotency: 'required',
    auditOperation: ACCOUNT_ADMIN_AUDIT.rolesGrant,
    auditExecution: 'handler_transaction',
    privacyProjector: projectAccountRoleList,
    handler: req => grantRole(req, roleMutationService, grantRoleRoute),
  };
  const revokeRoleRoute: ConsoleModuleDescriptor['routes'][number] = {
    method: 'POST',
    path: '/api/v1/admin/accounts/users/:user_id/roles/revoke',
    audience: 'admin',
    requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
    elevation: 'admin_5m',
    privacyClass: 'account_metadata',
    idempotency: 'required',
    auditOperation: ACCOUNT_ADMIN_AUDIT.rolesRevoke,
    auditExecution: 'handler_transaction',
    privacyProjector: projectAccountRoleList,
    handler: req => revokeRole(req, roleMutationService, revokeRoleRoute),
  };
  const revokeAllCredentialsRoute: ConsoleModuleDescriptor['routes'][number] = {
    method: 'POST',
    path: '/api/v1/admin/accounts/users/:user_id/credentials/revoke-all',
    audience: 'admin',
    requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
    elevation: 'admin_5m',
    privacyClass: 'account_metadata',
    idempotency: 'required',
    auditOperation: ACCOUNT_ADMIN_AUDIT.usersCredentialsRevokeAll,
    auditExecution: 'handler_transaction',
    privacyProjector: projectAccountPrincipalLifecycle,
    handler: req => revokeAllCredentials(req, credentialRevocationService, revokeAllCredentialsRoute),
  };
  const inviteRoute: ConsoleModuleDescriptor['routes'][number] = {
    method: 'POST',
    path: '/api/v1/admin/accounts/users/invite',
    audience: 'admin',
    requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
    elevation: 'admin_5m',
    privacyClass: 'account_metadata',
    idempotency: 'required',
    auditOperation: ACCOUNT_ADMIN_AUDIT.usersInvite,
    auditExecution: 'handler_transaction',
    privacyProjector: projectAccountInvite,
    handler: req => inviteService.invite(req, inviteRoute),
  };
  const addAllowlistRoute: ConsoleModuleDescriptor['routes'][number] = {
    method: 'POST',
    path: '/api/v1/admin/accounts/allowlist',
    audience: 'admin',
    requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
    elevation: 'admin_5m',
    privacyClass: 'account_metadata',
    idempotency: 'required',
    auditOperation: ACCOUNT_ADMIN_AUDIT.allowlistAdd,
    auditExecution: 'handler_transaction',
    privacyProjector: projectAccountAllowlistEntry,
    handler: req => allowlistService.add(req, addAllowlistRoute),
  };
  const updateAllowlistRoute: ConsoleModuleDescriptor['routes'][number] = {
    method: 'PATCH',
    path: '/api/v1/admin/accounts/allowlist/:id',
    audience: 'admin',
    requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
    elevation: 'admin_5m',
    privacyClass: 'account_metadata',
    idempotency: 'required',
    auditOperation: ACCOUNT_ADMIN_AUDIT.allowlistUpdate,
    auditExecution: 'handler_transaction',
    privacyProjector: projectAccountAllowlistEntry,
    handler: req => updateAllowlist(req, allowlistService, updateAllowlistRoute),
  };
  const removeAllowlistRoute: ConsoleModuleDescriptor['routes'][number] = {
    method: 'DELETE',
    path: '/api/v1/admin/accounts/allowlist/:id',
    audience: 'admin',
    requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
    elevation: 'admin_5m',
    privacyClass: 'account_metadata',
    idempotency: 'required',
    auditOperation: ACCOUNT_ADMIN_AUDIT.allowlistRemove,
    auditExecution: 'handler_transaction',
    privacyProjector: projectAccountAllowlistEntry,
    handler: req => removeAllowlist(req, allowlistService, removeAllowlistRoute),
  };
  const routes: ConsoleModuleDescriptor['routes'] = [
    {
      method: 'GET',
      path: '/api/v1/admin/accounts/users',
      audience: 'admin',
      requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
      elevation: 'admin_30m',
      privacyClass: 'account_metadata',
      idempotency: 'not_applicable',
      auditOperation: ACCOUNT_ADMIN_AUDIT.usersList,
      privacyProjector: projectAccountPrincipalList,
      handler: req => listUsers(req, service),
    },
    {
      method: 'GET',
      path: '/api/v1/admin/accounts/users/:user_id',
      audience: 'admin',
      requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
      elevation: 'admin_30m',
      privacyClass: 'account_metadata',
      idempotency: 'not_applicable',
      auditOperation: ACCOUNT_ADMIN_AUDIT.usersShow,
      privacyProjector: projectAccountPrincipal,
      handler: req => getUser(req, service),
    },
    inviteRoute,
    disableUserRoute,
    enableUserRoute,
    {
      method: 'GET',
      path: '/api/v1/admin/accounts/users/:user_id/roles',
      audience: 'admin',
      requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
      elevation: 'admin_30m',
      privacyClass: 'account_metadata',
      idempotency: 'not_applicable',
      auditOperation: ACCOUNT_ADMIN_AUDIT.rolesList,
      privacyProjector: projectAccountRoleList,
      handler: req => listRoles(req, service),
    },
    replaceRolesRoute,
    grantRoleRoute,
    revokeRoleRoute,
    revokeAllCredentialsRoute,
    ...(options.enableAccountAllowlistRoutes === true ? [
      {
        method: 'GET',
        path: '/api/v1/admin/accounts/allowlist',
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'account_metadata',
        idempotency: 'not_applicable',
        auditOperation: ACCOUNT_ADMIN_AUDIT.allowlistList,
        privacyProjector: projectAccountAllowlistList,
        handler: () => allowlistService.list(),
      },
      {
        method: 'GET',
        path: '/api/v1/admin/accounts/allowlist/:id',
        audience: 'admin',
        requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'account_metadata',
        idempotency: 'not_applicable',
        auditOperation: ACCOUNT_ADMIN_AUDIT.allowlistShow,
        privacyProjector: projectAccountAllowlistEntry,
        handler: req => getAllowlist(req, allowlistService),
      },
      addAllowlistRoute,
      updateAllowlistRoute,
      removeAllowlistRoute,
    ] satisfies ConsoleModuleDescriptor['routes'] : []),
    {
      method: 'GET',
      path: '/api/v1/admin/accounts/bootstrap',
      audience: 'admin',
      requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
      elevation: 'admin_30m',
      privacyClass: 'account_metadata',
      idempotency: 'not_applicable',
      auditOperation: ACCOUNT_ADMIN_AUDIT.bootstrapShow,
      privacyProjector: projectAccountBootstrapStatus,
      handler: () => bootstrapService.getStatus(),
    },
    {
      method: 'GET',
      path: '/api/v1/admin/accounts/correlations/:account_correlation_id',
      audience: 'admin',
      requiredCapability: ACCOUNT_ADMIN_CAPABILITY,
      elevation: 'admin_5m',
      privacyClass: 'account_metadata',
      idempotency: 'not_applicable',
      rateLimit: 'protected_correlation_resolution',
      auditOperation: ACCOUNT_ADMIN_AUDIT.correlationResolve,
      privacyProjector: projectAccountPrincipal,
      handler: req => resolveCorrelation(req, service),
    },
  ];
  return {
    id: 'accountAdmin',
    apiVersion: 'v1',
    capabilities: [ACCOUNT_ADMIN_CAPABILITY],
    auditOperations: routes.map(route => ({ id: route.auditOperation ?? '' })),
    routes,
  };
}

function listUsers(req: ConsoleRequest, service: AccountAdminReadService): Promise<ConsoleHandlerResult> {
  const query = parseUserListQuery(req);
  if (query.kind === 'invalid') return Promise.resolve(problem(400, 'invalid_request', query.detail));
  return service.listUsers(query.value).then(body => ({ status: 200, body }));
}

async function getUser(req: ConsoleRequest, service: AccountAdminReadService): Promise<ConsoleHandlerResult> {
  const userId = stringParam(req, USER_ID_PARAM);
  if (!userId) return problem(400, 'invalid_request', USER_ID_REQUIRED_DETAIL);
  const body = await service.getUser(userId);
  return body ? { status: 200, body } : problem(404, 'not_found', 'User principal was not found.');
}

async function listRoles(req: ConsoleRequest, service: AccountAdminReadService): Promise<ConsoleHandlerResult> {
  const userId = stringParam(req, USER_ID_PARAM);
  if (!userId) return problem(400, 'invalid_request', USER_ID_REQUIRED_DETAIL);
  const body = await service.listRoles(userId);
  return { status: 200, body };
}

async function disableUser(
  req: ConsoleRequest,
  service: AccountAdminLifecycleMutationService,
  route: ConsoleModuleDescriptor['routes'][number],
): Promise<ConsoleHandlerResult> {
  const userId = stringParam(req, USER_ID_PARAM);
  if (!userId) return problem(400, 'invalid_request', USER_ID_REQUIRED_DETAIL);
  return service.disablePrincipal(req, route, userId);
}

async function enableUser(
  req: ConsoleRequest,
  service: AccountAdminLifecycleMutationService,
  route: ConsoleModuleDescriptor['routes'][number],
): Promise<ConsoleHandlerResult> {
  const userId = stringParam(req, USER_ID_PARAM);
  if (!userId) return problem(400, 'invalid_request', USER_ID_REQUIRED_DETAIL);
  return service.enablePrincipal(req, route, userId);
}

async function replaceRoles(
  req: ConsoleRequest,
  service: AccountAdminRoleMutationService,
  route: ConsoleModuleDescriptor['routes'][number],
): Promise<ConsoleHandlerResult> {
  const userId = stringParam(req, USER_ID_PARAM);
  if (!userId) return problem(400, 'invalid_request', USER_ID_REQUIRED_DETAIL);
  return service.replaceRoles(req, route, userId);
}

async function grantRole(
  req: ConsoleRequest,
  service: AccountAdminRoleMutationService,
  route: ConsoleModuleDescriptor['routes'][number],
): Promise<ConsoleHandlerResult> {
  const userId = stringParam(req, USER_ID_PARAM);
  if (!userId) return problem(400, 'invalid_request', USER_ID_REQUIRED_DETAIL);
  return service.grantRole(req, route, userId);
}

async function revokeRole(
  req: ConsoleRequest,
  service: AccountAdminRoleMutationService,
  route: ConsoleModuleDescriptor['routes'][number],
): Promise<ConsoleHandlerResult> {
  const userId = stringParam(req, USER_ID_PARAM);
  if (!userId) return problem(400, 'invalid_request', USER_ID_REQUIRED_DETAIL);
  return service.revokeRole(req, route, userId);
}

async function revokeAllCredentials(
  req: ConsoleRequest,
  service: AccountAdminCredentialRevocationService,
  route: ConsoleModuleDescriptor['routes'][number],
): Promise<ConsoleHandlerResult> {
  const userId = stringParam(req, USER_ID_PARAM);
  if (!userId) return problem(400, 'invalid_request', USER_ID_REQUIRED_DETAIL);
  return service.revokeAllCredentials(req, route, userId);
}

async function getAllowlist(
  req: ConsoleRequest,
  service: AccountAdminAllowlistService,
): Promise<ConsoleHandlerResult> {
  const id = stringParam(req, 'id');
  if (!id) return problem(400, 'invalid_request', 'id path parameter is required.');
  return service.get(id);
}

async function updateAllowlist(
  req: ConsoleRequest,
  service: AccountAdminAllowlistService,
  route: ConsoleModuleDescriptor['routes'][number],
): Promise<ConsoleHandlerResult> {
  const id = stringParam(req, 'id');
  if (!id) return problem(400, 'invalid_request', 'id path parameter is required.');
  return service.update(req, route, id);
}

async function removeAllowlist(
  req: ConsoleRequest,
  service: AccountAdminAllowlistService,
  route: ConsoleModuleDescriptor['routes'][number],
): Promise<ConsoleHandlerResult> {
  const id = stringParam(req, 'id');
  if (!id) return problem(400, 'invalid_request', 'id path parameter is required.');
  return service.remove(req, route, id);
}

async function resolveCorrelation(
  req: ConsoleRequest,
  service: AccountAdminReadService,
): Promise<ConsoleHandlerResult> {
  const accountCorrelationId = stringParam(req, 'account_correlation_id');
  if (!accountCorrelationId) {
    return problem(400, 'invalid_request', 'account_correlation_id path parameter is required.');
  }
  const body = await service.resolveCorrelation(accountCorrelationId);
  return body ? { status: 200, body } : problem(404, 'not_found', 'Account correlation id was not found.');
}

function parseUserListQuery(
  req: ConsoleRequest,
): { readonly kind: 'valid'; readonly value: { readonly sub?: string; readonly limit?: number } }
  | { readonly kind: 'invalid'; readonly detail: string } {
  const query: { sub?: string; limit?: number } = {};
  if (typeof req.query.sub === 'string') {
    query.sub = req.query.sub;
  } else if (req.query.sub !== undefined) {
    return { kind: 'invalid', detail: 'sub must be a string.' };
  }
  if (typeof req.query.limit === 'string') {
    const limit = Number(req.query.limit);
    if (!Number.isInteger(limit)) {
      return { kind: 'invalid', detail: 'limit must be an integer.' };
    }
    query.limit = limit;
  } else if (req.query.limit !== undefined) {
    return { kind: 'invalid', detail: 'limit must be a string integer.' };
  }
  return { kind: 'valid', value: query };
}

function problem(status: number, code: string, detail: string): ConsoleHandlerResult {
  return {
    status,
    body: {
      type: 'about:blank',
      title: status === 404 ? 'Not found' : 'Invalid request',
      status,
      code,
      detail,
    },
  };
}

function stringParam(req: ConsoleRequest, name: string): string | null {
  const value = req.params[name];
  return typeof value === 'string' ? value : null;
}
