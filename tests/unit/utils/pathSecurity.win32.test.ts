/**
 * Windows path-semantics contract for pathSecurity.
 *
 * These tests substitute node:path with its Win32 implementation so the real
 * containment code is exercised under Windows separators and drive rules on
 * every runner. node:fs remains real; the synthetic drive paths do not exist,
 * so the create-later symlink checks stop safely at ENOENT.
 */

import { describe, expect, it, jest } from '@jest/globals';
import * as nodePath from 'node:path';

const win32 = nodePath.win32;

jest.unstable_mockModule('node:path', () => ({
  __esModule: true,
  default: win32,
  resolve: win32.resolve,
  relative: win32.relative,
  isAbsolute: win32.isAbsolute,
  dirname: win32.dirname,
  basename: win32.basename,
  extname: win32.extname,
  join: win32.join,
  normalize: win32.normalize,
  parse: win32.parse,
  format: win32.format,
  sep: win32.sep,
  delimiter: win32.delimiter,
  win32,
  posix: nodePath.posix,
}));

const { resolvePathWithinBase } = await import('../../../src/utils/pathSecurity.js');

const BASE = 'C:\\portfolio';

describe('pathSecurity under Win32 path semantics', () => {
  describe('ordinary contained segments', () => {
    it('resolves nested relative segments inside the base', () => {
      expect(resolvePathWithinBase(BASE, 'personas', 'creative.md'))
        .toBe('C:\\portfolio\\personas\\creative.md');
    });

    it('accepts a backslash-separated relative segment', () => {
      expect(resolvePathWithinBase(BASE, 'personas\\creative.md'))
        .toBe('C:\\portfolio\\personas\\creative.md');
    });
  });

  describe('Win32-specific escapes', () => {
    it.each([
      ['backslash traversal', '..\\..\\Windows\\System32'],
      ['same-drive absolute path', 'C:\\Windows\\System32'],
      ['different-drive absolute path', 'D:\\elsewhere'],
      ['UNC path', '\\\\attacker\\share\\payload'],
      ['sibling with base-name prefix', '..\\portfolio-evil'],
      ['mixed-separator traversal', '../..\\Windows'],
    ])('rejects %s', (_description, segment) => {
      expect(() => resolvePathWithinBase(BASE, segment))
        .toThrow('Resolved path escapes the base directory');
    });
  });

  describe('platform-independent input validation', () => {
    it('rejects a null byte in a segment', () => {
      expect(() => resolvePathWithinBase(BASE, 'personas\0.md'))
        .toThrow('Path segment contains a null byte');
    });

    it('rejects an empty base', () => {
      expect(() => resolvePathWithinBase('', 'personas'))
        .toThrow('Base directory must be a non-empty string');
    });
  });

  describe('platform constants used by the portability rules', () => {
    it('uses a backslash separator and semicolon PATH delimiter', () => {
      expect(win32.sep).toBe('\\');
      expect(win32.delimiter).toBe(';');
    });

    it('distinguishes root-relative join from relative join', () => {
      expect(win32.join('/custom/path', 'cache')).toBe('\\custom\\path\\cache');
      expect(win32.isAbsolute(win32.join('/custom/path', 'cache'))).toBe(true);
      expect(win32.isAbsolute(win32.join('custom', 'path'))).toBe(false);
    });
  });
});
