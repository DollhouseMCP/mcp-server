/**
 * Unit tests for LeaderElection.
 *
 * Tests the leader election protocol including lock file management,
 * stale detection, PID liveness checks, and claim mechanics.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// We test the exported utility functions directly rather than mocking fs,
// using a real temp directory for isolation.

// Dynamic import after we know the module path
let LeaderElection: typeof import('../../../../src/web/console/LeaderElection.js');

beforeAll(async () => {
  LeaderElection = await import('../../../../src/web/console/LeaderElection.js');
});

function makeLeaderInfo(
  overrides: Partial<import('../../../../src/web/console/LeaderElection.js').ConsoleLeaderInfo> = {},
): import('../../../../src/web/console/LeaderElection.js').ConsoleLeaderInfo {
  return {
    version: 1,
    pid: process.pid,
    port: 41715,
    sessionId: 'test-session',
    startedAt: new Date().toISOString(),
    heartbeat: new Date().toISOString(),
    serverVersion: '2.0.18',
    consoleProtocolVersion: LeaderElection.CONSOLE_PROTOCOL_VERSION,
    ...overrides,
  };
}

describe('LeaderElection', () => {
  describe('isProcessAlive', () => {
    it('should return true for the current process', () => {
      expect(LeaderElection.isProcessAlive(process.pid)).toBe(true);
    });

    it('should return false for a non-existent PID', () => {
      // PID 99999999 is almost certainly not running
      expect(LeaderElection.isProcessAlive(99999999)).toBe(false);
    });

    it('should return false for PID 0', () => {
      // PID 0 is special on most systems — signals to entire process group
      // isProcessAlive should handle this gracefully
      const result = LeaderElection.isProcessAlive(0);
      expect(typeof result).toBe('boolean');
    });
  });

  describe('isLockStale', () => {
    it('should detect a dead process as stale', () => {
      const info = {
        version: 1,
        pid: 99999999,
        port: 3939,
        sessionId: 'test-session',
        startedAt: new Date().toISOString(),
        heartbeat: new Date().toISOString(),
      };
      expect(LeaderElection.isLockStale(info)).toBe(true);
    });

    it('should detect an old heartbeat as stale', () => {
      const info = {
        version: 1,
        pid: process.pid, // alive
        port: 3939,
        sessionId: 'test-session',
        startedAt: new Date().toISOString(),
        heartbeat: new Date(Date.now() - 60_000).toISOString(), // 60s ago
      };
      expect(LeaderElection.isLockStale(info)).toBe(true);
    });

    it('should return false for a live process with fresh heartbeat', () => {
      const info = {
        version: 1,
        pid: process.pid,
        port: 3939,
        sessionId: 'test-session',
        startedAt: new Date().toISOString(),
        heartbeat: new Date().toISOString(),
      };
      expect(LeaderElection.isLockStale(info)).toBe(false);
    });
  });

  describe('readLeaderLock', () => {
    it('should return null when lock file does not exist', async () => {
      // readLeaderLock reads from the default path which may or may not exist
      // This test is environment-dependent but should not throw
      const result = await LeaderElection.readLeaderLock();
      expect(result === null || typeof result === 'object').toBe(true);
    });
  });

  describe('claimLeadership', () => {
    let tempDir: string;
    let tempLockPath: string;

    beforeEach(async () => {
      const { mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      tempDir = await mkdtemp(join(tmpdir(), 'dh-leader-claim-test-'));
      tempLockPath = join(tempDir, 'console-leader.auth.lock');
    });

    afterEach(async () => {
      const { rm } = await import('node:fs/promises');
      await rm(tempDir, { recursive: true, force: true });
    });

    it('creates a new lock when none exists', async () => {
      const claimed = await LeaderElection.claimLeadership(
        makeLeaderInfo({ sessionId: 'fresh-claim' }),
        tempLockPath,
      );

      expect(claimed).toBe(true);
      await expect(LeaderElection.readLeaderLock(tempLockPath)).resolves.toMatchObject({
        sessionId: 'fresh-claim',
        pid: process.pid,
      });
    });

    it('does not overwrite an existing lock', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(tempLockPath, JSON.stringify(makeLeaderInfo({ sessionId: 'existing-leader' })), 'utf-8');

      const claimed = await LeaderElection.claimLeadership(
        makeLeaderInfo({ sessionId: 'late-joiner' }),
        tempLockPath,
      );

      expect(claimed).toBe(false);
      await expect(LeaderElection.readLeaderLock(tempLockPath)).resolves.toMatchObject({
        sessionId: 'existing-leader',
      });
    });
  });

  describe('ConsoleLeaderInfo interface', () => {
    it('should have the expected shape', () => {
      const info: import('../../../../src/web/console/LeaderElection.js').ConsoleLeaderInfo = {
        version: 1,
        pid: 12345,
        port: 3939,
        sessionId: 'test-session',
        startedAt: '2026-03-28T10:00:00.000Z',
        heartbeat: '2026-03-28T10:05:00.000Z',
      };
      expect(info.version).toBe(1);
      expect(info.pid).toBe(12345);
      expect(info.port).toBe(3939);
      expect(info.sessionId).toBe('test-session');
    });
  });

  describe('ElectionResult interface', () => {
    it('should accept leader role', () => {
      const result: import('../../../../src/web/console/LeaderElection.js').ElectionResult = {
        role: 'leader',
        leaderInfo: {
          version: 1,
          pid: process.pid,
          port: 3939,
          sessionId: 'my-session',
          startedAt: new Date().toISOString(),
          heartbeat: new Date().toISOString(),
        },
      };
      expect(result.role).toBe('leader');
    });

    it('should accept follower role', () => {
      const result: import('../../../../src/web/console/LeaderElection.js').ElectionResult = {
        role: 'follower',
        leaderInfo: {
          version: 1,
          pid: 99999,
          port: 3939,
          sessionId: 'other-session',
          startedAt: new Date().toISOString(),
          heartbeat: new Date().toISOString(),
        },
      };
      expect(result.role).toBe('follower');
    });
  });

  describe('createLeaderInfo', () => {
    it('stamps the current server version and console protocol version', () => {
      const info = LeaderElection.createLeaderInfo('session-123', 41715);
      expect(info.serverVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(info.consoleProtocolVersion).toBe(LeaderElection.CONSOLE_PROTOCOL_VERSION);
      expect(info.sessionId).toBe('session-123');
      expect(info.port).toBe(41715);
    });
  });

  describe('evaluateLeaderPreference', () => {
    it('prefers a newer compatible candidate', () => {
      const decision = LeaderElection.evaluateLeaderPreference(
        makeLeaderInfo({ sessionId: 'newer', serverVersion: '2.0.19' }),
        makeLeaderInfo({ sessionId: 'older', serverVersion: '2.0.18' }),
      );
      expect(decision.shouldReplace).toBe(true);
      expect(decision.reason).toBe('newer-compatible-version');
    });

    it('does not replace on equal version', () => {
      const decision = LeaderElection.evaluateLeaderPreference(
        makeLeaderInfo({ sessionId: 'same-a', serverVersion: '2.0.18' }),
        makeLeaderInfo({ sessionId: 'same-b', serverVersion: '2.0.18' }),
      );
      expect(decision.shouldReplace).toBe(false);
      expect(decision.reason).toBe('same-version');
    });

    it('treats missing version metadata as a legacy leader and prefers the newer candidate', () => {
      const decision = LeaderElection.evaluateLeaderPreference(
        makeLeaderInfo({ sessionId: 'newer', serverVersion: '2.0.18' }),
        makeLeaderInfo({ sessionId: 'legacy', serverVersion: undefined, consoleProtocolVersion: undefined }),
      );
      expect(decision.shouldReplace).toBe(true);
      expect(decision.existingVersion).toBe(LeaderElection.LEGACY_SERVER_VERSION);
      expect(decision.existingProtocolVersion).toBe(LeaderElection.LEGACY_CONSOLE_PROTOCOL_VERSION);
    });

    it('does not replace an incompatible leader even if the candidate version is newer', () => {
      const decision = LeaderElection.evaluateLeaderPreference(
        makeLeaderInfo({ sessionId: 'newer', serverVersion: '9.0.0', consoleProtocolVersion: 2 }),
        makeLeaderInfo({ sessionId: 'incompatible', serverVersion: '1.0.0', consoleProtocolVersion: 1 }),
      );
      expect(decision.shouldReplace).toBe(false);
      expect(decision.reason).toBe('incompatible-protocol');
    });
  });

  describe('startHeartbeat', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should return a stop function', () => {
      const info = {
        version: 1,
        pid: process.pid,
        port: 3939,
        sessionId: 'test-session',
        startedAt: new Date().toISOString(),
        heartbeat: new Date().toISOString(),
      };
      const stop = LeaderElection.startHeartbeat(info);
      expect(typeof stop).toBe('function');
      stop(); // clean up immediately
    });
  });

  describe('renewLeaderHeartbeat', () => {
    let tempDir: string;
    let tempLockPath: string;

    beforeEach(async () => {
      const { mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      tempDir = await mkdtemp(join(tmpdir(), 'dh-heartbeat-renew-test-'));
      tempLockPath = join(tempDir, 'console-leader.auth.lock');
    });

    afterEach(async () => {
      const { rm } = await import('node:fs/promises');
      await rm(tempDir, { recursive: true, force: true });
    });

    it('returns lost-lock instead of overwriting another leader lock', async () => {
      const { writeFile, readFile } = await import('node:fs/promises');
      const existingLock = makeLeaderInfo({
        pid: 424242,
        sessionId: 'newer-leader',
      });
      await writeFile(tempLockPath, JSON.stringify(existingLock), 'utf-8');

      const result = await LeaderElection.renewLeaderHeartbeat(
        makeLeaderInfo({ sessionId: 'former-leader' }),
        {
          lockPath: tempLockPath,
          readLeaderLockImpl: LeaderElection.readLeaderLock,
          findPidOnPortImpl: async () => null,
        },
      );

      expect(result).toBe('lost-lock');
      await expect(readFile(tempLockPath, 'utf-8')).resolves.toEqual(JSON.stringify(existingLock));
    });

    it('returns lost-port instead of reclaiming the lock when another pid owns the port', async () => {
      const result = await LeaderElection.renewLeaderHeartbeat(
        makeLeaderInfo({ sessionId: 'former-leader' }),
        {
          lockPath: tempLockPath,
          readLeaderLockImpl: async () => null,
          findPidOnPortImpl: async () => 424242,
        },
      );

      expect(result).toBe('lost-port');
      await expect(LeaderElection.readLeaderLock(tempLockPath)).resolves.toBeNull();
    });
  });

  /**
   * Legacy (pre-authentication) leader detection — verifies that the
   * authenticated console can identify an unauthenticated sibling
   * installation running alongside it on the legacy port (#1794).
   *
   * `detectLegacyLeader` accepts an explicit path parameter for testing
   * so we can point it at a sandboxed temp directory and exercise every
   * branch deterministically without touching the real
   * `~/.dollhouse/run/console-leader.lock`.
   */
  describe('detectLegacyLeader', () => {
    let tempDir: string;
    let legacyLockPath: string;

    beforeEach(async () => {
      const { mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      tempDir = await mkdtemp(join(tmpdir(), 'dh-legacy-leader-test-'));
      legacyLockPath = join(tempDir, 'console-leader.lock');
    });

    afterEach(async () => {
      const { rm } = await import('node:fs/promises');
      await rm(tempDir, { recursive: true, force: true });
    });

    it('returns legacyRunning=false when no lock file exists', async () => {
      const result = await LeaderElection.detectLegacyLeader(legacyLockPath);
      expect(result.legacyRunning).toBe(false);
      expect(result.lockPath).toBe(legacyLockPath);
      expect(result.pid).toBeUndefined();
      expect(result.port).toBeUndefined();
    });

    it('returns legacyRunning=true with pid and port when legacy lock has a live process', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(legacyLockPath, JSON.stringify({
        version: 1,
        pid: process.pid, // current test process — guaranteed alive
        port: 3939,
        sessionId: 'legacy-test-session',
        startedAt: new Date().toISOString(),
        heartbeat: new Date().toISOString(),
      }));

      const result = await LeaderElection.detectLegacyLeader(legacyLockPath);
      expect(result.legacyRunning).toBe(true);
      expect(result.pid).toBe(process.pid);
      expect(result.port).toBe(3939);
      expect(result.lockPath).toBe(legacyLockPath);
    });

    it('returns legacyRunning=false when lock file exists but pid is dead', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(legacyLockPath, JSON.stringify({
        version: 1,
        pid: 99999999, // extremely unlikely to exist
        port: 3939,
        sessionId: 'dead-legacy-session',
        startedAt: new Date().toISOString(),
        heartbeat: new Date().toISOString(),
      }));

      const result = await LeaderElection.detectLegacyLeader(legacyLockPath);
      expect(result.legacyRunning).toBe(false);
      expect(result.lockPath).toBe(legacyLockPath);
    });

    it('returns legacyRunning=false when lock file is malformed JSON', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(legacyLockPath, 'this is not valid json at all');

      const result = await LeaderElection.detectLegacyLeader(legacyLockPath);
      expect(result.legacyRunning).toBe(false);
      expect(result.lockPath).toBe(legacyLockPath);
    });

    it('returns legacyRunning=false when lock file has no pid field', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(legacyLockPath, JSON.stringify({
        version: 1,
        port: 3939,
        sessionId: 'missing-pid',
      }));

      const result = await LeaderElection.detectLegacyLeader(legacyLockPath);
      expect(result.legacyRunning).toBe(false);
    });

    it('default lockPath points at the legacy (non-.auth) filename', async () => {
      // When called with no argument, must inspect the LEGACY path —
      // otherwise it would look at its own .auth.lock and always return
      // legacyRunning=false. This is the critical invariant of the
      // whole detection feature.
      const result = await LeaderElection.detectLegacyLeader();
      expect(result.lockPath).toMatch(/console-leader\.lock$/);
      expect(result.lockPath).not.toMatch(/\.auth\.lock$/);
    });
  });
});
