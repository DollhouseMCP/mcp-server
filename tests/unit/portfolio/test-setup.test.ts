/**
 * Unit tests for test-setup.ts test isolation utilities
 *
 * Covers setupTestEnvironment() — see issue #1096.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { setupTestEnvironment, cleanupTestEnvironment, clearSuiteDirectory } from './test-setup.js';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe('test-setup utilities', () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
  });

  afterEach(async () => {
    // Guard against any test leaving HOME pointed at a temp dir,
    // and make sure the suite-directory cache never leaks between tests.
    process.env.HOME = originalHome;
    await clearSuiteDirectory(true);
  });

  describe('setupTestEnvironment', () => {
    it('creates a unique temporary directory', async () => {
      const returnedOriginalHome = await setupTestEnvironment(false);
      const tempDir = process.env.HOME as string;

      expect(tempDir.startsWith(os.tmpdir())).toBe(true);
      expect(path.basename(tempDir)).toContain('dollhouse-test-');
      expect(await pathExists(tempDir)).toBe(true);

      await cleanupTestEnvironment(returnedOriginalHome, true);
    });

    it('generates a unique directory name incorporating PID, timestamp, and random components', async () => {
      const home1 = await setupTestEnvironment(false);
      const dirName1 = path.basename(process.env.HOME as string);
      await cleanupTestEnvironment(home1, true);

      const home2 = await setupTestEnvironment(false);
      const dirName2 = path.basename(process.env.HOME as string);
      await cleanupTestEnvironment(home2, true);

      // Directory names follow `dollhouse-test-<pid>-<timestamp>-<random>`
      const pattern = /^dollhouse-test-(\d+)-(\d+)-([a-z0-9]+)$/;
      const match1 = dirName1.match(pattern);
      const match2 = dirName2.match(pattern);

      expect(match1).not.toBeNull();
      expect(match2).not.toBeNull();

      // PID component matches the current process
      expect(match1?.[1]).toBe(String(process.pid));
      expect(match2?.[1]).toBe(String(process.pid));

      // Distinct calls produce distinct names overall (via timestamp/random)
      expect(dirName1).not.toBe(dirName2);
    });

    it('sets up the proper directory structure (.dollhouse/portfolio)', async () => {
      const returnedOriginalHome = await setupTestEnvironment(false);
      const tempDir = process.env.HOME as string;

      expect(await pathExists(path.join(tempDir, '.dollhouse', 'portfolio'))).toBe(true);

      await cleanupTestEnvironment(returnedOriginalHome, true);
    });

    it('overrides the HOME environment variable correctly', async () => {
      const returnedOriginalHome = await setupTestEnvironment(false);
      const tempDir = process.env.HOME as string;

      expect(process.env.HOME).toBe(tempDir);
      expect(process.env.HOME).not.toBe(originalHome);

      await cleanupTestEnvironment(returnedOriginalHome, true);
    });

    it('returns the original HOME value', async () => {
      const returnedOriginalHome = await setupTestEnvironment(false);

      expect(returnedOriginalHome).toBe(originalHome || '');

      await cleanupTestEnvironment(returnedOriginalHome, true);
    });

    it('reuses the suite directory when reuseSuiteDirectory=true', async () => {
      const home1 = await setupTestEnvironment(true);
      const tempDir1 = process.env.HOME as string;

      // setupTestEnvironment doesn't restore HOME itself, so the second call
      // captures HOME as it stands after the first call (the suite temp dir).
      const home2 = await setupTestEnvironment(true);
      const tempDir2 = process.env.HOME as string;

      expect(tempDir1).toBe(tempDir2);
      expect(home1).toBe(originalHome || '');
      expect(home2).toBe(tempDir1);

      await clearSuiteDirectory(true);
    });

    it('creates a new directory when reuseSuiteDirectory=false', async () => {
      await setupTestEnvironment(true);
      const suiteTempDir = process.env.HOME as string;

      const home = await setupTestEnvironment(false);
      const freshTempDir = process.env.HOME as string;

      expect(freshTempDir).not.toBe(suiteTempDir);

      await cleanupTestEnvironment(home, true);
      await clearSuiteDirectory(true);
    });
  });
});
