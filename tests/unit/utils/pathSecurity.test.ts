import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePathWithinBase, canonicalizePath, vetOutputBase } from '../../../src/utils/pathSecurity.js';

/**
 * Creates a symlink or skips the calling test on platforms where symlink
 * creation needs elevated privileges (Windows without developer mode).
 * Returns false when the test should bail out early.
 */
function trySymlink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, 'dir');
    return true;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code === 'EPERM' || code === 'EACCES') {
      return false;
    }
    throw error;
  }
}

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

  it('rejects a symlinked base directory before resolving child paths', () => {
    const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'dollhouse-path-security-'));
    const base = path.join(sandbox, 'base-link');
    const outside = path.join(sandbox, 'outside-target');

    try {
      fs.mkdirSync(outside, { recursive: true });

      try {
        fs.symlinkSync(outside, base, 'dir');
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
        if (code === 'EPERM' || code === 'EACCES') {
          return;
        }
        throw error;
      }

      expect(() => resolvePathWithinBase(base, 'file.md')).toThrow(
        'Base directory resolves through a symbolic link'
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  // #2342: a base that does not exist yet must be vetted through its nearest
  // existing ancestor — otherwise `/safe/link/new` (where `/safe/link` is a
  // symlink to an outside directory) passes the lstat-ENOENT check and the
  // recursive mkdir/write that follows escapes the intended tree.
  it('rejects a missing base directory whose nearest existing ancestor is a symlink', () => {
    const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'dollhouse-path-security-'));
    const outside = path.join(sandbox, 'outside-target');
    const link = path.join(sandbox, 'link');

    try {
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

      // Base does not exist yet; its nearest existing ancestor is the symlink.
      const missingBase = path.join(link, 'new-base');
      expect(() => resolvePathWithinBase(missingBase, 'file.md')).toThrow(
        'Base directory resolves through a symbolic link'
      );

      // Same for a base several missing levels below the symlink.
      const deepMissingBase = path.join(link, 'a', 'b', 'new-base');
      expect(() => resolvePathWithinBase(deepMissingBase, 'file.md')).toThrow(
        'Base directory resolves through a symbolic link'
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('allows a missing base directory under real existing ancestors', () => {
    const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'dollhouse-path-security-'));

    try {
      const missingBase = path.join(sandbox, 'not-created-yet', 'sub');
      expect(resolvePathWithinBase(missingBase, 'file.md')).toBe(
        path.resolve(missingBase, 'file.md')
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

// ── #2344: canonical containment for user-supplied output bases ──────────────

describe('canonicalizePath', () => {
  it('resolves the existing prefix and appends the missing suffix unchanged', () => {
    const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'dollhouse-path-security-'));
    try {
      const canonicalSandbox = fs.realpathSync(sandbox);
      const missing = path.join(sandbox, 'not-yet', 'created', 'dir');
      expect(canonicalizePath(missing)).toBe(
        path.join(canonicalSandbox, 'not-yet', 'created', 'dir')
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('resolves symlinks in the existing prefix', () => {
    const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'dollhouse-path-security-'));
    try {
      const outside = path.join(sandbox, 'outside-target');
      fs.mkdirSync(outside, { recursive: true });
      const link = path.join(sandbox, 'link');
      if (!trySymlink(outside, link)) return;

      expect(canonicalizePath(path.join(link, 'new'))).toBe(
        path.join(fs.realpathSync(outside), 'new')
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('vetOutputBase', () => {
  it('returns the canonical base for a relative output under real ancestors', () => {
    const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'dollhouse-path-security-'));
    try {
      const requested = path.join(sandbox, 'exports', 'skills');
      expect(vetOutputBase(requested, { anchor: sandbox })).toBe(
        path.join(fs.realpathSync(sandbox), 'exports', 'skills')
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects an in-anchor output redirected outside by a symlink (missing target)', () => {
    const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'dollhouse-path-security-'));
    try {
      const anchor = path.join(sandbox, 'anchor');
      const outside = path.join(sandbox, 'outside-target');
      fs.mkdirSync(anchor, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      const link = path.join(anchor, 'exports');
      if (!trySymlink(outside, link)) return;

      expect(() => vetOutputBase(path.join(link, 'new'), { anchor })).toThrow(
        'through a symbolic link'
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects the existing-through-symlink variant (codex P1 on #2343)', () => {
    const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'dollhouse-path-security-'));
    try {
      const anchor = path.join(sandbox, 'anchor');
      const outside = path.join(sandbox, 'outside-target');
      fs.mkdirSync(anchor, { recursive: true });
      // The attacker's target ALREADY CONTAINS the matching subdirectory —
      // per-component lstat checks pass this shape; canonical containment must not.
      fs.mkdirSync(path.join(outside, 'existing'), { recursive: true });
      const link = path.join(anchor, 'exports');
      if (!trySymlink(outside, link)) return;

      expect(() => vetOutputBase(path.join(link, 'existing', 'new'), { anchor })).toThrow(
        'through a symbolic link'
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('does not false-positive when the anchor itself is reached via a symlink (macOS /tmp shape)', () => {
    const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'dollhouse-path-security-'));
    try {
      const realAnchor = path.join(sandbox, 'real-anchor');
      fs.mkdirSync(realAnchor, { recursive: true });
      const anchorLink = path.join(sandbox, 'anchor-link');
      if (!trySymlink(realAnchor, anchorLink)) return;

      // Base lexically under the symlinked anchor: both sides canonicalize
      // through the same link, so this must be allowed.
      const requested = path.join(anchorLink, 'exports');
      expect(vetOutputBase(requested, { anchor: anchorLink })).toBe(
        path.join(fs.realpathSync(realAnchor), 'exports')
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('discloses the real destination for an outside-anchor output routed through a symlink', () => {
    const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'dollhouse-path-security-'));
    try {
      const anchor = path.join(sandbox, 'anchor');
      const outside = path.join(sandbox, 'outside-target');
      fs.mkdirSync(anchor, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      const link = path.join(sandbox, 'elsewhere-link');
      if (!trySymlink(outside, link)) return;

      const disclosed: string[] = [];
      const result = vetOutputBase(path.join(link, 'new'), {
        anchor,
        onDisclose: (p) => disclosed.push(p),
      });

      const canonical = path.join(fs.realpathSync(outside), 'new');
      expect(result).toBe(canonical);
      expect(disclosed).toEqual([canonical]);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('does not disclose for an outside-anchor output with no symlink divergence', () => {
    const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'dollhouse-path-security-'));
    try {
      const anchor = path.join(sandbox, 'anchor');
      fs.mkdirSync(anchor, { recursive: true });
      // Use the canonical sandbox so no divergence comes from tmpdir itself
      // (macOS /var -> /private/var would otherwise always disclose).
      const canonicalSandbox = fs.realpathSync(sandbox);
      const requested = path.join(canonicalSandbox, 'plain-exports');

      const disclosed: string[] = [];
      const result = vetOutputBase(requested, {
        anchor,
        onDisclose: (p) => disclosed.push(p),
      });

      expect(result).toBe(requested);
      expect(disclosed).toEqual([]);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects null bytes', () => {
    expect(() => vetOutputBase('bad\0dir')).toThrow('null byte');
  });
});
