/**
 * Tests for DisplayService
 *
 * This test suite provides comprehensive coverage for the DisplayService module
 * including platform detection, shell argument escaping, and dialog display logic.
 *
 * Note: Actual dialog display cannot be tested in automated tests as it requires
 * GUI environment and user interaction. These tests focus on logic flow, security
 * functions, and error handling.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { ExecFileSyncOptions, ExecSyncOptions } from 'child_process';

// Mock modules before importing the tested module
jest.unstable_mockModule('child_process', () => ({
  execFileSync: jest.fn(),
  execSync: jest.fn(),
}));

jest.unstable_mockModule('os', () => ({
  platform: jest.fn(),
}));

// Import mocked modules
const { execFileSync, execSync } = await import('child_process');
const { platform } = await import('os');
const { showVerificationDialog, isDialogAvailable } = await import(
  '../src/DisplayService.js'
);

// Type the mocks properly
const mockExecSync = execSync as jest.Mock<
  (command: string, options?: ExecSyncOptions) => Buffer | string
>;
const mockExecFileSync = execFileSync as unknown as jest.Mock<
  (
    file: string,
    args?: readonly string[],
    options?: ExecFileSyncOptions
  ) => Buffer | string
>;
const mockPlatform = platform as jest.Mock<() => NodeJS.Platform>;

describe('DisplayService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isDialogAvailable', () => {
    it('should return true for macOS', () => {
      mockPlatform.mockReturnValue('darwin');
      expect(isDialogAvailable()).toBe(true);
    });

    it('should return true for Windows', () => {
      mockPlatform.mockReturnValue('win32');
      expect(isDialogAvailable()).toBe(true);
    });

    it('should return true for Linux with zenity', () => {
      mockPlatform.mockReturnValue('linux');
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('which zenity')) {
          return Buffer.from('/usr/bin/zenity');
        }
        throw new Error('Command not found');
      });
      expect(isDialogAvailable()).toBe(true);
    });

    it('should return true for Linux with kdialog', () => {
      mockPlatform.mockReturnValue('linux');
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('which zenity')) {
          throw new Error('zenity not found');
        }
        if (cmd.includes('which kdialog')) {
          return Buffer.from('/usr/bin/kdialog');
        }
        throw new Error('Command not found');
      });
      expect(isDialogAvailable()).toBe(true);
    });

    it('should return true for Linux with xmessage', () => {
      mockPlatform.mockReturnValue('linux');
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('which zenity')) {
          throw new Error('zenity not found');
        }
        if (cmd.includes('which kdialog')) {
          throw new Error('kdialog not found');
        }
        if (cmd.includes('which xmessage')) {
          return Buffer.from('/usr/bin/xmessage');
        }
        throw new Error('Command not found');
      });
      expect(isDialogAvailable()).toBe(true);
    });

    it('should return false for Linux without any dialog tools', () => {
      mockPlatform.mockReturnValue('linux');
      mockExecSync.mockImplementation(() => {
        throw new Error('Command not found');
      });
      expect(isDialogAvailable()).toBe(false);
    });

    it('should return false for unsupported platforms', () => {
      mockPlatform.mockReturnValue('freebsd');
      expect(isDialogAvailable()).toBe(false);
    });
  });

  describe('showVerificationDialog', () => {
    describe('macOS (darwin)', () => {
      beforeEach(() => {
        mockPlatform.mockReturnValue('darwin');
      });

      it('should return success when dialog is accepted', () => {
        mockExecFileSync.mockReturnValue(Buffer.from('button returned:OK'));
        const result = showVerificationDialog('TEST123', 'Test verification');
        expect(result.success).toBe(true);
        expect(result.buttonClicked).toBe('OK');
      });

      it('should return failure when dialog is cancelled', () => {
        mockExecFileSync.mockImplementation(() => {
          throw new Error('User cancelled');
        });
        const result = showVerificationDialog('TEST123', 'Test verification');
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });

      it('passes display values as argv instead of AppleScript source', () => {
        mockExecFileSync.mockReturnValue(Buffer.from('button returned:Proceed'));
        const reason = 'Review \\"quoted" text\r\n$(marker) `marker`';
        const title = '-Title \\"quoted"';
        const buttons = ['Proceed \\"now"', '-Stop'];

        showVerificationDialog('-CODE\\"123', reason, {
          title,
          buttons,
          icon: 'error',
        });

        expect(mockExecFileSync).toHaveBeenCalledTimes(1);
        expect(mockExecSync).not.toHaveBeenCalled();

        const [file, args] = mockExecFileSync.mock.calls[0];
        expect(file).toBe('/usr/bin/osascript');
        expect(args?.[0]).toBe('-e');
        expect(args?.[2]).toBe('--');

        const script = args?.[1] ?? '';
        expect(script).toContain('on run argv');
        expect(script).not.toContain(reason);
        expect(script).not.toContain(title);
        for (const button of buttons) {
          expect(script).not.toContain(button);
        }

        expect(args?.[3]).toBe(title);
        expect(args?.[4]).toBe(
          `${reason}\n\nVerification Code: -CODE\\"123\n\nEnter this code when prompted.`
        );
        expect(args?.[5]).toBe(buttons[1]);
        expect(args?.[6]).toBe(buttons[0]);
        expect(args?.[7]).toBe('stop');
      });

      it('uses the same constant AppleScript for different input', () => {
        mockExecFileSync.mockReturnValue(Buffer.from('button returned:OK'));

        showVerificationDialog('FIRST', 'First reason');
        showVerificationDialog('SECOND', 'Second reason');

        const firstScript = mockExecFileSync.mock.calls[0][1]?.[1];
        const secondScript = mockExecFileSync.mock.calls[1][1]?.[1];
        expect(firstScript).toBe(secondScript);
      });
    });

    describe('Linux', () => {
      beforeEach(() => {
        mockPlatform.mockReturnValue('linux');
      });

      it('should try zenity first', () => {
        // First call for 'which zenity' succeeds
        // Second call for actual zenity dialog succeeds
        mockExecSync
          .mockReturnValueOnce(Buffer.from('/usr/bin/zenity'))
          .mockReturnValueOnce(Buffer.from(''));

        const result = showVerificationDialog('TEST123', 'Test verification');

        expect(mockExecSync).toHaveBeenCalledTimes(2);
        expect(result.success).toBe(true);
      });

      it('should fall back to kdialog if zenity unavailable', () => {
        mockExecSync.mockImplementation((cmd: string) => {
          if (cmd.includes('which zenity')) {
            throw new Error('not found');
          }
          if (cmd.includes('which kdialog')) {
            return Buffer.from('/usr/bin/kdialog');
          }
          if (cmd.includes('kdialog')) {
            return Buffer.from('');
          }
          throw new Error('Unknown command');
        });

        const result = showVerificationDialog('TEST123', 'Test verification');
        expect(result.success).toBe(true);
      });

      it('should fall back to xmessage if zenity and kdialog unavailable', () => {
        mockExecSync.mockImplementation((cmd: string) => {
          if (cmd.includes('which zenity')) {
            throw new Error('not found');
          }
          if (cmd.includes('which kdialog')) {
            throw new Error('not found');
          }
          if (cmd.includes('which xmessage')) {
            return Buffer.from('/usr/bin/xmessage');
          }
          if (cmd.includes('xmessage')) {
            return Buffer.from('');
          }
          throw new Error('Unknown command');
        });

        const result = showVerificationDialog('TEST123', 'Test verification');
        expect(result.success).toBe(true);
      });

      it('should return failure when no dialog tool available', () => {
        mockExecSync.mockImplementation(() => {
          throw new Error('not found');
        });

        const result = showVerificationDialog('TEST123', 'Test verification');
        expect(result.success).toBe(false);
        expect(result.error).toContain('No GUI dialog system available');
      });

      it('should not log verification code in fallback error messages', () => {
        // Spy on console.error to verify code is not logged
        const consoleErrorSpy = jest
          .spyOn(console, 'error')
          .mockImplementation(() => {});

        mockExecSync.mockImplementation(() => {
          throw new Error('not found');
        });

        showVerificationDialog('SECRET_CODE_123', 'Verification reason');

        // Check that SECRET_CODE_123 was NOT logged
        const allLoggedMessages = consoleErrorSpy.mock.calls
          .map((call) => String(call[0]))
          .join(' ');
        expect(allLoggedMessages).not.toContain('SECRET_CODE_123');
        expect(allLoggedMessages).toContain('hidden for security');

        consoleErrorSpy.mockRestore();
      });
    });

    describe('Windows (win32)', () => {
      beforeEach(() => {
        mockPlatform.mockReturnValue('win32');
      });

      it('should return success when dialog is accepted', () => {
        mockExecSync.mockReturnValue(Buffer.from(''));
        const result = showVerificationDialog('TEST123', 'Test verification');
        expect(result.success).toBe(true);
        expect(result.buttonClicked).toBe('OK');
      });

      it('should return failure when dialog is cancelled', () => {
        mockExecSync.mockImplementation(() => {
          const error = new Error('User cancelled');
          (error as NodeJS.ErrnoException).code = '1';
          throw error;
        });
        const result = showVerificationDialog('TEST123', 'Test verification');
        expect(result.success).toBe(false);
      });

      it('should use Base64-encoded command for security', () => {
        mockExecSync.mockReturnValue(Buffer.from(''));
        showVerificationDialog('TEST123', 'Test verification');

        expect(mockExecSync).toHaveBeenCalled();
        const command = mockExecSync.mock.calls[0][0] as string;

        // Should use -EncodedCommand for safety
        expect(command).toContain('powershell -EncodedCommand');
      });
    });

    describe('Unsupported platforms', () => {
      it('should return failure for unsupported platform', () => {
        mockPlatform.mockReturnValue('aix');
        const result = showVerificationDialog('TEST123', 'Test verification');
        expect(result.success).toBe(false);
        expect(result.error).toContain('Unsupported platform');
      });

      it('should not log verification code for unsupported platforms', () => {
        const consoleErrorSpy = jest
          .spyOn(console, 'error')
          .mockImplementation(() => {});

        mockPlatform.mockReturnValue('sunos');
        showVerificationDialog('HIDDEN_CODE', 'Test reason');

        const allLoggedMessages = consoleErrorSpy.mock.calls
          .map((call) => String(call[0]))
          .join(' ');
        expect(allLoggedMessages).not.toContain('HIDDEN_CODE');
        expect(allLoggedMessages).toContain('hidden for security');

        consoleErrorSpy.mockRestore();
      });
    });

    describe('Dialog options', () => {
      beforeEach(() => {
        mockPlatform.mockReturnValue('darwin');
        mockExecFileSync.mockReturnValue(Buffer.from('button returned:OK'));
      });

      it('should use custom title when provided', () => {
        showVerificationDialog('CODE123', 'Reason', {
          title: 'Custom Title',
        });

        const args = mockExecFileSync.mock.calls[0][1];
        expect(args?.[3]).toBe('Custom Title');
      });

      it('should use custom buttons when provided', () => {
        showVerificationDialog('CODE123', 'Reason', {
          buttons: ['Confirm', 'Abort'],
        });

        const args = mockExecFileSync.mock.calls[0][1];
        expect(args?.[5]).toBe('Abort');
        expect(args?.[6]).toBe('Confirm');
      });

      it('should support different icon types', () => {
        showVerificationDialog('CODE123', 'Reason', { icon: 'error' });

        const args = mockExecFileSync.mock.calls[0][1];
        expect(args?.[7]).toBe('stop');
      });
    });
  });
});
