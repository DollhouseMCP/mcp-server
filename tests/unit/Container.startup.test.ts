/**
 * Container Startup Error Scenario Tests
 *
 * ⚠️ DEPRECATED: This file has been decomposed into:
 *   - Container.startup-behavior.test.ts (behavior tests, stable)
 *   - Container.startup-timing.test.ts (timing tests with overhead compensation)
 *
 * This file is kept for backwards compatibility but timing-sensitive tests
 * are skipped here to avoid flakiness. Run the decomposed files for full coverage.
 *
 * Tests error handling in Container.preparePortfolio() which uses Promise.all()
 * These tests cover the CURRENT behavior (Promise.all - fail fast on first error)
 * and document FUTURE behavior (Promise.allSettled - continue despite failures)
 *
 * Current implementation: src/di/Container.ts:342 - await Promise.all([
 *   migrationManager.needsMigration(),
 *   portfolioManager.exists()
 * ])
 *
 * Test Coverage:
 * 1. All parallel checks succeed (happy path)
 * 2. Migration check fails
 * 3. Portfolio check fails
 * 4. Multiple checks fail
 * 5. Timeout during parallel operations
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DollhouseContainer } from '../../src/di/Container.js';
import { assertTiming, getTimingThreshold } from '../helpers/timing-thresholds.js';
import { createIsolatedContainer, type IsolatedContainer } from '../helpers/integration-container.js';

describe('Container Startup - Error Scenarios', () => {
  let container: DollhouseContainer;
  let env: IsolatedContainer;

  beforeEach(async () => {
    env = await createIsolatedContainer();
    container = env.container;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    await env.dispose();
  });

  describe('Happy Path - All Parallel Checks Succeed', () => {
    // Timing test - skip here, covered in Container.startup-timing.test.ts
    it.skip('should complete parallel checks successfully when no migration needed', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      // Mock successful checks
      const needsMigrationSpy = jest.spyOn(migrationManager, 'needsMigration')
        .mockResolvedValue(false);
      const existsSpy = jest.spyOn(portfolioManager, 'exists')
        .mockResolvedValue(true);

      const startTime = Date.now();
      await container.preparePortfolio();
      const elapsed = Date.now() - startTime;

      expect(needsMigrationSpy).toHaveBeenCalledTimes(1);
      expect(existsSpy).toHaveBeenCalledTimes(1);

      // Verify it was actually parallel (not sequential)
      // Environment-specific thresholds: strict locally, lenient in CI
      const threshold = assertTiming(elapsed, 'container-parallel-checks', 'preparePortfolio');
      expect(elapsed).toBeLessThan(threshold);
    });

    // Timing test - skip here, covered in Container.startup-timing.test.ts
    it.skip('should run checks in parallel for optimal performance', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      const checkDelay = 100; // ms
      const checkStartTimes: number[] = [];

      jest.spyOn(migrationManager, 'needsMigration').mockImplementation(async () => {
        checkStartTimes.push(Date.now());
        await new Promise(resolve => setTimeout(resolve, checkDelay));
        return false;
      });

      jest.spyOn(portfolioManager, 'exists').mockImplementation(async () => {
        checkStartTimes.push(Date.now());
        await new Promise(resolve => setTimeout(resolve, checkDelay));
        return true;
      });

      const startTime = Date.now();
      await container.preparePortfolio();
      const totalTime = Date.now() - startTime;

      // If parallel, should take ~100ms, not 200ms (sequential)
      // Environment-specific thresholds: strict locally, lenient in CI
      const threshold = assertTiming(totalTime, 'container-parallel-checks', 'parallel performance');
      expect(totalTime).toBeLessThan(threshold);

      // Both should start around the same time (best-effort check in multi-worker environment)
      expect(checkStartTimes).toHaveLength(2);
      const timeDiff = Math.abs(checkStartTimes[1] - checkStartTimes[0]);
      // Environment-specific threshold for start time difference
      const startDiffThreshold = getTimingThreshold('parallel-start-diff');
      expect(timeDiff).toBeLessThan(startDiffThreshold);
    });

    it('should proceed with migration when needed', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      jest.spyOn(migrationManager, 'needsMigration').mockResolvedValue(true);
      jest.spyOn(portfolioManager, 'exists').mockResolvedValue(false);

      const migrateSpy = jest.spyOn(migrationManager, 'migrate').mockResolvedValue({
        success: true,
        migratedCount: 5,
        errors: [],
        backedUp: true,
        backupPath: '/test/backup'
      });

      const initializeSpy = jest.spyOn(portfolioManager, 'initialize').mockResolvedValue();

      await container.preparePortfolio();

      expect(migrateSpy).toHaveBeenCalledWith({ backup: true });
      expect(initializeSpy).toHaveBeenCalled();
    });
  });

  describe('Error Scenario 1 - Migration Check Fails', () => {
    it('IMPROVED BEHAVIOR: should log warning and continue when migration check throws', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      const migrationError = new Error('Migration check failed: filesystem error');
      jest.spyOn(migrationManager, 'needsMigration').mockRejectedValue(migrationError);
      jest.spyOn(portfolioManager, 'exists').mockResolvedValue(true);

      // IMPROVED: Promise.allSettled captures both results
      // With portfolio check succeeding, can continue (logs warning for migration check failure)
      await expect(container.preparePortfolio()).resolves.not.toThrow();
    });

    it('IMPROVED BEHAVIOR: should handle migration service unavailable and continue', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      jest.spyOn(migrationManager, 'needsMigration')
        .mockRejectedValue(new Error('Migration service not initialized'));
      jest.spyOn(portfolioManager, 'exists').mockResolvedValue(true);

      // IMPROVED: Logs warning but continues since portfolio check succeeded
      await expect(container.preparePortfolio()).resolves.not.toThrow();
    });

    it('IMPROVED BEHAVIOR: should handle permission errors during migration check and continue', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      const permissionError = new Error('EACCES: permission denied');
      (permissionError as any).code = 'EACCES';

      jest.spyOn(migrationManager, 'needsMigration').mockRejectedValue(permissionError);
      jest.spyOn(portfolioManager, 'exists').mockResolvedValue(true);

      // IMPROVED: Logs warning but continues since portfolio check succeeded
      await expect(container.preparePortfolio()).resolves.not.toThrow();
    });
  });

  describe('Error Scenario 2 - Portfolio Check Fails', () => {
    it('CURRENT BEHAVIOR: should fail fast when portfolio check throws', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      jest.spyOn(migrationManager, 'needsMigration').mockResolvedValue(false);

      const portfolioError = new Error('Portfolio check failed: disk full');
      jest.spyOn(portfolioManager, 'exists').mockRejectedValue(portfolioError);

      await expect(container.preparePortfolio()).rejects.toThrow('Portfolio check failed');
    });

    it('should handle portfolio filesystem errors', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      jest.spyOn(migrationManager, 'needsMigration').mockResolvedValue(false);

      const fsError = new Error('ENOENT: no such file or directory');
      (fsError as any).code = 'ENOENT';
      jest.spyOn(portfolioManager, 'exists').mockRejectedValue(fsError);

      await expect(container.preparePortfolio()).rejects.toThrow('ENOENT');
    });

    it('should handle corrupted portfolio state', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      jest.spyOn(migrationManager, 'needsMigration').mockResolvedValue(false);
      jest.spyOn(portfolioManager, 'exists')
        .mockRejectedValue(new Error('Invalid portfolio metadata: JSON parse error'));

      await expect(container.preparePortfolio()).rejects.toThrow('Invalid portfolio metadata');
    });
  });

  describe('Error Scenario 3 - Multiple Checks Fail', () => {
    it('CURRENT BEHAVIOR: Promise.all returns first rejection only', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      // Both fail, but Promise.all returns whichever rejects first
      const error1 = new Error('Migration check error');
      const error2 = new Error('Portfolio check error');

      // Issue #506: Use deterministic promise ordering instead of ms-level timeouts.
      // Migration rejects immediately, portfolio rejects on next microtask.
      jest.spyOn(migrationManager, 'needsMigration').mockRejectedValue(error1);

      jest.spyOn(portfolioManager, 'exists').mockImplementation(async () => {
        // Yield to let migration rejection propagate first
        await Promise.resolve();
        throw error2;
      });

      // Will get the first rejection
      await expect(container.preparePortfolio()).rejects.toThrow('Migration check error');

      // Note: We never observe the second error in current implementation
    });

    it('CURRENT BEHAVIOR: second error is lost with Promise.all', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      const criticalError = new Error('CRITICAL: Data corruption detected');
      const warningError = new Error('WARNING: Slow disk performance');

      // First to reject determines the error thrown
      jest.spyOn(migrationManager, 'needsMigration').mockRejectedValue(criticalError);
      jest.spyOn(portfolioManager, 'exists').mockRejectedValue(warningError);

      try {
        await container.preparePortfolio();
        expect.fail('Should have thrown');
      } catch (error) {
        // We only get one of the errors - lose visibility into all failures
        expect((error as Error).message).toMatch(/CRITICAL|WARNING/);
      }
    });

    it('documents information loss with current Promise.all approach', async () => {
      // This test shows what we LOSE with Promise.all
      const promises = [
        Promise.reject(new Error('Database unreachable')),
        Promise.reject(new Error('Cache service down')),
        Promise.reject(new Error('Config file missing'))
      ];

      // With Promise.all, we only see the first error
      try {
        await Promise.all(promises);
        expect.fail('Should have rejected');
      } catch (error) {
        expect((error as Error).message).toBe('Database unreachable');
        // Lost information about cache and config problems!
      }

      // With Promise.allSettled, we see all errors
      const results = await Promise.allSettled(promises);
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map(r => r.reason.message);

      expect(errors).toEqual([
        'Database unreachable',
        'Cache service down',
        'Config file missing'
      ]);
    });
  });

  describe('Error Scenario 4 - Timeout During Parallel Operations', () => {
    it('should handle slow migration check', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      const slowCheckDuration = 5000; // 5 seconds

      jest.spyOn(migrationManager, 'needsMigration').mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, slowCheckDuration));
        return false;
      });

      jest.spyOn(portfolioManager, 'exists').mockResolvedValue(true);

      const startTime = Date.now();
      await container.preparePortfolio();
      const elapsed = Date.now() - startTime;

      // Currently no timeout mechanism - waits indefinitely
      expect(elapsed).toBeGreaterThanOrEqual(slowCheckDuration - 100);
    }, 10000); // Increase Jest timeout

    it('should handle hanging operations (documents need for timeout)', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      // Issue #506: Use AbortController to cleanly cancel the hanging promise
      // so the test doesn't leak resources.
      const abortController = new AbortController();

      jest.spyOn(migrationManager, 'needsMigration').mockImplementation(() => {
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(new Error('Aborted'));
          abortController.signal.addEventListener('abort', onAbort);
        });
      });

      jest.spyOn(portfolioManager, 'exists').mockResolvedValue(true);

      // Race against a timeout, then abort cleanly
      const preparePromise = container.preparePortfolio();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Test timeout')), 1000)
      );

      await expect(Promise.race([preparePromise, timeoutPromise])).rejects.toThrow('Test timeout');

      // Clean up: abort the hanging promise to prevent resource leak
      abortController.abort();
    }, 5000);

    // Timing test - skip here, covered in Container.startup-timing.test.ts
    it.skip('should measure actual parallel execution time', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      const checkDuration = 200; // ms each

      jest.spyOn(migrationManager, 'needsMigration').mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, checkDuration));
        return false;
      });

      jest.spyOn(portfolioManager, 'exists').mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, checkDuration));
        return true;
      });

      const startTime = Date.now();
      await container.preparePortfolio();
      const elapsed = Date.now() - startTime;

      // Parallel execution should be ~200ms, not 400ms (sequential)
      // Environment-specific thresholds: strict locally, lenient in CI
      const threshold = assertTiming(elapsed, 'container-parallel-checks', 'parallel execution time');
      expect(elapsed).toBeLessThan(threshold);
      expect(elapsed).toBeGreaterThanOrEqual(checkDuration - 100);
    });
  });

  describe('Error Scenario 5 - Migration Execution Failures', () => {
    it('should handle migration execution errors after successful checks', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      jest.spyOn(migrationManager, 'needsMigration').mockResolvedValue(true);
      jest.spyOn(portfolioManager, 'exists').mockResolvedValue(false);

      // Migration check succeeds, but execution fails
      jest.spyOn(migrationManager, 'migrate').mockResolvedValue({
        success: false,
        migratedCount: 0,
        errors: ['Failed to migrate persona1.md', 'Failed to migrate persona2.md'],
        backedUp: false
      });

      // Should not throw, but logs errors
      await container.preparePortfolio();
    });

    it('should handle partial migration success', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      jest.spyOn(migrationManager, 'needsMigration').mockResolvedValue(true);
      jest.spyOn(portfolioManager, 'exists').mockResolvedValue(false);

      jest.spyOn(migrationManager, 'migrate').mockResolvedValue({
        success: false, // Marked as failure due to some errors
        migratedCount: 3,
        errors: ['Failed to migrate persona4.md'],
        backedUp: true,
        backupPath: '/test/backup'
      });

      const initializeSpy = jest.spyOn(portfolioManager, 'initialize').mockResolvedValue();

      await container.preparePortfolio();

      // Should still initialize portfolio after partial migration
      expect(initializeSpy).toHaveBeenCalled();
    });
  });

  describe('FUTURE: Promise.allSettled Benefits', () => {
    it('demonstrates collecting all startup check results', async () => {
      const checks = [
        Promise.resolve({ check: 'migration', needed: false }),
        Promise.resolve({ check: 'portfolio', exists: true }),
        Promise.resolve({ check: 'config', valid: true })
      ];

      const results = await Promise.allSettled(checks);

      // All results available regardless of individual failures
      expect(results.every(r => r.status === 'fulfilled')).toBe(true);

      const values = results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
        .map(r => r.value);

      expect(values).toHaveLength(3);
    });

    it('demonstrates better error reporting with Promise.allSettled', async () => {
      const checks = [
        Promise.reject(new Error('Migration check failed')),
        Promise.reject(new Error('Portfolio corrupted')),
        Promise.resolve({ config: 'valid' })
      ];

      const results = await Promise.allSettled(checks);

      // Can collect ALL errors, not just the first
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map(r => r.reason.message);

      const successes = results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
        .map(r => r.value);

      expect(errors).toEqual(['Migration check failed', 'Portfolio corrupted']);
      expect(successes).toEqual([{ config: 'valid' }]);

      // FUTURE: Could report all failures in single error message
      const errorReport = errors.join('; ');
      expect(errorReport).toBe('Migration check failed; Portfolio corrupted');
    });
  });
});
