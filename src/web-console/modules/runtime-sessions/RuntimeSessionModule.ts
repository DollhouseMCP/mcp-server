import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import type { IRuntimeSessionControlStore } from '../../services/runtime/IRuntimeSessionControlStore.js';
import type { IConsoleAccountAdminStore } from '../../stores/IConsoleAccountAdminStore.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import { RuntimeSessionService } from './RuntimeSessionService.js';
import {
  projectRuntimeRevokeAll,
  projectRuntimeSessionAccountList,
  projectRuntimeSessionOperational,
  projectRuntimeSessionOperationalList,
  projectRuntimeSessionSelf,
  projectRuntimeSessionSelfList,
  projectRuntimeTermination,
} from './RuntimeSessionPrivacyProjectors.js';

const RUNTIME_CAPABILITY_SELF = 'console:self';
const RUNTIME_CAPABILITY_ACCOUNTS = 'console:admin:accounts';
const RUNTIME_CAPABILITY_OPERATE = 'console:admin:operate';
const SESSION_ID_PARAM = 'session_id';
const RUNTIME_SESSION_NOT_FOUND_DETAIL = 'Runtime session was not found.';

export interface RuntimeSessionModuleOptions {
  readonly runtimeStore: IRuntimeSessionControlStore;
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly now?: () => Date;
}

export function createRuntimeSessionModule(options: RuntimeSessionModuleOptions): ConsoleModuleDescriptor {
  const service = new RuntimeSessionService({
    runtimeStore: options.runtimeStore,
    accountAdminStore: options.accountAdminStore,
    now: options.now,
  });
  const routes: ConsoleModuleDescriptor['routes'] = [
    {
      method: 'GET',
      path: '/api/v1/me/sessions',
      audience: 'self',
      requiredCapability: RUNTIME_CAPABILITY_SELF,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      handler: req => listSelfSessions(req, service),
    },
    {
      method: 'GET',
      path: '/api/v1/me/sessions/:session_id',
      audience: 'self',
      requiredCapability: RUNTIME_CAPABILITY_SELF,
      ownership: 'owned_session',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      handler: req => getSelfSession(req, service),
    },
    {
      method: 'DELETE',
      path: '/api/v1/me/sessions/:session_id',
      audience: 'self',
      requiredCapability: RUNTIME_CAPABILITY_SELF,
      ownership: 'owned_session',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      // Self termination provenance is retained in runtime_control_commands; admin_audit remains admin-scoped.
      handler: req => terminateSelfSession(req, service),
    },
    {
      method: 'GET',
      path: '/api/v1/admin/accounts/users/:user_id/sessions',
      audience: 'admin',
      requiredCapability: RUNTIME_CAPABILITY_ACCOUNTS,
      elevation: 'admin_30m',
      privacyClass: 'account_metadata',
      idempotency: 'not_applicable',
      auditOperation: 'accounts.users.sessions.list',
      privacyProjector: projectRuntimeSessionAccountList,
      handler: req => listAccountSessions(req, service),
    },
    {
      method: 'DELETE',
      path: '/api/v1/admin/accounts/users/:user_id/sessions/:session_id',
      audience: 'admin',
      requiredCapability: RUNTIME_CAPABILITY_ACCOUNTS,
      elevation: 'admin_5m',
      privacyClass: 'account_metadata',
      idempotency: 'required',
      auditOperation: 'accounts.users.sessions.terminate',
      privacyProjector: projectRuntimeTermination,
      handler: req => terminateAccountSession(req, service),
    },
    {
      method: 'POST',
      path: '/api/v1/admin/accounts/users/:user_id/sessions/revoke-all',
      audience: 'admin',
      requiredCapability: RUNTIME_CAPABILITY_ACCOUNTS,
      elevation: 'admin_5m',
      privacyClass: 'account_metadata',
      idempotency: 'required',
      auditOperation: 'accounts.users.sessions.revoke_all',
      privacyProjector: projectRuntimeRevokeAll,
      handler: req => revokeAllAccountSessions(req, service),
    },
    {
      method: 'GET',
      path: '/api/v1/admin/operate/sessions',
      audience: 'admin',
      requiredCapability: RUNTIME_CAPABILITY_OPERATE,
      elevation: 'admin_30m',
      privacyClass: 'operational_allowlist',
      idempotency: 'not_applicable',
      auditOperation: 'operate.sessions.list',
      privacyProjector: projectRuntimeSessionOperationalList,
      handler: () => service.listOperationalSessions().then(body => ({ status: 200, body })),
    },
    {
      method: 'GET',
      path: '/api/v1/admin/operate/sessions/:session_id',
      audience: 'admin',
      requiredCapability: RUNTIME_CAPABILITY_OPERATE,
      elevation: 'admin_30m',
      privacyClass: 'operational_allowlist',
      idempotency: 'not_applicable',
      auditOperation: 'operate.sessions.show',
      privacyProjector: projectRuntimeSessionOperational,
      handler: req => getOperationalSession(req, service),
    },
    {
      method: 'DELETE',
      path: '/api/v1/admin/operate/sessions/:session_id',
      audience: 'admin',
      requiredCapability: RUNTIME_CAPABILITY_OPERATE,
      elevation: 'admin_5m',
      privacyClass: 'operational_allowlist',
      idempotency: 'required',
      auditOperation: 'operate.sessions.terminate',
      privacyProjector: projectRuntimeTermination,
      handler: req => terminateOperationalSession(req, service),
    },
  ];
  return {
    id: 'runtimeSessions',
    apiVersion: 'v1',
    capabilities: [RUNTIME_CAPABILITY_SELF, RUNTIME_CAPABILITY_ACCOUNTS, RUNTIME_CAPABILITY_OPERATE],
    auditOperations: routes
      .map(route => route.auditOperation)
      .filter((id): id is string => typeof id === 'string')
      .map(id => ({ id })),
    routes,
  };
}

