import { EvictingQueue } from '../../utils/EvictingQueue.js';
import type {
  ILogSink,
  LogCategory,
  LogQueryOptions,
  LogQueryResult,
  UnifiedLogEntry,
} from '../types.js';
import { LOG_LEVEL_PRIORITY } from '../types.js';

export interface MemoryLogSinkOptions {
  appCapacity: number;
  securityCapacity: number;
  perfCapacity: number;
  telemetryCapacity: number;
}

const CATEGORY_KEY: Record<LogCategory, keyof MemoryLogSinkOptions> = {
  application: 'appCapacity',
  security: 'securityCapacity',
  performance: 'perfCapacity',
  telemetry: 'telemetryCapacity',
};

export class MemoryLogSink implements ILogSink {
  private readonly queues: Map<LogCategory, EvictingQueue<UnifiedLogEntry>>;

  constructor(options: MemoryLogSinkOptions) {
    this.queues = new Map<LogCategory, EvictingQueue<UnifiedLogEntry>>();
    for (const [category, key] of Object.entries(CATEGORY_KEY)) {
      this.queues.set(
        category as LogCategory,
        new EvictingQueue<UnifiedLogEntry>(options[key]),
      );
    }
  }

  write(entry: UnifiedLogEntry): void {
    const queue = this.queues.get(entry.category);
    if (queue) {
      queue.push(entry);
    }
  }

  async flush(): Promise<void> {
    // No-op — in-memory, nothing to flush.
  }

  async close(): Promise<void> {
    for (const queue of this.queues.values()) {
      queue.clear();
    }
  }

  query(options?: LogQueryOptions): LogQueryResult {
    const category = options?.category ?? 'all';
    const limit = Math.max(1, Math.min(options?.limit ?? 50, 500));
    const offset = Math.max(0, options?.offset ?? 0);

    // 1. Select queues
    const selectedQueues: EvictingQueue<UnifiedLogEntry>[] = [];
    if (category === 'all') {
      for (const q of this.queues.values()) {
        selectedQueues.push(q);
      }
    } else {
      const q = this.queues.get(category);
      if (q) selectedQueues.push(q);
    }

    // 2. Collect entries from selected queues
    let entries: UnifiedLogEntry[] = [];
    for (const q of selectedQueues) {
      entries.push(...q.toArray());
    }

    // 3. Apply filters conjunctively
    if (options?.level) {
      const minPriority = LOG_LEVEL_PRIORITY[options.level];
      entries = entries.filter(e => LOG_LEVEL_PRIORITY[e.level] >= minPriority);
    }
    if (options?.source) {
      const needle = options.source.toLowerCase();
      entries = entries.filter(e => e.source.toLowerCase().includes(needle));
    }
    if (options?.message) {
      const needle = options.message.toLowerCase();
      entries = entries.filter(e => e.message.toLowerCase().includes(needle));
    }
    if (options?.since) {
      const since = options.since;
      entries = entries.filter(e => e.timestamp > since);
    }
    if (options?.until) {
      const until = options.until;
      entries = entries.filter(e => e.timestamp < until);
    }
    if (options?.correlationId) {
      const corrId = options.correlationId;
      entries = entries.filter(e => e.correlationId === corrId);
    }

    // 4. Count total before pagination
    const total = entries.length;

    // 5. Sort newest-first (descending timestamp)
    entries.sort((a, b) => (a.timestamp > b.timestamp ? -1 : a.timestamp < b.timestamp ? 1 : 0));

    // 6. Paginate
    entries = entries.slice(offset, offset + limit);

    return {
      entries,
      total,
      hasMore: offset + limit < total,
      limit,
      offset,
    };
  }

  getStats(): Record<LogCategory, { size: number; capacity: number }> {
    const stats = {} as Record<LogCategory, { size: number; capacity: number }>;
    for (const [category, queue] of this.queues) {
      stats[category] = { size: queue.size, capacity: queue.capacity };
    }
    return stats;
  }
}
