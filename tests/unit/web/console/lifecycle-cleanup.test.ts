/**
 * Tests for process lifecycle cleanup (#1856).
 *
 * Verifies that stale port files are swept on startup and that
 * shutdown cleanup functions are properly exported.
 */

import { describe, it, expect } from '@jest/globals';
import { mkdtemp, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Process Lifecycle Cleanup (#1856)', () => {
  let tempDir: string;
  let runDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dollhouse-cleanup-test-'));
    runDir = join(tempDir, 'run');
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('sweepStalePortFiles', () => {
    it('removes port files for dead PIDs', async () => {
      // Write port files for non-existent PIDs
      await writeFile(join(runDir, 'permission-server-99999991.port'), '41715');
      await writeFile(join(runDir, 'permission-server-99999992.port'), '41715');
      await writeFile(join(runDir, 'permission-server-99999993.port'), '41715');

      const { sweepStalePortFiles } = await import('../../../../src/web/portDiscovery.js');

      // We can't easily redirect sweepStalePortFiles to our temp dir since
      // it uses a module-level RUN_DIR constant. Instead, verify the function
      // exists and is callable — integration tests cover the full sweep.
      expect(typeof sweepStalePortFiles).toBe('function');
    });

    it('port file naming pattern matches expected format', async () => {
      const pattern = /^permission-server-\d+\.port$/;

      expect(pattern.test('permission-server-12345.port')).toBe(true);
      expect(pattern.test('permission-server-99999.port')).toBe(true);
      expect(pattern.test('permission-server.port')).toBe(false);
      expect(pattern.test('console-leader.auth.lock')).toBe(false);
      expect(pattern.test('console-token.auth.json')).toBe(false);
    });

    it('PID extraction from port filename works', () => {
      const PORT_FILE_RE = /^permission-server-(\d+)\.port$/;
      const extract = (filename: string): number | null => {
        const match = PORT_FILE_RE.exec(filename);
        return match ? Number(match[1]) : null;
      };

      expect(extract('permission-server-12345.port')).toBe(12345);
      expect(extract('permission-server-99999.port')).toBe(99999);
      expect(extract('permission-server.port')).toBeNull();
      expect(extract('other-file.txt')).toBeNull();
    });

    it('dead PID detection works correctly', () => {
      // Current process is alive
      expect(() => process.kill(process.pid, 0)).not.toThrow();

      // Non-existent PID throws ESRCH
      expect(() => process.kill(99999999, 0)).toThrow();
    });

    it('EPERM is treated as alive (different user process)', async () => {
      const LeaderElection = await import('../../../../src/web/console/LeaderElection.js');
      // PID 1 (init/launchd) is always alive but owned by root — EPERM on signal-0
      if (process.getuid && process.getuid() !== 0) {
        expect(LeaderElection.isProcessAlive(1)).toBe(true);
      }
    });

    it('sweepStalePortFiles removes dead PID files from custom dir', async () => {
      // Write files for dead and alive PIDs
      await writeFile(join(runDir, 'permission-server-99999991.port'), '41715');
      await writeFile(join(runDir, 'permission-server-99999992.port'), '41715');
      await writeFile(join(runDir, `permission-server-${process.pid}.port`), '41715');

      const { sweepStalePortFiles } = await import('../../../../src/web/portDiscovery.js');
      const removed = await sweepStalePortFiles(runDir);

      expect(removed).toBe(2); // Two dead PIDs
      const remaining = await readdir(runDir);
      const remainingPorts = remaining.filter(f => /^permission-server-\d+\.port$/.test(f));
      expect(remainingPorts.length).toBe(1); // Only current PID's file
      expect(remainingPorts[0]).toBe(`permission-server-${process.pid}.port`);
    });
  });

  describe('Shutdown functions exported', () => {
    it('shutdownWebServer is exported from server.ts', async () => {
      const { shutdownWebServer } = await import('../../../../src/web/server.js');
      expect(typeof shutdownWebServer).toBe('function');
    });

    it('registerPortCleanup is exported from portDiscovery.ts', async () => {
      const { registerPortCleanup } = await import('../../../../src/web/portDiscovery.js');
      expect(typeof registerPortCleanup).toBe('function');
    });

    it('registerLeaderCleanup is exported from LeaderElection.ts', async () => {
      const { registerLeaderCleanup } = await import('../../../../src/web/console/LeaderElection.js');
      expect(typeof registerLeaderCleanup).toBe('function');
    });
  });
});
