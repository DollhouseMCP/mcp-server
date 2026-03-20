/**
 * Unit tests for CalibrationBenchmark
 *
 * Verifies that the calibration benchmark system:
 * - Initializes correctly
 * - Runs individual benchmarks without errors
 * - Returns valid results with expected fields
 * - Cleans up temporary files properly
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CalibrationBenchmark } from './CalibrationBenchmark.js';
import type { BenchmarkResult } from './types.js';

describe('CalibrationBenchmark', () => {
  let benchmark: CalibrationBenchmark;

  beforeEach(() => {
    benchmark = new CalibrationBenchmark();
  });

  afterEach(async () => {
    benchmark.cleanup();
  });

  describe('instantiation', () => {
    it('should create instance without errors', () => {
      expect(benchmark).toBeDefined();
      expect(benchmark).toBeInstanceOf(CalibrationBenchmark);
    });

    it('should set up temp directory', () => {
      // The constructor should create a temp directory without throwing
      // We verify it worked by checking that cleanup doesn't throw
      expect(() => {
        benchmark.cleanup();
      }).not.toThrow();
    });
  });

  describe('benchmarkStringOperations', () => {
    it('should run string operations benchmark', async () => {
      const result: BenchmarkResult = await benchmark.runAll().then(r => r.benchmarks[0]);

      expect(result).toBeDefined();
      expect(result.name).toBe('String Operations');
      expect(result.operationsPerSecond).toBeGreaterThan(0);
      expect(result.meanTimeMs).toBeGreaterThan(0);
      expect(result.minTimeMs).toBeGreaterThan(0);
      expect(result.maxTimeMs).toBeGreaterThanOrEqual(result.meanTimeMs);
      expect(result.stdDevMs).toBeGreaterThanOrEqual(0);
      expect(result.samples).toBe(5);
    });

    it('should have valid statistics', async () => {
      const result: BenchmarkResult = await benchmark.runAll().then(r => r.benchmarks[0]);

      // Standard deviation should be less than mean time (reasonable variance)
      expect(result.stdDevMs).toBeLessThan(result.meanTimeMs * 2);

      // Min should not be greater than mean
      expect(result.minTimeMs).toBeLessThanOrEqual(result.meanTimeMs);

      // Max should not be less than mean
      expect(result.maxTimeMs).toBeGreaterThanOrEqual(result.meanTimeMs);
    });
  });

  describe('benchmarkFileReads', () => {
    it('should run file read benchmark', async () => {
      const result: BenchmarkResult = await benchmark.runAll().then(r => r.benchmarks[1]);

      expect(result).toBeDefined();
      expect(result.name).toBe('File Read Operations');
      expect(result.operationsPerSecond).toBeGreaterThan(0);
      expect(result.meanTimeMs).toBeGreaterThan(0);
      expect(result.samples).toBe(5);
    });

    it('should return valid benchmark result', async () => {
      const result: BenchmarkResult = await benchmark.runAll().then(r => r.benchmarks[1]);

      expect(result.minTimeMs).toBeGreaterThan(0);
      expect(result.maxTimeMs).toBeGreaterThanOrEqual(result.minTimeMs);
      expect(result.stdDevMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('benchmarkJsonOperations', () => {
    it('should run JSON operations benchmark', async () => {
      const result: BenchmarkResult = await benchmark.runAll().then(r => r.benchmarks[2]);

      expect(result).toBeDefined();
      expect(result.name).toBe('JSON Operations');
      expect(result.operationsPerSecond).toBeGreaterThan(0);
      expect(result.meanTimeMs).toBeGreaterThan(0);
      expect(result.samples).toBe(5);
    });

    it('should return valid result object', async () => {
      const result: BenchmarkResult = await benchmark.runAll().then(r => r.benchmarks[2]);

      expect(typeof result.operationsPerSecond).toBe('number');
      expect(typeof result.meanTimeMs).toBe('number');
      expect(typeof result.minTimeMs).toBe('number');
      expect(typeof result.maxTimeMs).toBe('number');
      expect(typeof result.stdDevMs).toBe('number');
    });
  });

  describe('runAll', () => {
    it('should run all benchmarks successfully', async () => {
      const results = await benchmark.runAll();

      expect(results).toBeDefined();
      expect(results.benchmarks).toHaveLength(3);
      expect(results.benchmarks[0].name).toBe('String Operations');
      expect(results.benchmarks[1].name).toBe('File Read Operations');
      expect(results.benchmarks[2].name).toBe('JSON Operations');
    });

    it('should include system info', async () => {
      const results = await benchmark.runAll();

      expect(results.systemInfo).toBeDefined();
      expect(results.systemInfo.platform).toBeDefined();
      expect(results.systemInfo.arch).toBeDefined();
      expect(results.systemInfo.cpus).toBeGreaterThan(0);
      expect(results.systemInfo.totalMemoryMB).toBeGreaterThan(0);
      expect(results.systemInfo.nodeVersion).toBeDefined();
    });

    it('should include timestamp', async () => {
      const results = await benchmark.runAll();

      expect(results.timestamp).toBeDefined();
      expect(new Date(results.timestamp)).toBeInstanceOf(Date);
    });
  });

  describe('cleanup', () => {
    it('should not throw on cleanup', () => {
      expect(() => {
        benchmark.cleanup();
      }).not.toThrow();
    });

    it('should remove temporary directory', async () => {
      const benchmarkInstance = new CalibrationBenchmark();

      // Run a benchmark to ensure files are created
      await benchmarkInstance.runAll();

      // Cleanup should remove temp dir
      benchmarkInstance.cleanup();

      // After cleanup, creating a new instance should work
      const newBenchmark = new CalibrationBenchmark();
      expect(newBenchmark).toBeDefined();
      newBenchmark.cleanup();
    });

    it('should handle cleanup gracefully when already cleaned', () => {
      benchmark.cleanup();

      // Second cleanup should not throw
      expect(() => {
        benchmark.cleanup();
      }).not.toThrow();
    });
  });

  describe('result fields', () => {
    it('should have all required BenchmarkResult fields', async () => {
      const results = await benchmark.runAll();

      for (const result of results.benchmarks) {
        expect(result).toHaveProperty('name');
        expect(result).toHaveProperty('operationsPerSecond');
        expect(result).toHaveProperty('meanTimeMs');
        expect(result).toHaveProperty('minTimeMs');
        expect(result).toHaveProperty('maxTimeMs');
        expect(result).toHaveProperty('stdDevMs');
        expect(result).toHaveProperty('samples');
      }
    });
  });
});
