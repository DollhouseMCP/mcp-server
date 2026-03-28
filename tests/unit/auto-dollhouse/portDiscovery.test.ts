/**
 * Unit tests for auto-dollhouse portDiscovery module.
 *
 * Tests dynamic port allocation, port file writing, and cleanup.
 */

import { createServer } from 'node:net';
import { readFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { findAvailablePort, writePortFile, cleanupPortFile } from '../../../src/auto-dollhouse/portDiscovery.js';

describe('portDiscovery', () => {
  describe('findAvailablePort', () => {
    it('should return the requested port when available', async () => {
      // Use a high port unlikely to be in use
      const port = await findAvailablePort(49152);
      expect(port).toBeGreaterThanOrEqual(49152);
      expect(port).toBeLessThanOrEqual(49162); // max 10 attempts
    });

    it('should skip to next port when requested port is in use', async () => {
      // Occupy a port
      const blocker = createServer();
      const blockerPort = await new Promise<number>((resolve) => {
        blocker.listen(0, '127.0.0.1', () => {
          const addr = blocker.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });

      try {
        const port = await findAvailablePort(blockerPort);
        expect(port).toBeGreaterThan(blockerPort);
        expect(port).toBeLessThanOrEqual(blockerPort + 10);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });

    it('should reject after MAX_PORT_ATTEMPTS exhausted', async () => {
      // Occupy 11 consecutive ports (more than MAX_PORT_ATTEMPTS=10)
      const blockers: ReturnType<typeof createServer>[] = [];
      const startPort = 49200;

      try {
        for (let i = 0; i <= 10; i++) {
          const server = createServer();
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(startPort + i, '127.0.0.1', () => resolve());
          });
          blockers.push(server);
        }

        await expect(findAvailablePort(startPort)).rejects.toThrow();
      } finally {
        await Promise.all(blockers.map(s => new Promise<void>(r => s.close(() => r()))));
      }
    });
  });

  describe('writePortFile and cleanupPortFile', () => {
    const runDir = join(homedir(), '.dollhouse', 'run');
    let writtenFile: string;

    afterEach(async () => {
      // Clean up any port files we created
      await cleanupPortFile();
      try {
        await unlink(join(runDir, 'permission-server.port'));
      } catch { /* may not exist */ }
    });

    it('should write port to PID-keyed file and latest file', async () => {
      writtenFile = await writePortFile(4242);

      expect(writtenFile).toContain(`permission-server-${process.pid}.port`);

      const pidContent = await readFile(writtenFile, 'utf-8');
      expect(pidContent).toBe('4242');

      const latestContent = await readFile(join(runDir, 'permission-server.port'), 'utf-8');
      expect(latestContent).toBe('4242');
    });

    it('should clean up PID-keyed file on cleanup', async () => {
      writtenFile = await writePortFile(4243);

      await cleanupPortFile();

      await expect(stat(writtenFile)).rejects.toThrow();
    });
  });
});
