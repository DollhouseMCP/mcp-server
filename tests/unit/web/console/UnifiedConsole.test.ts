/**
 * Unit tests for UnifiedConsole's legacy-console detection wiring (#1794).
 *
 * The core `detectLegacyLeader` function is tested directly in
 * `LeaderElection.test.ts`. This file asserts the *wiring* between
 * `startUnifiedConsole` and that detection function: specifically, that
 * `warnIfLegacyConsolePresent` (the extracted helper called at the top
 * of `startUnifiedConsole`) invokes `detectLegacyLeader` and emits an
 * appropriately-shaped `logger.warn` call when a legacy console is
 * running alongside the authenticated one.
 *
 * Both `detect` and `log` are passed as dependency-injected parameters
 * so tests can provide stubs without hitting real filesystem paths or
 * the real logger. This keeps the test focused on the wiring assertion
 * without standing up a full web server, leader election, or MCP
 * pipeline.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  warnIfLegacyConsolePresent,
  discoverLeaderServingPort,
  recoverLeaderBindFailure,
  evaluatePortOwnerReplacement,
  resolveFollowerAuthority,
} from '../../../../src/web/console/UnifiedConsole.js';
import type { LegacyLeaderInfo, ConsoleLeaderInfo } from '../../../../src/web/console/LeaderElection.js';

/**
 * Fake fixture path used in mock `LegacyLeaderInfo` return values.
 *
 * These strings are ONLY used as return-value payloads from stubbed
 * `detectLegacyLeader` calls — they are never passed to `fs` operations,
 * never read, never written. The test exercises the helper's routing
 * logic (does it log the warning? swallow errors? pass the port through?)
 * without touching the real filesystem.
 *
 * We deliberately do NOT use `/tmp/` here. Sonar's S5443 ("publicly
 * writable directories used safely") flags any hardcoded `/tmp/`
 * literal as a security hotspot, and the rule has no way to tell that
 * in a mock return value the string is inert. A plainly-fake path
 * avoids the false positive without suppressing the rule globally.
 */
const FIXTURE_LEGACY_LOCK_PATH = '/sonar-fixture/legacy.lock';

/** Build a minimal logger stub with jest mocks for .warn and .debug. */
function makeLoggerStub() {
  return {
    warn: jest.fn(),
    debug: jest.fn(),
    // Other logger methods that might be called — no-ops are fine
    info: jest.fn(),
    error: jest.fn(),
  } as unknown as typeof import('../../../../src/utils/logger.js').logger;
}

