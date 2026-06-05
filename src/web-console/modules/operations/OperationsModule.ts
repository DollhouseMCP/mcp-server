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
  projectOperationalMetric,
  projectOperationalMetrics,
  projectSystemMetrics,
} from './OperationsPrivacyProjectors.js';
import type { ISystemMetricsSource } from './SystemMetricsSource.js';
import type { MetricQueryOptions, MetricQueryResult } from '../../../metrics/types.js';

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
  'operate.metrics.stream',
  'operate.metrics.system',
] as const;

const OPERATIONS_STREAM_POLICY = {
  lastEventId: 'unsupported',
  heartbeatMs: 15_000,
  revalidateMs: 15_000,
  maxEventBytes: 64 * 1024,
  maxLastEventIdBytes: 512,
} as const;

export interface OperationsModuleOptions {
  readonly healthChecks: OperationsHealthChecks;
  readonly telemetry: IConsoleTelemetryQuery;
  readonly operatorConfigStore: IOperatorConfigStore;
  readonly operatorConfigDefinitions?: readonly OperatorConfigSettingDefinition[];
  /** In-process System A metrics sink; absent when metrics collection is off. */
  readonly systemMetrics?: ISystemMetricsSource;
  readonly now?: () => Date;
}

export function createOperationsModule(options: OperationsModuleOptions): ConsoleModuleDescriptor {
  const service = new OperationsService(options.healthChecks, options.telemetry, options.now);
  const configService = new OperatorConfigurationService(
    options.operatorConfigStore,
    options.operatorConfigDefinitions ?? DEFAULT_OPERATOR_CONFIG_DEFINITIONS,
    options.now,
  );
  const resolveNow = options.now ?? (() => new Date());
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
        elevation: 'admin_30m',
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
        streamPolicy: OPERATIONS_STREAM_POLICY,
        privacyProjector: projectOperationalLogStreamData,
        streamEventProjectors: {
          init: projectOperationalLogStreamInit,
          update: projectOperationalLog,
          end: projectOperationalLogStreamEnd,
        },
        handler: req => {
          const lastEventId = parseConsoleLastEventId(req, OPERATIONS_STREAM_POLICY);
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
      {
        method: 'GET',
        path: '/api/v1/admin/operate/metrics/stream',
        audience: 'admin',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'operational_allowlist',
        idempotency: 'not_applicable',
        auditOperation: 'operate.metrics.stream',
        responseKind: 'sse',
        streamPolicy: OPERATIONS_STREAM_POLICY,
        privacyProjector: projectOperationalMetricStreamData,
        streamEventProjectors: {
          init: projectOperationalMetricStreamInit,
          update: projectOperationalMetric,
          end: projectOperationalStreamEnd,
        },
        handler: req => {
          const lastEventId = parseConsoleLastEventId(req, OPERATIONS_STREAM_POLICY);
          if (!lastEventId.ok) {
            throw new ConsoleStoreValidationError('Invalid Last-Event-ID header for this stream.');
          }
          const query = parseMetricQuery(req);
          return service.streamMetrics(query, {
            stream_id: 'admin.operate.metrics',
            stream_type: 'operational_metrics',
            resume_supported: false,
            filters: {
              subsystem: query.subsystem,
              name: query.name,
            },
          });
        },
      },
      {
        // System A: the MCP server's in-process operational metrics
        // (cache/perf/gatekeeper/security counters), system-wide. Distinct from
        // the session_activity_events-backed /metrics above.
        method: 'GET',
        path: '/api/v1/admin/operate/metrics/system',
        audience: 'admin',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'operational_allowlist',
        idempotency: 'not_applicable',
        auditOperation: 'operate.metrics.system',
        privacyProjector: projectSystemMetrics,
        handler: req => querySystemMetrics(options.systemMetrics, parseSystemMetricQuery(req), resolveNow),
      },
    ],
    auditOperations: OPERATION_AUDIT_IDS.map(id => ({ id })),
  };
}

// Reads the in-process System A sink. When metrics collection is disabled the
// sink is absent, so we degrade to an empty result rather than erroring.
function querySystemMetrics(
  source: ISystemMetricsSource | undefined,
  query: MetricQueryOptions,
  now: () => Date,
): ConsoleHandlerResult {
  if (!source) return { status: 200, body: emptySystemMetrics(now()) };
  return { status: 200, body: source.query(query) };
}

function emptySystemMetrics(at: Date): MetricQueryResult {
  const ts = at.toISOString();
  return { snapshots: [], total: 0, hasMore: false, limit: 0, offset: 0, oldestAvailable: ts, newestAvailable: ts };
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
  return projectOperationalStreamEnd(value);
}

function projectOperationalMetricStreamData(value: unknown): unknown {
  return projectOperationalMetric(value);
}

function projectOperationalMetricStreamInit(value: unknown): unknown {
  const init = asOperationalMetricStreamInit(value);
  return {
    connected_at: typeof init.connected_at === 'string' ? init.connected_at : null,
    stream_id: 'admin.operate.metrics',
    stream_type: 'operational_metrics',
    resume_supported: init.resume_supported === true,
    filters: projectMetricStreamFilters(init.filters),
  };
}

function projectOperationalStreamEnd(value: unknown): unknown {
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

function asOperationalMetricStreamInit(value: unknown): {
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

function projectMetricStreamFilters(value: unknown): Record<string, string | null> {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    subsystem: typeof record.subsystem === 'string' ? record.subsystem : null,
    name: typeof record.name === 'string' ? record.name : null,
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

function parseSystemMetricQuery(req: ConsoleRequest): MetricQueryOptions {
  const options: MetricQueryOptions = {};
  const names = boundedString(firstString(req.query.names), 512);
  if (names) options.names = names.split(',').map(name => name.trim()).filter(Boolean).slice(0, 50);
  const source = boundedString(firstString(req.query.source), 80);
  if (source) options.source = source;
  const type = firstString(req.query.type);
  if (type === 'counter' || type === 'gauge' || type === 'histogram') options.type = type;
  const since = boundedString(firstString(req.query.since), 40);
  if (since) options.since = since;
  const until = boundedString(firstString(req.query.until), 40);
  if (until) options.until = until;
  const latest = firstString(req.query.latest);
  if (latest !== null) options.latest = latest !== 'false';
  const limit = boundedNonNegativeInt(firstString(req.query.limit), 1, 1000);
  if (limit !== null) options.limit = limit;
  const offset = boundedNonNegativeInt(firstString(req.query.offset), 0, Number.MAX_SAFE_INTEGER);
  if (offset !== null) options.offset = offset;
  return options;
}

function boundedNonNegativeInt(value: string | null, min: number, max: number): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return null;
  return Math.min(Math.max(parsed, min), max);
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
