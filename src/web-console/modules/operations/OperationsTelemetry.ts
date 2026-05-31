import { sql } from 'drizzle-orm';

import { withSystemContext } from '../../../database/admin.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import type {
  OperationalLogDto,
  OperationalLogPageDto,
  OperationalMetricDto,
  OperationalMetricResponseDto,
} from './OperationsDtos.js';

export interface OperationalLogQuery {
  readonly limit: number;
  readonly cursor: string | null;
  readonly level: string | null;
  readonly subsystem: string | null;
  readonly event: string | null;
}

export interface OperationalMetricQuery {
  readonly subsystem: string | null;
  readonly name: string | null;
}

export interface IConsoleTelemetryQuery {
  queryOperationalLogs(query: OperationalLogQuery): Promise<OperationalLogPageDto>;
  streamOperationalLogs(query: OperationalLogQuery): AsyncIterable<OperationalLogDto>;
  queryOperationalMetrics(query: OperationalMetricQuery): Promise<OperationalMetricResponseDto>;
  streamOperationalMetrics(query: OperationalMetricQuery): AsyncIterable<OperationalMetricDto>;
}

interface OperationalLogRow {
  readonly ts: Date | string;
  readonly level: string;
  readonly subsystem: string;
  readonly event: string;
  readonly correlation_id: string | null;
  readonly account_correlation_id: string | null;
  readonly session_id: string | null;
  readonly replica: string;
  readonly duration_ms: number | string | null;
  readonly status_code: number | string | null;
  readonly error_code: string | null;
}

interface OperationalMetricRow {
  readonly subsystem: string;
  readonly event: string;
  readonly error_code: string | null;
  readonly value: number | string;
}

export class PostgresConsoleTelemetryQuery implements IConsoleTelemetryQuery {
  constructor(
    private readonly db: DatabaseInstance,
    private readonly options: {
      readonly replicaId: string;
      readonly now?: () => Date;
    },
  ) {}

  async queryOperationalLogs(query: OperationalLogQuery): Promise<OperationalLogPageDto> {
    const offset = query.cursor ? decodeCursor(query.cursor) : 0;
    const rows = await withSystemContext(this.db, tx => tx.execute(sql`
      SELECT
        e.occurred_at AS ts,
        e.level,
        e.subsystem,
        e.event,
        e.correlation_id,
        u.account_correlation_id,
        e.session_id,
        ${this.options.replicaId} AS replica,
        NULL::integer AS duration_ms,
        NULL::integer AS status_code,
        e.stable_error_code AS error_code
      FROM session_activity_events e
      JOIN users u ON u.id = e.user_id
      WHERE (${query.level}::text IS NULL OR e.level = ${query.level})
        AND (${query.subsystem}::text IS NULL OR e.subsystem = ${query.subsystem})
        AND (${query.event}::text IS NULL OR e.event = ${query.event})
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT ${query.limit + 1}
      OFFSET ${offset}
    `)) as unknown as OperationalLogRow[];
    const items = rows.slice(0, query.limit).map(toOperationalLogDto);
    return {
      items,
      page: {
        limit: query.limit,
        cursor: query.cursor,
        next_cursor: rows.length > query.limit ? encodeCursor(offset + query.limit) : null,
      },
    };
  }

  async queryOperationalMetrics(query: OperationalMetricQuery): Promise<OperationalMetricResponseDto> {
    const rows = await withSystemContext(this.db, tx => tx.execute(sql`
      SELECT
        e.subsystem,
        e.event,
        e.stable_error_code AS error_code,
        COUNT(*)::integer AS value
      FROM session_activity_events e
      WHERE (${query.subsystem}::text IS NULL OR e.subsystem = ${query.subsystem})
      GROUP BY e.subsystem, e.event, e.stable_error_code
      ORDER BY e.subsystem ASC, e.event ASC, e.stable_error_code ASC NULLS FIRST
    `)) as unknown as OperationalMetricRow[];
    return {
      checked_at: this.now().toISOString(),
      metrics: operationalMetricsFromRows(rows, this.options.replicaId)
        .filter(metric => !query.name || metric.name === query.name),
    };
  }

