/**
 * In-memory ring buffer sink for metric snapshots.
 *
 * Stores snapshots in an EvictingQueue and provides a query interface
 * for the MCP query_metrics tool. Follows the same query pattern as
 * MemoryLogSink (see src/logging/sinks/MemoryLogSink.ts).
 */

import { EvictingQueue } from '../../utils/EvictingQueue.js';
import type {
  IMetricsSink,
  MetricEntry,
  MetricQueryOptions,
  MetricQueryResult,
  MetricSnapshot,
} from '../types.js';

export class MemoryMetricsSink implements IMetricsSink {
  readonly name = 'MemoryMetricsSink';
  private readonly queue: EvictingQueue<MetricSnapshot>;

  constructor(maxSnapshots: number = 240) {
    this.queue = new EvictingQueue<MetricSnapshot>(maxSnapshots);
  }

  onSnapshot(snapshot: MetricSnapshot): void {
    this.queue.push(snapshot);
  }

  async flush(): Promise<void> {
    // No-op — in-memory, nothing to flush.
  }

  async close(): Promise<void> {
    this.queue.clear();
  }

  query(options?: MetricQueryOptions): MetricQueryResult {
    const latest = options?.latest ?? true;
    const limit = Math.min(Math.max(options?.limit ?? 1, 0), 100);
    const offset = Math.max(options?.offset ?? 0, 0);

    const allSnapshots = this.queue.toArray();

    // Compute availability bounds BEFORE filtering
    const oldestAvailable = allSnapshots.length > 0 ? allSnapshots[0].timestamp : '';
    const newestAvailable = allSnapshots.length > 0 ? allSnapshots.at(-1)!.timestamp : '';

    // If limit is 0, return empty result with bounds
    if (limit === 0) {
      return {
        snapshots: [],
        total: 0,
        hasMore: false,
        limit,
        offset,
        oldestAvailable,
        newestAvailable,
      };
    }

    // 1. Select snapshots based on latest flag
    let snapshots: MetricSnapshot[];
    if (latest) {
      snapshots = allSnapshots.length > 0 ? [allSnapshots.at(-1)!] : [];
    } else {
      snapshots = [...allSnapshots];
    }

    // 2. Filter by time range
    if (options?.since) {
      const since = options.since;
      snapshots = snapshots.filter(s => s.timestamp > since);
    }
    if (options?.until) {
      const until = options.until;
      snapshots = snapshots.filter(s => s.timestamp < until);
    }

    // 3. Filter metrics within each snapshot by name/source/type
    if (options?.names || options?.source || options?.type) {
      const filtered: MetricSnapshot[] = [];
      for (const snapshot of snapshots) {
        const matchedMetrics = snapshot.metrics.filter(metric =>
          matchesMetricFilters(metric, options),
        );
        if (matchedMetrics.length > 0) {
          filtered.push({ ...snapshot, metrics: matchedMetrics });
        }
      }
      snapshots = filtered;
    }

    // 4. Sort newest-first (descending timestamp)
    snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // 5. Count total before pagination
    const total = snapshots.length;

    // 6. Paginate
    snapshots = snapshots.slice(offset, offset + limit);

    return {
      snapshots,
      total,
      hasMore: offset + limit < total,
      limit,
      offset,
      oldestAvailable,
      newestAvailable,
    };
  }

  getStats(): { size: number; capacity: number } {
    return { size: this.queue.size, capacity: this.queue.capacity };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function matchesMetricFilters(
  metric: MetricEntry,
  options: MetricQueryOptions,
): boolean {
  // Name filter: prefix match if ends with '.' or '.*', else exact match
  if (options.names && options.names.length > 0) {
    const matched = options.names.some(name => {
      if (name.endsWith('.') || name.endsWith('.*')) {
        const prefix = name.endsWith('.*') ? name.slice(0, -1) : name;
        return metric.name.startsWith(prefix);
      }
      return metric.name === name;
    });
    if (!matched) return false;
  }

  // Source filter: case-insensitive substring match
  if (options.source) {
    const needle = options.source.toLowerCase();
    if (!metric.source.toLowerCase().includes(needle)) return false;
  }

  // Type filter: exact match
  if (options.type) {
    if (metric.type !== options.type) return false;
  }

  return true;
}
