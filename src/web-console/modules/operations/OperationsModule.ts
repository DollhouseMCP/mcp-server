import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import { projectConsoleStreamEndStatus } from '../../platform/ConsoleProjectorHelpers.js';
import { offsetConsoleCursor, offsetFromConsoleCursor } from '../../platform/ConsoleCursor.js';
import { boundedLimit, boundedString, firstString, optionalLimit } from '../../platform/ConsoleQueryParams.js';
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
import type { IAccountAdminMutationTransactionRunner } from '../account-admin/AccountAdminMutationTransaction.js';
import { buildConsoleAdminAuditEvent } from '../../middleware/ConsoleAdminAudit.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { ConsoleAdminAuditResult } from '../../audit/IAdminAuditWriter.js';
import type { ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';

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
  maxLifetimeMs: 15 * 60_000,
  backpressureDrainTimeoutMs: 30_000,
  maxEventBytes: 64 * 1024,
  maxLastEventIdBytes: 512,
} as const;

export interface OperationsModuleOptions {
  readonly healthChecks: OperationsHealthChecks;
  readonly telemetry: IConsoleTelemetryQuery;
  readonly operatorConfigStore: IOperatorConfigStore;
  readonly transactionRunner: IAccountAdminMutationTransactionRunner;
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
      transactionalOperationRoute({
        method: 'PUT',
        path: '/api/v1/admin/operate/config/:key',
        audience: 'admin',
        requiredCapability: OPERATE_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'operational_allowlist',
        idempotency: 'required',
        auditOperation: 'operate.config.update',
        privacyProjector: projectOperatorConfigSetting,
      }, (req, route) => updateOperatorConfig(req, route, configService, options.transactionRunner, resolveNow)),
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
          end: projectConsoleStreamEndStatus,
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
          end: projectConsoleStreamEndStatus,
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

function transactionalOperationRoute(
  definition: Omit<ConsoleRouteDefinition, 'auditExecution' | 'handler'>,
  handler: (req: ConsoleRequest, route: ConsoleRouteDefinition) => Promise<ConsoleHandlerResult>,
): ConsoleRouteDefinition {
  let route!: ConsoleRouteDefinition;
  route = {
    ...definition,
    auditExecution: 'handler_transaction',
    handler: req => handler(req, route),
  };
  return route;
}

async function updateOperatorConfig(
  req: ConsoleRequest,
  route: ConsoleRouteDefinition,
  service: OperatorConfigurationService,
  transactionRunner: IAccountAdminMutationTransactionRunner,
  now: () => Date,
): Promise<ConsoleHandlerResult> {
  const key = firstString(req.params.key) ?? '';
  return transactionRunner.run(async tx => {
    const transactionalStore: IOperatorConfigStore = {
      load: () => tx.loadOperatorConfig(),
      save: (config, options) => tx.saveOperatorConfig(config, options),
    };
    const result = await service.updateConfig(operatorConfigUpdateInput(req), transactionalStore);
    const audit = operationAuditResult(result);
    await tx.writeAdminAuditEvent(buildConsoleAdminAuditEvent(
      route,
      route.auditOperation ?? '',
      req,
      audit.result,
      audit.errorCode,
      now(),
      {
        resourceKind: 'operator_config',
        resourceId: key || null,
        argsRedacted: { key },
        resultDetailRedacted: null,
      },
    ));
    return result;
  }, requireConsoleAuthentication(req));
}

function operatorConfigUpdateInput(req: ConsoleRequest) {
  return {
    key: firstString(req.params.key) ?? '',
    ifMatch: firstString(req.headers['if-match']),
    body: req.body,
  };
}

function operationAuditResult(result: ConsoleHandlerResult): {
  readonly result: ConsoleAdminAuditResult;
  readonly errorCode: string | null;
} {
  if (result.status >= 200 && result.status < 300) return { result: 'approved', errorCode: null };
  const errorCode = extractProblemCode(result.body);
  if (result.status === 409 || result.status === 412) return { result: 'conflict', errorCode };
  if (result.status === 404) return { result: 'failed', errorCode: errorCode ?? 'not_found' };
  if (result.status >= 400 && result.status < 500) return { result: 'rejected', errorCode };
  return { result: 'failed', errorCode: errorCode ?? 'internal_error' };
}

function extractProblemCode(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const code = (body as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

// Reads the in-process System A sink. When metrics collection is disabled the
// sink is absent, so we degrade to an empty result rather than erroring.
function querySystemMetrics(
  source: ISystemMetricsSource | undefined,
  query: MetricQueryOptions,
  now: () => Date,
): ConsoleHandlerResult {
  const result = source ? source.query(query) : emptySystemMetrics(now());
  return { status: 200, body: serializeSystemMetrics(result) };
}

// Cursor-family envelope over the offset-backed ring buffer: the offset is
// carried in an opaque cursor, never exposed raw. The ring-buffer anchors
// (oldest/newest available) are domain metadata and stay top-level. Keys here
// are the camelCase internal model — projectSystemMetrics maps them to the
// snake_case DTO (oldestAvailable → oldest_available) at the trust boundary.
function serializeSystemMetrics(result: MetricQueryResult): Record<string, unknown> {
  return {
    items: result.snapshots,
    page: {
      limit: result.limit,
      cursor: result.offset > 0 ? offsetConsoleCursor(result.offset) : null,
      next_cursor: result.hasMore ? offsetConsoleCursor(result.offset + result.snapshots.length) : null,
    },
    oldestAvailable: result.oldestAvailable,
    newestAvailable: result.newestAvailable,
  };
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
    limit: boundedLimit(firstString(req.query.limit), 100, 100),
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
  // Absent/invalid limit → omit the option so the sink's default applies.
  const limit = optionalLimit(firstString(req.query.limit), 1000);
  if (limit !== null) options.limit = limit;
  // Continuation position arrives as an opaque cursor (cursor family), never
  // as a raw offset parameter.
  const cursor = boundedString(firstString(req.query.cursor), 512);
  if (cursor) options.offset = offsetFromConsoleCursor(cursor);
  return options;
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