describe('warnIfLegacyConsolePresent', () => {
  it('logs a WARN when the legacy console is running, with pid/port in the message', async () => {
    const logStub = makeLoggerStub();
    const detectStub = jest.fn<() => Promise<LegacyLeaderInfo>>().mockResolvedValue({
      legacyRunning: true,
      pid: 12345,
      port: 3939,
      lockPath: FIXTURE_LEGACY_LOCK_PATH,
    });

    const result = await warnIfLegacyConsolePresent(41715, detectStub, logStub);

    expect(detectStub).toHaveBeenCalledTimes(1);
    expect(logStub.warn).toHaveBeenCalledTimes(1);
    const warnMessage = (logStub.warn as jest.Mock).mock.calls[0][0] as string;
    // Message must carry the key facts the user needs to self-diagnose
    expect(warnMessage).toContain('Legacy');
    expect(warnMessage).toContain('pid=12345');
    expect(warnMessage).toContain('port=3939');
    expect(warnMessage).toContain('port 41715'); // current port
    expect(warnMessage).toContain('update the legacy installation');
    // Result shape is passed through unchanged
    expect(result).toEqual({
      legacyRunning: true,
      pid: 12345,
      port: 3939,
      lockPath: FIXTURE_LEGACY_LOCK_PATH,
    });
  });

  it('does NOT log a WARN when no legacy console is detected', async () => {
    const logStub = makeLoggerStub();
    const detectStub = jest.fn<() => Promise<LegacyLeaderInfo>>().mockResolvedValue({
      legacyRunning: false,
      lockPath: FIXTURE_LEGACY_LOCK_PATH,
    });

    const result = await warnIfLegacyConsolePresent(41715, detectStub, logStub);

    expect(detectStub).toHaveBeenCalledTimes(1);
    expect(logStub.warn).not.toHaveBeenCalled();
    expect(result).toEqual({
      legacyRunning: false,
      lockPath: FIXTURE_LEGACY_LOCK_PATH,
    });
  });

  it('swallows detection errors and logs a DEBUG without propagating', async () => {
    // A detection failure must NEVER block leader election of the
    // authenticated console — the warning is nice to have, not
    // required. If reading the legacy lock throws for any reason
    // (permissions, corrupted file system, unexpected module state)
    // `warnIfLegacyConsolePresent` must return null and stay quiet
    // at WARN level.
    const logStub = makeLoggerStub();
    const detectStub = jest.fn<() => Promise<LegacyLeaderInfo>>().mockRejectedValue(
      new Error('simulated EACCES on legacy lock path'),
    );

    const result = await warnIfLegacyConsolePresent(41715, detectStub, logStub);

    expect(detectStub).toHaveBeenCalledTimes(1);
    expect(logStub.warn).not.toHaveBeenCalled();
    expect(logStub.debug).toHaveBeenCalledTimes(1);
    const debugArgs = (logStub.debug as jest.Mock).mock.calls[0];
    expect(debugArgs[0]).toContain('Legacy leader detection failed');
    expect(debugArgs[1]).toMatchObject({ error: expect.stringContaining('EACCES') });
    expect(result).toBeNull();
  });

  it('falls back to port 3939 in the message when legacy port field is missing', async () => {
    // Older legacy lock files might not have a port field. The warning
    // message should still display something useful — the legacy
    // default is 3939, so use that as a fallback.
    const logStub = makeLoggerStub();
    const detectStub = jest.fn<() => Promise<LegacyLeaderInfo>>().mockResolvedValue({
      legacyRunning: true,
      pid: 98765,
      // no port field
      lockPath: FIXTURE_LEGACY_LOCK_PATH,
    });

    await warnIfLegacyConsolePresent(41715, detectStub, logStub);

    const warnMessage = (logStub.warn as jest.Mock).mock.calls[0][0] as string;
    expect(warnMessage).toContain('pid=98765');
    // The explicit "legacy console uses port N" phrase must still resolve
    expect(warnMessage).toMatch(/legacy console uses port 3939/);
  });

  it('passes the current port through to the warning message', async () => {
    // Different deployments may configure different ports via
    // DOLLHOUSE_WEB_CONSOLE_PORT. The warning message must reflect
    // whatever port this process actually bound to, not hardcode 41715.
    const logStub = makeLoggerStub();
    const detectStub = jest.fn<() => Promise<LegacyLeaderInfo>>().mockResolvedValue({
      legacyRunning: true,
      pid: 11111,
      port: 3939,
      lockPath: FIXTURE_LEGACY_LOCK_PATH,
    });

    await warnIfLegacyConsolePresent(8080, detectStub, logStub);

    const warnMessage = (logStub.warn as jest.Mock).mock.calls[0][0] as string;
    expect(warnMessage).toContain('port 8080');
    expect(warnMessage).not.toMatch(/port 41715/);
  });
});

