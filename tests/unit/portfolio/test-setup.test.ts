/**
 * Unit tests for test-setup.ts test isolation utilities
 *
 * Covers setupTestEnvironment() — see issue #1096.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  clearSuiteDirectory,
  resetSingletons
} from './test-setup.js';

interface SingletonClass {
  instance: unknown;
}

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

  describe('cleanupTestEnvironment', () => {
    it('restores the original HOME environment variable', async () => {
      const returnedOriginalHome = await setupTestEnvironment(false);
      await cleanupTestEnvironment(returnedOriginalHome, false);

      expect(process.env.HOME).toBe(returnedOriginalHome);
    });

    it('removes the temp directory when cleanupFiles=true', async () => {
      const returnedOriginalHome = await setupTestEnvironment(false);
      const tempDir = process.env.HOME as string;

      await cleanupTestEnvironment(returnedOriginalHome, true);

      expect(await pathExists(tempDir)).toBe(false);
    });

    it('skips removal when cleanupFiles=false', async () => {
      const returnedOriginalHome = await setupTestEnvironment(false);
      const tempDir = process.env.HOME as string;

      await cleanupTestEnvironment(returnedOriginalHome, false);

      expect(await pathExists(tempDir)).toBe(true);

      // Manual cleanup so the temp dir doesn't linger on disk
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('does not delete the suite directory during individual test cleanup', async () => {
      const suiteHome = await setupTestEnvironment(true);
      const suiteTempDir = process.env.HOME as string;

      // Simulate an individual test that reused the suite dir and then cleaned up
      await cleanupTestEnvironment(suiteHome, true);

      expect(await pathExists(suiteTempDir)).toBe(true);

      await clearSuiteDirectory(true);
    });

    it('handles cleanup errors gracefully', async () => {
      const returnedOriginalHome = await setupTestEnvironment(false);
      const tempDir = process.env.HOME as string;

      // Remove the directory out-of-band so fs.rm inside cleanup hits a missing path;
      // fs.rm with force:true should not throw for a missing path either way.
      await fs.rm(tempDir, { recursive: true, force: true });

      await expect(cleanupTestEnvironment(returnedOriginalHome, true)).resolves.not.toThrow();
      expect(process.env.HOME).toBe(returnedOriginalHome);
    });
  });

  describe('clearSuiteDirectory', () => {
    it('removes the suite directory when cleanupFiles=true', async () => {
      await setupTestEnvironment(true);
      const suiteTempDir = process.env.HOME as string;

      await clearSuiteDirectory(true);

      expect(await pathExists(suiteTempDir)).toBe(false);
    });

    it('resets the suite directory cache', async () => {
      await setupTestEnvironment(true);
      const firstSuiteDir = process.env.HOME as string;
      await clearSuiteDirectory(true);

      // If the cache weren't reset, this call would reuse firstSuiteDir instead
      // of creating a fresh one.
      await setupTestEnvironment(true);
      const secondSuiteDir = process.env.HOME as string;

      expect(secondSuiteDir).not.toBe(firstSuiteDir);

      await clearSuiteDirectory(true);
    });

    it('handles a missing directory gracefully when no suite directory is active', async () => {
      await expect(clearSuiteDirectory(true)).resolves.not.toThrow();
    });

    it('handles cleanup errors gracefully when the suite directory was already removed', async () => {
      await setupTestEnvironment(true);
      const suiteTempDir = process.env.HOME as string;

      // Remove it out-of-band so clearSuiteDirectory's own fs.rm hits a missing path
      await fs.rm(suiteTempDir, { recursive: true, force: true });

      await expect(clearSuiteDirectory(true)).resolves.not.toThrow();
    });
  });

  describe('resetSingletons', () => {
    it('successfully resets all singleton instances', async () => {
      await resetSingletons();

      const enhancedIndexModule = await import('../../../src/portfolio/EnhancedIndexManager.js');
      const indexConfigModule = await import('../../../src/portfolio/config/IndexConfig.js');
      const verbTriggerModule = await import('../../../src/portfolio/VerbTriggerManager.js');
      const relationshipModule = await import('../../../src/portfolio/RelationshipManager.js');

      expect((enhancedIndexModule.EnhancedIndexManager as unknown as SingletonClass).instance).toBeNull();
      expect((indexConfigModule.IndexConfigManager as unknown as SingletonClass).instance).toBeNull();
      expect((verbTriggerModule.VerbTriggerManager as unknown as SingletonClass).instance).toBeNull();
      expect((relationshipModule.RelationshipManager as unknown as SingletonClass).instance).toBeNull();
    });

    it('works with the ES module dynamic import context', async () => {
      // resetSingletons relies on await import(...) rather than require(); confirm
      // it resolves cleanly under this project's ESM test setup.
      await expect(resetSingletons()).resolves.toBeUndefined();
    });

    it('can be called multiple times in a row without error', async () => {
      await resetSingletons();
      await expect(resetSingletons()).resolves.toBeUndefined();
    });
  });
});
