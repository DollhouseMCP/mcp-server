/**
 * Unit tests for CommandValidator
 *
 * Tests command allowlisting, argument validation, and secure execution.
 * Issue #449: Direct unit tests for the CommandValidator class.
 */

import { describe, it, expect, jest } from '@jest/globals';

// ESM mocking: mock child_process and logger
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { CommandValidator } = await import('../../../src/security/commandValidator.js');

describe('CommandValidator', () => {
  describe('sanitizeCommand()', () => {
    it('should allow git with permitted subcommands', () => {
      expect(() => CommandValidator.sanitizeCommand('git', ['status'])).not.toThrow();
      expect(() => CommandValidator.sanitizeCommand('git', ['pull'])).not.toThrow();
      expect(() => CommandValidator.sanitizeCommand('git', ['log'])).not.toThrow();
      expect(() => CommandValidator.sanitizeCommand('git', ['clone'])).not.toThrow();
      expect(() => CommandValidator.sanitizeCommand('git', ['fetch'])).not.toThrow();
    });

    it('should allow npm with permitted subcommands', () => {
      expect(() => CommandValidator.sanitizeCommand('npm', ['install'])).not.toThrow();
      expect(() => CommandValidator.sanitizeCommand('npm', ['run'])).not.toThrow();
      expect(() => CommandValidator.sanitizeCommand('npm', ['audit'])).not.toThrow();
    });

    it('should allow node --version', () => {
      expect(() => CommandValidator.sanitizeCommand('node', ['--version'])).not.toThrow();
    });

    it('should reject disallowed commands', () => {
      expect(() => CommandValidator.sanitizeCommand('rm', ['-rf', '/'])).toThrow('Command not allowed: rm');
      expect(() => CommandValidator.sanitizeCommand('curl', ['http://evil.com'])).toThrow('Command not allowed: curl');
      expect(() => CommandValidator.sanitizeCommand('wget', ['http://evil.com'])).toThrow('Command not allowed: wget');
      expect(() => CommandValidator.sanitizeCommand('python', ['-c', 'import os'])).toThrow('Command not allowed: python');
    });

    it('should reject shell metacharacters in arguments', () => {
      expect(() => CommandValidator.sanitizeCommand('git', ['status; rm -rf /'])).toThrow('Argument not allowed');
      expect(() => CommandValidator.sanitizeCommand('git', ['$(whoami)'])).toThrow('Argument not allowed');
      expect(() => CommandValidator.sanitizeCommand('git', ['`whoami`'])).toThrow('Argument not allowed');
      expect(() => CommandValidator.sanitizeCommand('npm', ['install && curl evil.com'])).toThrow('Argument not allowed');
    });

    it('should allow safe path-like arguments', () => {
      // Safe arguments matching /^[a-zA-Z0-9\-_.\/]+$/
      expect(() => CommandValidator.sanitizeCommand('git', ['clone', 'my-repo/path'])).not.toThrow();
      expect(() => CommandValidator.sanitizeCommand('npm', ['run', 'build'])).not.toThrow();
    });

    it('should reject arguments with pipes or redirects', () => {
      expect(() => CommandValidator.sanitizeCommand('git', ['log', '|', 'grep'])).toThrow('Argument not allowed');
      expect(() => CommandValidator.sanitizeCommand('npm', ['run', '>', '/tmp/out'])).toThrow('Argument not allowed');
    });

    it('should handle empty args array', () => {
      // git with no args - no arguments to validate
      expect(() => CommandValidator.sanitizeCommand('git', [])).not.toThrow();
    });
  });

  describe('secureExec()', () => {
    it('should reject disallowed commands before execution', async () => {
      await expect(CommandValidator.secureExec('rm', ['-rf', '/']))
        .rejects.toThrow('Command not allowed: rm');
    });

    it('should execute allowed command and return output', async () => {
      // CommandValidator restricts PATH to Unix-only paths (/usr/bin:/bin:/usr/local/bin).
      // On Windows, git is not on that restricted PATH, so skip this test.
      if (process.platform === 'win32') return;
      const result = await CommandValidator.secureExec('git', ['status']);
      expect(typeof result).toBe('string');
    });

    it('should reject shell metacharacters before execution', async () => {
      await expect(CommandValidator.secureExec('git', ['status; rm -rf /']))
        .rejects.toThrow('Argument not allowed');
    });
  });
});