  async *streamOperationalLogs(query: OperationalLogQuery): AsyncIterable<OperationalLogDto> {
    const page = await this.queryOperationalLogs(query);
    for (const item of page.items) yield item;
  }

  async *streamOperationalMetrics(query: OperationalMetricQuery): AsyncIterable<OperationalMetricDto> {
    const response = await this.queryOperationalMetrics(query);
    for (const item of response.metrics) yield item;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export class InMemoryConsoleTelemetryQuery implements IConsoleTelemetryQuery {
  private readonly logs: readonly OperationalLogDto[];
  private readonly metrics: OperationalMetricResponseDto;

  constructor(options: {
    readonly logs?: readonly OperationalLogDto[];
    readonly metrics?: OperationalMetricResponseDto;
    readonly now?: () => Date;
  } = {}) {
    this.logs = options.logs ?? [];
    this.metrics = options.metrics ?? {
      checked_at: (options.now ?? (() => new Date()))().toISOString(),
      metrics: [],
    };
  }

  queryOperationalLogs(query: OperationalLogQuery): Promise<OperationalLogPageDto> {
    const filtered = this.logs.filter(log => matchesLog(log, query));
    const start = query.cursor ? decodeCursor(query.cursor) : 0;
    const items = filtered.slice(start, start + query.limit);
    const next = start + items.length < filtered.length ? encodeCursor(start + items.length) : null;
    return Promise.resolve({
      items,
      page: {
        limit: query.limit,
        cursor: query.cursor,
        next_cursor: next,
      },
    });
  }

  queryOperationalMetrics(query: OperationalMetricQuery): Promise<OperationalMetricResponseDto> {
    return Promise.resolve({
      checked_at: this.metrics.checked_at,
      metrics: this.metrics.metrics.filter(metric =>
        (!query.name || metric.name === query.name) &&
        (!query.subsystem || metric.dimensions.subsystem === query.subsystem),
      ),
    });
  }

  async *streamOperationalLogs(query: OperationalLogQuery): AsyncIterable<OperationalLogDto> {
    const page = await this.queryOperationalLogs(query);
    for (const item of page.items) yield item;
  }

  async *streamOperationalMetrics(query: OperationalMetricQuery): AsyncIterable<OperationalMetricDto> {
    const response = await this.queryOperationalMetrics(query);
    for (const item of response.metrics) yield item;
  }

}

function matchesLog(log: OperationalLogDto, query: OperationalLogQuery): boolean {
  return (!query.level || log.level === query.level) &&
    (!query.subsystem || log.subsystem === query.subsystem) &&
    (!query.event || log.event === query.event);
}

function toOperationalLogDto(row: OperationalLogRow): OperationalLogDto {
  return {
    ts: toIso(row.ts),
    level: operationalLogLevel(row.level),
    subsystem: row.subsystem,
    event: row.event,
    correlation_id: row.correlation_id,
    account_correlation_id: row.account_correlation_id,
    session_id: row.session_id,
    replica: row.replica,
    duration_ms: nullableNumber(row.duration_ms),
    status_code: nullableNumber(row.status_code),
    error_code: row.error_code,
  };
}

function operationalMetricsFromRows(
  rows: readonly OperationalMetricRow[],
  replicaId: string,
): readonly OperationalMetricDto[] {
  return rows.flatMap(row => {
    const base: OperationalMetricDto = {
      name: 'session.activity.events',
      kind: 'counter',
      value: Number(row.value),
      unit: 'count',
      dimensions: {
        subsystem: row.subsystem,
        event: row.event,
        replica: replicaId,
      },
    };
    if (!row.error_code) return [base];
    return [base, {
      name: 'session.activity.errors',
      kind: 'counter',
      value: Number(row.value),
      unit: 'count',
      dimensions: {
        subsystem: row.subsystem,
        event: row.event,
        error_code: row.error_code,
        replica: replicaId,
      },
    }];
  });
}

function operationalLogLevel(value: string): OperationalLogDto['level'] {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : 'info';
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  const parsed = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
