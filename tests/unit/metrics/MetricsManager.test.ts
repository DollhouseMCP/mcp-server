import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { MetricsManager } from '../../../src/metrics/MetricsManager.js';
import type {
  IMetricCollector,
  IMetricsSink,
  MetricEntry,
  MetricSnapshot,
  MetricsManagerConfig,
} from '../../../src/metrics/types.js';
import type { ILogger } from '../../../src/types/ILogger.js';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<MetricsManagerConfig> = {}): MetricsManagerConfig {
  return {
    enabled: true,
    collectionIntervalMs: 0, // no auto-collection by default
    maxSnapshotSize: 65536,
    collectorFailureThreshold: 5,
    collectionDurationWarnMs: 500,
    memorySnapshotCapacity: 240,
    ...overrides,
  };
}

function makeMockLogger(): ILogger {
  return {
    debug: jest.fn<any>(),
    info: jest.fn<any>(),
    warn: jest.fn<any>(),
    error: jest.fn<any>(),
    getLogs: jest.fn<any>(),
    clearLogs: jest.fn<any>(),
    setMCPConnected: jest.fn<any>(),
  };
}

function makeMockCollector(overrides: Partial<IMetricCollector & { collect: () => MetricEntry[] | Promise<MetricEntry[]> }> = {}): IMetricCollector {
  return {
    name: overrides.name ?? 'TestCollector',
    description: overrides.description ?? 'A test collector',
    collect: overrides.collect ?? (() => [
      {
        type: 'gauge' as const,
        name: 'test.gauge',
        source: 'TestCollector',
        unit: 'count' as const,
        value: 42,
      },
    ]),
  };
}

interface MockSinkState {
  snapshots: MetricSnapshot[];
  flushCount: number;
  closeCount: number;
}

function makeMockSink(name?: string): { sink: IMetricsSink; state: MockSinkState } {
  const state: MockSinkState = { snapshots: [], flushCount: 0, closeCount: 0 };
  const sink: IMetricsSink = {
    name: name ?? 'MockSink',
    onSnapshot(snapshot: MetricSnapshot) {
      state.snapshots.push(snapshot);
    },
    async flush() {
      state.flushCount++;
    },
    async close() {
      state.closeCount++;
    },
  };
  return { sink, state };
}

