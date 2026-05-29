import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import {
  projectAdminAuditEvent,
  projectAdminAuditPage,
  projectApprovalAuditEvent,
  projectApprovalAuditPage,
  projectAuthenticationAuditPage,
} from './AuditPrivacyProjectors.js';
import type {
  AuditListQuery,
  IAdminAuditQuery,
  IApprovalAuditQuery,
  IAuthenticationAuditQuery,
} from './AuditQueries.js';

const AUDIT_CAPABILITY = 'console:admin:audit';
const AUDIT_FIND_OPERATION = 'audit.find';
const AUDIT_SHOW_OPERATION = 'audit.show';

export interface AuditModuleOptions {
  readonly adminAuditQuery: IAdminAuditQuery;
  readonly approvalAuditQuery: IApprovalAuditQuery;
  readonly authenticationAuditQuery: IAuthenticationAuditQuery;
}

export function createAuditModule(options: AuditModuleOptions): ConsoleModuleDescriptor {
  return {
    id: 'audit',
    apiVersion: 'v1',
    capabilities: [AUDIT_CAPABILITY],
    auditOperations: [
      { id: AUDIT_FIND_OPERATION },
      { id: AUDIT_SHOW_OPERATION },
    ],
    routes: [
      {
        method: 'GET',
        path: '/api/v1/admin/audit/admin',
        audience: 'admin',
        requiredCapability: AUDIT_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'admin_audit',
        idempotency: 'not_applicable',
        auditOperation: AUDIT_FIND_OPERATION,
        privacyProjector: projectAdminAuditPage,
        handler: req => listAdminAudit(req, options.adminAuditQuery),
      },
      {
        method: 'GET',
        path: '/api/v1/admin/audit/admin/:id',
        audience: 'admin',
        requiredCapability: AUDIT_CAPABILITY,
        elevation: 'admin_5m',
        privacyClass: 'admin_audit',
        idempotency: 'not_applicable',
        auditOperation: AUDIT_SHOW_OPERATION,
        privacyProjector: projectAdminAuditEvent,
        handler: req => getAdminAudit(req, options.adminAuditQuery),
      },
      {
        method: 'GET',
        path: '/api/v1/admin/audit/approvals',
        audience: 'admin',
        requiredCapability: AUDIT_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'approval_metadata',
        idempotency: 'not_applicable',
        auditOperation: AUDIT_FIND_OPERATION,
        privacyProjector: projectApprovalAuditPage,
        handler: req => listApprovalAudit(req, options.approvalAuditQuery),
      },
      {
        method: 'GET',
        path: '/api/v1/admin/audit/approvals/:id',
        audience: 'admin',
        requiredCapability: AUDIT_CAPABILITY,
        elevation: 'admin_5m',
        privacyClass: 'approval_metadata',
        idempotency: 'not_applicable',
        auditOperation: AUDIT_SHOW_OPERATION,
        privacyProjector: projectApprovalAuditEvent,
        handler: req => getApprovalAudit(req, options.approvalAuditQuery),
      },
      {
        method: 'GET',
        path: '/api/v1/admin/audit/authentication',
        audience: 'admin',
        requiredCapability: AUDIT_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'admin_audit',
        idempotency: 'not_applicable',
        auditOperation: AUDIT_FIND_OPERATION,
        privacyProjector: projectAuthenticationAuditPage,
        handler: req => options.authenticationAuditQuery
          .listAuthenticationAudit(parseListQuery(req))
          .then(body => ({ status: 200, body })),
      },
    ],
  };
}

async function listAdminAudit(req: ConsoleRequest, query: IAdminAuditQuery): Promise<ConsoleHandlerResult> {
  return { status: 200, body: await query.listAdminAudit(parseListQuery(req)) };
}

async function getAdminAudit(req: ConsoleRequest, query: IAdminAuditQuery): Promise<ConsoleHandlerResult> {
  const id = requiredParam(req, 'id');
  if (!id) return invalidParam('id');
  const body = await query.getAdminAudit(id);
  return body ? { status: 200, body } : notFound('Admin audit event was not found.');
}

async function listApprovalAudit(req: ConsoleRequest, query: IApprovalAuditQuery): Promise<ConsoleHandlerResult> {
  return { status: 200, body: await query.listApprovalAudit(parseListQuery(req)) };
}

async function getApprovalAudit(req: ConsoleRequest, query: IApprovalAuditQuery): Promise<ConsoleHandlerResult> {
  const id = requiredParam(req, 'id');
  if (!id) return invalidParam('id');
  const body = await query.getApprovalAudit(id);
  return body ? { status: 200, body } : notFound('Approval audit event was not found.');
}

function parseListQuery(req: ConsoleRequest): AuditListQuery {
  return {
    limit: boundedLimit(firstQueryValue(req.query.limit), 100),
    cursor: boundedString(firstQueryValue(req.query.cursor), 256),
  };
}

function boundedLimit(value: string | null, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 100);
}

function boundedString(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function firstQueryValue(value: ConsoleRequest['query'][string]): string | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : null;
  }
  return typeof value === 'string' ? value : null;
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
