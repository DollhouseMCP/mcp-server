/**
 * Central coordinator for the Unified Logging System.
 *
 * Accepts UnifiedLogEntry objects from all sources, enforces level filtering
 * and entry size limits, routes entries to registered sinks, and manages
 * flush lifecycle (timer + buffer threshold + immediate flush for security).
 *
 * See docs/LOGGING-DESIGN.md §4.2 for the full design.
 */

import { EvictingQueue } from '../utils/EvictingQueue.js';
import {
  type UnifiedLogEntry,
  type ILogSink,
  type LogLevel,
  type LogManagerConfig,
  LOG_LEVEL_PRIORITY,
} from './types.js';

export class LogManager {
  private readonly sinks: ILogSink[] = [];
  private readonly buffer: EvictingQueue<UnifiedLogEntry>;
  private readonly config: LogManagerConfig;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private entryCounter = 0;
  private dropCount = 0;
  private previousBufferSize = 0;

  // Sliding-window rate limiter for immediate flushes (per-second window)
  private immediateFlushWindowStart = 0;
  private immediateFlushCount = 0;

  constructor(config: LogManagerConfig) {
    this.config = config;
    this.buffer = new EvictingQueue<UnifiedLogEntry>(config.bufferSize);
    this.startFlushTimer();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Route a log entry to all registered sinks.
   *
   * - Skips entries below the minimum log level.
   * - Enforces max entry size (truncates `data`, sets `_truncated`).
   * - Security warn/error entries trigger an immediate (rate-limited) flush.
   * - Other entries are buffered; a flush is triggered when the buffer is full.
   */
  log(entry: UnifiedLogEntry): void {
    // Level gate
    if (LOG_LEVEL_PRIORITY[entry.level] < LOG_LEVEL_PRIORITY[this.config.logLevel]) {
      return;
    }

    // Enforce entry size limit
    const enforced = this.enforceEntrySize(entry);

    // Route to every registered sink
    for (const sink of this.sinks) {
      sink.write(enforced);
    }

    // Determine flush strategy
    const needsImmediateFlush =
      enforced.category === 'security' &&
      (enforced.level === 'warn' || enforced.level === 'error');

    if (needsImmediateFlush && this.canImmediateFlush()) {
      // Fire-and-forget — logging must never block the caller
      void this.flush();
    } else {
      // Track buffer occupancy for backpressure reporting
      const wasFull = this.buffer.size === this.buffer.capacity;
      this.buffer.push(enforced);

      // Detect eviction (buffer was at capacity before push)
      if (wasFull) {
        this.dropCount++;
      }

      // Buffer-full flush — only on the transition to full, not while already full.
      // The periodic flush timer handles steady-state draining.
      if (!wasFull && this.buffer.size >= this.config.bufferSize) {
        void this.flush();
      }
    }
  }

  /** Register an output sink. */
  registerSink(sink: ILogSink): void {
    this.sinks.push(sink);
  }

  /** Flush all registered sinks and report drops if any occurred. */
  async flush(): Promise<void> {
    // Accumulate drops and only report when meaningful.
    // Single-entry evictions are normal ring-buffer cycling under load;
    // only warn when drops exceed 10% of buffer capacity per flush interval.
    const dropThreshold = Math.max(5, Math.ceil(this.config.bufferSize * 0.1));
    if (this.dropCount >= dropThreshold) {
      const dropEntry = this.createMetaEntry(
        'warn',
        `Backpressure: ${this.dropCount} buffered entries evicted since last flush`,
        { droppedCount: this.dropCount },
      );
      for (const sink of this.sinks) {
        sink.write(dropEntry);
      }
      this.dropCount = 0;
    }

    const flushPromises = this.sinks.map((sink) => sink.flush());
    await Promise.allSettled(flushPromises);
  }

  /** Graceful shutdown: clear timer, flush, then close all sinks. */
  async close(): Promise<void> {
    this.stopFlushTimer();
    await this.flush();
    const closePromises = this.sinks.map((sink) => sink.close());
    await Promise.allSettled(closePromises);
  }

  /**
   * Generate a unique log entry ID.
   * Format: `LOG-{timestamp}-{counter}`
   */
  generateId(): string {
    return `LOG-${Date.now()}-${this.entryCounter++}`;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private startFlushTimer(): void {
    if (this.config.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, this.config.flushIntervalMs);

      // Allow the process to exit even if the timer is still running
      if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
        this.flushTimer.unref();
      }
    }
  }

  private stopFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Sliding-window rate limiter for immediate flushes.
   * Returns `true` if an immediate flush is allowed right now.
   */
  private canImmediateFlush(): boolean {
    const now = Date.now();
    const windowMs = 1000;

    if (now - this.immediateFlushWindowStart >= windowMs) {
      // New window
      this.immediateFlushWindowStart = now;
      this.immediateFlushCount = 1;
      return true;
    }

    if (this.immediateFlushCount < this.config.immediateFlushRate) {
      this.immediateFlushCount++;
      return true;
    }

    // Rate exceeded — demote to buffered path (caller will buffer instead)
    return false;
  }

