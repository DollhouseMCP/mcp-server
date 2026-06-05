import { sql } from 'drizzle-orm';

import { withSystemContext } from '../../../database/admin.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import type { UserMetricDto, UserMetricResponseDto } from './SessionTelemetryDtos.js';

export interface MetricQuery {
  readonly subsystem: string | null;
  readonly name: string | null;
}

export interface IOwnedMetricQuery {
  queryOwnedMetrics(userId: string, sessionId: string, query: MetricQuery): Promise<UserMetricResponseDto>;
  streamOwnedMetrics(userId: string, sessionId: string, query: MetricQuery): AsyncIterable<UserMetricDto>;
}

interface OwnedMetricRow {
  readonly subsystem: string;
  readonly event: string;
  readonly error_code: string | null;
  readonly value: number | string;
}

export class PostgresOwnedMetricQuery implements IOwnedMetricQuery {
  constructor(
    private readonly db: DatabaseInstance,
    private readonly options: { readonly now?: () => Date } = {},
  ) {}

  async queryOwnedMetrics(userId: string, sessionId: string, query: MetricQuery): Promise<UserMetricResponseDto> {
    const rows = await withSystemContext(this.db, tx => tx.execute(sql`
      SELECT
        e.subsystem,
        e.event,
        e.stable_error_code AS error_code,
        COUNT(*)::integer AS value
      FROM session_activity_events e
      WHERE e.user_id = ${userId}
        AND e.session_id = ${sessionId}
        AND (${query.subsystem}::text IS NULL OR e.subsystem = ${query.subsystem})
      GROUP BY e.subsystem, e.event, e.stable_error_code
      ORDER BY e.subsystem ASC, e.event ASC, e.stable_error_code ASC NULLS FIRST
    `)) as unknown as OwnedMetricRow[];
    return {
      checked_at: this.now().toISOString(),
      metrics: ownedMetricsFromRows(rows).filter(metric => !query.name || metric.name === query.name),
    };
  }

  async *streamOwnedMetrics(
    userId: string,
    sessionId: string,
    query: MetricQuery,
  ): AsyncIterable<UserMetricDto> {
    const response = await this.queryOwnedMetrics(userId, sessionId, query);
    for (const item of response.metrics) yield item;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export class InMemoryOwnedMetricQuery implements IOwnedMetricQuery {
  private readonly metrics = new Map<string, UserMetricResponseDto>();
  private readonly now: () => Date;

  constructor(options: {
    readonly metrics?: Readonly<Record<string, UserMetricResponseDto>>;
    readonly now?: () => Date;
  } = {}) {
    this.now = options.now ?? (() => new Date());
    for (const [key, value] of Object.entries(options.metrics ?? {})) {
      this.metrics.set(key, cloneMetricResponse(value));
    }
  }

  seedOwnedMetrics(userId: string, sessionId: string, metrics: UserMetricResponseDto): void {
    this.metrics.set(this.ownedMetricKey(userId, sessionId), cloneMetricResponse(metrics));
  }

  queryOwnedMetrics(userId: string, sessionId: string, query: MetricQuery): Promise<UserMetricResponseDto> {
    const response = this.metrics.get(this.ownedMetricKey(userId, sessionId)) ?? {
      checked_at: this.now().toISOString(),
      metrics: [],
    };
    return Promise.resolve({
      checked_at: response.checked_at,
      metrics: response.metrics.filter(metric => matchesMetric(metric, query)).map(cloneMetric),
    });
  }

  async *streamOwnedMetrics(
    userId: string,
    sessionId: string,
    query: MetricQuery,
  ): AsyncIterable<UserMetricDto> {
    const response = await this.queryOwnedMetrics(userId, sessionId, query);
    for (const item of response.metrics) yield item;
  }

  private ownedMetricKey(userId: string, sessionId: string): string {
    return `${userId}\u0000${sessionId}`;
  }
}

function matchesMetric(metric: UserMetricDto, query: MetricQuery): boolean {
  return (!query.name || metric.name === query.name) &&
    (!query.subsystem || metric.dimensions.subsystem === query.subsystem);
}

function ownedMetricsFromRows(rows: readonly OwnedMetricRow[]): readonly UserMetricDto[] {
  return rows.flatMap(row => {
    const base: UserMetricDto = {
      name: 'session.activity.events',
      kind: 'counter',
      value: Number(row.value),
      unit: 'count',
      dimensions: {
        subsystem: row.subsystem,
        event: row.event,
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
      },
    }];
  });
}

function cloneMetricResponse(response: UserMetricResponseDto): UserMetricResponseDto {
  return {
    checked_at: response.checked_at,
    metrics: response.metrics.map(cloneMetric),
  };
}

function cloneMetric(metric: UserMetricDto): UserMetricDto {
  return {
    ...metric,
    dimensions: { ...metric.dimensions },
  };
}