describe('MetricsManager', () => {
  let manager: MetricsManager;
  let logger: ILogger;

  beforeEach(() => {
    logger = makeMockLogger();
    manager = new MetricsManager(makeConfig(), logger);
  });

  afterEach(async () => {
    try { await manager.close(); } catch { /* already closed */ }
  });

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  describe('registration', () => {
    test('registerCollector adds a collector', async () => {
      manager.registerCollector(makeMockCollector());
      const snapshot = await manager.collectNow();
      // Should have self-monitoring metrics + test.gauge
      const names = snapshot.metrics.map(m => m.name);
      expect(names).toContain('test.gauge');
    });

    test('registerSink receives snapshots', async () => {
      const { sink, state } = makeMockSink();
      manager.registerSink(sink);
      await manager.collectNow();
      expect(state.snapshots).toHaveLength(1);
    });

    test('registerCollector throws after close', async () => {
      await manager.close();
      expect(() => manager.registerCollector(makeMockCollector())).toThrow('MetricsManager is closed');
    });

    test('registerSink throws after close', async () => {
      await manager.close();
      expect(() => manager.registerSink(makeMockSink().sink)).toThrow('MetricsManager is closed');
    });
  });

  // -----------------------------------------------------------------------
  // collectNow()
  // -----------------------------------------------------------------------

  describe('collectNow()', () => {
    test('returns a snapshot with id, timestamp, metrics, errors', async () => {
      const snapshot = await manager.collectNow();
      expect(snapshot.id).toMatch(/^SNAP-\d+-\d+$/);
      expect(snapshot.timestamp).toBeTruthy();
      expect(Array.isArray(snapshot.metrics)).toBe(true);
      expect(Array.isArray(snapshot.errors)).toBe(true);
      expect(typeof snapshot.durationMs).toBe('number');
    });

    test('snapshot includes collector metrics', async () => {
      manager.registerCollector(makeMockCollector({
        collect: () => [
          { type: 'counter' as const, name: 'my.counter', source: 'Test', unit: 'count' as const, value: 10 },
        ],
      }));

      const snapshot = await manager.collectNow();
      const entry = snapshot.metrics.find(m => m.name === 'my.counter');
      expect(entry).toBeDefined();
      expect(entry!.value).toBe(10);
    });

    test('snapshot includes self-monitoring metrics', async () => {
      const snapshot = await manager.collectNow();
      const names = snapshot.metrics.map(m => m.name);
      expect(names).toContain('metrics.manager.collectors_registered');
      expect(names).toContain('metrics.manager.sinks_registered');
      expect(names).toContain('metrics.manager.collector_errors_total');
      expect(names).toContain('metrics.manager.sink_errors_total');
      expect(names).toContain('metrics.manager.last_collection_duration_ms');
      expect(names).toContain('metrics.manager.snapshots_taken_total');
      expect(names).toContain('metrics.manager.disabled_collectors');
    });

    test('snapshot is deeply frozen', async () => {
      const snapshot = await manager.collectNow();
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.metrics)).toBe(true);
      expect(Object.isFrozen(snapshot.errors)).toBe(true);
      if (snapshot.metrics.length > 0) {
        expect(Object.isFrozen(snapshot.metrics[0])).toBe(true);
      }
    });

    test('snapshot IDs increment', async () => {
      const snap1 = await manager.collectNow();
      const snap2 = await manager.collectNow();
      expect(snap1.id).not.toBe(snap2.id);
    });

    test('collectNow dispatches to all sinks', async () => {
      const { sink: s1, state: st1 } = makeMockSink('Sink1');
      const { sink: s2, state: st2 } = makeMockSink('Sink2');
      manager.registerSink(s1);
      manager.registerSink(s2);

      await manager.collectNow();
      expect(st1.snapshots).toHaveLength(1);
      expect(st2.snapshots).toHaveLength(1);
    });

    test('collectNow throws after close', async () => {
      await manager.close();
      await expect(manager.collectNow()).rejects.toThrow('MetricsManager is closed');
    });

    test('handles async collectors', async () => {
      manager.registerCollector(makeMockCollector({
        collect: async () => [
          { type: 'gauge' as const, name: 'async.metric', source: 'Async', unit: 'count' as const, value: 99 },
        ],
      }));

      const snapshot = await manager.collectNow();
      const entry = snapshot.metrics.find(m => m.name === 'async.metric');
      expect(entry).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Error isolation
  // -----------------------------------------------------------------------

  describe('error isolation', () => {
    test('failing collector does not block other collectors', async () => {
      manager.registerCollector(makeMockCollector({
        name: 'FailCollector',
        collect: () => { throw new Error('boom'); },
      }));
      manager.registerCollector(makeMockCollector({
        name: 'GoodCollector',
        collect: () => [
          { type: 'gauge' as const, name: 'good.metric', source: 'Good', unit: 'count' as const, value: 1 },
        ],
      }));

      const snapshot = await manager.collectNow();
      expect(snapshot.errors).toHaveLength(1);
      expect(snapshot.errors[0]).toContain('FailCollector');
      expect(snapshot.metrics.find(m => m.name === 'good.metric')).toBeDefined();
    });

    test('collector errors increment collectorErrorsTotal', async () => {
      manager.registerCollector(makeMockCollector({
        collect: () => { throw new Error('fail'); },
      }));

      await manager.collectNow();
      await manager.collectNow();

      const stats = manager.getManagerStats();
      expect(stats.collectorErrorsTotal).toBe(2);
    });

    test('failing sink does not block other sinks', async () => {
      const failSink: IMetricsSink = {
        name: 'FailSink',
        onSnapshot() { throw new Error('sink boom'); },
        async flush() {},
        async close() {},
      };
      const { sink: goodSink, state: goodState } = makeMockSink('GoodSink');

      manager.registerSink(failSink);
      manager.registerSink(goodSink);

      await manager.collectNow();
      expect(goodState.snapshots).toHaveLength(1);
    });

    test('sink errors increment sinkErrorsTotal', async () => {
      const failSink: IMetricsSink = {
        name: 'FailSink',
        onSnapshot() { throw new Error('sink boom'); },
        async flush() {},
        async close() {},
      };
      manager.registerSink(failSink);

      await manager.collectNow();
      await manager.collectNow();

      const stats = manager.getManagerStats();
      expect(stats.sinkErrorsTotal).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Circuit breaker
  // -----------------------------------------------------------------------

  describe('circuit breaker', () => {
    test('collector disabled after reaching failure threshold', async () => {
      const mgr = new MetricsManager(
        makeConfig({ collectorFailureThreshold: 3 }),
        logger,
      );
      mgr.registerCollector(makeMockCollector({
        name: 'Flaky',
        collect: () => { throw new Error('fail'); },
      }));

      await mgr.collectNow();
      await mgr.collectNow();
      await mgr.collectNow();

      // Check self-monitoring metric
      const snap = await mgr.collectNow();
      const disabled = snap.metrics.find(m => m.name === 'metrics.manager.disabled_collectors');
      expect(disabled).toBeDefined();
      expect(disabled!.value).toBe(1);

      // The 4th collection should have 0 errors (collector is disabled)
      expect(snap.errors).toHaveLength(0);

      await mgr.close();
    });

    test('consecutive failures reset on success', async () => {
      let callCount = 0;
      const mgr = new MetricsManager(
        makeConfig({ collectorFailureThreshold: 3 }),
        logger,
      );
      mgr.registerCollector(makeMockCollector({
        name: 'Intermittent',
        collect: () => {
          callCount++;
          if (callCount <= 2) throw new Error('fail');
          return [{ type: 'gauge' as const, name: 'ok', source: 'Test', unit: 'count' as const, value: 1 }];
        },
      }));

      await mgr.collectNow(); // fail 1
      await mgr.collectNow(); // fail 2
      await mgr.collectNow(); // success — resets counter

      const snap = await mgr.collectNow();
      const disabled = snap.metrics.find(m => m.name === 'metrics.manager.disabled_collectors');
      expect(disabled!.value).toBe(0);

      await mgr.close();
    });
  });

  // -----------------------------------------------------------------------
  // Timer
  // -----------------------------------------------------------------------

  describe('timer', () => {
    test('start() with interval triggers periodic collection', async () => {
      const { sink, state } = makeMockSink();
      const mgr = new MetricsManager(
        makeConfig({ collectionIntervalMs: 50 }),
        logger,
      );
      mgr.registerSink(sink);
      mgr.start();

      await new Promise(r => setTimeout(r, 80));

      expect(state.snapshots.length).toBeGreaterThanOrEqual(1);
      await mgr.close();
    });

    test('double start logs warning and does not create second timer', () => {
      const mgr = new MetricsManager(
        makeConfig({ collectionIntervalMs: 60000 }),
        logger,
      );
      mgr.start();
      mgr.start();

      expect(logger.warn).toHaveBeenCalledWith(
        'MetricsManager.start() called but timer already running',
      );
      // cleanup
      void mgr.close();
    });

    test('start() throws after close', async () => {
      await manager.close();
      expect(() => manager.start()).toThrow('MetricsManager is closed');
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle: close()
  // -----------------------------------------------------------------------

  describe('close()', () => {
    test('close flushes and closes all sinks', async () => {
      const { sink, state } = makeMockSink();
      manager.registerSink(sink);

      await manager.close();
      expect(state.flushCount).toBe(1);
      expect(state.closeCount).toBe(1);
    });

    test('close performs a final collection', async () => {
      const { sink, state } = makeMockSink();
      manager.registerSink(sink);

      await manager.close();
      // The final collectNow + any previous = at least 1 snapshot
      expect(state.snapshots.length).toBeGreaterThanOrEqual(1);
    });

    test('close is idempotent', async () => {
      const { sink, state } = makeMockSink();
      manager.registerSink(sink);

      await manager.close();
      const flushCountAfterFirst = state.flushCount;
      await manager.close();
      expect(state.flushCount).toBe(flushCountAfterFirst);
    });
  });

  // -----------------------------------------------------------------------
  // getManagerStats()
  // -----------------------------------------------------------------------

  describe('getManagerStats()', () => {
    test('returns all stat fields', async () => {
      manager.registerCollector(makeMockCollector());
      const { sink } = makeMockSink();
      manager.registerSink(sink);

      await manager.collectNow();
      const stats = manager.getManagerStats();

      expect(stats.collectionsCompleted).toBe(1);
      expect(stats.collectorsRegistered).toBe(1);
      expect(stats.sinksRegistered).toBe(1);
      expect(stats.disabledCollectors).toBe(0);
      expect(stats.collectorErrorsTotal).toBe(0);
      expect(stats.sinkErrorsTotal).toBe(0);
      expect(typeof stats.lastCollectionDurationMs).toBe('number');
      expect(stats.processStartTime).toBeTruthy();
    });

    test('callable after close', async () => {
      await manager.close();
      const stats = manager.getManagerStats();
      expect(stats.collectionsCompleted).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Warnings
  // -----------------------------------------------------------------------

  describe('warnings', () => {
    test('warns when snapshot size exceeds maxSnapshotSize', async () => {
      const mgr = new MetricsManager(
        makeConfig({ maxSnapshotSize: 10 }), // tiny limit
        logger,
      );
      await mgr.collectNow();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('exceeds limit'),
        expect.any(Object),
      );
      await mgr.close();
    });

    test('does not warn about duration during warmup (first 3 collections)', async () => {
      const mgr = new MetricsManager(
        makeConfig({ collectionDurationWarnMs: 0 }), // 0ms threshold = always exceed
        logger,
      );

      await mgr.collectNow(); // #1
      await mgr.collectNow(); // #2
      await mgr.collectNow(); // #3

      // Filter duration-specific warnings
      const durationWarns = (logger.warn as jest.Mock).mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Collection took'),
      );
      expect(durationWarns).toHaveLength(0);

      await mgr.close();
    });
  });
});