  /**
   * Enforce `maxEntrySize` by truncating the `data` field if necessary.
   * Returns the original entry unmodified when under the limit, or a
   * shallow copy with `data` replaced when truncation is needed.
   */
  private enforceEntrySize(entry: UnifiedLogEntry): UnifiedLogEntry {
    if (!entry.data) return entry;

    const serialized = JSON.stringify(entry);
    if (serialized.length <= this.config.maxEntrySize) return entry;

    const originalSize = serialized.length;

    // Emit a warn meta-entry about the truncation
    const truncationNotice = this.createMetaEntry(
      'warn',
      `Entry truncated: original size ${originalSize} bytes exceeds limit ${this.config.maxEntrySize}`,
      { originalSize, maxSize: this.config.maxEntrySize, entryId: entry.id },
    );
    for (const sink of this.sinks) {
      sink.write(truncationNotice);
    }

    // Return a copy with data replaced by a truncation marker
    return {
      ...entry,
      data: { _truncated: true, _originalSize: originalSize },
    };
  }

  /** Create a meta/system log entry from the LogManager itself. */
  private createMetaEntry(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
  ): UnifiedLogEntry {
    return {
      id: this.generateId(),
      timestamp: new Date().toISOString(),
      category: 'application',
      level,
      source: 'LogManager',
      message,
      data,
    };
  }
}

// ---------------------------------------------------------------------------
// Helper: build LogManagerConfig from validated env vars
// ---------------------------------------------------------------------------

/**
 * Map the flat env object (from Zod-parsed `process.env`) to a typed
 * `LogManagerConfig`. Keeps the mapping in one place so the DI container
 * only needs `buildLogManagerConfig(env)`.
 */
export function buildLogManagerConfig(envVars: {
  DOLLHOUSE_LOG_DIR: string;
  DOLLHOUSE_LOG_FORMAT: 'text' | 'jsonl';
  DOLLHOUSE_LOG_RETENTION_DAYS: number;
  DOLLHOUSE_LOG_SECURITY_RETENTION_DAYS: number;
  DOLLHOUSE_LOG_FLUSH_INTERVAL_MS: number;
  DOLLHOUSE_LOG_BUFFER_SIZE: number;
  DOLLHOUSE_LOG_MEMORY_CAPACITY: number;
  DOLLHOUSE_LOG_MEMORY_APP_CAPACITY: number;
  DOLLHOUSE_LOG_MEMORY_SECURITY_CAPACITY: number;
  DOLLHOUSE_LOG_MEMORY_PERF_CAPACITY: number;
  DOLLHOUSE_LOG_MEMORY_TELEMETRY_CAPACITY: number;
  DOLLHOUSE_LOG_MAX_ENTRY_SIZE: number;
  DOLLHOUSE_LOG_IMMEDIATE_FLUSH_RATE: number;
  DOLLHOUSE_LOG_FILE_MAX_SIZE: number;
  DOLLHOUSE_LOG_MAX_DIR_SIZE_BYTES: number;
  DOLLHOUSE_LOG_MAX_FILES_PER_CATEGORY: number;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
}): LogManagerConfig {
  return {
    logDir: envVars.DOLLHOUSE_LOG_DIR,
    logFormat: envVars.DOLLHOUSE_LOG_FORMAT,
    retentionDays: envVars.DOLLHOUSE_LOG_RETENTION_DAYS,
    securityRetentionDays: envVars.DOLLHOUSE_LOG_SECURITY_RETENTION_DAYS,
    flushIntervalMs: envVars.DOLLHOUSE_LOG_FLUSH_INTERVAL_MS,
    bufferSize: envVars.DOLLHOUSE_LOG_BUFFER_SIZE,
    memoryCapacity: envVars.DOLLHOUSE_LOG_MEMORY_CAPACITY,
    memoryAppCapacity: envVars.DOLLHOUSE_LOG_MEMORY_APP_CAPACITY,
    memorySecurityCapacity: envVars.DOLLHOUSE_LOG_MEMORY_SECURITY_CAPACITY,
    memoryPerfCapacity: envVars.DOLLHOUSE_LOG_MEMORY_PERF_CAPACITY,
    memoryTelemetryCapacity: envVars.DOLLHOUSE_LOG_MEMORY_TELEMETRY_CAPACITY,
    maxEntrySize: envVars.DOLLHOUSE_LOG_MAX_ENTRY_SIZE,
    immediateFlushRate: envVars.DOLLHOUSE_LOG_IMMEDIATE_FLUSH_RATE,
    fileMaxSize: envVars.DOLLHOUSE_LOG_FILE_MAX_SIZE,
    maxDirSizeBytes: envVars.DOLLHOUSE_LOG_MAX_DIR_SIZE_BYTES,
    maxFilesPerCategory: envVars.DOLLHOUSE_LOG_MAX_FILES_PER_CATEGORY,
    logLevel: envVars.LOG_LEVEL,
  };
}