async function listSelfSessions(req: ConsoleRequest, service: RuntimeSessionService): Promise<ConsoleHandlerResult> {
  const actor = requireConsoleAuthentication(req);
  return { status: 200, body: projectRuntimeSessionSelfList(await service.listSelfSessions(actor.userId)) };
}

async function getSelfSession(req: ConsoleRequest, service: RuntimeSessionService): Promise<ConsoleHandlerResult> {
  const actor = requireConsoleAuthentication(req);
  const sessionId = requiredParam(req, SESSION_ID_PARAM);
  if (!sessionId) return invalidParam(SESSION_ID_PARAM);
  const body = await service.getSelfSession(actor.userId, sessionId);
  return body ? { status: 200, body: projectRuntimeSessionSelf(body) } : notFound(RUNTIME_SESSION_NOT_FOUND_DETAIL);
}

async function terminateSelfSession(req: ConsoleRequest, service: RuntimeSessionService): Promise<ConsoleHandlerResult> {
  const actor = requireConsoleAuthentication(req);
  const sessionId = requiredParam(req, SESSION_ID_PARAM);
  if (!sessionId) return invalidParam(SESSION_ID_PARAM);
  const body = await service.terminateSelfSession(actor.userId, sessionId);
  return body ? { status: 202, body: projectRuntimeTermination(body) } : notFound(RUNTIME_SESSION_NOT_FOUND_DETAIL);
}

async function listAccountSessions(req: ConsoleRequest, service: RuntimeSessionService): Promise<ConsoleHandlerResult> {
  const userId = requiredParam(req, 'user_id');
  if (!userId) return invalidParam('user_id');
  const body = await service.listAccountSessions(userId);
  return body ? { status: 200, body } : notFound('User principal was not found.');
}

async function terminateAccountSession(req: ConsoleRequest, service: RuntimeSessionService): Promise<ConsoleHandlerResult> {
  const userId = requiredParam(req, 'user_id');
  const sessionId = requiredParam(req, SESSION_ID_PARAM);
  if (!userId) return invalidParam('user_id');
  if (!sessionId) return invalidParam(SESSION_ID_PARAM);
  const body = await service.terminateAccountSession(userId, sessionId);
  return body ? { status: 202, body } : notFound(RUNTIME_SESSION_NOT_FOUND_DETAIL);
}

async function revokeAllAccountSessions(req: ConsoleRequest, service: RuntimeSessionService): Promise<ConsoleHandlerResult> {
  const userId = requiredParam(req, 'user_id');
  if (!userId) return invalidParam('user_id');
  const body = await service.revokeAllAccountSessions(userId);
  return body ? { status: 202, body } : notFound('User principal was not found.');
}

async function getOperationalSession(req: ConsoleRequest, service: RuntimeSessionService): Promise<ConsoleHandlerResult> {
  const sessionId = requiredParam(req, SESSION_ID_PARAM);
  if (!sessionId) return invalidParam(SESSION_ID_PARAM);
  const body = await service.getOperationalSession(sessionId);
  return body ? { status: 200, body } : notFound(RUNTIME_SESSION_NOT_FOUND_DETAIL);
}

async function terminateOperationalSession(req: ConsoleRequest, service: RuntimeSessionService): Promise<ConsoleHandlerResult> {
  const sessionId = requiredParam(req, SESSION_ID_PARAM);
  if (!sessionId) return invalidParam(SESSION_ID_PARAM);
  const actor = requireConsoleAuthentication(req);
  const body = await service.terminateOperationalSession(sessionId, actor.userId);
  return body ? { status: 202, body } : notFound(RUNTIME_SESSION_NOT_FOUND_DETAIL);
}

function requiredParam(req: ConsoleRequest, name: string): string | null {
  const value = req.params[name];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function invalidParam(name: string): ConsoleHandlerResult {
  return problem(400, 'invalid_request', `${name} path parameter is required.`);
}

function notFound(detail: string): ConsoleHandlerResult {
  return problem(404, 'not_found', detail);
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
