import type { LogLevel, LogQueryOptions, LogQueryResult } from '../../../logging/types.js';
import type { ConsoleLogPage, ConsoleLogQueryOptions, IConsoleLogSource } from './MeLogsModule.js';

/** The in-memory log backend the console reads through the IConsoleLogSource port. */
interface QueryableLogSink {
  query(options?: LogQueryOptions): LogQueryResult;
}

/**
 * Adapt the in-memory MemoryLogSink to the console's backend-agnostic log port.
 * This is the ONLY place that knows the sink's shape; swapping the log backend
 * means swapping this adapter, not the module.
 */
export function createMemoryConsoleLogSource(sink: QueryableLogSink): IConsoleLogSource {
  return {
    queryUserLogs(options: ConsoleLogQueryOptions): ConsoleLogPage {
      const result = sink.query({
        userId: options.userId,
        level: (options.level ?? undefined) as LogLevel | undefined,
        source: options.source ?? undefined,
        message: options.message ?? undefined,
        correlationId: options.correlationId ?? undefined,
        sessionId: options.sessionId ?? undefined,
        since: options.since ?? undefined,
        limit: options.limit,
      });
      return {
        entries: result.entries.map(entry => ({
          id: entry.id,
          ts: entry.timestamp,
          level: entry.level,
          category: entry.category,
          source: entry.source,
          message: entry.message,
          correlation_id: entry.correlationId ?? null,
          session_id: entry.sessionId ?? null,
        })),
        total: result.total,
        has_more: result.hasMore,
      };
    },
  };
}
