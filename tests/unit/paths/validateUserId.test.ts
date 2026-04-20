/**
 * Unit tests for validateUserId — the shared userId safety check.
 */

import { describe, it, expect } from '@jest/globals';
import { validateUserId, InvalidUserIdError } from '../../../src/paths/validateUserId.js';

describe('validateUserId', () => {
  describe('accepts safe identifiers', () => {
    it.each([
      ['00000000-0000-4000-8000-000000000001'], // UUID v4
      ['user-alice'],
      ['alice_bot_3'],
      ['a'],                    // single char
      ['0'],                    // single digit
      ['__probe__'],            // starts with underscore
      ['admin'],                // identity layer concern, not path
      ['A'.repeat(64)],         // max length
      ['local-user'],           // stdio default
    ])('accepts %s', (id) => {
      expect(() => validateUserId(id)).not.toThrow();
      expect(validateUserId(id)).toBe(id);
    });
  });

  describe('rejects path-traversal attempts', () => {
    it.each([
      ['../alice'],
      ['alice/../bob'],
      ['alice/bob'],
      ['alice\\bob'],
      ['/alice'],
      ['.'],
      ['..'],
    ])('rejects %s', (id) => {
      expect(() => validateUserId(id)).toThrow(InvalidUserIdError);
    });
  });

  describe('rejects dot-prefixed and hidden-file names', () => {
    it.each([
      ['.hidden'],
      ['.dollhouse'],
      ['alice.bob'],            // any dot — not in charset
    ])('rejects %s', (id) => {
      expect(() => validateUserId(id)).toThrow(InvalidUserIdError);
    });
  });

  describe('rejects control chars and null bytes', () => {
    it.each([
      ['alice\0admin'],         // null byte
      ['alice\tbob'],           // tab
      ['alice\nbob'],           // newline
      ['alice\rbob'],           // CR
      ['alice\x01bob'],         // SOH
    ])('rejects %s', (id) => {
      expect(() => validateUserId(id)).toThrow(InvalidUserIdError);
    });
  });

  describe('rejects non-ASCII (Unicode)', () => {
    it.each([
      ['café'],                 // accented char
      ['аlice'],                // Cyrillic lookalike
      ['alice-α'],              // Greek letter
      ['\u0000user'],           // null as Unicode escape
      ['user\u200B'],           // zero-width space
    ])('rejects %s', (id) => {
      expect(() => validateUserId(id)).toThrow(InvalidUserIdError);
    });
  });

  describe('rejects leading/trailing problematic chars', () => {
    it.each([
      ['-alice'],               // leading hyphen (argv confusion)
      ['alice '],               // trailing space
      ['alice.'],               // trailing dot
      [' alice'],               // leading space
      ['alice\t'],              // trailing tab
    ])('rejects %s', (id) => {
      expect(() => validateUserId(id)).toThrow(InvalidUserIdError);
    });
  });

  describe('rejects empty / whitespace-only', () => {
    it('rejects empty string', () => {
      expect(() => validateUserId('')).toThrow(/empty/);
    });
    it('rejects whitespace only (charset)', () => {
      expect(() => validateUserId('   ')).toThrow(InvalidUserIdError);
    });
  });

  describe('rejects oversized userIds', () => {
    it('rejects 65-char userId (exceeds 64 char cap)', () => {
      const oversize = 'a'.repeat(65);
      expect(() => validateUserId(oversize)).toThrow(/64 characters/);
    });
    it('rejects very large userId', () => {
      const huge = 'a'.repeat(10_000);
      expect(() => validateUserId(huge)).toThrow(/64 characters/);
    });
  });

  describe('rejects Windows reserved device names', () => {
    it.each([
      ['CON'], ['PRN'], ['AUX'], ['NUL'],
      ['COM1'], ['COM9'],
      ['LPT1'], ['LPT9'],
      // Case-insensitive
      ['con'], ['Con'], ['nul'], ['Com1'],
    ])('rejects %s', (id) => {
      expect(() => validateUserId(id)).toThrow(/Windows reserved/);
    });
  });

  describe('rejects directory-sentinel collisions', () => {
    it.each([
      ['users'],    // collides with users/ container
      ['USERS'],
      ['Users'],    // case-insensitive
      ['shared'],   // collides with shared/ pool (Step 4.6)
      ['Shared'],
      ['SHARED'],
      ['system'],   // SYSTEM user identity
      ['SYSTEM'],
      ['System'],
    ])('rejects %s', (id) => {
      expect(() => validateUserId(id)).toThrow(/reserved directory sentinel/);
    });
  });

  describe('rejects non-string inputs', () => {
    it('rejects null', () => {
      expect(() => validateUserId(null as unknown as string)).toThrow(/not a string/);
    });
    it('rejects undefined', () => {
      expect(() => validateUserId(undefined as unknown as string)).toThrow(/not a string/);
    });
    it('rejects a number', () => {
      expect(() => validateUserId(42 as unknown as string)).toThrow(/not a string/);
    });
  });

  describe('InvalidUserIdError', () => {
    it('carries a stable error code', () => {
      try {
        validateUserId('../escape');
        throw new Error('expected to throw');
      } catch (err) {
        expect((err as InvalidUserIdError).code).toBe('INVALID_USER_ID');
      }
    });
  });
});
