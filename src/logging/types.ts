/**
 * Core types for the Unified Logging System.
 *
 * These types are shared across the LogManager, all sinks, and all formatters.
 * See docs/LOGGING-DESIGN.md for the full RFC.
 */

// ---------------------------------------------------------------------------
// Log entry
// ---------------------------------------------------------------------------

export type LogCategory = 'application' | 'security' | 'performance' | 'telemetry';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Numeric priority for each log level (higher = more severe).
 * Used by LogManager for minimum-level filtering.
 */
export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Universal log entry format used across all sinks.
 *
 * - `id` format: `"LOG-{timestamp}-{counter}"`
 * - `timestamp`: ISO 8601, always UTC
 * - `error`: structured — never a raw Error object
 */
export interface UnifiedLogEntry {
  id: string;
  timestamp: string;
  category: LogCategory;
  level: LogLevel;
  source: string;
  message: string;
  data?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  correlationId?: string;
  /** Session user identity, auto-populated from SessionContext when available. */
  userId?: string;
  /** Session identifier, auto-populated from SessionContext when available. */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Sink & formatter interfaces
// ---------------------------------------------------------------------------

/** Output target for log entries. */
export interface ILogSink {
  /** Synchronous write — sinks buffer internally if needed. */
  write(entry: UnifiedLogEntry): void;
  /** Flush any buffered data to the underlying store. */
  flush(): Promise<void>;
  /** Flush and release resources. */
  close(): Promise<void>;
}

/** Pluggable disk format (plain text, JSONL, etc.). */
export interface ILogFormatter {
  format(entry: UnifiedLogEntry): string;
  /** File extension including the dot, e.g. `'.log'` or `'.jsonl'`. */
  fileExtension: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Query types (used by MemoryLogSink and Phase 5 MCP query_logs tool)
// ---------------------------------------------------------------------------

export interface LogQueryOptions {
  category?: LogCategory | 'all';
  level?: LogLevel;
  source?: string;
  message?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  correlationId?: string;
  userId?: string;
  sessionId?: string;
}

export interface LogQueryResult {
  entries: UnifiedLogEntry[];
  total: number;
  hasMore: boolean;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Typed config for LogManager, mapped from `DOLLHOUSE_LOG_*` env vars. */
export interface LogManagerConfig {
  logDir: string;
  logFormat: 'text' | 'jsonl';
  retentionDays: number;
  securityRetentionDays: number;
  flushIntervalMs: number;
  bufferSize: number;
  memoryCapacity: number;
  memoryAppCapacity: number;
  memorySecurityCapacity: number;
  memoryPerfCapacity: number;
  memoryTelemetryCapacity: number;
  maxEntrySize: number;
  immediateFlushRate: number;
  fileMaxSize: number;
  maxDirSizeBytes: number;       // 0 = disabled
  maxFilesPerCategory: number;   // 0 = disabled
  logLevel: LogLevel;
}
