/**
 * Unit tests for PathsServiceRegistrar.
 *
 * Uses a minimal in-test DI container that satisfies the facade
 * interface, so the registrar can be exercised without pulling in
 * the full Container.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';

import { PathsServiceRegistrar } from '../../../../src/di/registrars/PathsServiceRegistrar.js';
import type { DiContainerFacade } from '../../../../src/di/DiContainerFacade.js';
import { PathService, type UserIdResolver } from '../../../../src/paths/PathService.js';
import { PackageResourceLocator } from '../../../../src/paths/PackageResourceLocator.js';
import { MIGRATION_MARKER_FILENAME } from '../../../../src/paths/LegacyDetectingPathResolver.js';

class FakeContainer implements DiContainerFacade {
  private services = new Map<string, () => unknown>();
  private cache = new Map<string, unknown>();

  register<T>(name: string, factory: () => T): void {
    this.services.set(name, factory);
    this.cache.delete(name);
  }

  resolve<T>(name: string): T {
    if (this.cache.has(name)) return this.cache.get(name) as T;
    const factory = this.services.get(name);
    if (!factory) throw new Error(`service ${name} not registered`);
    const instance = factory() as T;
    this.cache.set(name, instance);
    return instance;
  }

  hasRegistration(name: string): boolean {
    return this.services.has(name);
  }
}

function buildFakeContextTracker(userId: string) {
  return {
    getSessionContext: () => ({ userId, sessionId: 'session-x' }),
  };
}

describe('PathsServiceRegistrar', () => {
  let tmpHome: string;
  let originalHomeDirEnv: string | undefined;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'paths-registrar-test-'));
    originalHomeDirEnv = process.env.DOLLHOUSE_HOME_DIR;
    process.env.DOLLHOUSE_HOME_DIR = tmpHome;
  });

  afterEach(async () => {
    if (originalHomeDirEnv === undefined) {
      delete process.env.DOLLHOUSE_HOME_DIR;
    } else {
      process.env.DOLLHOUSE_HOME_DIR = originalHomeDirEnv;
    }
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('registers PackageResourceLocator, UserPathResolver, and PathService', async () => {
    const container = new FakeContainer();
    container.register('ContextTracker', () => buildFakeContextTracker('u-1'));

    const registrar = new PathsServiceRegistrar();
    await registrar.bootstrapAndRegister(container);

    expect(container.hasRegistration('PackageResourceLocator')).toBe(true);
    expect(container.hasRegistration('UserPathResolver')).toBe(true);
    expect(container.hasRegistration('PathService')).toBe(true);
    expect(container.resolve<PackageResourceLocator>('PackageResourceLocator'))
      .toBeInstanceOf(PackageResourceLocator);
    expect(container.resolve<PathService>('PathService')).toBeInstanceOf(PathService);
  });

  it('registers UserIdResolver in file mode (when not already registered)', async () => {
    const container = new FakeContainer();
    container.register('ContextTracker', () => buildFakeContextTracker('u-1'));

    await new PathsServiceRegistrar().bootstrapAndRegister(container);

    expect(container.hasRegistration('UserIdResolver')).toBe(true);
    const resolver = container.resolve<UserIdResolver>('UserIdResolver');
    expect(resolver()).toBe('u-1');
  });

  it('does not replace an existing UserIdResolver registration (DB mode provides its own)', async () => {
    const container = new FakeContainer();
    container.register('ContextTracker', () => buildFakeContextTracker('u-1'));
    const preExisting: UserIdResolver = () => 'db-provided-user';
    container.register('UserIdResolver', () => preExisting);

    await new PathsServiceRegistrar().bootstrapAndRegister(container);

    const resolver = container.resolve<UserIdResolver>('UserIdResolver');
    expect(resolver()).toBe('db-provided-user');
  });

  it('detects fresh install (no legacy root) and selects PerUserPathResolver on portfolioRoot', async () => {
    // tmpHome has no `.dollhouse/` subdir → fresh install.
    const container = new FakeContainer();
    container.register('ContextTracker', () => buildFakeContextTracker('u-1'));

    await new PathsServiceRegistrar().bootstrapAndRegister(container);
    const pathService = container.resolve<PathService>('PathService');

    const portfolio = pathService.getUserPortfolioDir('u-1');
    // Fresh install path — portfolio anchored on portfolioRoot.
    expect(portfolio).toBe(path.join(tmpHome, 'DollhouseMCP', 'users', 'u-1', 'portfolio'));
  });

  it('detects legacy install (~/.dollhouse/ present) and selects FlatPathResolver', async () => {
    // Create the legacy root so detection picks it up.
    await fs.mkdir(path.join(tmpHome, '.dollhouse'), { recursive: true });

    const container = new FakeContainer();
    container.register('ContextTracker', () => buildFakeContextTracker('u-1'));

    await new PathsServiceRegistrar().bootstrapAndRegister(container);
    const pathService = container.resolve<PathService>('PathService');

    const portfolio = pathService.getUserPortfolioDir('u-1');
    expect(portfolio).toBe(path.join(tmpHome, '.dollhouse', 'portfolio'));
  });

  it('legacy install routes app-internal keys under legacy root (byte-identical compat)', async () => {
    await fs.mkdir(path.join(tmpHome, '.dollhouse'), { recursive: true });

    const container = new FakeContainer();
    container.register('ContextTracker', () => buildFakeContextTracker('u-1'));

    await new PathsServiceRegistrar().bootstrapAndRegister(container);
    const pathService = container.resolve<PathService>('PathService');

    expect(pathService.resolveDataDir('state')).toBe(path.join(tmpHome, '.dollhouse', 'state'));
    expect(pathService.resolveDataDir('logs')).toBe(path.join(tmpHome, '.dollhouse', 'logs'));
    expect(pathService.resolveDataDir('run')).toBe(path.join(tmpHome, '.dollhouse', 'run'));
  });

  it('detects migrated legacy install (marker file present) and uses per-user on legacy base', async () => {
    const legacy = path.join(tmpHome, '.dollhouse');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, MIGRATION_MARKER_FILENAME), '1\n');

    const container = new FakeContainer();
    container.register('ContextTracker', () => buildFakeContextTracker('u-1'));

    await new PathsServiceRegistrar().bootstrapAndRegister(container);
    const pathService = container.resolve<PathService>('PathService');

    // Portfolio anchored on legacy root but per-user.
    expect(pathService.getUserPortfolioDir('u-1'))
      .toBe(path.join(legacy, 'users', 'u-1', 'portfolio'));
    // App-internals still under legacy root.
    expect(pathService.resolveDataDir('state'))
      .toBe(path.join(legacy, 'state'));
  });

  it('throws at bootstrap when ContextTracker is not registered', async () => {
    const container = new FakeContainer();
    // Intentionally no ContextTracker registration.
    await expect(new PathsServiceRegistrar().bootstrapAndRegister(container))
      .rejects.toThrow(/ContextTracker must be registered/);
  });
});
