import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import { OperationsService } from './OperationsService.js';
import type { OperationsHealthChecks } from './OperationsHealth.js';
import type {
  IConsoleTelemetryQuery,
  OperationalLogQuery,
  OperationalMetricQuery,
} from './OperationsTelemetry.js';
import {
  projectOperationHealthComponent,
  projectOperationHealthSummary,
  projectOperationalLogs,
  projectOperationalMetrics,
} from './OperationsPrivacyProjectors.js';

const OPERATE_CAPABILITY = 'console:admin:operate';
const OPERATION_AUDIT_IDS = [
  'operate.health.show',
  'operate.health.database',
  'operate.health.auth_server',
  'operate.health.gatekeeper',
  'operate.logs.list',
  'operate.metrics.show',
] as const;

export interface OperationsModuleOptions {
  readonly healthChecks: OperationsHealthChecks;
  readonly telemetry: IConsoleTelemetryQuery;
  readonly now?: () => Date;
}

export function createOperationsModule(options: OperationsModuleOptions): ConsoleModuleDescriptor {
  const service = new OperationsService(options.healthChecks, options.telemetry, options.now);
  return {
    id: 'operations',
    apiVersion: 'v1',
    capabilities: [OPERATE_CAPABILITY],
    routes: [
      {
        method: 'GET',
        path: '/api/v1/admin/operate/health',
        audience: 'admin',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'operational_allowlist',
        idempotency: 'not_applicable',
        auditOperation: 'operate.health.show',
        privacyProjector: projectOperationHealthSummary,
        handler: () => service.getHealth(),
      },
      {
        method: 'GET',
        path: '/api/v1/admin/operate/health/database',
        audience: 'admin',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'operational_allowlist',
        idempotency: 'not_applicable',
        auditOperation: 'operate.health.database',
        privacyProjector: projectOperationHealthComponent,
        handler: () => service.getDatabaseHealth(),
      },
      {
        method: 'GET',
        path: '/api/v1/admin/operate/health/auth-server',
        audience: 'admin',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'operational_allowlist',
        idempotency: 'not_applicable',
        auditOperation: 'operate.health.auth_server',
        privacyProjector: projectOperationHealthComponent,
        handler: () => service.getAuthServerHealth(),
      },
      {
        method: 'GET',
        path: '/api/v1/admin/operate/health/gatekeeper',
        audience: 'admin',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'operational_allowlist',
        idempotency: 'not_applicable',
        auditOperation: 'operate.health.gatekeeper',
        privacyProjector: projectOperationHealthComponent,
        handler: () => service.getGatekeeperHealth(),
      },
      {
        method: 'GET',
        path: '/api/v1/admin/operate/logs',
        audience: 'admin',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'operational_allowlist',
        idempotency: 'not_applicable',
        auditOperation: 'operate.logs.list',
        privacyProjector: projectOperationalLogs,
        handler: req => service.queryLogs(parseLogQuery(req)),
      },
      {
        method: 'GET',
        path: '/api/v1/admin/operate/metrics',
        audience: 'admin',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'operational_allowlist',
        idempotency: 'not_applicable',
        auditOperation: 'operate.metrics.show',
        privacyProjector: projectOperationalMetrics,
        handler: req => service.queryMetrics(parseMetricQuery(req)),
      },
    ],
    auditOperations: OPERATION_AUDIT_IDS.map(id => ({ id })),
  };
}

function parseLogQuery(req: ConsoleRequest): OperationalLogQuery {
  return {
    limit: boundedLimit(firstQueryValue(req.query.limit), 100),
    cursor: boundedString(firstQueryValue(req.query.cursor), 256),
    level: boundedString(firstQueryValue(req.query.level), 16),
    subsystem: boundedString(firstQueryValue(req.query.subsystem), 64),
    event: boundedString(firstQueryValue(req.query.event), 128),
  };
}

function parseMetricQuery(req: ConsoleRequest): OperationalMetricQuery {
  return {
    subsystem: boundedString(firstQueryValue(req.query.subsystem), 64),
    name: boundedString(firstQueryValue(req.query.name), 128),
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
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function firstQueryValue(value: ConsoleRequest['query'][string]): string | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : null;
  }
  return typeof value === 'string' ? value : null;
}

export function operationalProblem(status: number, code: string, detail: string): ConsoleHandlerResult {
  return {
    status,
    body: {
      type: 'about:blank',
      title: status >= 500 ? 'Service unavailable' : 'Invalid request',
      status,
      code,
      detail,
    },
  };
}
