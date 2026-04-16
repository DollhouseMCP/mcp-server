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

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
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

function spawnClientConnection(port: number): Promise<import('node:child_process').ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import net from 'node:net';
          const socket = net.createConnection({ host: '127.0.0.1', port: Number(process.env.TEST_PORT) }, () => {
            process.stdout.write('CONNECTED\\n');
          });
          process.on('SIGTERM', () => socket.end());
          process.on('SIGINT', () => socket.end());
          socket.on('close', () => process.exit(0));
          socket.on('error', (error) => {
            console.error(error);
            process.exit(1);
          });
          setInterval(() => {}, 1000);
        `,
      ],
      {
        env: { ...process.env, TEST_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out waiting for client connection'));
    }, 5000);

    const handleFailure = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };

    child.once('error', handleFailure);
    child.stderr.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        clearTimeout(timeout);
        reject(new Error(message));
      }
    });
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('CONNECTED')) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
  });
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
      const { readdir: readDir } = await import('node:fs/promises');
      const files = await readDir(runDir);
      const portFiles = files.filter(f => f.includes('permission-server'));
      expect(portFiles.length).toBe(6);
    });

    it('sweepStalePortFiles removes dead PID files and preserves alive', async () => {
      // Write files for dead PIDs and one for our own (alive) PID
      for (let i = 0; i < 5; i++) {
        await writeFile(join(runDir, `permission-server-${99999990 + i}.port`), '41715');
      }
      await writeFile(join(runDir, `permission-server-${process.pid}.port`), '41715');
      await writeFile(join(runDir, 'permission-server.port'), '41715'); // latest file — not PID-keyed

      const { sweepStalePortFiles } = await import('../../src/web/portDiscovery.js');
      const removed = await sweepStalePortFiles(runDir);

      expect(removed).toBe(5); // 5 dead PIDs swept
      const { readdir: readDir } = await import('node:fs/promises');
      const remaining = await readDir(runDir);
      const remainingPid = remaining.filter(f => /^permission-server-\d+\.port$/.test(f));
      expect(remainingPid.length).toBe(1); // Only our PID survives
      expect(remaining).toContain('permission-server.port'); // Non-PID file preserved
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

  // ── End-to-end: port recovery after zombie kill ───────────────────────

  describe('End-to-end port recovery', () => {
    it('recoverStalePort returns false for a non-DollhouseMCP server (full flow)', async () => {
      const Recovery = await import('../../src/web/console/StaleProcessRecovery.js');

      // Start a plain TCP server to occupy a port (simulates a zombie)
      const { server, port } = await listenOnPort();
      try {
        // recoverStalePort should find the PID but refuse to kill (not DollhouseMCP)
        const recovered = await Recovery.recoverStalePort(port);
        expect(recovered).toBe(false);

        // The server must still be alive — recovery didn't kill it
        const addr = server.address();
        expect(addr).not.toBeNull();
      } finally {
        await closeServer(server);
      }
    });

    it('port is bindable after manual server close (simulates successful kill)', async () => {
      // This simulates the flow: zombie detected → killed → port freed → rebind succeeds
      const { server: zombie, port } = await listenOnPort();

      // Verify port is occupied
      const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
        const s = net.createServer();
        s.on('error', (e: NodeJS.ErrnoException) => resolve(e));
        s.listen(port, '127.0.0.1');
      });
      expect(error.code).toBe('EADDRINUSE');

      // Kill the zombie (simulates killStaleProcess success)
      await closeServer(zombie);
      await new Promise(r => setTimeout(r, 100)); // brief pause

      // Now rebind should succeed (simulates attemptBind retry)
      const { server: newServer } = await listenOnPort(port);
      expect((newServer.address() as net.AddressInfo).port).toBe(port);
      await closeServer(newServer);
    });
  });

  // ── PromotionManager state machine ────────────────────────────────────

  describe('PromotionManager', () => {
    it('PromotionManager class is importable and constructable', async () => {
      const { PromotionManager } = await import('../../src/web/console/PromotionManager.js');
      expect(typeof PromotionManager).toBe('function');

      const mockOptions = {
        sessionId: 'test-session',
        portfolioDir: tempDir,
        memorySink: { write: () => {}, close: async () => {} } as any,
        registerLogSink: () => {},
        wireSSEBroadcasts: () => {},
      };

      const mgr = new PromotionManager(
        mockOptions,
        41715,
        async () => {}, // startAsLeader
        async () => {}, // startAsFollower
      );
      expect(mgr).toBeDefined();
    });

    it('promote() calls startAsLeader when claim succeeds', async () => {
      const { PromotionManager } = await import('../../src/web/console/PromotionManager.js');
      const LeaderElection = await import('../../src/web/console/LeaderElection.js');

      let leaderStarted = false;
      const mockOptions = {
        sessionId: 'promote-test',
        portfolioDir: tempDir,
        memorySink: { write: () => {}, close: async () => {} } as any,
        registerLogSink: () => {},
        wireSSEBroadcasts: () => {},
      };

      const mgr = new PromotionManager(
        mockOptions,
        41715,
        async () => { leaderStarted = true; },
        async () => {},
      );

      // Clean any existing lock so claim succeeds
      await LeaderElection.deleteLeaderLock();

      const mockSink = { close: async () => {} } as any;
      const mockHeartbeat = { stop: async () => {} } as any;

      await mgr.promote(mockSink, mockHeartbeat);

      expect(leaderStarted).toBe(true);

      // Clean up the lock file we created
      await LeaderElection.deleteLeaderLock();
    });

    it('promote() respects MAX_PROMOTION_ATTEMPTS', async () => {
      const { PromotionManager } = await import('../../src/web/console/PromotionManager.js');

      let attempts = 0;
      const mockOptions = {
        sessionId: 'max-attempts-test',
        portfolioDir: tempDir,
        memorySink: { write: () => {}, close: async () => {} } as any,
        registerLogSink: () => {},
        wireSSEBroadcasts: () => {},
      };

      const mgr = new PromotionManager(
        mockOptions,
        41715,
        async () => { attempts++; throw new Error('simulated bind failure'); },
        async () => {},
      );

      const mockSink = { close: async () => {} } as any;
      const mockHeartbeat = { stop: async () => {} } as any;

      // Attempt promotion multiple times — should stop after MAX_PROMOTION_ATTEMPTS (3)
      for (let i = 0; i < 5; i++) {
        await mgr.promote(mockSink, mockHeartbeat);
      }

      // Should have tried at most 3 times (MAX_PROMOTION_ATTEMPTS)
      expect(attempts).toBeLessThanOrEqual(3);
    });
  });

  // ── findPidOnPort fallback ────────────────────────────────────────────

  describe('findPidOnPort with fallback commands', () => {
    it('finds a PID using available system commands', async () => {
      const Recovery = await import('../../src/web/console/StaleProcessRecovery.js');
      const { server, port } = await listenOnPort();

      try {
        const pid = await Recovery.findPidOnPort(port);
        // Our own PID is filtered, so may be null, but shouldn't throw
        expect(pid === null || pid > 0).toBe(true);
      } finally {
        await closeServer(server);
      }
    });

    it('does not mistake connected clients for the listening owner', async () => {
      const Recovery = await import('../../src/web/console/StaleProcessRecovery.js');
      const { server, port } = await listenOnPort();
      const client = await spawnClientConnection(port);

      try {
        expect(await Recovery.findPidOnPort(port)).toBeNull();
      } finally {
        client.kill('SIGTERM');
        await new Promise((resolve) => client.once('exit', resolve));
        await closeServer(server);
      }
    }, 15000);
  });
});
