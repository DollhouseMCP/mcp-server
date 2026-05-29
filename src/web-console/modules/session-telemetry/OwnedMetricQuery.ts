import type { UserMetricDto, UserMetricResponseDto } from './SessionTelemetryDtos.js';

export interface MetricQuery {
  readonly subsystem: string | null;
  readonly name: string | null;
}

export interface IOwnedMetricQuery {
  queryOwnedMetrics(userId: string, sessionId: string, query: MetricQuery): Promise<UserMetricResponseDto>;
  streamOwnedMetrics(userId: string, sessionId: string, query: MetricQuery): AsyncIterable<UserMetricDto>;
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
