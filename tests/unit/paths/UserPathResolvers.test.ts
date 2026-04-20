/**
 * Unit tests for IUserPathResolver implementations (Flat, PerUser, LegacyDetecting).
 *
 * The same interface contract is exercised against all three resolvers;
 * each test that is shape-independent uses the `resolverContract` helper
 * so adding a new implementation requires no test duplication.
 */

import { describe, it, expect } from '@jest/globals';
import path from 'node:path';

import { ElementType } from '../../../src/portfolio/types.js';
import { FlatPathResolver } from '../../../src/paths/FlatPathResolver.js';
import { PerUserPathResolver } from '../../../src/paths/PerUserPathResolver.js';
import {
  LegacyDetectingPathResolver,
  MIGRATION_MARKER_FILENAME,
} from '../../../src/paths/LegacyDetectingPathResolver.js';
import type { IUserPathResolver } from '../../../src/paths/IUserPathResolver.js';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

/**
 * Shared-contract tests: every IUserPathResolver must satisfy these.
 */
function resolverContract(
  name: string,
  build: () => IUserPathResolver,
  expect_: { isPerUser: boolean }
) {
  describe(`${name} — interface contract`, () => {
    it('returns absolute paths for every method', () => {
      const r = build();
      expect(path.isAbsolute(r.getUserPortfolioDir(USER_A))).toBe(true);
      expect(path.isAbsolute(r.getUserElementDir(USER_A, ElementType.PERSONA))).toBe(true);
      expect(path.isAbsolute(r.getUserStateDir(USER_A))).toBe(true);
      expect(path.isAbsolute(r.getUserAuthDir(USER_A))).toBe(true);
      expect(path.isAbsolute(r.getUserBackupsDir(USER_A))).toBe(true);
      expect(path.isAbsolute(r.getUserSecurityDir(USER_A))).toBe(true);
    });

    it('element dir is a subdirectory of portfolio dir', () => {
      const r = build();
      const portfolio = r.getUserPortfolioDir(USER_A);
      const element = r.getUserElementDir(USER_A, ElementType.PERSONA);
      expect(element.startsWith(portfolio + path.sep)).toBe(true);
    });

    it('element dir uses the ElementType enum value as its basename', () => {
      const r = build();
      expect(path.basename(r.getUserElementDir(USER_A, ElementType.PERSONA))).toBe('personas');
      expect(path.basename(r.getUserElementDir(USER_A, ElementType.SKILL))).toBe('skills');
      expect(path.basename(r.getUserElementDir(USER_A, ElementType.AGENT))).toBe('agents');
      expect(path.basename(r.getUserElementDir(USER_A, ElementType.MEMORY))).toBe('memories');
    });

    if (expect_.isPerUser) {
      it('produces different paths for different users', () => {
        const r = build();
        expect(r.getUserPortfolioDir(USER_A)).not.toBe(r.getUserPortfolioDir(USER_B));
        expect(r.getUserStateDir(USER_A)).not.toBe(r.getUserStateDir(USER_B));
        expect(r.getUserAuthDir(USER_A)).not.toBe(r.getUserAuthDir(USER_B));
        expect(r.getUserBackupsDir(USER_A)).not.toBe(r.getUserBackupsDir(USER_B));
      });

      it("user B's paths are not within user A's portfolio subtree", () => {
        const r = build();
        const aPortfolio = r.getUserPortfolioDir(USER_A);
        const bPortfolio = r.getUserPortfolioDir(USER_B);
        expect(bPortfolio.startsWith(aPortfolio + path.sep)).toBe(false);
        expect(aPortfolio.startsWith(bPortfolio + path.sep)).toBe(false);
      });
    } else {
      it('ignores userId (same path regardless of user)', () => {
        const r = build();
        expect(r.getUserPortfolioDir(USER_A)).toBe(r.getUserPortfolioDir(USER_B));
        expect(r.getUserStateDir(USER_A)).toBe(r.getUserStateDir(USER_B));
      });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────
// FlatPathResolver

resolverContract(
  'FlatPathResolver',
  () => new FlatPathResolver('/home/user/.dollhouse'),
  { isPerUser: false }
);

describe('FlatPathResolver — constructor rejects relative legacyRoot', () => {
  it('throws when given a relative root', () => {
    expect(() => new FlatPathResolver('relative/dir')).toThrow(/must be absolute/);
  });
});

describe('FlatPathResolver — specific paths', () => {
  const r = new FlatPathResolver('/home/user/.dollhouse');

  it('portfolio lives at <legacyRoot>/portfolio', () => {
    expect(r.getUserPortfolioDir('ignored')).toBe('/home/user/.dollhouse/portfolio');
  });

  it('state lives at <legacyRoot>/state', () => {
    expect(r.getUserStateDir('ignored')).toBe('/home/user/.dollhouse/state');
  });

  it('auth lives at <legacyRoot>/.auth (preserves today\'s hidden location)', () => {
    expect(r.getUserAuthDir('ignored')).toBe('/home/user/.dollhouse/.auth');
  });

  it('backups live at <legacyRoot>/portfolio/.backups (matches current BackupService)', () => {
    expect(r.getUserBackupsDir('ignored')).toBe('/home/user/.dollhouse/portfolio/.backups');
  });

  it('security lives at <legacyRoot>/security', () => {
    expect(r.getUserSecurityDir('ignored')).toBe('/home/user/.dollhouse/security');
  });
});

// ─────────────────────────────────────────────────────────────────────
// PerUserPathResolver

resolverContract(
  'PerUserPathResolver',
  () => new PerUserPathResolver('/home/user/DollhouseMCP'),
  { isPerUser: true }
);

describe('PerUserPathResolver — constructor rejects relative portfolioRoot', () => {
  it('throws when given a relative root', () => {
    expect(() => new PerUserPathResolver('relative/dir')).toThrow(/must be absolute/);
  });
});

// Note: PerUserPathResolver intentionally does not validate userId
// itself — PathService.user() is the single validation chokepoint.
// See PerUserPathResolver.ts class docstring for the ownership rule.

describe('PerUserPathResolver — specific paths', () => {
  const r = new PerUserPathResolver('/home/user/DollhouseMCP');

  it('portfolio lives at <portfolioRoot>/users/<userId>/portfolio', () => {
    expect(r.getUserPortfolioDir(USER_A)).toBe(
      `/home/user/DollhouseMCP/users/${USER_A}/portfolio`
    );
  });

  it('state lives at <portfolioRoot>/users/<userId>/state', () => {
    expect(r.getUserStateDir(USER_A)).toBe(
      `/home/user/DollhouseMCP/users/${USER_A}/state`
    );
  });

  it('auth lives at <portfolioRoot>/users/<userId>/auth', () => {
    expect(r.getUserAuthDir(USER_A)).toBe(
      `/home/user/DollhouseMCP/users/${USER_A}/auth`
    );
  });

  it('backups live at <portfolioRoot>/users/<userId>/backups (sibling of portfolio)', () => {
    expect(r.getUserBackupsDir(USER_A)).toBe(
      `/home/user/DollhouseMCP/users/${USER_A}/backups`
    );
  });

  it('security lives at <portfolioRoot>/users/<userId>/security', () => {
    expect(r.getUserSecurityDir(USER_A)).toBe(
      `/home/user/DollhouseMCP/users/${USER_A}/security`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// LegacyDetectingPathResolver — detection

describe('LegacyDetectingPathResolver — detection', () => {
  type EntryKind = 'dir' | 'file' | 'missing';
  function mockProbe(entries: Record<string, EntryKind>): (p: string) => Promise<EntryKind> {
    return async (p) => entries[p] ?? 'missing';
  }

  it('uses per-user layout on portfolioRoot when legacy root does not exist', async () => {
    const resolver = await LegacyDetectingPathResolver.detect({
      legacyRoot: '/home/user/.dollhouse',
      portfolioRoot: '/home/user/DollhouseMCP',
      probe: mockProbe({}),
    });
    expect(resolver.getLayout()).toBe('per-user');
    expect(resolver.getAnchorRoot()).toBe('/home/user/DollhouseMCP');
    expect(resolver.getUserPortfolioDir(USER_A)).toBe(
      `/home/user/DollhouseMCP/users/${USER_A}/portfolio`
    );
  });

  it('uses flat layout on legacy root when legacy root exists without marker', async () => {
    const resolver = await LegacyDetectingPathResolver.detect({
      legacyRoot: '/home/user/.dollhouse',
      portfolioRoot: '/home/user/DollhouseMCP',
      probe: mockProbe({ '/home/user/.dollhouse': 'dir' }),
    });
    expect(resolver.getLayout()).toBe('flat');
    expect(resolver.getAnchorRoot()).toBe('/home/user/.dollhouse');
    expect(resolver.getUserPortfolioDir(USER_A)).toBe('/home/user/.dollhouse/portfolio');
  });

  it('uses per-user layout on legacy root when migration marker is a regular file', async () => {
    const resolver = await LegacyDetectingPathResolver.detect({
      legacyRoot: '/home/user/.dollhouse',
      portfolioRoot: '/home/user/DollhouseMCP',
      probe: mockProbe({
        '/home/user/.dollhouse': 'dir',
        [`/home/user/.dollhouse/${MIGRATION_MARKER_FILENAME}`]: 'file',
      }),
    });
    expect(resolver.getLayout()).toBe('per-user');
    expect(resolver.getAnchorRoot()).toBe('/home/user/.dollhouse');
    expect(resolver.getUserPortfolioDir(USER_A)).toBe(
      `/home/user/.dollhouse/users/${USER_A}/portfolio`
    );
  });

  it('stays flat when marker probe returns "missing" (symlink / wrong kind / absent)', async () => {
    // The default probe uses lstat and reports 'missing' for symlinks,
    // so a pre-planted symlink cannot flip the layout.
    const resolver = await LegacyDetectingPathResolver.detect({
      legacyRoot: '/home/user/.dollhouse',
      portfolioRoot: '/home/user/DollhouseMCP',
      probe: mockProbe({
        '/home/user/.dollhouse': 'dir',
        // Marker present but probe reports 'missing' (e.g. it's a
        // symlink — lstat returns it, but isFile() is false, and the
        // default probe treats that as 'missing').
      }),
    });
    expect(resolver.getLayout()).toBe('flat');
  });

  it('rejects legacy root that is itself a symlink/file (probe returns non-dir)', async () => {
    // If legacyRoot is a symlink pointing elsewhere, the probe returns
    // 'file' or 'missing', not 'dir'. We treat that as "no legacy
    // install" and use the new layout. Symlink-planting cannot hijack
    // detection into a legacy branch.
    const resolver = await LegacyDetectingPathResolver.detect({
      legacyRoot: '/home/user/.dollhouse',
      portfolioRoot: '/home/user/DollhouseMCP',
      probe: mockProbe({ '/home/user/.dollhouse': 'file' }),
    });
    expect(resolver.getLayout()).toBe('per-user');
    expect(resolver.getAnchorRoot()).toBe('/home/user/DollhouseMCP');
  });

  it('rethrows non-ENOENT errors from the probe (fails loud on permission denied)', async () => {
    const errProbe = async (_p: string) => {
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    await expect(LegacyDetectingPathResolver.detect({
      legacyRoot: '/home/user/.dollhouse',
      portfolioRoot: '/home/user/DollhouseMCP',
      probe: errProbe,
    })).rejects.toThrow(/permission denied/);
  });
});

describe('LegacyDetectingPathResolver — delegation forwarding', () => {
  // Verifies that every IUserPathResolver method forwards to the chosen
  // delegate. A regression here (wrong method delegated, or a method
  // missed when the interface grows) would otherwise be invisible.

  async function detectPerUser(): Promise<LegacyDetectingPathResolver> {
    return LegacyDetectingPathResolver.detect({
      legacyRoot: '/home/user/.dollhouse',
      portfolioRoot: '/home/user/DollhouseMCP',
      probe: async () => 'missing', // forces per-user on portfolioRoot
    });
  }

  it('forwards getUserPortfolioDir', async () => {
    const r = await detectPerUser();
    expect(r.getUserPortfolioDir(USER_A)).toBe(
      `/home/user/DollhouseMCP/users/${USER_A}/portfolio`
    );
  });

  it('forwards getUserElementDir for every ElementType', async () => {
    const r = await detectPerUser();
    for (const type of Object.values(ElementType)) {
      const result = r.getUserElementDir(USER_A, type);
      expect(result).toBe(
        `/home/user/DollhouseMCP/users/${USER_A}/portfolio/${type}`
      );
    }
  });

  it('forwards getUserStateDir', async () => {
    const r = await detectPerUser();
    expect(r.getUserStateDir(USER_A)).toBe(
      `/home/user/DollhouseMCP/users/${USER_A}/state`
    );
  });

  it('forwards getUserAuthDir', async () => {
    const r = await detectPerUser();
    expect(r.getUserAuthDir(USER_A)).toBe(
      `/home/user/DollhouseMCP/users/${USER_A}/auth`
    );
  });

  it('forwards getUserBackupsDir', async () => {
    const r = await detectPerUser();
    expect(r.getUserBackupsDir(USER_A)).toBe(
      `/home/user/DollhouseMCP/users/${USER_A}/backups`
    );
  });

  it('forwards getUserSecurityDir', async () => {
    const r = await detectPerUser();
    expect(r.getUserSecurityDir(USER_A)).toBe(
      `/home/user/DollhouseMCP/users/${USER_A}/security`
    );
  });

  it('forwards to FlatPathResolver when detection selects flat mode', async () => {
    const r = await LegacyDetectingPathResolver.detect({
      legacyRoot: '/home/user/.dollhouse',
      portfolioRoot: '/home/user/DollhouseMCP',
      probe: async (p) => (p === '/home/user/.dollhouse' ? 'dir' : 'missing'),
    });
    // Flat resolver: userId ignored, paths anchored on legacy root.
    expect(r.getUserPortfolioDir(USER_A)).toBe('/home/user/.dollhouse/portfolio');
    expect(r.getUserPortfolioDir('ignored')).toBe('/home/user/.dollhouse/portfolio');
  });
});
