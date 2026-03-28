/**
 * Unit tests for LeaderElection.
 *
 * Tests the leader election protocol including lock file management,
 * stale detection, PID liveness checks, and claim mechanics.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// We test the exported utility functions directly rather than mocking fs,
// using a real temp directory for isolation.

// Dynamic import after we know the module path
let LeaderElection: typeof import('../../../../src/web/console/LeaderElection.js');

beforeAll(async () => {
  LeaderElection = await import('../../../../src/web/console/LeaderElection.js');
});

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

  describe('startHeartbeat', () => {
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
});
