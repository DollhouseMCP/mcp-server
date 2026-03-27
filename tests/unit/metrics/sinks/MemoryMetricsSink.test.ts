import { describe, test, expect, beforeEach } from '@jest/globals';
import { MemoryMetricsSink } from '../../../../src/metrics/sinks/MemoryMetricsSink.js';
import type { CounterEntry, MetricSnapshot } from '../../../../src/metrics/types.js';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeMetricEntry(overrides: Partial<CounterEntry> = {}): CounterEntry {
  return {
    type: 'counter',
    name: 'test.metric',
    source: 'TestCollector',
    unit: 'count',
    value: 1,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    id: 'SNAP-1234-0',
    timestamp: '2026-02-10T15:30:00.000Z',
    metrics: [makeMetricEntry()],
    errors: [],
    durationMs: 5,
    ...overrides,
  };
}

function createSink(maxSnapshots: number = 100): MemoryMetricsSink {
  return new MemoryMetricsSink(maxSnapshots);
}

describe('MemoryMetricsSink', () => {
  let sink: MemoryMetricsSink;

  beforeEach(() => {
    sink = createSink();
  });

  // -----------------------------------------------------------------------
  // IMetricsSink contract
  // -----------------------------------------------------------------------

  describe('IMetricsSink contract', () => {
    test('name is MemoryMetricsSink', () => {
      expect(sink.name).toBe('MemoryMetricsSink');
    });

    test('onSnapshot() stores snapshot in the buffer', () => {
      sink.onSnapshot(makeSnapshot());
      expect(sink.getStats().size).toBe(1);
    });

    test('flush() resolves without error and does not clear snapshots', async () => {
      sink.onSnapshot(makeSnapshot());
      await expect(sink.flush()).resolves.toBeUndefined();
      expect(sink.getStats().size).toBe(1);
    });

    test('close() clears the buffer', async () => {
      sink.onSnapshot(makeSnapshot());
      await sink.close();
      expect(sink.getStats().size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Eviction
  // -----------------------------------------------------------------------

  describe('eviction', () => {
    test('oldest snapshots are evicted when buffer exceeds capacity', () => {
      const small = createSink(3);
      for (let i = 0; i < 5; i++) {
        small.onSnapshot(makeSnapshot({
          id: `SNAP-${i}`,
          timestamp: `2026-02-10T${String(i).padStart(2, '0')}:00:00.000Z`,
        }));
      }

      const result = small.query({ latest: false, limit: 100 });
      expect(result.total).toBe(3);
      const ids = result.snapshots.map(s => s.id);
      expect(ids).not.toContain('SNAP-0');
      expect(ids).not.toContain('SNAP-1');
      expect(ids).toContain('SNAP-2');
      expect(ids).toContain('SNAP-3');
      expect(ids).toContain('SNAP-4');
    });
  });

  // -----------------------------------------------------------------------
  // Query: latest flag
  // -----------------------------------------------------------------------

  describe('query latest flag', () => {
    test('latest: true (default) returns only the newest snapshot', () => {
      sink.onSnapshot(makeSnapshot({ id: 'SNAP-0', timestamp: '2026-02-10T01:00:00.000Z' }));
      sink.onSnapshot(makeSnapshot({ id: 'SNAP-1', timestamp: '2026-02-10T02:00:00.000Z' }));
      sink.onSnapshot(makeSnapshot({ id: 'SNAP-2', timestamp: '2026-02-10T03:00:00.000Z' }));

      const result = sink.query();
      expect(result.total).toBe(1);
      expect(result.snapshots[0].id).toBe('SNAP-2');
    });

    test('latest: false returns all snapshots', () => {
      sink.onSnapshot(makeSnapshot({ id: 'SNAP-0', timestamp: '2026-02-10T01:00:00.000Z' }));
      sink.onSnapshot(makeSnapshot({ id: 'SNAP-1', timestamp: '2026-02-10T02:00:00.000Z' }));

      const result = sink.query({ latest: false, limit: 100 });
      expect(result.total).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Query: time range filtering
  // -----------------------------------------------------------------------

  describe('query time range', () => {
    beforeEach(() => {
      sink.onSnapshot(makeSnapshot({ id: 'A', timestamp: '2026-02-10T10:00:00.000Z' }));
      sink.onSnapshot(makeSnapshot({ id: 'B', timestamp: '2026-02-10T12:00:00.000Z' }));
      sink.onSnapshot(makeSnapshot({ id: 'C', timestamp: '2026-02-10T14:00:00.000Z' }));
    });

    test('since filter returns snapshots strictly after the timestamp', () => {
      const result = sink.query({ latest: false, limit: 100, since: '2026-02-10T12:00:00.000Z' });
      expect(result.total).toBe(1);
      expect(result.snapshots[0].id).toBe('C');
    });

    test('until filter returns snapshots strictly before the timestamp', () => {
      const result = sink.query({ latest: false, limit: 100, until: '2026-02-10T12:00:00.000Z' });
      expect(result.total).toBe(1);
      expect(result.snapshots[0].id).toBe('A');
    });

    test('since + until combined restricts to a time window', () => {
      const result = sink.query({
        latest: false,
        limit: 100,
        since: '2026-02-10T09:00:00.000Z',
        until: '2026-02-10T13:00:00.000Z',
      });
      expect(result.total).toBe(2);
      const ids = result.snapshots.map(s => s.id);
      expect(ids).toContain('A');
      expect(ids).toContain('B');
    });
  });

  // -----------------------------------------------------------------------
  // Query: metric filtering
  // -----------------------------------------------------------------------

  describe('query metric filtering', () => {
    test('name filter: exact match', () => {
      sink.onSnapshot(makeSnapshot({
        id: 'S1',
        metrics: [
          makeMetricEntry({ name: 'cache.hits' }),
          makeMetricEntry({ name: 'cache.misses' }),
        ],
      }));

      const result = sink.query({ names: ['cache.hits'] });
      expect(result.snapshots[0].metrics).toHaveLength(1);
      expect(result.snapshots[0].metrics[0].name).toBe('cache.hits');
    });

    test('name filter: prefix match with trailing dot', () => {
      sink.onSnapshot(makeSnapshot({
        id: 'S1',
        metrics: [
          makeMetricEntry({ name: 'cache.hits' }),
          makeMetricEntry({ name: 'cache.misses' }),
          makeMetricEntry({ name: 'system.cpu' }),
        ],
      }));

      const result = sink.query({ names: ['cache.'] });
      expect(result.snapshots[0].metrics).toHaveLength(2);
    });

    test('name filter: prefix match with trailing .*', () => {
      sink.onSnapshot(makeSnapshot({
        id: 'S1',
        metrics: [
          makeMetricEntry({ name: 'metrics.manager.collectors_registered' }),
          makeMetricEntry({ name: 'metrics.manager.sinks_registered' }),
          makeMetricEntry({ name: 'system.cpu' }),
        ],
      }));

      const result = sink.query({ names: ['metrics.manager.*'] });
      expect(result.snapshots[0].metrics).toHaveLength(2);
    });

    test('name filter: multiple names (OR logic)', () => {
      sink.onSnapshot(makeSnapshot({
        id: 'S1',
        metrics: [
          makeMetricEntry({ name: 'cache.hits' }),
          makeMetricEntry({ name: 'cache.misses' }),
          makeMetricEntry({ name: 'system.cpu' }),
        ],
      }));

      const result = sink.query({ names: ['cache.hits', 'system.cpu'] });
      expect(result.snapshots[0].metrics).toHaveLength(2);
    });

    test('source filter: case-insensitive substring match', () => {
      sink.onSnapshot(makeSnapshot({
        id: 'S1',
        metrics: [
          makeMetricEntry({ source: 'CacheCollector' }),
          makeMetricEntry({ source: 'SystemCollector' }),
        ],
      }));

      const result = sink.query({ source: 'cache' });
      expect(result.snapshots[0].metrics).toHaveLength(1);
      expect(result.snapshots[0].metrics[0].source).toBe('CacheCollector');
    });

    test('type filter: exact match', () => {
      sink.onSnapshot(makeSnapshot({
        id: 'S1',
        metrics: [
          makeMetricEntry({ type: 'counter', name: 'a' }),
          { type: 'gauge', name: 'b', source: 'X', unit: 'count', value: 42 },
        ],
      }));

      const result = sink.query({ type: 'gauge' });
      expect(result.snapshots[0].metrics).toHaveLength(1);
      expect(result.snapshots[0].metrics[0].name).toBe('b');
    });

    test('filters exclude snapshot entirely if no metrics match', () => {
      sink.onSnapshot(makeSnapshot({
        id: 'S1',
        metrics: [makeMetricEntry({ name: 'cache.hits' })],
      }));
      sink.onSnapshot(makeSnapshot({
        id: 'S2',
        timestamp: '2026-02-10T16:00:00.000Z',
        metrics: [makeMetricEntry({ name: 'system.cpu' })],
      }));

      const result = sink.query({ latest: false, limit: 100, names: ['system.cpu'] });
      expect(result.total).toBe(1);
      expect(result.snapshots[0].id).toBe('S2');
    });
  });

  // -----------------------------------------------------------------------
  // Query: availability bounds
  // -----------------------------------------------------------------------

  describe('query availability bounds', () => {
    test('empty buffer returns empty strings for bounds', () => {
      const result = sink.query();
      expect(result.oldestAvailable).toBe('');
      expect(result.newestAvailable).toBe('');
    });

    test('bounds reflect full buffer before filtering', () => {
      sink.onSnapshot(makeSnapshot({ id: 'A', timestamp: '2026-02-10T01:00:00.000Z' }));
      sink.onSnapshot(makeSnapshot({ id: 'B', timestamp: '2026-02-10T02:00:00.000Z' }));
      sink.onSnapshot(makeSnapshot({ id: 'C', timestamp: '2026-02-10T03:00:00.000Z' }));

      const result = sink.query({ latest: false, limit: 100, since: '2026-02-10T02:30:00.000Z' });
      expect(result.oldestAvailable).toBe('2026-02-10T01:00:00.000Z');
      expect(result.newestAvailable).toBe('2026-02-10T03:00:00.000Z');
      expect(result.total).toBe(1); // only C passes the filter
    });
  });

  // -----------------------------------------------------------------------
  // Pagination
  // -----------------------------------------------------------------------

  describe('pagination', () => {
    beforeEach(() => {
      for (let i = 0; i < 10; i++) {
        sink.onSnapshot(makeSnapshot({
          id: `SNAP-${i}`,
          timestamp: `2026-02-10T${String(i).padStart(2, '0')}:00:00.000Z`,
        }));
      }
    });

    test('limit defaults to 1', () => {
      const result = sink.query();
      expect(result.limit).toBe(1);
    });

    test('limit is clamped to [0, 100]', () => {
      expect(sink.query({ latest: false, limit: -5 }).limit).toBe(0);
      expect(sink.query({ latest: false, limit: 200 }).limit).toBe(100);
    });

    test('limit 0 returns empty result', () => {
      const result = sink.query({ latest: false, limit: 0 });
      expect(result.snapshots).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    test('offset defaults to 0', () => {
      const result = sink.query();
      expect(result.offset).toBe(0);
    });

    test('offset clamped to >= 0', () => {
      const result = sink.query({ offset: -3 });
      expect(result.offset).toBe(0);
    });

    test('limit and offset paginate correctly', () => {
      const page1 = sink.query({ latest: false, limit: 3, offset: 0 });
      expect(page1.snapshots).toHaveLength(3);
      expect(page1.total).toBe(10);
      expect(page1.hasMore).toBe(true);

      const page2 = sink.query({ latest: false, limit: 3, offset: 3 });
      expect(page2.snapshots).toHaveLength(3);
      expect(page2.hasMore).toBe(true);

      const lastPage = sink.query({ latest: false, limit: 3, offset: 9 });
      expect(lastPage.snapshots).toHaveLength(1);
      expect(lastPage.hasMore).toBe(false);
    });

    test('offset beyond total returns empty snapshots with correct total', () => {
      const result = sink.query({ latest: false, limit: 100, offset: 100 });
      expect(result.snapshots).toHaveLength(0);
      expect(result.total).toBe(10);
      expect(result.hasMore).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Sort order
  // -----------------------------------------------------------------------

  describe('sort order', () => {
    test('results returned newest-first', () => {
      sink.onSnapshot(makeSnapshot({ id: 'OLD', timestamp: '2026-02-10T01:00:00.000Z' }));
      sink.onSnapshot(makeSnapshot({ id: 'NEW', timestamp: '2026-02-10T03:00:00.000Z' }));
      sink.onSnapshot(makeSnapshot({ id: 'MID', timestamp: '2026-02-10T02:00:00.000Z' }));

      const result = sink.query({ latest: false, limit: 100 });
      expect(result.snapshots.map(s => s.id)).toEqual(['NEW', 'MID', 'OLD']);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    test('empty sink returns zero results', () => {
      const result = sink.query();
      expect(result.snapshots).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    test('query with no options returns latest snapshot only', () => {
      sink.onSnapshot(makeSnapshot({ id: 'A', timestamp: '2026-02-10T01:00:00.000Z' }));
      sink.onSnapshot(makeSnapshot({ id: 'B', timestamp: '2026-02-10T02:00:00.000Z' }));

      const result = sink.query();
      expect(result.total).toBe(1);
      expect(result.snapshots[0].id).toBe('B');
    });
  });

  // -----------------------------------------------------------------------
  // getStats()
  // -----------------------------------------------------------------------

  describe('getStats()', () => {
    test('returns size and capacity', () => {
      const s = createSink(50);
      s.onSnapshot(makeSnapshot());
      s.onSnapshot(makeSnapshot());

      const stats = s.getStats();
      expect(stats).toEqual({ size: 2, capacity: 50 });
    });
  });
});
