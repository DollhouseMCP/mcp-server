import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import type { IConsoleAccountAdminStore } from '../../stores/IConsoleAccountAdminStore.js';
import { AccountAdminReadService } from './AccountAdminReadService.js';
import {
  projectAccountPrincipal,
  projectAccountPrincipalList,
  projectAccountRoleList,
} from './AccountAdminPrivacyProjectors.js';

const ACCOUNT_ADMIN_AUDIT = {
  usersList: 'accounts.users.list',
  usersShow: 'accounts.users.show',
  rolesList: 'accounts.roles.list',
  correlationResolve: 'accounts.correlation.resolve',
} as const;
const ACCOUNT_ADMIN_CAPABILITY = 'console:admin:accounts';

export interface AccountAdminModuleOptions {
  readonly accountAdminStore: IConsoleAccountAdminStore;
}

export function createAccountAdminModule(options: AccountAdminModuleOptions): ConsoleModuleDescriptor {
  const { accountAdminStore } = options;
  const service = new AccountAdminReadService(accountAdminStore);
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
  const userId = stringParam(req, 'user_id');
  if (!userId) return problem(400, 'invalid_request', 'user_id path parameter is required.');
  const body = await service.getUser(userId);
  return body ? { status: 200, body } : problem(404, 'not_found', 'User principal was not found.');
}

async function listRoles(req: ConsoleRequest, service: AccountAdminReadService): Promise<ConsoleHandlerResult> {
  const userId = stringParam(req, 'user_id');
  if (!userId) return problem(400, 'invalid_request', 'user_id path parameter is required.');
  const body = await service.listRoles(userId);
  return { status: 200, body };
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
