import { describe, test, expect } from '@jest/globals';
import { buildMetricsManagerConfig } from '../../../src/metrics/types.js';

describe('buildMetricsManagerConfig', () => {
  const defaultEnv = {
    DOLLHOUSE_METRICS_ENABLED: true,
    DOLLHOUSE_METRICS_COLLECTION_INTERVAL_MS: 15000,
    DOLLHOUSE_METRICS_MAX_SNAPSHOT_SIZE: 65536,
    DOLLHOUSE_METRICS_COLLECTOR_FAILURE_THRESHOLD: 5,
    DOLLHOUSE_METRICS_COLLECTION_DURATION_WARN_MS: 500,
    DOLLHOUSE_METRICS_MEMORY_SNAPSHOT_CAPACITY: 240,
  };

  test('maps all env vars to config properties', () => {
    const config = buildMetricsManagerConfig(defaultEnv);

    expect(config.enabled).toBe(true);
    expect(config.collectionIntervalMs).toBe(15000);
    expect(config.maxSnapshotSize).toBe(65536);
    expect(config.collectorFailureThreshold).toBe(5);
    expect(config.collectionDurationWarnMs).toBe(500);
    expect(config.memorySnapshotCapacity).toBe(240);
  });

  test('preserves custom values without modification', () => {
    const custom = {
      DOLLHOUSE_METRICS_ENABLED: false,
      DOLLHOUSE_METRICS_COLLECTION_INTERVAL_MS: 5000,
      DOLLHOUSE_METRICS_MAX_SNAPSHOT_SIZE: 1024,
      DOLLHOUSE_METRICS_COLLECTOR_FAILURE_THRESHOLD: 10,
      DOLLHOUSE_METRICS_COLLECTION_DURATION_WARN_MS: 200,
      DOLLHOUSE_METRICS_MEMORY_SNAPSHOT_CAPACITY: 500,
    };
    const config = buildMetricsManagerConfig(custom);

    expect(config.enabled).toBe(false);
    expect(config.collectionIntervalMs).toBe(5000);
    expect(config.maxSnapshotSize).toBe(1024);
    expect(config.collectorFailureThreshold).toBe(10);
    expect(config.collectionDurationWarnMs).toBe(200);
    expect(config.memorySnapshotCapacity).toBe(500);
  });

  test('returns a plain object (not a class instance)', () => {
    const config = buildMetricsManagerConfig(defaultEnv);
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
  });
});
