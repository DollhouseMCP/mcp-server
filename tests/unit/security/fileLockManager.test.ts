import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { assertTiming } from '../../helpers/timing-thresholds.js';

describe('FileLockManager', () => {
  let fileLockManager: FileLockManager;

  beforeEach(() => {
    fileLockManager = new FileLockManager();
  });

  afterEach(() => {
    // Cleanup any lingering locks
  });

  describe('withLock', () => {
    test('should execute operations sequentially for same resource', async () => {
      const results: number[] = [];
      const delays = [50, 30, 40]; // Different delays to test ordering
      
      // Start multiple operations on same resource
      const promises = delays.map((delay, index) => 
        fileLockManager.withLock('test-resource', async () => {
          await new Promise(resolve => setTimeout(resolve, delay));
          results.push(index);
          return index;
        })
      );
      
      // Wait for all to complete
      const returnValues = await Promise.all(promises);
      
      // Results should be in order despite different delays
      expect(results).toEqual([0, 1, 2]);
      expect(returnValues).toEqual([0, 1, 2]);
    });

    test('should execute operations in parallel for different resources', async () => {
      const startTime = Date.now();

      // Start operations on different resources
      const promises = [
        fileLockManager.withLock('resource-1', async () => {
          await new Promise(resolve => setTimeout(resolve, 50));
          return 1;
        }),
        fileLockManager.withLock('resource-2', async () => {
          await new Promise(resolve => setTimeout(resolve, 50));
          return 2;
        }),
        fileLockManager.withLock('resource-3', async () => {
          await new Promise(resolve => setTimeout(resolve, 50));
          return 3;
        })
      ];

      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      // Should complete in ~50ms (parallel) not ~150ms (sequential)
      // Environment-specific thresholds: strict locally, lenient in CI
      const threshold = assertTiming(duration, 'parallel-operations', 'FileLockManager');
      expect(duration).toBeLessThan(threshold);
      expect(results).toEqual([1, 2, 3]);
    });

    test('should handle errors in locked operations', async () => {
      const error = new Error('Operation failed');
      
      // First operation fails
      const promise1 = fileLockManager.withLock('error-resource', async () => {
        throw error;
      });
      
      // Second operation should still run
      const promise2 = fileLockManager.withLock('error-resource', async () => {
        return 'success';
      });
      
      await expect(promise1).rejects.toThrow('Operation failed');
      await expect(promise2).resolves.toBe('success');
    });

    test('should timeout long-running operations', async () => {
      const promise = fileLockManager.withLock(
        'timeout-resource',
        async () => {
          await new Promise(resolve => setTimeout(resolve, 200));
          return 'should not reach';
        },
        { timeout: 100 }
      );
      
      await expect(promise).rejects.toThrow('Lock operation timeout for resource: timeout-resource');
      
      // Metrics should reflect timeout
      const metrics = fileLockManager.getMetrics();
      expect(metrics.timeouts).toBe(1);
    });

    test('should track concurrent waits', async () => {
      // First operation holds lock
      const promise1 = fileLockManager.withLock('wait-test', async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return 1;
      });
      
      // Second operation waits
      const promise2 = fileLockManager.withLock('wait-test', async () => {
        return 2;
      });
      
      await Promise.all([promise1, promise2]);
      
      const metrics = fileLockManager.getMetrics();
      expect(metrics.concurrentWaits).toBeGreaterThan(0);
    });
  });

  describe('metrics', () => {
    test('should track lock metrics', async () => {
      // Perform some operations
      await fileLockManager.withLock('metric-test-1', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      
      await fileLockManager.withLock('metric-test-2', async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      
      const metrics = fileLockManager.getMetrics();
      
      expect(metrics.totalRequests).toBe(2);
      expect(metrics.activeLocksCount).toBe(0);
      expect(metrics.avgWaitTimeByResource['metric-test-1']).toBeGreaterThan(0);
      expect(metrics.avgWaitTimeByResource['metric-test-2']).toBeGreaterThan(0);
    });

    test('should reset metrics', () => {
      // Create a new instance to get fresh metrics
      fileLockManager = new FileLockManager();
      const metrics = fileLockManager.getMetrics();
      
      expect(metrics.totalRequests).toBe(0);
      expect(metrics.timeouts).toBe(0);
      expect(metrics.concurrentWaits).toBe(0);
      expect(metrics.avgWaitTimeByResource).toEqual({});
    });
  });

  describe('race condition prevention', () => {
    test('should prevent concurrent writes to same file', async () => {
      const operations: string[] = [];
      
      // Simulate concurrent write attempts
      const write1 = fileLockManager.withLock('file:test.txt', async () => {
        operations.push('write1-start');
        await new Promise(resolve => setTimeout(resolve, 50));
        operations.push('write1-end');
        return 'write1';
      });
      
      const write2 = fileLockManager.withLock('file:test.txt', async () => {
        operations.push('write2-start');
        await new Promise(resolve => setTimeout(resolve, 30));
        operations.push('write2-end');
        return 'write2';
      });
      
      await Promise.all([write1, write2]);
      
      // Operations should not interleave
      expect(operations).toEqual([
        'write1-start',
        'write1-end',
        'write2-start',
        'write2-end'
      ]);
    });

    test('should handle high concurrency gracefully', async () => {
      const concurrency = 10;
      const results: number[] = [];
      
      // Create many concurrent operations
      const promises = Array.from({ length: concurrency }, (_, i) =>
        fileLockManager.withLock('high-concurrency', async () => {
          await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
          results.push(i);
          return i;
        })
      );
      
      const returnValues = await Promise.all(promises);
      
      // All operations should complete
      expect(results).toHaveLength(concurrency);
      expect(returnValues).toHaveLength(concurrency);
      
      // Each number should appear exactly once (no duplicates)
      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBe(concurrency);
      
      // All numbers 0-9 should be present
      for (let i = 0; i < concurrency; i++) {
        expect(results).toContain(i);
      }
    });

    test('should maintain lock until operation completes even after caller timeout', async () => {
      const results: string[] = [];

      const promise1 = fileLockManager.withLock(
        'deadlock-test',
        async () => {
          results.push('op1-start');
          await new Promise(resolve => setTimeout(resolve, 150));
          results.push('op1-end');
          return 'op1';
        },
        { timeout: 100 }
      );

      const promise2 = fileLockManager.withLock(
        'deadlock-test',
        async () => {
          results.push('op2-start');
          return 'op2';
        }
      );

      // Caller gets timeout error
      await expect(promise1).rejects.toThrow('Lock operation timeout');

      // Second waits for real operation to finish, then succeeds
      await expect(promise2).resolves.toBe('op2');

      // Under the fix: op1 runs to completion before op2 starts
      expect(results).toContain('op1-start');
      expect(results).toContain('op1-end');
      expect(results).toContain('op2-start');
      expect(results.indexOf('op1-end')).toBeLessThan(results.indexOf('op2-start'));
    });

    test('should prevent zombie operations from racing with new callers after timeout', async () => {
      const concurrentOps: string[] = [];

      const promise1 = fileLockManager.withLock(
        'zombie-test',
        async () => {
          concurrentOps.push('op1-running');
          await new Promise(resolve => setTimeout(resolve, 200));
          concurrentOps.push('op1-done');
        },
        { timeout: 50 }
      );

      const promise2 = fileLockManager.withLock(
        'zombie-test',
        async () => {
          concurrentOps.push('op2-running');
        }
      );

      await expect(promise1).rejects.toThrow('Lock operation timeout');
      await promise2;

      // op2 must not start until op1 actually finishes
      const op1DoneIdx = concurrentOps.indexOf('op1-done');
      const op2RunningIdx = concurrentOps.indexOf('op2-running');
      expect(op1DoneIdx).toBeGreaterThan(-1);
      expect(op2RunningIdx).toBeGreaterThan(op1DoneIdx);
    });

    test('should report activeLocksCount 0 after timed-out operation completes', async () => {
      let resolveOp!: () => void;
      const opFinished = new Promise<void>(resolve => { resolveOp = resolve; });

      const promise = fileLockManager.withLock(
        'cleanup-test',
        async () => { await opFinished; },
        { timeout: 50 }
      );

      await expect(promise).rejects.toThrow('Lock operation timeout');

      // Lock still held while operation runs
      expect(fileLockManager.getMetrics().activeLocksCount).toBe(1);

      // Release the zombie operation
      resolveOp();
      await new Promise(resolve => setImmediate(resolve));

      // Lock cleaned up
      expect(fileLockManager.getMetrics().activeLocksCount).toBe(0);
    });
  });
});