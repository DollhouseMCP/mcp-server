/**
 * BuildInfoService Parallel Error Scenario Tests
 *
 * Tests error handling in BuildInfoService.getBuildInfo() which uses Promise.allSettled()
 * These tests verify Promise.allSettled continues despite failures and returns partial results.
 *
 * Current implementation: src/services/BuildInfoService.ts uses Promise.allSettled([
 *   this.getGitInfo(),
 *   this.getDockerInfo()
 * ])
 *
 * Note: Package info and build timestamp now come from build-time generated constants,
 * so they are always available and don't need error handling.
 *
 * Test Coverage:
 * 1. All git info retrieval succeeds (happy path)
 * 2. Git command fails
 * 3. Partial git info available
 * 4. No git repository
 * 5. Git command timeout
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { BuildInfoService } from '../../../src/services/BuildInfoService.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { assertTiming, createTimingThreshold } from '../../helpers/timing-thresholds.js';

describe('BuildInfoService - Parallel Error Scenarios', () => {
  let service: BuildInfoService;
  let container: DollhouseContainer;

  beforeEach(() => {
    container = new DollhouseContainer();
    service = container.resolve<BuildInfoService>('BuildInfoService');
  });

  afterEach(async () => {
    await container.dispose();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('Happy Path - All Git Info Retrieval Succeeds', () => {
    it('should retrieve all build info components in parallel', async () => {
      const startTime = Date.now();
      const info = await service.getBuildInfo();
      const elapsed = Date.now() - startTime;

      // Verify structure is complete
      expect(info).toHaveProperty('package');
      expect(info).toHaveProperty('build');
      expect(info).toHaveProperty('runtime');
      expect(info).toHaveProperty('environment');
      expect(info).toHaveProperty('server');

      // Should be reasonably fast (parallel execution)
      // Uses environment-aware threshold: local=1000ms, CI=15000ms (Windows shell commands are slow)
      const threshold = assertTiming(elapsed, 'build-info-retrieval', 'getBuildInfo');
      expect(elapsed).toBeLessThan(threshold);
    });

    it('should execute parallel calls efficiently', async () => {
      // Create a mock implementation that tracks call times
      const callTimes: { method: string; time: number }[] = [];

      const originalGetGitInfo = (service as any).getGitInfo.bind(service);
      const originalGetDockerInfo = (service as any).getDockerInfo.bind(service);

      jest.spyOn(service as any, 'getGitInfo').mockImplementation(async () => {
        callTimes.push({ method: 'git', time: Date.now() });
        return originalGetGitInfo();
      });

      jest.spyOn(service as any, 'getDockerInfo').mockImplementation(async () => {
        callTimes.push({ method: 'docker', time: Date.now() });
        return originalGetDockerInfo();
      });

      await service.getBuildInfo();

      // Both git and docker should start around the same time (parallel)
      expect(callTimes).toHaveLength(2);
      const maxTimeDiff = Math.max(...callTimes.map(c => c.time)) - Math.min(...callTimes.map(c => c.time));
      // FIX: Use platform-specific timing tolerance (Windows scheduler has higher latency)
      // Increased tolerances to account for system load, CI environment variance, and Jest spy overhead
      // macOS CI runners can have high variance due to shared resources
      const timingTolerance = process.platform === 'win32' ? 600 : 200;
      expect(maxTimeDiff).toBeLessThan(timingTolerance); // Started within tolerance of each other
    });
  });

  describe('Error Scenario 1 - Git Command Fails', () => {
    it('IMPROVED BEHAVIOR: should return partial results when git info fails', async () => {
      // Mock getGitInfo to simulate git command failure
      jest.spyOn(service as any, 'getGitInfo').mockRejectedValue(
        new Error('git command not found')
      );

      // IMPROVED: Promise.allSettled returns partial results with fallback values
      const info = await service.getBuildInfo();

      // Should have package and docker info, but git info uses fallback
      expect(info.package).toBeDefined();
      expect(info.build.gitCommit).toBeUndefined();
      expect(info.build.gitBranch).toBeUndefined();
    });

    it('should handle git not installed', async () => {
      jest.spyOn(service as any, 'getGitInfo').mockResolvedValue({
        commit: undefined,
        branch: undefined
      });

      const info = await service.getBuildInfo();

      expect(info.build.gitCommit).toBeUndefined();
      expect(info.build.gitBranch).toBeUndefined();
      // Build type comes from build-time constant BUILD_TYPE
      expect(info.build.type).toBeDefined();
    });

    it('IMPROVED BEHAVIOR: should return partial results on git command timeout', async () => {
      // Simulate a hanging git command
      jest.spyOn(service as any, 'getGitInfo').mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        throw new Error('Command timeout');
      });

      // IMPROVED: Promise.allSettled returns partial results
      const info = await service.getBuildInfo();

      expect(info.package).toBeDefined();
      expect(info.build.gitCommit).toBeUndefined();
    }, 5000);

    it('IMPROVED BEHAVIOR: should return partial results when git stderr output occurs', async () => {
      jest.spyOn(service as any, 'getGitInfo').mockImplementation(async () => {
        const error: any = new Error('Command failed');
        error.stderr = 'fatal: not a git repository';
        throw error;
      });

      // IMPROVED: Returns partial results instead of failing
      const info = await service.getBuildInfo();

      expect(info.package).toBeDefined();
      expect(info.build.gitCommit).toBeUndefined();
    });
  });

  describe('Error Scenario 2 - Partial Git Info Available', () => {
    it('should handle case where commit available but branch fails', async () => {
      jest.spyOn(service as any, 'getGitInfo').mockResolvedValue({
        commit: 'abc123def456',
        branch: undefined
      });

      const info = await service.getBuildInfo();

      expect(info.build.gitCommit).toBe('abc123def456');
      expect(info.build.gitBranch).toBeUndefined();
      // build.type is a build-time constant from generated/version.ts, not derived from git info
      expect(info.build.type).toBeDefined();
    });

    it('should handle case where branch available but commit fails', async () => {
      jest.spyOn(service as any, 'getGitInfo').mockResolvedValue({
        commit: undefined,
        branch: 'main'
      });

      const info = await service.getBuildInfo();

      expect(info.build.gitCommit).toBeUndefined();
      expect(info.build.gitBranch).toBe('main');
    });

    it('IMPROVED BEHAVIOR: returns partial results with git and docker info', async () => {
      // Package info now comes from build-time constants, so it's always available
      // Git and Docker succeed
      jest.spyOn(service as any, 'getGitInfo').mockResolvedValue({
        commit: 'abc123',
        branch: 'main'
      });
      jest.spyOn(service as any, 'getDockerInfo').mockResolvedValue({ isDocker: true, info: 'container-123' });

      // IMPROVED: Promise.allSettled returns partial results
      const info = await service.getBuildInfo();

      // Git and docker info are preserved
      expect(info.build.gitCommit).toBe('abc123');
      expect(info.build.gitBranch).toBe('main');
      expect(info.environment.isDocker).toBe(true);

      // Package info is always available from build-time constants
      expect(info.package.name).toBeDefined();
      expect(info.package.version).toBeDefined();
    });
  });

  describe('Error Scenario 3 - No Git Repository', () => {
    it('should handle non-git environment gracefully', async () => {
      jest.spyOn(service as any, 'getGitInfo').mockResolvedValue({
        commit: undefined,
        branch: undefined
      });

      const info = await service.getBuildInfo();

      expect(info.build.gitCommit).toBeUndefined();
      expect(info.build.gitBranch).toBeUndefined();
      // Build type comes from build-time constant BUILD_TYPE
      expect(info.build.type).toBeDefined();
    });

    it('should use build-time constant for timestamp', async () => {
      jest.spyOn(service as any, 'getGitInfo').mockResolvedValue({
        commit: undefined,
        branch: undefined
      });

      const info = await service.getBuildInfo();

      // Build timestamp comes from build-time generated constants
      expect(info.build.timestamp).toBeDefined();
      // Build type is determined from the build-time BUILD_TYPE constant
      expect(info.build.type).toBeDefined();
    });
  });

  describe('Error Scenario 4 - Multiple Parallel Failures', () => {
    it('IMPROVED BEHAVIOR: Promise.allSettled collects all failures and returns fallbacks', async () => {
      const gitError = new Error('Git failed');
      const dockerError = new Error('Docker failed');

      // Make git and docker fail
      jest.spyOn(service as any, 'getGitInfo').mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        throw gitError;
      });

      jest.spyOn(service as any, 'getDockerInfo').mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        throw dockerError;
      });

      // IMPROVED: Promise.allSettled returns partial results with fallbacks
      const info = await service.getBuildInfo();

      // Git and docker failures result in fallback values
      expect(info.build.gitCommit).toBeUndefined();
      expect(info.build.gitBranch).toBeUndefined();
      expect(info.environment.isDocker).toBe(false);

      // Package info is always available from build-time constants
      expect(info.package.name).toBeDefined();
      expect(info.package.version).toBeDefined();
    });

    it('IMPROVED BEHAVIOR: now captures all error information', async () => {
      const errors = [
        new Error('Git unavailable'),
        new Error('Docker daemon not running')
      ];

      jest.spyOn(service as any, 'getGitInfo').mockRejectedValue(errors[0]);
      jest.spyOn(service as any, 'getDockerInfo').mockRejectedValue(errors[1]);

      // IMPROVED: Returns partial results instead of throwing
      const info = await service.getBuildInfo();

      // All errors are logged (check console/logger), and fallback values are used
      expect(info.build.gitCommit).toBeUndefined();
      expect(info.environment.isDocker).toBe(false);

      // Package info is always available from build-time constants
      expect(info.package.name).toBeDefined();
      expect(info.package.version).toBeDefined();
    });

    it('FUTURE: Promise.allSettled would capture all errors', async () => {
      const promises = [
        Promise.reject(new Error('Git unavailable')),
        Promise.reject(new Error('Docker daemon not running'))
      ];

      const results = await Promise.allSettled(promises);

      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map(r => r.reason.message);

      // Both errors captured
      expect(errors).toEqual([
        'Git unavailable',
        'Docker daemon not running'
      ]);

      // FUTURE: Could build partial BuildInfo with available data
      // and report all errors together
    });
  });

  describe('Error Scenario 5 - Docker Detection Failures', () => {
    it('IMPROVED BEHAVIOR: should return partial results when docker fails', async () => {
      jest.spyOn(service as any, 'getDockerInfo').mockRejectedValue(
        new Error('Docker not installed')
      );

      // IMPROVED: Promise.allSettled returns partial results
      const info = await service.getBuildInfo();

      // Should have package and git info, docker uses fallback
      expect(info.package).toBeDefined();
      expect(info.environment.isDocker).toBe(false);
      expect(info.environment.dockerInfo).toBeUndefined();
    });

    it('IMPROVED BEHAVIOR: should return partial results when docker has permission errors', async () => {
      const permError: any = new Error('Permission denied');
      permError.code = 'EACCES';

      jest.spyOn(service as any, 'getDockerInfo').mockRejectedValue(permError);

      // IMPROVED: Returns partial results with docker fallback
      const info = await service.getBuildInfo();

      expect(info.package).toBeDefined();
      expect(info.environment.isDocker).toBe(false);
    });

    it('FUTURE: should continue with partial info if docker fails', async () => {
      // This documents desired behavior with Promise.allSettled
      const promises = [
        Promise.resolve({ name: 'app', version: '1.0.0' }), // package
        Promise.resolve({ commit: 'abc123', branch: 'main' }), // git
        Promise.reject(new Error('Docker not available')) // docker
      ];

      const results = await Promise.allSettled(promises);

      const successes = results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
        .map(r => r.value);

      const failures = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map(r => r.reason.message);

      // Can extract successful data
      expect(successes).toHaveLength(2);
      expect(successes[0]).toEqual({ name: 'app', version: '1.0.0' });
      expect(successes[1]).toEqual({ commit: 'abc123', branch: 'main' });

      // And track failure
      expect(failures).toEqual(['Docker not available']);

      // FUTURE: BuildInfo could still be constructed with available data
    });
  });

  describe('Performance and Concurrency', () => {
    it('should benefit from parallel execution', async () => {
      const delay = 100; // ms per operation

      jest.spyOn(service as any, 'getGitInfo').mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, delay));
        return { commit: 'abc', branch: 'main' };
      });

      jest.spyOn(service as any, 'getDockerInfo').mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, delay));
        return { isDocker: true, info: 'container-123' };
      });

      const startTime = Date.now();
      await service.getBuildInfo();
      const elapsed = Date.now() - startTime;

      // Parallel should be ~100ms, not 200ms (sequential)
      // Use CI-aware thresholds: local=250ms (2.5x delay), CI=600ms (6x delay)
      // CI threshold accounts for Windows scheduling delays, system load, and timer resolution
      const { threshold } = createTimingThreshold(delay * 2.5, 2.4); // 250ms local, 600ms CI
      expect(elapsed).toBeLessThan(threshold);
      // Lower bound ensures operations actually ran (fast systems may skip mocks)
      const lowerBound = delay - 60;
      expect(elapsed).toBeGreaterThanOrEqual(lowerBound);
    });

    it('should handle concurrent getBuildInfo calls', async () => {
      const promises = [
        service.getBuildInfo(),
        service.getBuildInfo(),
        service.getBuildInfo()
      ];

      const results = await Promise.all(promises);

      expect(results).toHaveLength(3);
      results.forEach(info => {
        expect(info).toHaveProperty('package');
        expect(info).toHaveProperty('build');
      });

      // Package info should be same (from build-time constants)
      expect(results[0].package).toEqual(results[1].package);
      expect(results[1].package).toEqual(results[2].package);
    });
  });

  describe('FUTURE: Promise.allSettled Benefits for BuildInfo', () => {
    it('demonstrates building partial BuildInfo from available data', async () => {
      const [gitResult, dockerResult] = await Promise.allSettled([
        Promise.reject(new Error('Git unavailable')),
        Promise.resolve({ isDocker: true, info: 'container-abc123' })
      ]);

      // Extract successful values
      const dockerInfo = dockerResult.status === 'fulfilled' ? dockerResult.value : null;

      // Can build partial BuildInfo
      expect(dockerInfo).toEqual({ isDocker: true, info: 'container-abc123' });

      // Git failure doesn't prevent using available data
      expect(gitResult.status).toBe('rejected');

      // Service constructs BuildInfo with:
      // - Package info: always available from build-time constants
      // - Git info: fallback to undefined
      // - Docker info: available
    });

    it('demonstrates comprehensive error reporting with Promise.allSettled', async () => {
      const results = await Promise.allSettled([
        Promise.reject(new Error('Git command timeout')),
        Promise.reject(new Error('Docker daemon not running'))
      ]);

      const allErrors = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map(r => r.reason.message);

      // All errors captured
      expect(allErrors).toHaveLength(2);
      expect(allErrors).toContain('Git command timeout');
      expect(allErrors).toContain('Docker daemon not running');

      // FUTURE: Could present comprehensive error report:
      const errorReport = `Build info collection failed:\n${allErrors.map(e => `  - ${e}`).join('\n')}`;
      expect(errorReport).toContain('Build info collection failed:');
      expect(errorReport).toContain('timeout');
      expect(errorReport).toContain('Docker');
    });
  });
});
