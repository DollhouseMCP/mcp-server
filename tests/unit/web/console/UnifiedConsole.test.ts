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
import { warnIfLegacyConsolePresent } from '../../../../src/web/console/UnifiedConsole.js';
import type { LegacyLeaderInfo } from '../../../../src/web/console/LeaderElection.js';

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
      lockPath: '/tmp/fake-legacy.lock',
    });

    const result = await warnIfLegacyConsolePresent(5907, detectStub, logStub);

    expect(detectStub).toHaveBeenCalledTimes(1);
    expect(logStub.warn).toHaveBeenCalledTimes(1);
    const warnMessage = (logStub.warn as jest.Mock).mock.calls[0][0] as string;
    // Message must carry the key facts the user needs to self-diagnose
    expect(warnMessage).toContain('Legacy');
    expect(warnMessage).toContain('pid=12345');
    expect(warnMessage).toContain('port=3939');
    expect(warnMessage).toContain('port 5907'); // current port
    expect(warnMessage).toContain('update the legacy installation');
    // Result shape is passed through unchanged
    expect(result).toEqual({
      legacyRunning: true,
      pid: 12345,
      port: 3939,
      lockPath: '/tmp/fake-legacy.lock',
    });
  });

  it('does NOT log a WARN when no legacy console is detected', async () => {
    const logStub = makeLoggerStub();
    const detectStub = jest.fn<() => Promise<LegacyLeaderInfo>>().mockResolvedValue({
      legacyRunning: false,
      lockPath: '/tmp/fake-legacy.lock',
    });

    const result = await warnIfLegacyConsolePresent(5907, detectStub, logStub);

    expect(detectStub).toHaveBeenCalledTimes(1);
    expect(logStub.warn).not.toHaveBeenCalled();
    expect(result).toEqual({
      legacyRunning: false,
      lockPath: '/tmp/fake-legacy.lock',
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

    const result = await warnIfLegacyConsolePresent(5907, detectStub, logStub);

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
      lockPath: '/tmp/fake-legacy.lock',
    });

    await warnIfLegacyConsolePresent(5907, detectStub, logStub);

    const warnMessage = (logStub.warn as jest.Mock).mock.calls[0][0] as string;
    expect(warnMessage).toContain('pid=98765');
    // The explicit "legacy console uses port N" phrase must still resolve
    expect(warnMessage).toMatch(/legacy console uses port 3939/);
  });

  it('passes the current port through to the warning message', async () => {
    // Different deployments may configure different ports via
    // DOLLHOUSE_WEB_CONSOLE_PORT. The warning message must reflect
    // whatever port this process actually bound to, not hardcode 5907.
    const logStub = makeLoggerStub();
    const detectStub = jest.fn<() => Promise<LegacyLeaderInfo>>().mockResolvedValue({
      legacyRunning: true,
      pid: 11111,
      port: 3939,
      lockPath: '/tmp/fake.lock',
    });

    await warnIfLegacyConsolePresent(8080, detectStub, logStub);

    const warnMessage = (logStub.warn as jest.Mock).mock.calls[0][0] as string;
    expect(warnMessage).toContain('port 8080');
    expect(warnMessage).not.toMatch(/port 5907/);
  });
});
