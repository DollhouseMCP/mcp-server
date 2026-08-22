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
import { decodeConsoleCursor, encodeConsoleCursor } from '../../platform/ConsoleCursor.js';
import { boundedLimit, boundedString, firstString } from '../../platform/ConsoleQueryParams.js';

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
  /** Opaque request cursor, retained in the response when it is valid. */
  readonly cursor: string | null;
  /** Continue strictly after this entry in newest-first timestamp/id order. */
  readonly beforeTimestamp: string | null;
  readonly beforeId: string | null;
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
  readonly has_more: boolean;
}

/** Cursor-family response envelope (`{items, page:{limit, cursor, next_cursor}}`). */
export interface ConsoleLogPageDto {
  readonly items: readonly ConsoleLogEntry[];
  readonly page: {
    readonly limit: number;
    readonly cursor: string | null;
    readonly next_cursor: string | null;
  };
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
        privacyProjector: projectConsoleLogPageDto,
        handler: (req): ConsoleHandlerResult => {
          const actor = requireConsoleAuthentication(req);
          const query = parseLogQuery(req, actor.userId);
          const page = logSource.queryUserLogs(query);
          return { status: 200, body: serializeConsoleLogPage(page, query) };
        },
      },
    ],
  };
}

function parseLogQuery(req: ConsoleRequest, userId: string): ConsoleLogQueryOptions {
  const rawCursor = boundedString(firstString(req.query.cursor), 512);
  const boundary = logBoundaryFromCursor(rawCursor);
  return {
    userId,
    level: boundedString(firstString(req.query.level), 16),
    source: boundedString(firstString(req.query.source), 120),
    message: boundedString(firstString(req.query.message), 200),
    correlationId: boundedString(firstString(req.query.correlation_id), 128),
    sessionId: boundedString(firstString(req.query.session_id), 200),
    since: boundedString(firstString(req.query.since), 64),
    limit: boundedLimit(firstString(req.query.limit), 200, 1000),
    cursor: boundary ? rawCursor : null,
    beforeTimestamp: boundary?.timestamp ?? null,
    beforeId: boundary?.id ?? null,
  };
}

function serializeConsoleLogPage(page: ConsoleLogPage, query: ConsoleLogQueryOptions): ConsoleLogPageDto {
  const lastEntry = page.entries.at(-1);
  return {
    items: page.entries,
    page: {
      limit: query.limit,
      cursor: query.cursor,
      next_cursor: page.has_more && lastEntry ? logCursor(lastEntry) : null,
    },
  };
}

function logBoundaryFromCursor(token: string | null): { timestamp: string; id: string } | null {
  if (!token) return null;
  const payload = decodeConsoleCursor(token);
  if (payload?.v !== 1 || typeof payload.t !== 'string' || typeof payload.i !== 'string') return null;
  if (payload.t.length === 0 || payload.t.length > 64 || payload.i.length === 0 || payload.i.length > 200) return null;
  return { timestamp: payload.t, id: payload.i };
}

function logCursor(entry: ConsoleLogEntry): string {
  return encodeConsoleCursor({ v: 1, t: entry.ts, i: entry.id });
}

function projectConsoleLogPageDto(value: unknown): ConsoleLogPageDto {
  const record = objectValue(value);
  const page = objectValue(record.page);
  return {
    items: arrayValue(record.items).map(projectConsoleLogEntry),
    page: {
      limit: numberField(page, 'limit'),
      cursor: nullableStringField(page, 'cursor'),
      next_cursor: nullableStringField(page, 'next_cursor'),
    },
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