describe('discoverLeaderServingPort', () => {
  it('prefers the active leader session returned by /api/sessions for the port owner', async () => {
    const fetchStub = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({
        sessions: [
          {
            sessionId: 'older-follower',
            pid: 1234,
            isLeader: false,
            kind: 'mcp',
            status: 'active',
          },
          {
            sessionId: 'real-leader',
            pid: 4567,
            isLeader: true,
            kind: 'mcp',
            status: 'active',
            startedAt: '2026-04-16T13:55:00.000Z',
            lastHeartbeat: '2026-04-16T13:55:10.000Z',
            serverVersion: '2.0.19',
            consoleProtocolVersion: 1,
          },
        ],
      }),
    } as Response);

    const result = await discoverLeaderServingPort(41715, 'token-123', {
      fetchImpl: fetchStub,
      findPidOnPortImpl: async () => 4567,
      readLeaderLockImpl: async () => null,
    });

    expect(fetchStub).toHaveBeenCalledWith('http://127.0.0.1:41715/api/sessions', expect.objectContaining({
      headers: { Authorization: 'Bearer token-123' },
      signal: expect.any(AbortSignal),
    }));
    expect(result.source).toBe('api');
    expect(result.ownerPid).toBe(4567);
    expect(result.leaderInfo).toMatchObject({
      sessionId: 'real-leader',
      pid: 4567,
      port: 41715,
      serverVersion: '2.0.19',
      consoleProtocolVersion: 1,
    });
  });

  it('normalizes the discovered leader session ID from /api/sessions', async () => {
    const result = await discoverLeaderServingPort(41715, null, {
      fetchImpl: jest.fn<typeof fetch>().mockResolvedValue({
        ok: true,
        json: async () => ({
          sessions: [
            {
              sessionId: 'real\u200Bleader',
              pid: 4567,
              isLeader: true,
              kind: 'mcp',
              status: 'active',
            },
          ],
        }),
      } as Response),
      findPidOnPortImpl: async () => 4567,
      readLeaderLockImpl: async () => null,
    });

    expect(result.leaderInfo?.sessionId).toBe('realleader');
  });

  it('falls back to a synthetic leader when the port owner is known but sessions are unavailable', async () => {
    const result = await discoverLeaderServingPort(41715, null, {
      fetchImpl: jest.fn<typeof fetch>().mockRejectedValue(new Error('connect ECONNRESET')),
      findPidOnPortImpl: async () => 81234,
      readLeaderLockImpl: async () => null,
    });

    expect(result.source).toBe('synthetic');
    expect(result.ownerPid).toBe(81234);
    expect(result.leaderInfo).toMatchObject({
      sessionId: 'port-owner-81234',
      pid: 81234,
      port: 41715,
    });
  });

  it('falls back to a synthetic leader when the sessions API hangs', async () => {
    const fetchStub = jest.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      await new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
        setTimeout(resolve, 5000);
      });
      throw new Error('unreachable');
    });

    const result = await discoverLeaderServingPort(41715, null, {
      fetchImpl: fetchStub,
      findPidOnPortImpl: async () => 81234,
      readLeaderLockImpl: async () => null,
    });

    expect(result.source).toBe('synthetic');
    expect(result.ownerPid).toBe(81234);
    expect(result.leaderInfo).toMatchObject({
      sessionId: 'port-owner-81234',
      pid: 81234,
      port: 41715,
    });
  });
});

describe('recoverLeaderBindFailure', () => {
  it('removes the provisional self-lock before following the real leader on the bound port', async () => {
    const provisionalLeader: ConsoleLeaderInfo = {
      version: 1,
      pid: 99123,
      port: 41715,
      sessionId: 'burattino',
      startedAt: '2026-04-16T13:55:09.000Z',
      heartbeat: '2026-04-16T13:55:09.000Z',
      serverVersion: '2.0.19',
      consoleProtocolVersion: 1,
    };
    const deleteLeaderLockImpl = jest.fn<typeof import('../../../../src/web/console/LeaderElection.js').deleteLeaderLock>().mockResolvedValue();

    const result = await recoverLeaderBindFailure(provisionalLeader, 41715, 'token-123', {
      deleteLeaderLockImpl,
      readLeaderLockImpl: async () => provisionalLeader,
      findPidOnPortImpl: async () => 57117,
      fetchImpl: jest.fn<typeof fetch>().mockResolvedValue({
        ok: true,
        json: async () => ({
          sessions: [
            {
              sessionId: 'ollie',
              pid: 57117,
              isLeader: true,
              kind: 'mcp',
              status: 'active',
              serverVersion: '2.0.18',
              consoleProtocolVersion: 1,
            },
          ],
        }),
      } as Response),
    });

    expect(deleteLeaderLockImpl).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('api');
    expect(result.lockCleanupAttempted).toBe(true);
    expect(result.lockCleanupPerformed).toBe(true);
    expect(result.leaderInfo).toMatchObject({
      sessionId: 'ollie',
      pid: 57117,
      port: 41715,
    });
  });
});

