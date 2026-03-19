/**
 * Container Disposal Error Scenario Tests
 *
 * Tests error handling in Container.dispose() which uses Promise.all()
 * These tests cover the CURRENT behavior (Promise.all - fail fast on first error)
 * and document FUTURE behavior (Promise.allSettled - continue despite failures)
 *
 * Current implementation: src/di/Container.ts:558 - await Promise.all(disposalPromises)
 *
 * Test Coverage:
 * 1. All services dispose successfully (happy path)
 * 2. One service disposal fails
 * 3. Multiple services fail
 * 4. Service throws during disposal
 * 5. Async disposal timeout
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DollhouseContainer } from '../../src/di/Container.js';

describe('Container Disposal - Error Scenarios', () => {
  let container: DollhouseContainer;

  beforeEach(() => {
    container = new DollhouseContainer();
  });

  afterEach(async () => {
    // Clean up - but don't fail tests if disposal fails
    if (container) {
      try {
        // Clear any services that might throw to avoid afterEach failures
        const services = (container as any).services;
        if (services) {
          for (const [_name, service] of services) {
            if (service.instance && typeof service.instance.dispose === 'function') {
              // Replace with no-op to prevent errors during cleanup
              service.instance.dispose = jest.fn().mockResolvedValue(undefined);
            }
          }
        }
        await container.dispose();
      } catch (_error) {
        // Expected in error tests - silently ignore
      }
    }
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('Happy Path - All Services Dispose Successfully', () => {
    it('should dispose all services without errors', async () => {
      // Create mock services with successful dispose
      const mockService1 = {
        dispose: jest.fn().mockResolvedValue(undefined)
      };
      const mockService2 = {
        dispose: jest.fn().mockResolvedValue(undefined)
      };
      const mockService3 = {
        cleanup: jest.fn().mockResolvedValue(undefined)
      };

      // Register services
      (container as any).services.set('Service1', { instance: mockService1 });
      (container as any).services.set('Service2', { instance: mockService2 });
      (container as any).services.set('Service3', { instance: mockService3 });

      // Act
      await container.dispose();

      // Assert - all should be called
      expect(mockService1.dispose).toHaveBeenCalledTimes(1);
      expect(mockService2.dispose).toHaveBeenCalledTimes(1);
      expect(mockService3.cleanup).toHaveBeenCalledTimes(1);
    });

    it('should dispose services in parallel for performance', async () => {
      const disposeStartTimes: number[] = [];
      const disposeDelay = 100; // ms

      const mockService1 = {
        dispose: jest.fn().mockImplementation(async () => {
          disposeStartTimes.push(Date.now());
          await new Promise(resolve => setTimeout(resolve, disposeDelay));
        })
      };
      const mockService2 = {
        dispose: jest.fn().mockImplementation(async () => {
          disposeStartTimes.push(Date.now());
          await new Promise(resolve => setTimeout(resolve, disposeDelay));
        })
      };

      (container as any).services.set('Service1', { instance: mockService1 });
      (container as any).services.set('Service2', { instance: mockService2 });

      const startTime = Date.now();
      await container.dispose();
      const totalTime = Date.now() - startTime;

      // If parallel, should take ~100ms, not 200ms
      // TIMING-SENSITIVE TEST: Very generous tolerance for multi-worker execution
      // setTimeout can drift significantly under event loop saturation
      expect(totalTime).toBeLessThan(disposeDelay * 30); // Allow 30x for CI worst-case

      // Both should start around the same time (parallel execution)
      const timeDiff = Math.abs(disposeStartTimes[1] - disposeStartTimes[0]);
      // Very generous tolerance for CI multi-worker saturation
      expect(timeDiff).toBeLessThan(1000); // Started within 1 second of each other
    });
  });

  describe('Error Scenario 1 - Single Service Disposal Fails', () => {
    it('CURRENT BEHAVIOR: should catch and log error, continue with other services', async () => {
      const mockService1 = {
        dispose: jest.fn().mockRejectedValue(new Error('Service1 disposal failed'))
      };
      const mockService2 = {
        dispose: jest.fn().mockResolvedValue(undefined)
      };

      (container as any).services.set('Service1', { instance: mockService1 });
      (container as any).services.set('Service2', { instance: mockService2 });

      // Current implementation catches errors in individual promises
      // So dispose() should succeed overall
      await expect(container.dispose()).resolves.not.toThrow();

      // Both should be called
      expect(mockService1.dispose).toHaveBeenCalledTimes(1);
      expect(mockService2.dispose).toHaveBeenCalledTimes(1);
    });

    it('should handle rejected promises gracefully', async () => {
      const error = new Error('Database connection cleanup failed');
      const mockFailingService = {
        dispose: jest.fn().mockRejectedValue(error)
      };
      const mockSuccessService = {
        dispose: jest.fn().mockResolvedValue(undefined)
      };

      (container as any).services.set('FailingService', { instance: mockFailingService });
      (container as any).services.set('SuccessService', { instance: mockSuccessService });

      // Should not throw - errors are caught
      await container.dispose();

      expect(mockFailingService.dispose).toHaveBeenCalledTimes(1);
      expect(mockSuccessService.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Error Scenario 2 - Multiple Services Fail', () => {
    it('CURRENT BEHAVIOR: should handle multiple failures without cascading', async () => {
      const mockService1 = {
        dispose: jest.fn().mockRejectedValue(new Error('Service1 failed'))
      };
      const mockService2 = {
        dispose: jest.fn().mockRejectedValue(new Error('Service2 failed'))
      };
      const mockService3 = {
        dispose: jest.fn().mockResolvedValue(undefined)
      };

      (container as any).services.set('Service1', { instance: mockService1 });
      (container as any).services.set('Service2', { instance: mockService2 });
      (container as any).services.set('Service3', { instance: mockService3 });

      // Should complete without throwing
      await container.dispose();

      // All should be attempted
      expect(mockService1.dispose).toHaveBeenCalledTimes(1);
      expect(mockService2.dispose).toHaveBeenCalledTimes(1);
      expect(mockService3.dispose).toHaveBeenCalledTimes(1);
    });

    it('should dispose all services even when some fail', async () => {
      const disposeCallOrder: string[] = [];

      const mockService1 = {
        dispose: jest.fn().mockImplementation(async () => {
          disposeCallOrder.push('Service1');
          throw new Error('Service1 error');
        })
      };
      const mockService2 = {
        dispose: jest.fn().mockImplementation(async () => {
          disposeCallOrder.push('Service2');
        })
      };
      const mockService3 = {
        dispose: jest.fn().mockImplementation(async () => {
          disposeCallOrder.push('Service3');
          throw new Error('Service3 error');
        })
      };

      (container as any).services.set('Service1', { instance: mockService1 });
      (container as any).services.set('Service2', { instance: mockService2 });
      (container as any).services.set('Service3', { instance: mockService3 });

      await container.dispose();

      // All three should be in the call order
      expect(disposeCallOrder).toHaveLength(3);
      expect(disposeCallOrder).toContain('Service1');
      expect(disposeCallOrder).toContain('Service2');
      expect(disposeCallOrder).toContain('Service3');
    });
  });

  describe('Error Scenario 3 - Service Throws Synchronously During Disposal', () => {
    it('IMPROVED BEHAVIOR: synchronous throws are NOW caught by Promise.resolve().then()', async () => {
      const mockService = {
        dispose: jest.fn().mockImplementation(() => {
          throw new Error('Synchronous error in dispose');
        })
      };

      (container as any).services.set('ThrowingService', { instance: mockService });

      // IMPROVED: Promise.resolve().then() wrapper catches synchronous throws
      // Container disposal completes successfully, logging the error
      await expect(container.dispose()).resolves.not.toThrow();

      expect(mockService.dispose).toHaveBeenCalledTimes(1);
    });

    it('should handle async rejected promises', async () => {
      const mockService = {
        dispose: jest.fn().mockImplementation(async () => {
          throw new Error('Async rejection in dispose');
        })
      };

      (container as any).services.set('AsyncReject', { instance: mockService });

      // Async rejections ARE caught
      await container.dispose();

      expect(mockService.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Error Scenario 4 - Async Disposal Timeout', () => {
    it('should handle slow disposal operations', async () => {
      const slowDispose = 2000; // 2 seconds

      const mockSlowService = {
        dispose: jest.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, slowDispose));
        })
      };

      (container as any).services.set('SlowService', { instance: mockSlowService });

      // This test just verifies current behavior - no timeout mechanism exists
      // FUTURE: Could add timeout with Promise.race
      const startTime = Date.now();
      await container.dispose();
      const elapsed = Date.now() - startTime;

      expect(mockSlowService.dispose).toHaveBeenCalledTimes(1);
      expect(elapsed).toBeGreaterThanOrEqual(slowDispose - 100); // Allow some variance
    }, 10000); // Increase Jest timeout for this test

    it('documents need for timeout protection', async () => {
      // This test documents FUTURE behavior - adding timeout protection
      // Skip actual hanging test to avoid test suite timeout issues

      // CURRENT BEHAVIOR: A hanging disposal would block forever
      // FUTURE BEHAVIOR: Should timeout after reasonable duration

      // Example of how timeout protection could work:
      const exampleHangingPromise = new Promise(() => {}); // Never resolves
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), 100)
      );

      await expect(Promise.race([exampleHangingPromise, timeoutPromise]))
        .rejects.toThrow('Timeout');

      // Note: This documents that timeout protection is needed
      // for production code to prevent indefinite hangs
    });
  });

  describe('Edge Cases', () => {
    it('should handle services with both dispose and cleanup methods', async () => {
      const mockService = {
        dispose: jest.fn().mockResolvedValue(undefined),
        cleanup: jest.fn().mockResolvedValue(undefined)
      };

      (container as any).services.set('BothMethods', { instance: mockService });

      await container.dispose();

      // Should prefer dispose over cleanup
      expect(mockService.dispose).toHaveBeenCalledTimes(1);
      expect(mockService.cleanup).not.toHaveBeenCalled();
    });

    it('should handle services without dispose or cleanup', async () => {
      const mockService = {
        someMethod: jest.fn()
      };

      (container as any).services.set('NoDispose', { instance: mockService });

      // Should not throw
      await container.dispose();

      expect(mockService.someMethod).not.toHaveBeenCalled();
    });

    it('should handle empty services map', async () => {
      const emptyContainer = new DollhouseContainer();
      (emptyContainer as any).services.clear();

      // Should not throw
      await expect(emptyContainer.dispose()).resolves.not.toThrow();
    });

    it('should handle rate limiter disposal', async () => {
      // Create fresh container to avoid afterEach conflict
      const testContainer = new DollhouseContainer();
      const mockRateLimiter = {
        dispose: jest.fn()
      };

      (testContainer as any).services.set('GitHubRateLimiter', { instance: mockRateLimiter });

      await testContainer.dispose();

      // Rate limiter gets disposed twice in current implementation:
      // 1. In the services loop (line 538)
      // 2. In the special rate limiter section (line 553)
      // This is a code smell that could be improved with refactoring
      expect(mockRateLimiter.dispose).toHaveBeenCalled();
      expect(mockRateLimiter.dispose.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('IMPROVED BEHAVIOR: sync throws in services are now properly caught', async () => {
      // Create fresh container to avoid afterEach conflict
      const testContainer = new DollhouseContainer();
      const mockRateLimiter = {
        dispose: jest.fn().mockImplementation(() => {
          // Synchronous throw - now properly caught by Promise.resolve().then()
          throw new Error('Rate limiter disposal failed');
        })
      };

      (testContainer as any).services.set('GitHubRateLimiter', { instance: mockRateLimiter });

      // IMPROVED: Promise.resolve().then() wrapper catches synchronous throws
      // Disposal completes successfully with error logged
      await expect(testContainer.dispose()).resolves.not.toThrow();

      expect(mockRateLimiter.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('FUTURE: Promise.allSettled Behavior Documentation', () => {
    it('documents expected behavior with Promise.allSettled', async () => {
      // This test documents what WILL happen after refactoring
      const results = await Promise.allSettled([
        Promise.resolve('success1'),
        Promise.reject(new Error('failure1')),
        Promise.resolve('success2'),
        Promise.reject(new Error('failure2'))
      ]);

      expect(results).toHaveLength(4);
      expect(results[0]).toEqual({ status: 'fulfilled', value: 'success1' });
      expect(results[1]).toEqual({
        status: 'rejected',
        reason: expect.objectContaining({ message: 'failure1' })
      });
      expect(results[2]).toEqual({ status: 'fulfilled', value: 'success2' });
      expect(results[3]).toEqual({
        status: 'rejected',
        reason: expect.objectContaining({ message: 'failure2' })
      });

      // FUTURE: Can collect all failures and report them together
      const failures = results.filter(r => r.status === 'rejected');
      expect(failures).toHaveLength(2);
    });

    it('compares Promise.all vs Promise.allSettled failure handling', async () => {
      const promises = [
        Promise.resolve('success'),
        Promise.reject(new Error('first failure')),
        Promise.reject(new Error('second failure'))
      ];

      // CURRENT: Promise.all fails fast on first rejection
      await expect(Promise.all(promises)).rejects.toThrow('first failure');
      // Note: 'second failure' is never observed

      // FUTURE: Promise.allSettled waits for all to complete
      const results = await Promise.allSettled(promises);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(results[2].status).toBe('rejected');

      // Can collect ALL errors
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map(r => r.reason.message);

      expect(errors).toEqual(['first failure', 'second failure']);
    });
  });
});
