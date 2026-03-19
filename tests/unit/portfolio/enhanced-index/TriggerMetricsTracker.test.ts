import { describe, it, expect, beforeEach } from '@jest/globals';
import { TriggerMetricsTracker } from '../../../../src/portfolio/enhanced-index/TriggerMetricsTracker.js';
import type { EnhancedIndex } from '../../../../src/portfolio/types/IndexTypes.js';

const createIndex = (): EnhancedIndex => ({
  metadata: {
    version: '2.0.0',
    created: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    total_elements: 0
  },
  action_triggers: {},
  elements: {}
});

describe('TriggerMetricsTracker', () => {
  let index: EnhancedIndex;
  let persistCalls: number;

  beforeEach(() => {
    index = createIndex();
    persistCalls = 0;
  });

  const createTracker = (batchSize = 2) => new TriggerMetricsTracker({
    batchSize,
    flushIntervalMs: 50,
    cacheLimits: { maxSize: 10, maxMemoryMB: 1 },
    getIndex: async () => index,
    persistIndex: async () => {
      persistCalls++;
    }
  });

  it('flushes metrics when batch threshold is reached', async () => {
    const tracker = createTracker(2);

    await tracker.track('debug');
    expect(persistCalls).toBe(0);

    await tracker.track('create');
    expect(persistCalls).toBe(1);
    expect(index.metadata.trigger_metrics?.usage_count.debug).toBe(1);
    expect(index.metadata.trigger_metrics?.usage_count.create).toBe(1);

    tracker.dispose();
  });

  it('flushes immediately when requested', async () => {
    const tracker = createTracker(10);

    await tracker.track('create');
    expect(persistCalls).toBe(0);

    await tracker.track('create', true);
    expect(persistCalls).toBe(1);

    tracker.dispose();
  });
});
