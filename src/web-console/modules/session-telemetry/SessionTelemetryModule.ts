import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import { projectConsoleStreamEndStatus } from '../../platform/ConsoleProjectorHelpers.js';
import { parseConsoleLastEventId } from '../../platform/ConsoleSseStream.js';
import type { IRuntimeSessionControlStore } from '../../services/runtime/IRuntimeSessionControlStore.js';
import { ConsoleStoreValidationError } from '../../stores/ConsoleStoreValidation.js';
import type { ActivityQuery, IOwnedActivityQuery } from './OwnedActivityQuery.js';
import type { IOwnedMetricQuery, MetricQuery } from './OwnedMetricQuery.js';
import {
  projectUserActivity,
  projectUserActivityPage,
  projectUserMetric,
  projectUserMetrics,
} from './SessionTelemetryProjectors.js';
import { SessionTelemetryService } from './SessionTelemetryService.js';

const SELF_CAPABILITY = 'console:self';
const SESSION_TELEMETRY_STREAM_POLICY = {
  lastEventId: 'unsupported',
  heartbeatMs: 15_000,
  revalidateMs: 15_000,
  maxLifetimeMs: 15 * 60_000,
  backpressureDrainTimeoutMs: 30_000,
  maxEventBytes: 64 * 1024,
  maxLastEventIdBytes: 512,
} as const;

export interface SessionTelemetryModuleOptions {
  readonly runtimeStore: IRuntimeSessionControlStore;
  readonly ownedActivityQuery: IOwnedActivityQuery;
  readonly ownedMetricQuery: IOwnedMetricQuery;
  readonly now?: () => Date;
}

export function createSessionTelemetryModule(options: SessionTelemetryModuleOptions): ConsoleModuleDescriptor {
  const service = new SessionTelemetryService(options);
  return {
    id: 'session-telemetry',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    routes: [
      {
        method: 'GET',
        path: '/api/v1/me/sessions/:session_id/logs',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectUserActivityPage,
        handler: req => withSessionId(req, sessionId => service.queryLogs(req, sessionId, parseActivityQuery(req))),
      },
      {
        method: 'GET',
        path: '/api/v1/me/sessions/:session_id/logs/stream',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        responseKind: 'sse',
        streamPolicy: SESSION_TELEMETRY_STREAM_POLICY,
        privacyProjector: projectUserActivity,
        streamEventProjectors: {
          init: projectLogStreamInit,
          update: projectUserActivity,
          end: projectConsoleStreamEndStatus,
        },
        handler: req => withSessionId(req, sessionId => {
          const lastEventId = parseConsoleLastEventId(req, SESSION_TELEMETRY_STREAM_POLICY);
          if (!lastEventId.ok) {
            throw new ConsoleStoreValidationError('Invalid Last-Event-ID header for this stream.');
          }
          const query = parseActivityQuery(req);
          return service.streamLogs(req, sessionId, query, {
            stream_id: `me.sessions.${sessionId}.logs`,
            stream_type: 'session_logs',
            resume_supported: false,
            session_id: sessionId,
            filters: {
              level: query.level,
              subsystem: query.subsystem,
              event: query.event,
            },
          });
        }),
      },
      {
        method: 'GET',
        path: '/api/v1/me/sessions/:session_id/metrics',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectUserMetrics,
        handler: req => withSessionId(req, sessionId => service.queryMetrics(req, sessionId, parseMetricQuery(req))),
      },
      {
        method: 'GET',
        path: '/api/v1/me/sessions/:session_id/metrics/stream',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        responseKind: 'sse',
        streamPolicy: SESSION_TELEMETRY_STREAM_POLICY,
        privacyProjector: projectUserMetric,
        streamEventProjectors: {
          init: projectMetricStreamInit,
          update: projectUserMetric,
          end: projectConsoleStreamEndStatus,
        },
        handler: req => withSessionId(req, sessionId => {
          const lastEventId = parseConsoleLastEventId(req, SESSION_TELEMETRY_STREAM_POLICY);
          if (!lastEventId.ok) {
            throw new ConsoleStoreValidationError('Invalid Last-Event-ID header for this stream.');
          }
          const query = parseMetricQuery(req);
          return service.streamMetrics(req, sessionId, query, {
            stream_id: `me.sessions.${sessionId}.metrics`,
            stream_type: 'session_metrics',
            resume_supported: false,
            session_id: sessionId,
            filters: {
              subsystem: query.subsystem,
              name: query.name,
            },
          });
        }),
      },
    ],
  };
}

function projectLogStreamInit(value: unknown): unknown {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    connected_at: typeof record.connected_at === 'string' ? record.connected_at : null,
    stream_id: typeof record.stream_id === 'string' ? record.stream_id : '',
    stream_type: 'session_logs',
    resume_supported: record.resume_supported === true,
    session_id: typeof record.session_id === 'string' ? record.session_id : '',
    filters: projectStreamFilters(record.filters),
  };
}

function projectMetricStreamInit(value: unknown): unknown {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    connected_at: typeof record.connected_at === 'string' ? record.connected_at : null,
    stream_id: typeof record.stream_id === 'string' ? record.stream_id : '',
    stream_type: 'session_metrics',
    resume_supported: record.resume_supported === true,
    session_id: typeof record.session_id === 'string' ? record.session_id : '',
    filters: projectMetricStreamFilters(record.filters),
  };
}

function projectStreamFilters(value: unknown): unknown {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    level: typeof record.level === 'string' ? record.level : null,
    subsystem: typeof record.subsystem === 'string' ? record.subsystem : null,
    event: typeof record.event === 'string' ? record.event : null,
  };
}

function projectMetricStreamFilters(value: unknown): unknown {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    subsystem: typeof record.subsystem === 'string' ? record.subsystem : null,
    name: typeof record.name === 'string' ? record.name : null,
  };
}

function parseActivityQuery(req: ConsoleRequest): ActivityQuery {
  return {
    limit: boundedLimit(firstString(req.query.limit), 100),
    cursor: boundedString(firstString(req.query.cursor), 256),
    level: boundedString(firstString(req.query.level), 16),
    subsystem: boundedString(firstString(req.query.subsystem), 64),
    event: boundedString(firstString(req.query.event), 128),
  };
}

function parseMetricQuery(req: ConsoleRequest): MetricQuery {
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

function firstString(value: ConsoleRequest['query'][string] | undefined): string | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : null;
  }
  return typeof value === 'string' ? value : null;
}

function withSessionId(
  req: ConsoleRequest,
  action: (sessionId: string) => Promise<ConsoleHandlerResult>,
): Promise<ConsoleHandlerResult> | ConsoleHandlerResult {
  const sessionId = req.params.session_id;
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return invalidRequest('session_id path parameter is required.');
  }
  return action(sessionId);
}

function invalidRequest(detail: string): ConsoleHandlerResult {
  return {
    status: 400,
    body: {
      type: 'about:blank',
      title: 'Invalid request',
      status: 400,
      code: 'invalid_request',
      detail,
    },
  };
}
