import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
  ConsoleSseEvent,
} from '../../platform/ConsolePlatformTypes.js';
import { projectConsoleStreamEndStatus } from '../../platform/ConsoleProjectorHelpers.js';
import { parseConsoleLastEventId } from '../../platform/ConsoleSseStream.js';
import { ConsoleStoreValidationError } from '../../stores/ConsoleStoreValidation.js';
import {
  projectAdminAuditEvent,
  projectAdminAuditPage,
  projectApprovalAuditEvent,
  projectApprovalAuditPage,
  projectAuthenticationAuditPage,
} from './AuditPrivacyProjectors.js';
import type {
  AuditExportQuery,
  AuditListQuery,
  IAdminAuditQuery,
  IApprovalAuditQuery,
  IAuthenticationAuditQuery,
} from './AuditQueries.js';
import type { AdminAuditEventDto } from './AuditDtos.js';

const AUDIT_CAPABILITY = 'console:admin:audit';
const AUDIT_FIND_OPERATION = 'audit.find';
const AUDIT_SHOW_OPERATION = 'audit.show';
const AUDIT_EXPORT_OPERATION = 'audit.export';
const AUDIT_STREAM_POLICY = {
  lastEventId: 'unsupported',
  heartbeatMs: 15_000,
  revalidateMs: 15_000,
  maxLifetimeMs: 15 * 60_000,
  backpressureDrainTimeoutMs: 30_000,
  maxEventBytes: 64 * 1024,
  maxLastEventIdBytes: 512,
} as const;

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
      { id: AUDIT_EXPORT_OPERATION },
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
        path: '/api/v1/admin/audit/admin/export',
        audience: 'admin',
        requiredCapability: AUDIT_CAPABILITY,
        elevation: 'admin_5m',
        privacyClass: 'admin_audit',
        idempotency: 'not_applicable',
        auditOperation: AUDIT_EXPORT_OPERATION,
        responseKind: 'sse',
        streamPolicy: AUDIT_STREAM_POLICY,
        privacyProjector: projectAdminAuditEvent,
        streamEventProjectors: {
          init: projectAdminAuditExportInit,
          update: projectAdminAuditEvent,
          end: projectConsoleStreamEndStatus,
        },
        handler: req => exportAdminAudit(req, options.adminAuditQuery),
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

function exportAdminAudit(req: ConsoleRequest, query: IAdminAuditQuery): ConsoleHandlerResult {
  const lastEventId = parseConsoleLastEventId(req, AUDIT_STREAM_POLICY);
  if (!lastEventId.ok) {
    throw new ConsoleStoreValidationError('Invalid Last-Event-ID header for this stream.');
  }
  const exportQuery = parseExportQuery(req);
  return {
    status: 200,
    stream: {
      init: {
        stream_id: 'admin.audit.admin.export',
        stream_type: 'admin_audit_export',
        resume_supported: false,
        cursor: exportQuery.cursor,
        batch_size: exportQuery.batchSize,
      },
      events: streamAdminAuditEvents(query.streamAdminAudit(exportQuery)),
    },
  };
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

function parseExportQuery(req: ConsoleRequest): AuditExportQuery {
  return {
    cursor: boundedString(firstQueryValue(req.query.cursor), 256),
    batchSize: boundedLimit(firstQueryValue(req.query.batch_size), 100),
  };
}

async function* streamAdminAuditEvents(rows: AsyncIterable<AdminAuditEventDto>): AsyncIterable<ConsoleSseEvent> {
  for await (const row of rows) {
    yield {
      event: 'update',
      data: row,
    };
  }
  yield {
    event: 'end',
    data: {
      status: 'complete',
    },
  };
}

function projectAdminAuditExportInit(value: unknown): unknown {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    connected_at: typeof record.connected_at === 'string' ? record.connected_at : null,
    stream_id: 'admin.audit.admin.export',
    stream_type: 'admin_audit_export',
    resume_supported: record.resume_supported === true,
    cursor: typeof record.cursor === 'string' ? record.cursor : null,
    batch_size: typeof record.batch_size === 'number' && Number.isSafeInteger(record.batch_size)
      ? record.batch_size
      : 100,
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
