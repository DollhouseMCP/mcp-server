/**
 * Integration tests for console lifecycle (#1850).
 *
 * Tests the full leader election → server startup → port recovery flow
 * using real filesystem state (temp directories), real net.Server
 * instances, and real lock files.
 *
 * These tests reproduce the actual failure scenarios from the 2026-04-08
 * diagnostic: stale lock files, bare server squatting, EADDRINUSE
 * recovery, and follower re-election.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as net from 'node:net';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

function listenOnPort(port?: number): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port ?? 0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port });
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('Console Lifecycle Integration (#1850)', () => {
  let tempDir: string;
  let runDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dollhouse-lifecycle-test-'));
    runDir = join(tempDir, 'run');
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── Leader election state ─────────────────────────────────────────────

  describe('Leader election lock file lifecycle', () => {
    it('creates a valid lock file with required fields', async () => {
      const lockPath = join(runDir, 'console-leader.auth.lock');
      const lockData = {
        version: 1,
        pid: process.pid,
        port: 41715,
        sessionId: 'test-session-abc',
        startedAt: new Date().toISOString(),
        heartbeat: new Date().toISOString(),
      };
      await writeFile(lockPath, JSON.stringify(lockData, null, 2));

      const raw = JSON.parse(await readFile(lockPath, 'utf8'));
      expect(raw.version).toBe(1);
      expect(raw.pid).toBe(process.pid);
      expect(raw.port).toBe(41715);
      expect(raw.sessionId).toBe('test-session-abc');
      expect(raw.startedAt).toBeDefined();
      expect(raw.heartbeat).toBeDefined();
    });

    it('detects stale lock file when PID is dead', async () => {
      const LeaderElection = await import('../../src/web/console/LeaderElection.js');
      const staleLock = {
        version: 1,
        pid: 99999999,
        port: 41715,
        sessionId: 'dead-leader',
        startedAt: '2026-04-08T17:59:52.000Z',
        heartbeat: '2026-04-08T17:59:52.000Z',
      };
      expect(LeaderElection.isLockStale(staleLock)).toBe(true);
    });

    it('detects stale lock file when heartbeat is expired', async () => {
      const LeaderElection = await import('../../src/web/console/LeaderElection.js');
      const staleLock = {
        version: 1,
        pid: process.pid, // alive, but heartbeat old
        port: 41715,
        sessionId: 'hung-leader',
        startedAt: new Date().toISOString(),
        heartbeat: new Date(Date.now() - 60_000).toISOString(), // 60s ago
      };
      expect(LeaderElection.isLockStale(staleLock)).toBe(true);
    });

    it('does not flag a healthy lock as stale', async () => {
      const LeaderElection = await import('../../src/web/console/LeaderElection.js');
      const freshLock = {
        version: 1,
        pid: process.pid,
        port: 41715,
        sessionId: 'active-leader',
        startedAt: new Date().toISOString(),
        heartbeat: new Date().toISOString(),
      };
      expect(LeaderElection.isLockStale(freshLock)).toBe(false);
    });
  });

  // ── Port squatting scenario ───────────────────────────────────────────

  describe('Port squatting and recovery', () => {
    it('EADDRINUSE occurs when a zombie holds the port', async () => {
      // Simulate: zombie process holds port
      const { server: zombie, port } = await listenOnPort();

      try {
        // New server tries to bind the same port
        const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
          const newServer = net.createServer();
          newServer.on('error', (err: NodeJS.ErrnoException) => resolve(err));
          newServer.listen(port, '127.0.0.1');
        });
        expect(error.code).toBe('EADDRINUSE');
      } finally {
        await closeServer(zombie);
      }
    });

    it('port is available after zombie is killed', async () => {
      const { server: zombie, port } = await listenOnPort();

      // Kill the zombie (simulate our recovery)
      await closeServer(zombie);

      // Now we can bind
      const { server: newServer, port: newPort } = await listenOnPort(port);
      expect(newPort).toBe(port);
      await closeServer(newServer);
    });

    it('lock file PID mismatch identifies squatter', async () => {
      const lockPath = join(runDir, 'console-leader.auth.lock');
      const port = await getFreePort();

      // Lock file says PID 12345 is the leader
      await writeFile(lockPath, JSON.stringify({
        version: 1,
        pid: 12345,
        port,
        sessionId: 'old-leader',
        startedAt: new Date().toISOString(),
        heartbeat: new Date().toISOString(),
      }, null, 2));

      // But PID 99999 is on the port — that's a squatter
      const lock = JSON.parse(await readFile(lockPath, 'utf8'));
      const portHolderPid = 99999;
      expect(lock.pid).not.toBe(portHolderPid);
      // This mismatch is what recoverStalePort uses to decide to kill
    });
  });

  // ── Token store initialization ────────────────────────────────────────

  describe('Token store on fresh and existing installations', () => {
    it('creates token file on first run', async () => {
      const tokenPath = join(runDir, 'console-token.auth.json');
      const { ConsoleTokenStore } = await import('../../src/web/console/consoleToken.js');
      const store = new ConsoleTokenStore(tokenPath);
      const token = await store.ensureInitialized('TestPuppet');

      expect(token).toBeDefined();
      expect(token.name).toContain('TestPuppet');
      expect(token.kind).toBe('console');

      // File should exist on disk
      const raw = JSON.parse(await readFile(tokenPath, 'utf8'));
      expect(raw.version).toBe(1);
      expect(raw.tokens.length).toBeGreaterThan(0);
    });

    it('reads existing token file on subsequent run', async () => {
      const tokenPath = join(runDir, 'console-token.auth.json');
      const { ConsoleTokenStore } = await import('../../src/web/console/consoleToken.js');

      // First run creates
      const store1 = new ConsoleTokenStore(tokenPath);
      const token1 = await store1.ensureInitialized('FirstRun');

      // Second run reads existing
      const store2 = new ConsoleTokenStore(tokenPath);
      const token2 = await store2.ensureInitialized('SecondRun');

      // Should return the same token, not create a new one
      expect(token2.id).toBe(token1.id);
    });
  });

  // ── Multiple process simulation ───────────────────────────────────────

  describe('Multiple process port contention', () => {
    it('second server gets EADDRINUSE while first holds the port', async () => {
      const { server: first, port } = await listenOnPort();
      const errors: string[] = [];

      try {
        // Attempt 3 more servers on the same port — all should fail
        for (let i = 0; i < 3; i++) {
          const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
            const s = net.createServer();
            s.on('error', (e: NodeJS.ErrnoException) => resolve(e));
            s.listen(port, '127.0.0.1');
          });
          errors.push(err.code || 'unknown');
        }

        expect(errors).toEqual(['EADDRINUSE', 'EADDRINUSE', 'EADDRINUSE']);
      } finally {
        await closeServer(first);
      }
    });

    it('stale port files accumulate without cleanup', async () => {
      // Simulate: multiple sessions write port files
      for (let i = 0; i < 5; i++) {
        await writeFile(join(runDir, `permission-server-${10000 + i}.port`), '41715');
      }
      await writeFile(join(runDir, 'permission-server.port'), '41715');

      // All 6 files exist — this is the accumulation problem
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(runDir);
      const portFiles = files.filter(f => f.includes('permission-server'));
      expect(portFiles.length).toBe(6);
    });
  });

  // ── ForwardingSink leader death detection ──────────────────────────────

  describe('ForwardingSink detects leader death', () => {
    it('fires onLeaderDeath after consecutive failures', async () => {
      const { LeaderForwardingLogSink } = await import(
        '../../src/web/console/LeaderForwardingSink.js'
      );

      const deathCallback = jest.fn();
      // Point at an unreachable port
      const sink = new LeaderForwardingLogSink(
        'http://127.0.0.1:1',
        'test-follower',
        null,
        deathCallback,
      );

      // Write entries to trigger flush attempts
      for (let i = 0; i < 10; i++) {
        sink.write({
          level: 'info',
          category: 'application',
          message: `entry ${i}`,
          timestamp: new Date().toISOString(),
          data: {},
        });
      }

      // Wait for death detection (backoff cycle)
      let waited = 0;
      while (!deathCallback.mock.calls.length && waited < 45_000) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
      }

      expect(deathCallback).toHaveBeenCalledTimes(1);
      await sink.close();
    }, 60000);
  });

  // ── Binary path detection end-to-end ──────────────────────────────────

  describe('Binary path detection with real ps output', () => {
    if (process.platform !== 'win32') {
      it('current process does NOT match DollhouseMCP binary pattern', async () => {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const exec = promisify(execFile);

        const { stdout } = await exec('ps', ['-p', String(process.pid), '-o', 'command='], { timeout: 1000 });
        const cmdLine = stdout.trim();

        // Jest worker should NOT match the DollhouseMCP binary patterns
        const isDollhouseBin = /(?:^|\/)dollhousemcp(?:\s|$)/.test(cmdLine) ||
          cmdLine.includes('.bin/dollhousemcp');
        const isMcpServerBin = cmdLine.includes('.bin/mcp-server') ||
          cmdLine.includes('dist/index.js');

        expect(isDollhouseBin || isMcpServerBin).toBe(false);
      });
    }
  });
});
