import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCollectionCacheDir } from '../../../src/cache/cachePaths.js';

describe('resolveCollectionCacheDir', () => {
  let originalCacheDir: string | undefined;
  let originalHomeDir: string | undefined;

  beforeEach(() => {
    originalCacheDir = process.env.DOLLHOUSE_CACHE_DIR;
    originalHomeDir = process.env.DOLLHOUSE_HOME_DIR;
    delete process.env.DOLLHOUSE_CACHE_DIR;
    delete process.env.DOLLHOUSE_HOME_DIR;
  });

  afterEach(() => {
    if (originalCacheDir === undefined) delete process.env.DOLLHOUSE_CACHE_DIR;
    else process.env.DOLLHOUSE_CACHE_DIR = originalCacheDir;

    if (originalHomeDir === undefined) delete process.env.DOLLHOUSE_HOME_DIR;
    else process.env.DOLLHOUSE_HOME_DIR = originalHomeDir;
  });

  it('uses DOLLHOUSE_CACHE_DIR as an exact override', () => {
    process.env.DOLLHOUSE_CACHE_DIR = '/exact/cache';
    process.env.DOLLHOUSE_HOME_DIR = '/ignored/home';

    expect(resolveCollectionCacheDir('/ignored/base')).toBe('/exact/cache');
  });

  it('uses an explicit home root before DOLLHOUSE_HOME_DIR', () => {
    process.env.DOLLHOUSE_HOME_DIR = '/ignored/home';

    expect(resolveCollectionCacheDir('/test/home')).toBe(
      path.join('/test/home', '.dollhouse', 'cache')
    );
  });

  it('uses DOLLHOUSE_HOME_DIR when no explicit root is provided', () => {
    process.env.DOLLHOUSE_HOME_DIR = '/configured/home';

    expect(resolveCollectionCacheDir()).toBe(
      path.join('/configured/home', '.dollhouse', 'cache')
    );
  });

  it('falls back to the operating-system home directory, never the CWD', () => {
    expect(resolveCollectionCacheDir()).toBe(
      path.join(os.homedir(), '.dollhouse', 'cache')
    );
    expect(resolveCollectionCacheDir()).not.toBe(
      path.join(process.cwd(), '.dollhouse', 'cache')
    );
  });
});
