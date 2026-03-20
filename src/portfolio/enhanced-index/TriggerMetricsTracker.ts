import { LRUCache } from '../../cache/LRUCache.js';
import { logger } from '../../utils/logger.js';
import type { EnhancedIndex } from '../types/IndexTypes.js';

export interface TriggerMetricsTrackerOptions {
  batchSize: number;
  flushIntervalMs: number;
  cacheLimits: {
    maxSize: number;
    maxMemoryMB: number;
  };
  getIndex: () => Promise<EnhancedIndex>;
  persistIndex: (index: EnhancedIndex) => Promise<void>;
}

export class TriggerMetricsTracker {
  private metricsBatch: LRUCache<number>;
  private flushTimer: NodeJS.Timeout | null = null;
  private logListener?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;

  addLogListener(fn: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void): void {
    this.logListener = fn;
  }

  constructor(private readonly options: TriggerMetricsTrackerOptions) {
    this.metricsBatch = new LRUCache<number>({
      name: 'trigger-metrics',
      maxSize: options.cacheLimits.maxSize,
      maxMemoryMB: options.cacheLimits.maxMemoryMB
    });
  }

  public async track(trigger: string, immediate: boolean = false): Promise<void> {
    this.metricsBatch.set(trigger, (this.metricsBatch.get(trigger) || 0) + 1);

    if (immediate || this.pendingCount >= this.options.batchSize) {
      await this.flush();
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush().catch(error => {
          logger.warn('Failed to flush metrics batch', { error });
        });
      }, this.options.flushIntervalMs);

      if (typeof this.flushTimer.unref === 'function') {
        this.flushTimer.unref();
      }
    }
  }

  public async flush(): Promise<void> {
    if (this.pendingCount === 0) {
      return;
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const entries = Array.from(this.metricsBatch.entries());
    const index = await this.options.getIndex();

    if (!index.metadata.trigger_metrics) {
      index.metadata.trigger_metrics = {
        usage_count: {},
        last_used: {},
        first_used: {},
        daily_usage: {}
      };
    }

    const metrics = index.metadata.trigger_metrics;
    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toISOString();

    if (!metrics.daily_usage[today]) {
      metrics.daily_usage[today] = {};
    }

    for (const [trigger, count] of entries) {
      metrics.usage_count[trigger] = (metrics.usage_count[trigger] || 0) + count;
      metrics.last_used[trigger] = now;
      if (!metrics.first_used[trigger]) {
        metrics.first_used[trigger] = now;
      }

      metrics.daily_usage[today][trigger] = (metrics.daily_usage[today][trigger] || 0) + count;

      logger.debug('Flushing batched metrics', {
        trigger,
        batch_count: count,
        total_uses: metrics.usage_count[trigger]
      });
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);
    const cutoff = cutoffDate.toISOString().split('T')[0];

    for (const date in metrics.daily_usage) {
      if (date < cutoff) {
        delete metrics.daily_usage[date];
      }
    }

    index.metadata.last_updated = now;

    try {
      await this.options.persistIndex(index);
      const totalUpdates = entries.reduce((sum, [, count]) => sum + count, 0);
      logger.info('Metrics batch flushed', {
        triggers_updated: entries.length,
        total_updates: totalUpdates
      });
      this.logListener?.('info', 'Flush metrics batch', {
        triggers_updated: entries.length,
        total_updates: totalUpdates,
      });
      this.metricsBatch.clear();
    } catch (error) {
      logger.error('Failed to persist trigger metrics', { error });
      this.logListener?.('warn', 'Fail to persist trigger metrics', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Do not clear batch so we can retry on next flush attempt
    }
  }

  public dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.metricsBatch.clear();
  }

  public get pendingCount(): number {
    return this.metricsBatch.getStats().size;
  }
}
