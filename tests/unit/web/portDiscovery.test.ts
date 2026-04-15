/**
 * Unit tests for web console port discovery.
 *
 * Tests dynamic port allocation, port file writing, cleanup, and
 * the discoverAndBindPort convenience function.
 */

import { createServer } from 'node:net';
import { readFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { findAvailablePort, writePortFile, cleanupPortFile, discoverAndBindPort } from '../../../src/web/portDiscovery.js';

const MAX_PORT_ATTEMPTS = 10;
const PORT_RANGE_DISCOVERY_ATTEMPTS = 25;

async function listenOnPort(port: number): Promise<ReturnType<typeof createServer>> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return server;
}

async function closeServers(servers: ReturnType<typeof createServer>[]): Promise<void> {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
}

async function reserveBlockedPortRange(rangeSize: number): Promise<{
  startPort: number;
  blockers: ReturnType<typeof createServer>[];
}> {
  for (let attempt = 0; attempt < PORT_RANGE_DISCOVERY_ATTEMPTS; attempt++) {
    const probe = createServer();
    const startPort = await new Promise<number>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        if (typeof address === 'object' && address) {
          resolve(address.port);
          return;
        }
        reject(new Error('Could not determine probe port'));
      });
    });
    await new Promise<void>(resolve => probe.close(() => resolve()));

    const blockers: ReturnType<typeof createServer>[] = [];
    try {
      for (let i = 0; i < rangeSize; i++) {
        blockers.push(await listenOnPort(startPort + i));
      }
      return { startPort, blockers };
    } catch {
      await closeServers(blockers);
    }
  }

  throw new Error(`Could not reserve ${rangeSize} consecutive ports for test`);
}

describe('portDiscovery', () => {
  describe('findAvailablePort', () => {
    it('should return the requested port when available', async () => {
      // Use a high port unlikely to be in use
      const port = await findAvailablePort(49152);
      expect(port).toBeGreaterThanOrEqual(49152);
      expect(port).toBeLessThanOrEqual(49162); // max 10 attempts
    });

    it('should skip to next port when requested port is in use', async () => {
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
      const { startPort, blockers } = await reserveBlockedPortRange(MAX_PORT_ATTEMPTS);

      try {
        await expect(findAvailablePort(startPort)).rejects.toThrow();
      } finally {
        await closeServers(blockers);
      }
    });
  });

  describe('writePortFile and cleanupPortFile', () => {
    const runDir = join(homedir(), '.dollhouse', 'run');
    let writtenFile: string;

    afterEach(async () => {
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

  describe('discoverAndBindPort', () => {
    afterEach(async () => {
      await cleanupPortFile();
      try {
        await unlink(join(homedir(), '.dollhouse', 'run', 'permission-server.port'));
      } catch { /* may not exist */ }
    });

    it('should return a port and write port file', async () => {
      const port = await discoverAndBindPort(49170);

      expect(port).toBeDefined();
      expect(port).toBeGreaterThanOrEqual(49170);

      // Port file should exist
      const runDir = join(homedir(), '.dollhouse', 'run');
      const content = await readFile(join(runDir, 'permission-server.port'), 'utf-8');
      expect(content).toBe(String(port));
    });

    it('should find next available port when default is taken', async () => {
      const blocker = createServer();
      const blockerPort = 49180;
      await new Promise<void>((resolve) => {
        blocker.listen(blockerPort, '127.0.0.1', () => resolve());
      });

      try {
        const port = await discoverAndBindPort(blockerPort);
        expect(port).toBeDefined();
        expect(port).toBeGreaterThan(blockerPort);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });
  });
});
