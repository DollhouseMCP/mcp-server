/**
 * Lightweight in-memory accumulator for MCP-AQL operation metrics.
 *
 * Records operation counts, durations, and error rates. The companion
 * OperationMetricsCollector reads from this tracker each collection cycle.
 */

const DURATION_RING_SIZE = 1000;

export interface OperationMetrics {
  totalOps: number;
  failedOps: number;
  durations: number[];
  byEndpoint: Map<string, number>;
  byOperation: Map<string, number>;
}

export class OperationMetricsTracker {
  private totalOps = 0;
  private failedOps = 0;
  private readonly durations: number[] = [];
  private readonly byEndpoint = new Map<string, number>();
  private readonly byOperation = new Map<string, number>();

  record(operation: string, endpoint: string, durationMs: number, success: boolean): void {
    this.totalOps++;
    if (!success) this.failedOps++;

    // Ring buffer for durations
    this.durations.push(durationMs);
    if (this.durations.length > DURATION_RING_SIZE) {
      this.durations.shift();
    }

    this.byEndpoint.set(endpoint, (this.byEndpoint.get(endpoint) ?? 0) + 1);
    this.byOperation.set(operation, (this.byOperation.get(operation) ?? 0) + 1);
  }

  getMetrics(): OperationMetrics {
    return {
      totalOps: this.totalOps,
      failedOps: this.failedOps,
      durations: [...this.durations],
      byEndpoint: new Map(this.byEndpoint),
      byOperation: new Map(this.byOperation),
    };
  }

  /** Compute duration percentiles from the ring buffer. */
  static percentiles(durations: number[]): {
    count: number;
    sum: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  } {
    if (durations.length === 0) {
      return { count: 0, sum: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    const pct = (p: number) => sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
    return {
      count: sorted.length,
      sum,
      avg: sum / sorted.length,
      p50: pct(0.5),
      p95: pct(0.95),
      p99: pct(0.99),
    };
  }
}
