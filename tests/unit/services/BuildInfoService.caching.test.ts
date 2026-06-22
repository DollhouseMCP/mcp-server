/**
 * Unit tests for BuildInfoService caching (Issue #1948).
 *
 * Verifies that git/docker info is cached by checking that
 * repeated calls return identical results without timing overhead.
 */

import { describe, it, expect, jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule('../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: { logSecurityEvent: jest.fn() },
}));

const { BuildInfoService } = await import('../../../src/services/BuildInfoService.js');

describe('BuildInfoService caching (Issue #1948)', () => {
  it('should return identical build info on repeated calls (git/docker cached)', async () => {
    const mockFileOps = {
      readFile: jest.fn<() => Promise<string>>().mockRejectedValue(new Error('ENOENT')),
    } as any;

    const service = new BuildInfoService(mockFileOps);

    const first = await service.getBuildInfo();
    const second = await service.getBuildInfo();

    // Same git commit and branch on both calls
    expect(second.git?.commit).toBe(first.git?.commit);
    expect(second.git?.branch).toBe(first.git?.branch);
    // Same docker detection
    expect(second.runtime?.isDocker).toBe(first.runtime?.isDocker);
  });

  it('should have cached fields populated after first call', async () => {
    const mockFileOps = {
      readFile: jest.fn<() => Promise<string>>().mockRejectedValue(new Error('ENOENT')),
    } as any;

    const service = new BuildInfoService(mockFileOps);
    await service.getBuildInfo();

    // Internal caches should be set (access via any for verification)
    const svc = service as any;
    expect(svc._cachedGitInfo).toBeDefined();
    expect(svc._cachedDockerInfo).toBeDefined();
  });

  it('should cache even when git is not available', async () => {
    const mockFileOps = {
      readFile: jest.fn<() => Promise<string>>().mockRejectedValue(new Error('ENOENT')),
    } as any;

    const service = new BuildInfoService(mockFileOps);

    // getBuildInfo should work even without git (returns empty git info)
    const info = await service.getBuildInfo();
    expect(info).toBeDefined();

    // Cache should be populated regardless
    const svc = service as any;
    expect(svc._cachedGitInfo).toBeDefined();
    expect(svc._cachedDockerInfo).toBeDefined();
  });
});
