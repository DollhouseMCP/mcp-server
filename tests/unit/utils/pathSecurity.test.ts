import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePathWithinBase } from '../../../src/utils/pathSecurity.js';

describe('resolvePathWithinBase', () => {
  const baseDir = path.join(tmpdir(), 'dollhouse-path-security-base');

  it('resolves nested paths inside the base directory', () => {
    expect(resolvePathWithinBase(baseDir, 'nested', 'file.md')).toBe(
      path.resolve(baseDir, 'nested', 'file.md')
    );
  });

  it('allows resolving the base directory itself', () => {
    expect(resolvePathWithinBase(baseDir)).toBe(path.resolve(baseDir));
  });

  it('allows in-base filenames that start with two dots', () => {
    expect(resolvePathWithinBase(baseDir, '..backup.md')).toBe(
      path.resolve(baseDir, '..backup.md')
    );
  });

  it('rejects traversal outside the base directory', () => {
    expect(() => resolvePathWithinBase(baseDir, '..', 'outside.md')).toThrow(
      'Resolved path escapes the base directory'
    );
  });

  it('rejects absolute target paths outside the base directory', () => {
    expect(() => resolvePathWithinBase(baseDir, path.join(tmpdir(), 'outside.md'))).toThrow(
      'Resolved path escapes the base directory'
    );
  });

  it('rejects sibling paths that only share a string prefix', () => {
    const sibling = `${path.resolve(baseDir)}-sibling`;
    expect(() => resolvePathWithinBase(baseDir, sibling, 'file.md')).toThrow(
      'Resolved path escapes the base directory'
    );
  });

  it('rejects null bytes in path segments', () => {
    expect(() => resolvePathWithinBase(baseDir, 'bad\0file.md')).toThrow(
      'Path segment contains a null byte'
    );
  });

  it('rejects paths through symlinked directories inside the base directory', () => {
    const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'dollhouse-path-security-'));
    const base = path.join(sandbox, 'base');
    const outside = path.join(sandbox, 'outside-target');
    const link = path.join(base, 'scripts');

    try {
      fs.mkdirSync(base, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });

      try {
        fs.symlinkSync(outside, link, 'dir');
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
        if (code === 'EPERM' || code === 'EACCES') {
          return;
        }
        throw error;
      }

      expect(() => resolvePathWithinBase(base, 'scripts', 'file.md')).toThrow(
        'Path segment resolves through a symbolic link'
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
