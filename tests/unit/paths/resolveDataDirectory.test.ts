/**
 * Unit tests for resolveDataDirectory — the pure path-resolution function.
 */

import { describe, it, expect } from '@jest/globals';
import path from 'node:path';

import {
  resolveDataDirectory,
  envOverrideFor,
  type DataDirKey,
  type ResolveOptions,
} from '../../../src/paths/resolveDataDirectory.js';

const LINUX_HOME = '/home/user';
const MAC_HOME = '/Users/user';
const WIN_HOME = String.raw`C:\Users\user`;

/** Build an options object with an empty env to prevent host env leakage. */
function opts(overrides: Partial<ResolveOptions>): ResolveOptions {
  return { env: {}, ...overrides };
}

function expectNativePath(actual: string, expected: string): void {
  expect(normalize(actual)).toBe(normalize(path.normalize(expected)));
}

function expectResolvedPath(actual: string, expected: string): void {
  expect(normalize(actual)).toBe(normalize(path.resolve(expected)));
}

describe('resolveDataDirectory', () => {
  describe('Linux (XDG) defaults', () => {
    const base = opts({ platform: 'linux', homeDir: LINUX_HOME });

    it.each([
      ['config', '/home/user/.config/dollhousemcp'],
      ['cache',  '/home/user/.cache/dollhousemcp'],
      ['state',  '/home/user/.local/state/dollhousemcp'],
      ['logs',   '/home/user/.local/state/dollhousemcp/logs'],
      ['run',    '/home/user/.local/state/dollhousemcp/run'],
    ] as [DataDirKey, string][])(
      'resolves %s to %s',
      (key, expected) => {
        expectNativePath(resolveDataDirectory(key, base), expected);
      }
    );

    it('honors XDG_CONFIG_HOME when set', () => {
      const result = resolveDataDirectory('config', opts({
        platform: 'linux',
        homeDir: LINUX_HOME,
        env: { XDG_CONFIG_HOME: '/custom/config' },
      }));
      expectNativePath(result, '/custom/config/dollhousemcp');
    });

    it('honors XDG_CACHE_HOME when set', () => {
      const result = resolveDataDirectory('cache', opts({
        platform: 'linux',
        homeDir: LINUX_HOME,
        env: { XDG_CACHE_HOME: '/custom/cache' },
      }));
      expectNativePath(result, '/custom/cache/dollhousemcp');
    });

    it('honors XDG_STATE_HOME when set (state / logs / run share it)', () => {
      const withState = opts({
        platform: 'linux',
        homeDir: LINUX_HOME,
        env: { XDG_STATE_HOME: '/custom/state' },
      });
      expectNativePath(resolveDataDirectory('state', withState), '/custom/state/dollhousemcp');
      expectNativePath(resolveDataDirectory('logs', withState), '/custom/state/dollhousemcp/logs');
      expectNativePath(resolveDataDirectory('run', withState), '/custom/state/dollhousemcp/run');
    });
  });

  describe('macOS (Library) defaults', () => {
    const base = opts({ platform: 'darwin', homeDir: MAC_HOME });

    it.each([
      ['config', '/Users/user/Library/Preferences/DollhouseMCP'],
      ['cache',  '/Users/user/Library/Caches/DollhouseMCP'],
      ['state',  '/Users/user/Library/Application Support/DollhouseMCP'],
      ['logs',   '/Users/user/Library/Logs/DollhouseMCP'],
      ['run',    '/Users/user/Library/Application Support/DollhouseMCP/run'],
    ] as [DataDirKey, string][])(
      'resolves %s to %s',
      (key, expected) => {
        expectNativePath(resolveDataDirectory(key, base), expected);
      }
    );
  });

  describe('Windows (LOCALAPPDATA / APPDATA) defaults', () => {
    const base = opts({
      platform: 'win32',
      homeDir: WIN_HOME,
      env: {
        LOCALAPPDATA: String.raw`C:\Users\user\AppData\Local`,
        APPDATA: String.raw`C:\Users\user\AppData\Roaming`,
      },
    });

    it.each([
      ['config', String.raw`C:\Users\user\AppData\Roaming\DollhouseMCP\Config`],
      ['cache',  String.raw`C:\Users\user\AppData\Local\DollhouseMCP\Cache`],
      ['state',  String.raw`C:\Users\user\AppData\Local\DollhouseMCP\Data`],
      ['logs',   String.raw`C:\Users\user\AppData\Local\DollhouseMCP\Log`],
      ['run',    String.raw`C:\Users\user\AppData\Local\DollhouseMCP\Run`],
    ] as [DataDirKey, string][])(
      'resolves %s to %s',
      (key, expected) => {
        // path.join produces platform-native separators. On a Linux host
        // running these tests, path.join uses '/'. We normalize both sides.
        const actual = resolveDataDirectory(key, base);
        expect(normalize(actual)).toBe(normalize(expected));
      }
    );

    it('falls back to homeDir-derived paths when LOCALAPPDATA/APPDATA unset', () => {
      const result = resolveDataDirectory('config', opts({
        platform: 'win32',
        homeDir: WIN_HOME,
        env: {},
      }));
      expect(normalize(result)).toBe(normalize(String.raw`C:\Users\user\AppData\Roaming\DollhouseMCP\Config`));
    });
  });

  describe('Portfolio root (user-facing, cross-platform)', () => {
    it('returns ~/DollhouseMCP on Linux', () => {
      const result = resolveDataDirectory('portfolio-root', opts({
        platform: 'linux', homeDir: LINUX_HOME,
      }));
      expectNativePath(result, '/home/user/DollhouseMCP');
    });

    it('returns ~/DollhouseMCP on macOS', () => {
      const result = resolveDataDirectory('portfolio-root', opts({
        platform: 'darwin', homeDir: MAC_HOME,
      }));
      expectNativePath(result, '/Users/user/DollhouseMCP');
    });

    it(String.raw`returns %USERPROFILE%\DollhouseMCP on Windows`, () => {
      const result = resolveDataDirectory('portfolio-root', opts({
        platform: 'win32', homeDir: WIN_HOME,
      }));
      expect(normalize(result)).toBe(normalize(String.raw`C:\Users\user\DollhouseMCP`));
    });

    it('shared-pool lives under portfolio-root', () => {
      const result = resolveDataDirectory('shared-pool', opts({
        platform: 'linux', homeDir: LINUX_HOME,
      }));
      expectNativePath(result, '/home/user/DollhouseMCP/shared');
    });

    it('shared-provenance lives under shared-pool', () => {
      const result = resolveDataDirectory('shared-provenance', opts({
        platform: 'linux', homeDir: LINUX_HOME,
      }));
      expectNativePath(result, '/home/user/DollhouseMCP/shared/.provenance');
    });
  });

  describe('Env var overrides (highest precedence)', () => {
    it.each([
      ['config', 'DOLLHOUSE_CONFIG_DIR'],
      ['cache',  'DOLLHOUSE_CACHE_DIR'],
      ['state',  'DOLLHOUSE_STATE_DIR'],
      ['logs',   'DOLLHOUSE_LOG_DIR'],
      ['run',    'DOLLHOUSE_RUN_DIR'],
      ['portfolio-root', 'DOLLHOUSE_PORTFOLIO_DIR'],
      ['shared-pool', 'DOLLHOUSE_SHARED_POOL_DIR'],
      ['shared-provenance', 'DOLLHOUSE_SHARED_PROVENANCE_DIR'],
    ] as [DataDirKey, string][])(
      '%s honors %s',
      (key, envVar) => {
        const result = resolveDataDirectory(key, opts({
          platform: 'linux',
          homeDir: LINUX_HOME,
          env: { [envVar]: '/custom/override' },
        }));
        expectResolvedPath(result, '/custom/override');
      }
    );

    it('env override wins over legacy-root mode', () => {
      const result = resolveDataDirectory('portfolio-root', opts({
        platform: 'linux',
        homeDir: LINUX_HOME,
        legacyRoot: '/legacy/root',
        env: { DOLLHOUSE_PORTFOLIO_DIR: '/wins' },
      }));
      expectResolvedPath(result, '/wins');
    });

    it('empty env value is treated as unset', () => {
      const result = resolveDataDirectory('config', opts({
        platform: 'linux',
        homeDir: LINUX_HOME,
        env: { DOLLHOUSE_CONFIG_DIR: '' },
      }));
      expectNativePath(result, '/home/user/.config/dollhousemcp');
    });

    it('rejects relative env override (must be absolute)', () => {
      expect(() => resolveDataDirectory('config', opts({
        platform: 'linux',
        homeDir: LINUX_HOME,
        env: { DOLLHOUSE_CONFIG_DIR: './relative/path' },
      }))).toThrow(/must be an absolute path/);
    });

    it('rejects env values containing null bytes', () => {
      expect(() => resolveDataDirectory('config', opts({
        platform: 'linux',
        homeDir: LINUX_HOME,
        env: { DOLLHOUSE_CONFIG_DIR: '/safe\0/evil' },
      }))).toThrow(/control characters/);
    });

    it('rejects env values containing control characters', () => {
      expect(() => resolveDataDirectory('config', opts({
        platform: 'linux',
        homeDir: LINUX_HOME,
        env: { DOLLHOUSE_CONFIG_DIR: '/path\twith/tab' },
      }))).toThrow(/control characters/);
    });

    it('treats whitespace-only env value as unset', () => {
      const result = resolveDataDirectory('config', opts({
        platform: 'linux',
        homeDir: LINUX_HOME,
        env: { DOLLHOUSE_CONFIG_DIR: '   ' },
      }));
      expectNativePath(result, '/home/user/.config/dollhousemcp');
    });
  });

  describe('Legacy-root mode (backward compat)', () => {
    const legacyRoot = '/home/user/.dollhouse';
    const base = opts({
      platform: 'linux',
      homeDir: LINUX_HOME,
      legacyRoot,
    });

    it.each([
      ['config',            '/home/user/.dollhouse'],
      ['cache',             '/home/user/.dollhouse/.dollhousemcp/cache'],
      ['state',             '/home/user/.dollhouse/state'],
      ['logs',              '/home/user/.dollhouse/logs'],
      ['run',               '/home/user/.dollhouse/run'],
      ['portfolio-root',    '/home/user/.dollhouse/portfolio'],
      ['shared-pool',       '/home/user/.dollhouse/shared'],
      ['shared-provenance', '/home/user/.dollhouse/shared/.provenance'],
    ] as [DataDirKey, string][])(
      'resolves %s to %s',
      (key, expected) => {
        expectResolvedPath(resolveDataDirectory(key, base), expected);
      }
    );

    it('ignores platform when legacy root is set — legacy layout wins', () => {
      // Legacy-root mode produces the same relative structure regardless of
      // which platform the host claims to be. Sanity-check that by flipping
      // the platform and keeping a POSIX legacyRoot.
      const onDarwin = resolveDataDirectory('portfolio-root', opts({
        platform: 'darwin',
        homeDir: MAC_HOME,
        legacyRoot,
      }));
      expectResolvedPath(onDarwin, '/home/user/.dollhouse/portfolio');
    });
  });

  describe('DOLLHOUSE_HOME_DIR override', () => {
    it('overrides the default home directory when no explicit homeDir passed', () => {
      const result = resolveDataDirectory('config', {
        platform: 'linux',
        env: { DOLLHOUSE_HOME_DIR: '/custom/home' },
      });
      expectNativePath(result, '/custom/home/.config/dollhousemcp');
    });

    it('explicit homeDir option wins over DOLLHOUSE_HOME_DIR', () => {
      const result = resolveDataDirectory('config', {
        platform: 'linux',
        homeDir: '/explicit/home',
        env: { DOLLHOUSE_HOME_DIR: '/ignored' },
      });
      expectNativePath(result, '/explicit/home/.config/dollhousemcp');
    });
  });

  describe('envOverrideFor', () => {
    it.each([
      ['config', 'DOLLHOUSE_CONFIG_DIR'],
      ['cache',  'DOLLHOUSE_CACHE_DIR'],
      ['state',  'DOLLHOUSE_STATE_DIR'],
      ['logs',   'DOLLHOUSE_LOG_DIR'],
      ['run',    'DOLLHOUSE_RUN_DIR'],
      ['portfolio-root', 'DOLLHOUSE_PORTFOLIO_DIR'],
      ['shared-pool', 'DOLLHOUSE_SHARED_POOL_DIR'],
      ['shared-provenance', 'DOLLHOUSE_SHARED_PROVENANCE_DIR'],
    ] as [DataDirKey, string][])(
      'maps %s to %s',
      (key, envVar) => {
        expect(envOverrideFor(key)).toBe(envVar);
      }
    );
  });
});

/**
 * Normalize path separators so tests pass on any host platform.
 * Windows-style paths use `\`, POSIX uses `/`; `path.join` mirrors the
 * host so we compare on a canonical form.
 */
function normalize(p: string): string {
  return p.replaceAll(/[\\/]+/g, '/');
}
