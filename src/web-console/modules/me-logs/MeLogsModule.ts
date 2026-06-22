import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import {
  arrayValue,
  nullableStringField,
  numberField,
  objectValue,
  stringField,
} from '../../platform/ConsoleProjectorHelpers.js';

const SELF_CAPABILITY = 'console:self';

/**
 * Backend-agnostic log-query seam. The Logs tab reads the server's own logs from
 * whatever logging backend is configured (today the in-memory MemoryLogSink) via
 * this port — NOT from the storage backend. The module depends only on this
 * interface, so the log source is swappable without touching the route.
 */
export interface ConsoleLogQueryOptions {
  readonly userId: string;
  readonly level: string | null;
  readonly source: string | null;
  readonly message: string | null;
  readonly correlationId: string | null;
  readonly sessionId: string | null;
  readonly since: string | null;
  readonly limit: number;
}

export interface ConsoleLogEntry {
  readonly id: string;
  readonly ts: string;
  readonly level: string;
  readonly category: string;
  readonly source: string;
  readonly message: string;
  readonly correlation_id: string | null;
  readonly session_id: string | null;
}

export interface ConsoleLogPage {
  readonly entries: readonly ConsoleLogEntry[];
  readonly total: number;
  readonly has_more: boolean;
}

export interface IConsoleLogSource {
  queryUserLogs(options: ConsoleLogQueryOptions): ConsoleLogPage;
}

export interface MeLogsModuleOptions {
  readonly logSource: IConsoleLogSource;
}

export function createMeLogsModule(options: MeLogsModuleOptions): ConsoleModuleDescriptor {
  const { logSource } = options;
  return {
    id: 'me-logs',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    routes: [
      {
        method: 'GET',
        // The authenticated user's own logs, across all their sessions. Scoped
        // solely by actor.userId — the log source filters to that user.
        path: '/api/v1/me/logs',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectConsoleLogPage,
        handler: (req): ConsoleHandlerResult => {
          const actor = requireConsoleAuthentication(req);
          const page = logSource.queryUserLogs(parseLogQuery(req, actor.userId));
          return { status: 200, body: projectConsoleLogPage(page) };
        },
      },
    ],
  };
}

function parseLogQuery(req: ConsoleRequest, userId: string): ConsoleLogQueryOptions {
  return {
    userId,
    level: boundedString(firstString(req.query.level), 16),
    source: boundedString(firstString(req.query.source), 120),
    message: boundedString(firstString(req.query.message), 200),
    correlationId: boundedString(firstString(req.query.correlation_id), 128),
    sessionId: boundedString(firstString(req.query.session_id), 200),
    since: boundedString(firstString(req.query.since), 64),
    limit: boundedLimit(firstString(req.query.limit), 200),
  };
}

function projectConsoleLogPage(value: unknown): ConsoleLogPage {
  const record = objectValue(value);
  return {
    entries: arrayValue(record.entries).map(projectConsoleLogEntry),
    total: numberField(record, 'total'),
    has_more: record.has_more === true,
  };
}

function projectConsoleLogEntry(value: unknown): ConsoleLogEntry {
  const record = objectValue(value);
  return {
    id: stringField(record, 'id'),
    ts: stringField(record, 'ts'),
    level: stringField(record, 'level'),
    category: stringField(record, 'category'),
    source: stringField(record, 'source'),
    message: stringField(record, 'message'),
    correlation_id: nullableStringField(record, 'correlation_id'),
    session_id: nullableStringField(record, 'session_id'),
  };
}

function boundedLimit(value: string | null, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 1000);
}

function boundedString(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function firstString(value: ConsoleRequest['query'][string] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}
