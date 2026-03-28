/**
 * Forwarding sinks for follower MCP servers.
 *
 * When a server becomes a follower in the unified console election, it
 * registers these sinks with its LogManager and MetricsManager. Instead
 * of broadcasting to local SSE clients, entries are batch-POSTed to
 * the leader's ingestion endpoints.
 *
 * Features:
 * - Batch buffering (50 entries or 1s flush, whichever comes first)
 * - In-memory buffer up to 10,000 entries on leader failure
 * - Exponential backoff on POST failure (1s → 2s → 4s, max 30s)
 * - Automatic drain on leader recovery
 *
 * @since v2.1.0 — Issue #1700
 */

import type { ILogSink, UnifiedLogEntry } from '../../logging/types.js';
import type { MetricSnapshot } from '../../metrics/types.js';
import { logger } from '../../utils/logger.js';

/** Maximum entries to buffer when leader is unreachable */
const MAX_BUFFER_SIZE = 10_000;

/** Batch size before flushing */
const BATCH_SIZE = 50;

/** Time-based flush interval (ms) */
const FLUSH_INTERVAL_MS = 1_000;

/** Initial backoff delay on failure (ms) */
const INITIAL_BACKOFF_MS = 1_000;

/** Maximum backoff delay (ms) */
const MAX_BACKOFF_MS = 30_000;

/** HTTP request timeout (ms) */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * ILogSink that batch-POSTs entries to the leader's /api/ingest/logs.
 */
export class LeaderForwardingLogSink implements ILogSink {
  private readonly buffer: UnifiedLogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private flushing = false;

  constructor(
    private readonly leaderUrl: string,
    private readonly sessionId: string,
  ) {
    try { this.sessionId = sessionId.normalize('NFC'); } catch { /* use raw */ }
    this.flushTimer = setInterval(() => this.flushBuffer(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  write(entry: UnifiedLogEntry): void {
    // Stamp session ID before buffering
    const stamped: UnifiedLogEntry = {
      ...entry,
      data: { ...entry.data, _sessionId: this.sessionId },
    };

    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      // Evict oldest entry (FIFO)
      this.buffer.shift();
    }
    this.buffer.push(stamped);

    if (this.buffer.length >= BATCH_SIZE) {
      this.flushBuffer();
    }
  }

  async flush(): Promise<void> {
    await this.flushBuffer();
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushBuffer();
  }

  private async flushBuffer(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;

    const batch = this.buffer.splice(0, BATCH_SIZE);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(`${this.leaderUrl}/api/ingest/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId, entries: batch }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        this.backoffMs = INITIAL_BACKOFF_MS;
      } else {
        this.requeueBatch(batch);
        this.scheduleRetry();
      }
    } catch {
      this.requeueBatch(batch);
      this.scheduleRetry();
    } finally {
      this.flushing = false;
    }
  }

  private requeueBatch(batch: UnifiedLogEntry[]): void {
    const spaceAvailable = MAX_BUFFER_SIZE - this.buffer.length;
    if (spaceAvailable > 0) {
      const toRequeue = batch.slice(0, spaceAvailable);
      this.buffer.unshift(...toRequeue);
    } else {
      logger.warn(`[ForwardingSink] Buffer full (${MAX_BUFFER_SIZE}), dropping ${batch.length} entries`);
    }
  }

  private scheduleRetry(): void {
    logger.debug(`[ForwardingSink] Leader unreachable, backoff ${this.backoffMs}ms (buffered: ${this.buffer.length})`);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }
}

/**
 * Forwards metric snapshots to the leader's /api/ingest/metrics.
 */
export class LeaderForwardingMetricsSink {
  constructor(
    private readonly leaderUrl: string,
    private readonly sessionId: string,
  ) {}

  async onSnapshot(snapshot: MetricSnapshot): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      await fetch(`${this.leaderUrl}/api/ingest/metrics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId, snapshot }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch {
      logger.debug('[ForwardingSink] Failed to forward metrics snapshot');
    }
  }
}

/**
 * Sends session lifecycle events to the leader.
 */
export class SessionHeartbeat {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly leaderUrl: string,
    private readonly sessionId: string,
    private readonly pid: number,
  ) {}

  /** Notify the leader that this session has started */
  async start(): Promise<void> {
    await this.sendEvent('started');

    this.heartbeatTimer = setInterval(() => {
      this.sendEvent('heartbeat').catch(() => {});
    }, 10_000);
    this.heartbeatTimer.unref();
  }

  /** Notify the leader that this session is stopping */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.sendEvent('stopped');
  }

  private async sendEvent(event: 'started' | 'stopped' | 'heartbeat'): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      await fetch(`${this.leaderUrl}/api/ingest/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.sessionId,
          event,
          pid: this.pid,
          startedAt: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch {
      logger.debug(`[SessionHeartbeat] Failed to send ${event} event`);
    }
  }
}
