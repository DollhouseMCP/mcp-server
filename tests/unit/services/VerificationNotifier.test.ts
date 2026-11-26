/**
 * Unit tests for VerificationNotifier (Issue #522)
 *
 * Tests the non-blocking OS dialog service that displays verification codes.
 * All child_process and os modules are mocked — no actual dialogs are spawned.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// Mock child_process before importing the module under test
const mockSpawn = jest.fn();
const mockExecSync = jest.fn();
jest.unstable_mockModule('child_process', () => ({
  spawn: mockSpawn,
  execSync: mockExecSync,
  execFile: jest.fn(),
  execFileSync: jest.fn(),
}));

// Mock os.platform
const mockPlatform = jest.fn();
jest.unstable_mockModule('os', () => ({
  platform: mockPlatform,
}));

// Mock SecurityMonitor
const mockLogSecurityEvent = jest.fn();
jest.unstable_mockModule('../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: {
    logSecurityEvent: mockLogSecurityEvent,
  },
}));

// Dynamic import after mocks are set up (ESM requirement)
const { VerificationNotifier } = await import('../../../src/services/VerificationNotifier.js');

describe('VerificationNotifier', () => {
  let notifier: InstanceType<typeof VerificationNotifier>;
  let mockChildProcess: { unref: jest.Mock; once: jest.Mock; stdin: { end: jest.Mock; on: jest.Mock } };

  beforeEach(() => {
    notifier = new VerificationNotifier();
    mockChildProcess = { unref: jest.fn(), once: jest.fn(), stdin: { end: jest.fn(), on: jest.fn() } };
    mockSpawn.mockReturnValue(mockChildProcess);
    mockExecSync.mockImplementation(() => ''); // default: tool found
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('showCode', () => {
    it('should spawn osascript on macOS', () => {
      mockPlatform.mockReturnValue('darwin');

      notifier.showCode('ABC123', 'Test reason');

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/osascript',
        expect.arrayContaining(['-e', expect.stringContaining('fileHandleWithStandardInput')]),
        expect.objectContaining({
          detached: true,
          stdio: ['pipe', 'ignore', 'ignore'],
        })
      );
      expect(mockChildProcess.unref).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mockSpawn.mock.calls)).not.toContain('ABC123');
      expect(mockChildProcess.stdin.end).toHaveBeenCalledWith(expect.stringContaining('ABC123'));
    });

    it('should spawn zenity on Linux when available', () => {
      mockPlatform.mockReturnValue('linux');
      // zenity is found (execSync doesn't throw)

      notifier.showCode('XYZ789', 'Linux test');

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn).toHaveBeenCalledWith(
        'zenity',
        expect.arrayContaining([
          '--text-info',
          '--title=DollhouseMCP Verification Required',
        ]),
        expect.objectContaining({
          detached: true,
          stdio: ['pipe', 'ignore', 'ignore'],
        })
      );
      expect(mockChildProcess.unref).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mockSpawn.mock.calls)).not.toContain('XYZ789');
      expect(mockChildProcess.stdin.end).toHaveBeenCalledWith(expect.stringContaining('XYZ789'));
    });

    it('should spawn powershell on Windows', () => {
      mockPlatform.mockReturnValue('win32');

      notifier.showCode('WIN456', 'Windows test');

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining(['-EncodedCommand', expect.any(String)]),
        expect.objectContaining({
          detached: true,
          stdio: ['pipe', 'ignore', 'ignore'],
        })
      );
      expect(mockChildProcess.unref).toHaveBeenCalledTimes(1);
      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(Buffer.from(args.at(-1)!, 'base64').toString('utf16le')).not.toContain('WIN456');
      expect(mockChildProcess.stdin.end).toHaveBeenCalledWith(expect.stringContaining('WIN456'));
    });

    it('should never throw on any error', () => {
      mockPlatform.mockReturnValue('darwin');
      mockSpawn.mockImplementation(() => { throw new Error('spawn failed'); });

      // Must not throw
      expect(() => notifier.showCode('ERR001', 'Error test')).not.toThrow();
    });

    it('should log SecurityMonitor event on unsupported platform', async () => {
      mockPlatform.mockReturnValue('freebsd');

      notifier.showCode('BSD001', 'Unsupported test');
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'DANGER_ZONE_TRIGGERED',
          severity: 'MEDIUM',
          source: 'VerificationNotifier.showCode',
          details: expect.stringContaining('freebsd'),
        })
      );
    });

    it('should log SecurityMonitor event on spawn failure', async () => {
      mockPlatform.mockReturnValue('darwin');
      mockSpawn.mockImplementation(() => { throw new Error('spawn failed with synthetic proof FAIL01'); });

      notifier.showCode('FAIL01', 'Failure test');
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'DANGER_ZONE_TRIGGERED',
          severity: 'MEDIUM',
          source: 'VerificationNotifier.showCode',
        })
      );
      expect(JSON.stringify(mockLogSecurityEvent.mock.calls)).not.toContain('FAIL01');
    });

    it('should never include the code in SecurityMonitor log details', async () => {
      mockPlatform.mockReturnValue('freebsd');

      notifier.showCode('SECRET42', 'Must not leak');
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(mockLogSecurityEvent).toHaveBeenCalledTimes(1);
      for (const call of mockLogSecurityEvent.mock.calls) {
        const event = call[0] as Record<string, unknown>;
        expect(JSON.stringify(event)).not.toContain('SECRET42');
      }
    });

    it('should use detached and discard output for fire-and-forget', () => {
      mockPlatform.mockReturnValue('darwin');

      notifier.showCode('DET001', 'Detach test');

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          detached: true,
          stdio: ['pipe', 'ignore', 'ignore'],
        })
      );
      expect(mockChildProcess.unref).toHaveBeenCalled();
    });
  });

  describe('isAvailable', () => {
    it('should return true on macOS', () => {
      mockPlatform.mockReturnValue('darwin');
      expect(notifier.isAvailable()).toBe(true);
    });

    it('should return true on Windows', () => {
      mockPlatform.mockReturnValue('win32');
      expect(notifier.isAvailable()).toBe(true);
    });

    it('should return true on Linux when zenity is available', () => {
      mockPlatform.mockReturnValue('linux');
      // execSync doesn't throw = zenity found
      expect(notifier.isAvailable()).toBe(true);
    });

    it('should return false on Linux when no dialog tool is available', () => {
      mockPlatform.mockReturnValue('linux');
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });
      expect(notifier.isAvailable()).toBe(false);
    });

    it('should return false on unsupported platform', () => {
      mockPlatform.mockReturnValue('freebsd');
      expect(notifier.isAvailable()).toBe(false);
    });
  });
});
