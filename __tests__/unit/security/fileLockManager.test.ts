import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { FileLockManager } from '../../../src/security/fileLockManager.js';

describe('FileLockManager', () => {
  beforeEach(() => {
    FileLockManager.resetMetrics();
    FileLockManager.clearAllLocks();
  });

  afterEach(() => {
    FileLockManager.clearAllLocks();
  });

  describe('withLock', () => {
    test('should execute operations sequentially for same resource', async () => {
      const results: number[] = [];
      const delays = [50, 30, 40]; // Different delays to test ordering
      
      // Start multiple operations on same resource
      const promises = delays.map((delay, index) => 
        FileLockManager.withLock('test-resource', async () => {
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
        FileLockManager.withLock('resource-1', async () => {
          await new Promise(resolve => setTimeout(resolve, 50));
          return 1;
        }),
        FileLockManager.withLock('resource-2', async () => {
          await new Promise(resolve => setTimeout(resolve, 50));
          return 2;
        }),
        FileLockManager.withLock('resource-3', async () => {
          await new Promise(resolve => setTimeout(resolve, 50));
          return 3;
        })
      ];
      
      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;
      
      // Should complete in ~50ms (parallel) not ~150ms (sequential)
      expect(duration).toBeLessThan(100);
      expect(results).toEqual([1, 2, 3]);
    });

    test('should handle errors in locked operations', async () => {
      const error = new Error('Operation failed');
      
      // First operation fails
      const promise1 = FileLockManager.withLock('error-resource', async () => {
        throw error;
      });
      
      // Second operation should still run
      const promise2 = FileLockManager.withLock('error-resource', async () => {
        return 'success';
      });
      
      await expect(promise1).rejects.toThrow('Operation failed');
      await expect(promise2).resolves.toBe('success');
    });

    test('should timeout long-running operations', async () => {
      const promise = FileLockManager.withLock(
        'timeout-resource',
        async () => {
          await new Promise(resolve => setTimeout(resolve, 200));
          return 'should not reach';
        },
        { timeout: 100 }
      );
      
      await expect(promise).rejects.toThrow('Lock operation timeout for resource: timeout-resource');
      
      // Metrics should reflect timeout
      const metrics = FileLockManager.getMetrics();
      expect(metrics.timeouts).toBe(1);
    });

    test('should track concurrent waits', async () => {
      // First operation holds lock
      const promise1 = FileLockManager.withLock('wait-test', async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return 1;
      });
      
      // Second operation waits
      const promise2 = FileLockManager.withLock('wait-test', async () => {
        return 2;
      });
      
      await Promise.all([promise1, promise2]);
      
      const metrics = FileLockManager.getMetrics();
      expect(metrics.concurrentWaits).toBeGreaterThan(0);
    });
  });

  describe('metrics', () => {
    test('should track lock metrics', async () => {
      // Perform some operations
      await FileLockManager.withLock('metric-test-1', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      
      await FileLockManager.withLock('metric-test-2', async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      
      const metrics = FileLockManager.getMetrics();
      
      expect(metrics.totalRequests).toBe(2);
      expect(metrics.activeLocksCount).toBe(0);
      expect(metrics.avgWaitTimeByResource['metric-test-1']).toBeGreaterThan(0);
      expect(metrics.avgWaitTimeByResource['metric-test-2']).toBeGreaterThan(0);
    });

    test('should reset metrics', () => {
      FileLockManager.resetMetrics();
      const metrics = FileLockManager.getMetrics();
      
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
      const write1 = FileLockManager.withLock('file:test.txt', async () => {
        operations.push('write1-start');
        await new Promise(resolve => setTimeout(resolve, 50));
        operations.push('write1-end');
        return 'write1';
      });
      
      const write2 = FileLockManager.withLock('file:test.txt', async () => {
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
        FileLockManager.withLock('high-concurrency', async () => {
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

    test('should handle deadlock prevention with timeout', async () => {
      const results: string[] = [];
      
      // Create potential deadlock scenario with very short timeout
      const promise1 = FileLockManager.withLock(
        'deadlock-test',
        async () => {
          results.push('op1-start');
          await new Promise(resolve => setTimeout(resolve, 150));
          results.push('op1-end');
          return 'op1';
        },
        { timeout: 100 }
      );
      
      // This should proceed after first times out
      const promise2 = FileLockManager.withLock(
        'deadlock-test',
        async () => {
          results.push('op2-start');
          return 'op2';
        }
      );
      
      // First should timeout
      await expect(promise1).rejects.toThrow('Lock operation timeout');
      
      // Second should succeed
      await expect(promise2).resolves.toBe('op2');
      
      // Verify operations
      expect(results).toContain('op1-start');
      expect(results).not.toContain('op1-end'); // Should not complete
      expect(results).toContain('op2-start');
    });
  });
});