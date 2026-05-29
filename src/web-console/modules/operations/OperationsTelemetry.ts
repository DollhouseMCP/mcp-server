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

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  const parsed = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
