import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import { parseConsoleLastEventId } from '../../platform/ConsoleSseStream.js';
import type { IOperatorConfigStore } from '../../../storage/operatorConfig/IOperatorConfigStore.js';
import { ConsoleStoreValidationError } from '../../stores/ConsoleStoreValidation.js';
import {
  DEFAULT_OPERATOR_CONFIG_DEFINITIONS,
  OperatorConfigurationService,
  type OperatorConfigSettingDefinition,
} from './OperationsConfig.js';
import { OperationsService } from './OperationsService.js';
import type { OperationsHealthChecks } from './OperationsHealth.js';
import type {
  IConsoleTelemetryQuery,
  OperationalLogQuery,
  OperationalMetricQuery,
} from './OperationsTelemetry.js';
import {
  projectOperatorConfigList,
  projectOperatorConfigSetting,
  projectOperationHealthComponent,
  projectOperationHealthSummary,
  projectOperationalLog,
  projectOperationalLogs,
  projectOperationalMetrics,
} from './OperationsPrivacyProjectors.js';

const OPERATE_CAPABILITY = 'console:admin:operate';
const OPERATION_AUDIT_IDS = [
  'operate.config.list',
  'operate.config.show',
  'operate.config.update',
  'operate.health.show',
  'operate.health.database',
  'operate.health.auth_server',
  'operate.health.gatekeeper',
  'operate.logs.list',
  'operate.logs.stream',
  'operate.metrics.show',
] as const;

export interface OperationsModuleOptions {
  readonly healthChecks: OperationsHealthChecks;
  readonly telemetry: IConsoleTelemetryQuery;
  readonly operatorConfigStore: IOperatorConfigStore;
  readonly operatorConfigDefinitions?: readonly OperatorConfigSettingDefinition[];
  readonly now?: () => Date;
}

export function createOperationsModule(options: OperationsModuleOptions): ConsoleModuleDescriptor {
  const service = new OperationsService(options.healthChecks, options.telemetry, options.now);
  const configService = new OperatorConfigurationService(
    options.operatorConfigStore,
    options.operatorConfigDefinitions ?? DEFAULT_OPERATOR_CONFIG_DEFINITIONS,
    options.now,
  );
  return {
    id: 'operations',
    apiVersion: 'v1',
    capabilities: [OPERATE_CAPABILITY],
    routes: [
      {
        method: 'GET',
        path: '/api/v1/admin/operate/config',
        audience: 'admin',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'operational_allowlist',
        idempotency: 'not_applicable',
        auditOperation: 'operate.config.list',
        privacyProjector: projectOperatorConfigList,
        handler: () => configService.listConfig(),
      },
      {
        method: 'GET',
        path: '/api/v1/admin/operate/config/:key',
        audience: 'admin',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'operational_allowlist',
        idempotency: 'not_applicable',
        auditOperation: 'operate.config.show',
        privacyProjector: projectOperatorConfigSetting,
        handler: req => configService.getConfig(firstString(req.params.key) ?? ''),
      },
      {
        method: 'PUT',
        path: '/api/v1/admin/operate/config/:key',
        audience: 'admin',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_5m',
        privacyClass: 'operational_allowlist',
        idempotency: 'required',
        auditOperation: 'operate.config.update',
        privacyProjector: projectOperatorConfigSetting,
        handler: req => configService.updateConfig({
          key: firstString(req.params.key) ?? '',
          ifMatch: firstString(req.headers['if-match']),
          body: req.body,
        }),
      },
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
        path: '/api/v1/admin/operate/logs/stream',
        audience: 'admin',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'operational_allowlist',
        idempotency: 'not_applicable',
        auditOperation: 'operate.logs.stream',
        responseKind: 'sse',
        streamPolicy: {
          lastEventId: 'unsupported',
          heartbeatMs: 15_000,
          revalidateMs: 15_000,
          maxEventBytes: 64 * 1024,
          maxLastEventIdBytes: 512,
        },
        privacyProjector: projectOperationalLogStreamData,
        streamEventProjectors: {
          init: projectOperationalLogStreamInit,
          update: projectOperationalLog,
          end: projectOperationalLogStreamEnd,
        },
        handler: req => {
          const lastEventId = parseConsoleLastEventId(req, {
            lastEventId: 'unsupported',
            heartbeatMs: 15_000,
            revalidateMs: 15_000,
            maxEventBytes: 64 * 1024,
            maxLastEventIdBytes: 512,
          });
          if (!lastEventId.ok) {
            throw new ConsoleStoreValidationError('Invalid Last-Event-ID header for this stream.');
          }
          const query = parseLogQuery(req);
          return service.streamLogs(query, {
            stream_id: 'admin.operate.logs',
            stream_type: 'operational_logs',
            resume_supported: false,
            filters: {
              level: query.level,
              subsystem: query.subsystem,
              event: query.event,
            },
          });
        },
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

function projectOperationalLogStreamData(value: unknown): unknown {
  return projectOperationalLog(value);
}

function projectOperationalLogStreamInit(value: unknown): unknown {
  const init = asOperationalLogStreamInit(value);
  return {
    connected_at: typeof init.connected_at === 'string' ? init.connected_at : null,
    stream_id: 'admin.operate.logs',
    stream_type: 'operational_logs',
    resume_supported: init.resume_supported === true,
    filters: projectStreamFilters(init.filters),
  };
}

function projectOperationalLogStreamEnd(value: unknown): unknown {
  const end = value && typeof value === 'object' ? value as { readonly status?: unknown } : {};
  return { status: end.status === 'complete' ? 'complete' : 'closed' };
}

function asOperationalLogStreamInit(value: unknown): {
  readonly connected_at?: unknown;
  readonly stream_id?: unknown;
  readonly stream_type?: unknown;
  readonly resume_supported?: unknown;
  readonly filters?: unknown;
} {
  return value && typeof value === 'object' ? value : {};
}

function projectStreamFilters(value: unknown): Record<string, string | null> {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    level: typeof record.level === 'string' ? record.level : null,
    subsystem: typeof record.subsystem === 'string' ? record.subsystem : null,
    event: typeof record.event === 'string' ? record.event : null,
  };
}

function parseLogQuery(req: ConsoleRequest): OperationalLogQuery {
  return {
    limit: boundedLimit(firstString(req.query.limit), 100),
    cursor: boundedString(firstString(req.query.cursor), 256),
    level: boundedString(firstString(req.query.level), 16),
    subsystem: boundedString(firstString(req.query.subsystem), 64),
    event: boundedString(firstString(req.query.event), 128),
  };
}

function parseMetricQuery(req: ConsoleRequest): OperationalMetricQuery {
  return {
    subsystem: boundedString(firstString(req.query.subsystem), 64),
    name: boundedString(firstString(req.query.name), 128),
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

function firstString(value: ConsoleRequest['query'][string] | string | readonly string[] | undefined): string | null {
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