describe('evaluatePortOwnerReplacement', () => {
  it('prefers evicting an older legacy leader that still owns the console port', () => {
    const candidateLeader: ConsoleLeaderInfo = {
      version: 1,
      pid: 83150,
      port: 41715,
      sessionId: 'session-new',
      startedAt: '2026-04-16T15:45:00.000Z',
      heartbeat: '2026-04-16T15:45:00.000Z',
      serverVersion: '2.0.21',
      consoleProtocolVersion: 1,
    };

    const decision = evaluatePortOwnerReplacement(candidateLeader, {
      ownerPid: 57117,
      source: 'api',
      leaderInfo: {
        version: 1,
        pid: 57117,
        port: 41715,
        sessionId: 'session-old',
        startedAt: '2026-04-09T23:21:46.000Z',
        heartbeat: '2026-04-16T15:45:00.000Z',
        serverVersion: undefined,
        consoleProtocolVersion: undefined,
      },
    });

    expect(decision.shouldEvict).toBe(true);
    expect(decision.ownerPid).toBe(57117);
    expect(decision.preference).toMatchObject({
      reason: 'newer-compatible-version',
      existingVersion: '0.0.0',
    });
  });

  it('does not evict a port owner when there is no preference to replace it', () => {
    const candidateLeader: ConsoleLeaderInfo = {
      version: 1,
      pid: 83150,
      port: 41715,
      sessionId: 'session-new',
      startedAt: '2026-04-16T15:45:00.000Z',
      heartbeat: '2026-04-16T15:45:00.000Z',
      serverVersion: '2.0.21',
      consoleProtocolVersion: 1,
    };

    const decision = evaluatePortOwnerReplacement(candidateLeader, {
      ownerPid: 57117,
      source: 'api',
      leaderInfo: {
        version: 1,
        pid: 57117,
        port: 41715,
        sessionId: 'session-current',
        startedAt: '2026-04-16T15:44:00.000Z',
        heartbeat: '2026-04-16T15:45:00.000Z',
        serverVersion: '2.0.21',
        consoleProtocolVersion: 1,
      },
    });

    expect(decision.shouldEvict).toBe(false);
    expect(decision.preference).toMatchObject({
      reason: 'same-version',
    });
  });
});

describe('resolveFollowerAuthority', () => {
  it('promotes a newer session to leader when the reachable port owner is older than the elected lock holder', async () => {
    const electedLeader: ConsoleLeaderInfo = {
      version: 1,
      pid: 77290,
      port: 41715,
      sessionId: 'lock-holder',
      startedAt: '2026-04-16T13:55:09.000Z',
      heartbeat: '2026-04-16T16:29:44.000Z',
      serverVersion: '2.0.19',
      consoleProtocolVersion: 1,
    };
    const deleteLeaderLockImpl = jest.fn<typeof import('../../../../src/web/console/LeaderElection.js').deleteLeaderLock>().mockResolvedValue();

    const result = await resolveFollowerAuthority('session-newest', 41715, {
      role: 'follower',
      leaderInfo: electedLeader,
    }, {
      isLeaderWebConsoleReachableImpl: async () => true,
      discoverLeaderServingPortImpl: async () => ({
        ownerPid: 57117,
        source: 'api',
        leaderInfo: {
          version: 1,
          pid: 57117,
          port: 41715,
          sessionId: 'legacy-console',
          startedAt: '2026-04-13T19:07:12.895Z',
          heartbeat: '2026-04-16T16:29:44.000Z',
          serverVersion: undefined,
          consoleProtocolVersion: undefined,
        },
      }),
      deleteLeaderLockImpl,
    });

    expect(deleteLeaderLockImpl).toHaveBeenCalledTimes(1);
    expect(result.election.role).toBe('leader');
    expect(result.election.leaderInfo).toMatchObject({
      sessionId: 'session-newest',
      port: 41715,
      serverVersion: expect.any(String),
      consoleProtocolVersion: 1,
    });
  });

  it('follows the actual port owner when split-brain is present but replacement is not preferred', async () => {
    const actualOwnerVersion = '999.0.0';
    const electedLeader: ConsoleLeaderInfo = {
      version: 1,
      pid: 77290,
      port: 41715,
      sessionId: 'lock-holder',
      startedAt: '2026-04-16T13:55:09.000Z',
      heartbeat: '2026-04-16T16:29:44.000Z',
      serverVersion: actualOwnerVersion,
      consoleProtocolVersion: 1,
    };

    const result = await resolveFollowerAuthority('session-newest', 41715, {
      role: 'follower',
      leaderInfo: electedLeader,
    }, {
      isLeaderWebConsoleReachableImpl: async () => true,
      discoverLeaderServingPortImpl: async () => ({
        ownerPid: 85513,
        source: 'api',
        leaderInfo: {
          version: 1,
          pid: 85513,
          port: 41715,
          sessionId: 'actual-owner',
          startedAt: '2026-04-16T16:29:44.000Z',
          heartbeat: '2026-04-16T16:29:44.000Z',
          serverVersion: actualOwnerVersion,
          consoleProtocolVersion: 1,
        },
      }),
    });

    expect(result.election).toEqual({
      role: 'follower',
      leaderInfo: {
        version: 1,
        pid: 85513,
        port: 41715,
        sessionId: 'actual-owner',
        startedAt: '2026-04-16T16:29:44.000Z',
        heartbeat: '2026-04-16T16:29:44.000Z',
        serverVersion: actualOwnerVersion,
        consoleProtocolVersion: 1,
      },
    });
  });
});
