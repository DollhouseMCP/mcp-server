import { describe, expect, it } from '@jest/globals';
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
});
