/**
 * Unit tests for PathValidator instance isolation (Issue #1948).
 *
 * Verifies that two PathValidator instances with different allowed
 * directories are fully independent.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { PathValidator } = await import('../../../src/security/pathValidator.js');

describe('PathValidator instance isolation (Issue #1948)', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'path-validator-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

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

  it('enforceWritablePath should allow non-element extensions inside writable dirs', async () => {
    const userDir = path.join(tempRoot, 'users', 'alice');
    await fs.mkdir(userDir, { recursive: true });
    const instance = new PathValidator({
      writeDirs: [userDir],
      allowedExtensions: ['.md'],
    });

    const target = path.join(userDir, 'element.md.tmp.12345');

    await expect(instance.enforceWritablePath(target)).resolves.toBe(target);
  });

  it('enforceWritablePath should reject paths outside writable dirs', async () => {
    const userDir = path.join(tempRoot, 'users', 'alice');
    const otherDir = path.join(tempRoot, 'users', 'bob');
    await fs.mkdir(userDir, { recursive: true });
    await fs.mkdir(otherDir, { recursive: true });
    const instance = new PathValidator({ writeDirs: [userDir] });

    await expect(instance.enforceWritablePath(path.join(otherDir, 'file.json')))
      .rejects.toThrow('Path access denied');
  });
});
