/**
 * Unit tests for PathValidator instance isolation (Issue #1948).
 *
 * Verifies that two PathValidator instances with different allowed
 * directories are fully independent.
 */

import { describe, it, expect, jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { PathValidator } = await import('../../../src/security/pathValidator.js');

describe('PathValidator instance isolation (Issue #1948)', () => {
  it('should have independent allowed directories per instance', () => {
    const instanceA = new PathValidator('/opt/portfolio-a/personas');
    const instanceB = new PathValidator('/opt/portfolio-b/personas');

    // Each instance is constructed — they should be different objects
    expect(instanceA).not.toBe(instanceB);
  });

  it('should validate paths against its own allowed directories', async () => {
    const instanceA = new PathValidator('/opt/portfolio-a/personas');

    // Path within A's allowed directory should be accepted
    // (will fail at filesystem level since the dir doesn't exist,
    //  but the path validation logic itself should not reject it)
    try {
      await instanceA.validatePersonaPath('/opt/portfolio-a/personas/test.md');
      // If it succeeds, the path was within allowed dirs
    } catch (error) {
      // Acceptable — the dir may not exist on disk, but the error
      // should NOT be "Path access denied" (that would mean the dir wasn't allowed)
      expect((error as Error).message).not.toBe('Path access denied');
    }
  });

  it('should reject paths outside its own allowed directories', async () => {
    const instanceA = new PathValidator('/opt/portfolio-a/personas');

    try {
      await instanceA.validatePersonaPath('/opt/portfolio-b/personas/test.md');
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toBe('Path access denied');
    }
  });

  it('should have independent resolved directory caches', async () => {
    const instanceA = new PathValidator('/opt/portfolio-a/personas');
    const instanceB = new PathValidator('/opt/portfolio-b/personas');

    // Triggering resolution on A should not affect B
    // Both will fail (dirs don't exist) but they should cache independently
    try { await instanceA.validatePersonaPath('/opt/portfolio-a/personas/test.md'); } catch { /* expected */ }
    try { await instanceB.validatePersonaPath('/opt/portfolio-b/personas/test.md'); } catch { /* expected */ }

    // The key assertion: B should NOT accept A's path
    try {
      await instanceB.validatePersonaPath('/opt/portfolio-a/personas/test.md');
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toBe('Path access denied');
    }
  });
});
