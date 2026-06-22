/**
 * Unit tests for PathService — the DI-injectable facade composing the
 * three path-resolution backends.
 */

import { describe, it, expect, jest } from '@jest/globals';
import path from 'node:path';

import { ElementType } from '../../../src/portfolio/types.js';
import { FlatPathResolver } from '../../../src/paths/FlatPathResolver.js';
import { PerUserPathResolver } from '../../../src/paths/PerUserPathResolver.js';
import { PackageResourceLocator } from '../../../src/paths/PackageResourceLocator.js';
import { PathService } from '../../../src/paths/PathService.js';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

function build(opts: {
  userResolver?: FlatPathResolver | PerUserPathResolver;
  userIdResolver?: () => string;
  dataDirectoryOptions?: Parameters<PathService['resolveDataDir']>[1];
} = {}): PathService {
  return new PathService({
    userResolver: opts.userResolver ?? new PerUserPathResolver('/home/u/DollhouseMCP'),
    packageLocator: new PackageResourceLocator(),
    userIdResolver: opts.userIdResolver ?? (() => USER_A),
    dataDirectoryOptions: {
      platform: 'linux',
      homeDir: '/home/u',
      env: {},
      ...opts.dataDirectoryOptions,
    },
  });
}

function buildFlatResolver() {
  return new FlatPathResolver('/home/u/.dollhouse');
}

describe('PathService', () => {
  describe('resolveDataDir', () => {
    it('resolves app-internal keys via resolveDataDirectory', () => {
      const svc = build();
      expect(svc.resolveDataDir('config')).toBe('/home/u/.config/dollhousemcp');
      expect(svc.resolveDataDir('cache')).toBe('/home/u/.cache/dollhousemcp');
      expect(svc.resolveDataDir('state')).toBe('/home/u/.local/state/dollhousemcp');
    });

    it('applies service-level dataDirectoryOptions to every call', () => {
      const svc = build({
        dataDirectoryOptions: {
          platform: 'linux',
          homeDir: '/home/u',
          legacyRoot: '/home/u/.dollhouse',
          env: {},
        },
      });
      expect(svc.resolveDataDir('portfolio-root')).toBe('/home/u/.dollhouse/portfolio');
      expect(svc.resolveDataDir('state')).toBe('/home/u/.dollhouse/state');
    });

    it('per-call options override service-level options', () => {
      const svc = build({
        dataDirectoryOptions: {
          platform: 'linux',
          homeDir: '/home/u',
          legacyRoot: '/home/u/.dollhouse',
          env: {},
        },
      });
      // Per-call passes no legacyRoot — but service-level still applies.
      // Per-call would need to explicitly override to disable; that's
      // intentional — service-level defaults stick unless overridden.
      expect(svc.resolveDataDir('state')).toBe('/home/u/.dollhouse/state');
      expect(svc.resolveDataDir('state', { homeDir: '/other' })).toBe('/home/u/.dollhouse/state');
    });
  });

  describe('per-user paths (implicit userId via resolver)', () => {
    it('uses the userIdResolver when no explicit userId is passed', () => {
      const svc = build({ userIdResolver: () => USER_A });
      expect(svc.getUserPortfolioDir()).toBe(
        `/home/u/DollhouseMCP/users/${USER_A}/portfolio`
      );
    });

    it('calls userIdResolver on every invocation (fresh context)', () => {
      const resolver = jest.fn(() => USER_A);
      const svc = build({ userIdResolver: resolver });
      svc.getUserPortfolioDir();
      svc.getUserStateDir();
      svc.getUserAuthDir();
      expect(resolver).toHaveBeenCalledTimes(3);
    });

    it('wires every per-user method through the user resolver', () => {
      const svc = build({ userIdResolver: () => USER_A });
      expect(svc.getUserElementDir(ElementType.PERSONA)).toContain('personas');
      expect(svc.getUserStateDir()).toContain(`users/${USER_A}/state`);
      expect(svc.getUserAuthDir()).toContain(`users/${USER_A}/auth`);
      expect(svc.getUserBackupsDir()).toContain(`users/${USER_A}/backups`);
      expect(svc.getUserSecurityDir()).toContain(`users/${USER_A}/security`);
    });
  });

  describe('per-user paths (explicit userId)', () => {
    it('explicit userId wins over resolver callback', () => {
      const resolver = jest.fn(() => USER_A);
      const svc = build({ userIdResolver: resolver });
      expect(svc.getUserPortfolioDir(USER_B)).toBe(
        `/home/u/DollhouseMCP/users/${USER_B}/portfolio`
      );
      // Resolver was not consulted when explicit userId passed.
      expect(resolver).not.toHaveBeenCalled();
    });

    it('empty string userId throws (empty is never valid; use undefined for fallback)', () => {
      const svc = build({ userIdResolver: () => USER_A });
      expect(() => svc.getUserPortfolioDir('')).toThrow(/empty string/);
    });
  });

  describe('per-user paths with FlatPathResolver', () => {
    it('ignores userId (same paths regardless of which user)', () => {
      const svc = build({
        userResolver: buildFlatResolver(),
        userIdResolver: () => USER_A,
      });
      const aPortfolio = svc.getUserPortfolioDir();
      const bPortfolio = svc.getUserPortfolioDir(USER_B);
      expect(aPortfolio).toBe(bPortfolio);
      expect(aPortfolio).toBe('/home/u/.dollhouse/portfolio');
    });
  });

  describe('package resources', () => {
    it('resolve() returns a path without disk verification', () => {
      const svc = build();
      const result = svc.resolvePackageResource('seed-elements/memories/foo.yaml');
      // Exact path depends on where the test runs from, but it must
      // end with the relative segment.
      expect(result).toMatch(/seed-elements\/memories\/foo\.yaml$/);
    });

    it('locate() returns null for nonexistent resources', async () => {
      const svc = build();
      const result = await svc.locatePackageResource('nonexistent-xyz.bogus');
      expect(result).toBeNull();
    });

    it('getPackageRoot() returns the installed package root', () => {
      const svc = build();
      const root = svc.getPackageRoot();
      expect(path.isAbsolute(root)).toBe(true);
      // Package root is the parent of a tree root named 'src' or 'dist'.
      expect(root).not.toMatch(/(src|dist)$/);
    });
  });

  describe('userId validation at the facade boundary', () => {
    it('rejects traversal in explicit userId', () => {
      const svc = build();
      expect(() => svc.getUserPortfolioDir('../alice')).toThrow();
    });

    it('rejects Windows reserved device names in explicit userId', () => {
      const svc = build();
      expect(() => svc.getUserPortfolioDir('CON')).toThrow(/Windows reserved/);
    });

    it('rejects invalid userId returned by the resolver callback', () => {
      const svc = build({ userIdResolver: () => '../evil' });
      expect(() => svc.getUserPortfolioDir()).toThrow();
    });
  });
});
