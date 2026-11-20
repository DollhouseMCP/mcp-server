/**
 * Unit tests for PathsServiceRegistrar.
 *
 * Uses a minimal in-test DI container that satisfies the facade
 * interface, so the registrar can be exercised without pulling in
 * the full Container.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';

import { env } from '../../../../src/config/env.js';
import { SEED_MEMORY_FILENAME } from '../../../../src/elements/memories/constants.js';
import { logger } from '../../../../src/utils/logger.js';
import { PathsServiceRegistrar } from '../../../../src/di/registrars/PathsServiceRegistrar.js';
import type { DiContainerFacade } from '../../../../src/di/DiContainerFacade.js';
import { PathService, type UserIdResolver } from '../../../../src/paths/PathService.js';
import { PackageResourceLocator } from '../../../../src/paths/PackageResourceLocator.js';
import { LegacyDetectingPathResolver, MIGRATION_MARKER_FILENAME, PORTFOLIO_LAYOUT_MARKER_FILENAME } from '../../../../src/paths/LegacyDetectingPathResolver.js';

class FakeContainer implements DiContainerFacade {
  private readonly services = new Map<string, () => unknown>();
  private readonly cache = new Map<string, unknown>();

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
    jest.restoreAllMocks();
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

  it.each(['database', 'file'] as const)('handles an unwritable portfolio root in %s mode', async backend => {
    jest.replaceProperty(env, 'DOLLHOUSE_STORAGE_BACKEND', backend);
    const root = path.join(tmpHome, 'DollhouseMCP');
    // A file occupying the directory path denies writes on every platform,
    // including privileged test runners where chmod cannot enforce read-only access.
    await fs.writeFile(root, 'Do not replace');
    const container = new FakeContainer();
    container.register('ContextTracker', () => buildFakeContextTracker('u-1'));
    const starting = new PathsServiceRegistrar().bootstrapAndRegister(container);
    if (backend === 'database') {
      await starting;
      expect(container.resolve<PathService>('PathService').getUserPortfolioDir('u-1'))
        .toBe(path.join(root, 'users', 'u-1', 'portfolio'));
    } else {
      await expect(starting).rejects.toThrow();
      expect(container.hasRegistration('PathService')).toBe(false);
    }
    expect(await fs.readFile(root, 'utf8')).toBe('Do not replace');
    await expect(fs.lstat(path.join(root, PORTFOLIO_LAYOUT_MARKER_FILENAME))).rejects.toThrow();
  });

  it('keeps file-mode publication fail-loud on a read-only filesystem', async () => {
    jest.replaceProperty(env, 'DOLLHOUSE_STORAGE_BACKEND', 'file');
    const error = Object.assign(new Error('Read-only filesystem'), { code: 'EROFS' });
    jest.spyOn(LegacyDetectingPathResolver.prototype, 'persistLayoutDecision').mockRejectedValueOnce(error);
    const container = new FakeContainer();
    container.register('ContextTracker', () => buildFakeContextTracker('u-1'));
    await expect(new PathsServiceRegistrar().bootstrapAndRegister(container)).rejects.toBe(error);
    expect(container.hasRegistration('PathService')).toBe(false);
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

  it('preserves marker bytes, mode and modification time when persisting twice', async () => {
    const root = path.join(tmpHome, 'DollhouseMCP');
    const resolver = await LegacyDetectingPathResolver.detect({
      legacyRoot: path.join(tmpHome, '.dollhouse'), portfolioRoot: root,
    });
    await resolver.persistLayoutDecision();
    const marker = path.join(root, PORTFOLIO_LAYOUT_MARKER_FILENAME);
    const oldTime = new Date('2020-01-01T00:00:00Z');
    await fs.utimes(marker, oldTime, oldTime);
    const bytes = await fs.readFile(marker);
    const before = await fs.stat(marker, { bigint: true });
    await expect(resolver.persistLayoutDecision()).resolves.toBeUndefined();
    expect(await fs.readFile(marker)).toEqual(bytes);
    const after = await fs.stat(marker, { bigint: true });
    expect({ mode: after.mode, mtime: after.mtimeNs })
      .toEqual({ mode: before.mode, mtime: before.mtimeNs });
  });

  it('records the portfolio decision once and keeps it ahead of later legacy content', async () => {
    const start = async () => {
      const container = new FakeContainer();
      container.register('ContextTracker', () => buildFakeContextTracker('u-1'));
      await new PathsServiceRegistrar().bootstrapAndRegister(container);
      return container.resolve<PathService>('PathService');
    };
    const [first] = await Promise.all([start(), start()]);
    const root = path.join(tmpHome, 'DollhouseMCP');
    const marker = path.join(root, PORTFOLIO_LAYOUT_MARKER_FILENAME);
    expect((await fs.lstat(marker)).isFile()).toBe(true);
    const oldTime = new Date('2020-01-01T00:00:00Z');
    await fs.utimes(marker, oldTime, oldTime);
    const normalWarning = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    await fs.mkdir(path.join(tmpHome, '.dollhouse', 'logs'), { recursive: true });
    await fs.writeFile(path.join(tmpHome, '.dollhouse', 'logs', 'server.log'), 'Runtime file');
    expect((await start()).getUserPortfolioDir('u-1')).toBe(first.getUserPortfolioDir('u-1'));
    expect(normalWarning).not.toHaveBeenCalled();
    normalWarning.mockRestore();
    const legacySkills = path.join(tmpHome, '.dollhouse', 'portfolio', 'skills');
    await fs.mkdir(legacySkills, { recursive: true });
    await fs.writeFile(path.join(legacySkills, 'legacy.md'), 'Legacy content stays separate');
    const warning = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const restarted = await start();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(path.join(tmpHome, '.dollhouse', 'portfolio')));
    expect(restarted.getUserPortfolioDir('u-1')).toBe(first.getUserPortfolioDir('u-1'));
    expect(restarted.getUserPortfolioDir('u-1')).toBe(path.join(root, 'users', 'u-1', 'portfolio'));
    expect((await fs.stat(marker)).mtimeMs).toBe(oldTime.getTime());
    expect(await fs.readFile(path.join(legacySkills, 'legacy.md'), 'utf8')).toBe('Legacy content stays separate');
  });

  it.each(['symlink', 'directory'] as const)('refuses a %s portfolio marker but honours a regular file', async kind => {
    const root = path.join(tmpHome, 'DollhouseMCP');
    const legacy = path.join(tmpHome, '.dollhouse');
    await fs.mkdir(root);
    await fs.mkdir(legacy);
    const marker = path.join(root, PORTFOLIO_LAYOUT_MARKER_FILENAME);
    const target = path.join(tmpHome, 'target');
    await fs.writeFile(target, '');
    if (kind === 'symlink') await fs.symlink(target, marker);
    else await fs.mkdir(marker);
    const start = async () => {
      const container = new FakeContainer();
      container.register('ContextTracker', () => buildFakeContextTracker('u-1'));
      await new PathsServiceRegistrar().bootstrapAndRegister(container);
      return container.resolve<PathService>('PathService').getUserPortfolioDir('u-1');
    };
    await expect(start()).rejects.toThrow('Portfolio layout record must be a regular file');
    await fs.rm(marker, { recursive: true });
    await fs.writeFile(marker, '');
    expect(await start()).toBe(path.join(root, 'users', 'u-1', 'portfolio'));
  });

  it('refuses a fresh startup when its decision cannot replace a symlink', async () => {
    const root = path.join(tmpHome, 'DollhouseMCP');
    await fs.mkdir(root);
    const target = path.join(tmpHome, 'untouched');
    await fs.writeFile(target, 'Keep this content');
    await fs.symlink(target, path.join(root, PORTFOLIO_LAYOUT_MARKER_FILENAME));
    const container = new FakeContainer();
    container.register('ContextTracker', () => buildFakeContextTracker('u-1'));
    await expect(new PathsServiceRegistrar().bootstrapAndRegister(container)).rejects.toThrow('Portfolio layout record must be a regular file');
    expect(await fs.readFile(target, 'utf8')).toBe('Keep this content');
  });

  describe('recovery of an unrecorded per-user portfolio', () => {
    const detect = () => LegacyDetectingPathResolver.detect({
      legacyRoot: path.join(tmpHome, '.dollhouse'), portfolioRoot: path.join(tmpHome, 'DollhouseMCP'),
    });
    const skillPath = () => path.join(tmpHome, 'DollhouseMCP', 'users', 'u-1', 'portfolio', 'skills', 'kept.md');
    const markerPath = () => path.join(tmpHome, 'DollhouseMCP', PORTFOLIO_LAYOUT_MARKER_FILENAME);
    async function writeSkill(file = skillPath()) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'Existing element content');
    }

    it.each(['incidental', 'linked file', 'linked directory'] as const)('recovers beside %s legacy content and records once', async kind => {
      await fs.mkdir(path.join(tmpHome, '.dollhouse', 'logs'), { recursive: true });
      await fs.writeFile(path.join(tmpHome, '.dollhouse', 'config.yml'), 'Runtime configuration');
      await writeSkill();
      if (kind !== 'incidental') {
        const target = path.join(tmpHome, 'outside');
        const legacyDirectory = path.join(tmpHome, '.dollhouse', 'portfolio', 'skills');
        await fs.mkdir(path.dirname(legacyDirectory), { recursive: true });
        if (kind === 'linked file') {
          await fs.mkdir(legacyDirectory);
          await fs.writeFile(target, 'Linked element');
          await fs.symlink(target, path.join(legacyDirectory, 'linked.md'));
        } else {
          await writeSkill(path.join(target, 'linked.md'));
          await fs.symlink(target, legacyDirectory, 'junction');
        }
      }
      const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
      const recovered = await detect();
      expect(recovered.getAnchorRoot()).toBe(path.join(tmpHome, 'DollhouseMCP'));
      expect(recovered.getLayout()).toBe('per-user');
      await recovered.persistLayoutDecision();
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(expect.stringContaining('Recovered the per-user layout'));
      const oldTime = new Date('2020-01-01T00:00:00Z');
      await fs.utimes(markerPath(), oldTime, oldTime);
      await (await detect()).persistLayoutDecision();
      expect((await fs.stat(markerPath())).mtimeMs).toBe(oldTime.getTime());
      expect(info).toHaveBeenCalledTimes(1);
    });

    it('keeps conflicting portfolios flat with one warning and no record or data movement', async () => {
      await writeSkill();
      const legacySkill = path.join(tmpHome, '.dollhouse', 'portfolio', 'skills', 'flat.md');
      await writeSkill(legacySkill);
      const warning = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      const result = await detect();
      await result.persistLayoutDecision();
      expect(result.getLayout()).toBe('flat');
      expect(result.getAnchorRoot()).toBe(path.join(tmpHome, '.dollhouse'));
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(path.join(tmpHome, '.dollhouse', 'portfolio')));
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(path.join(tmpHome, 'DollhouseMCP')));
      await expect(fs.lstat(markerPath())).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(skillPath(), 'utf8')).toBe('Existing element content');
      expect(await fs.readFile(legacySkill, 'utf8')).toBe('Existing element content');
    });

    it.each(['empty', 'non-element', 'linked file', 'linked directory', 'linked user', 'linked users'] as const)(
      'ignores %s content until a regular per-user element exists', async kind => {
        await fs.mkdir(path.join(tmpHome, '.dollhouse'));
        const users = path.join(tmpHome, 'DollhouseMCP', 'users');
        const directory = path.dirname(skillPath());
        await fs.mkdir(directory, { recursive: true });
        if (kind === 'non-element') await fs.writeFile(path.join(directory, 'notes.txt'), 'Not an element');
        if (kind.startsWith('linked')) {
          const target = path.join(tmpHome, 'elsewhere');
          const links = { 'linked file': skillPath(), 'linked directory': directory,
            'linked user': path.join(users, 'u-1'), 'linked users': users };
          const link = links[kind as keyof typeof links];
          await fs.rm(link, { recursive: true, force: true });
          if (kind === 'linked file') {
            await fs.writeFile(target, 'Existing element content');
            await fs.symlink(target, link);
          } else {
            const suffixes = { 'linked directory': ['kept.md'], 'linked user': ['portfolio', 'skills', 'kept.md'],
              'linked users': ['u-1', 'portfolio', 'skills', 'kept.md'] };
            const suffix = suffixes[kind as keyof typeof suffixes];
            await writeSkill(path.join(target, ...suffix));
            await fs.symlink(target, link, 'junction');
          }
        }
        const ignored = await detect();
        await ignored.persistLayoutDecision();
        expect(ignored.getLayout()).toBe('flat');
        await expect(fs.lstat(markerPath())).rejects.toMatchObject({ code: 'ENOENT' });
        await fs.rm(users, { recursive: true, force: true });
        await writeSkill();
        expect((await detect()).getLayout()).toBe('per-user');
      });
  });

  describe('server artifacts in layout evidence', () => {
    const root = () => path.join(tmpHome, 'DollhouseMCP');
    const legacy = () => path.join(tmpHome, '.dollhouse');
    const perUser = () => path.join(root(), 'users', 'u-1', 'portfolio');
    const detect = () => LegacyDetectingPathResolver.detect({ legacyRoot: legacy(), portfolioRoot: root() });
    async function write(file: string, content: string) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    }
    async function artifact(portfolio: string, kind: string) {
      if (kind === 'default') {
        const file = path.join(portfolio, 'skills', 'code-review.md');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.copyFile(path.join(new PackageResourceLocator().getPackageRoot(), 'data', 'skills', 'code-review.md'), file);
        return file;
      }
      if (kind === 'seed' || kind === 'seed-backup') {
        const filename = kind === 'seed' ? SEED_MEMORY_FILENAME
          : SEED_MEMORY_FILENAME.replace('.yaml', '.backup-2025-11-14-22-40-57-303.yaml');
        const file = path.join(portfolio, 'memories', 'system', filename);
        await write(file, 'Installed or edited seed content');
        return file;
      }
      const file = kind === 'dot-file' ? path.join(portfolio, 'skills', '.runtime.yaml')
        : path.join(portfolio, 'agents', '.state', 'runtime.state.yaml');
      await write(file, 'Runtime state');
      return file;
    }

    it.each(['default', 'dot-file', 'dot-directory', 'seed', 'seed-backup'])('ignores a legacy %s during recovery and recorded startup', async kind => {
      await write(path.join(perUser(), 'skills', 'user.md'), 'User element');
      await artifact(path.join(legacy(), 'portfolio'), kind);
      const warning = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      const recovered = await detect();
      expect(recovered.getAnchorRoot()).toBe(root());
      await recovered.persistLayoutDecision();
      expect((await detect()).getAnchorRoot()).toBe(root());
      expect(warning).not.toHaveBeenCalled();
    });

    it.each(['default', 'dot-file', 'dot-directory', 'seed', 'seed-backup'])('does not recover from a per-user %s alone', async kind => {
      await fs.mkdir(legacy());
      await artifact(perUser(), kind);
      const empty = await detect();
      expect(empty.getLayout()).toBe('flat');
      await empty.persistLayoutDecision();
      await expect(fs.lstat(path.join(root(), PORTFOLIO_LAYOUT_MARKER_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each([
      ['system', 'user-memory.yaml'], ['archive', SEED_MEMORY_FILENAME],
      ['archive/system', SEED_MEMORY_FILENAME], ['system', SEED_MEMORY_FILENAME.replace('.yaml', '.backup-not-a-timestamp.yaml')],
    ])('counts user memory at %s/%s as content', async (directory, filename) => {
      await write(path.join(perUser(), 'skills', 'user.md'), 'User element');
      await write(path.join(legacy(), 'portfolio', 'memories', directory, filename), 'User memory');
      expect((await detect()).getLayout()).toBe('flat');
    });

    it('counts an edited bundled default as user content', async () => {
      await write(path.join(perUser(), 'skills', 'user.md'), 'User element');
      const file = await artifact(path.join(legacy(), 'portfolio'), 'default');
      expect((await detect()).getLayout()).toBe('per-user');
      await fs.appendFile(file, '\nUser edits must be preserved.');
      const conflict = await detect();
      expect(conflict.getLayout()).toBe('flat');
      await conflict.persistLayoutDecision();
      await expect(fs.lstat(path.join(root(), PORTFOLIO_LAYOUT_MARKER_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(file, 'utf8')).toContain('User edits must be preserved.');
    });
  });

  describe('concurrent detection and invalid layout roots', () => {
    const root = () => path.join(tmpHome, 'DollhouseMCP');
    const legacy = () => path.join(tmpHome, '.dollhouse');
    const marker = () => path.join(root(), PORTFOLIO_LAYOUT_MARKER_FILENAME);
    const options = () => ({ legacyRoot: legacy(), portfolioRoot: root() });
    async function probe(file: string): Promise<'dir' | 'file' | 'other' | 'missing'> {
      try {
        const stat = await fs.lstat(file);
        if (stat.isDirectory()) return 'dir';
        return stat.isFile() ? 'file' : 'other';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
        throw error;
      }
    }

    it.each([false, true])('adopts a record published before its legacy probe resumes (migration: %s)', async migrated => {
      let interleaved = false;
      const first = await LegacyDetectingPathResolver.detect({ ...options(), probe: async file => {
        if (file === legacy() && !interleaved) {
          interleaved = true;
          const second = await LegacyDetectingPathResolver.detect(options());
          await second.persistLayoutDecision();
          await fs.mkdir(path.join(legacy(), 'run'), { recursive: true });
          if (migrated) await fs.writeFile(path.join(legacy(), MIGRATION_MARKER_FILENAME), '');
        }
        return probe(file);
      } });
      expect(interleaved).toBe(true);
      expect(first.getLayout()).toBe('per-user');
      expect(first.getAnchorRoot()).toBe(root());
    });

    it.each(['file', 'directory'])('rechecks a %s record after probing content', async kind => {
      const second = await LegacyDetectingPathResolver.detect(options());
      await fs.mkdir(legacy());
      await fs.mkdir(root());
      let interleaved = false;
      const detection = LegacyDetectingPathResolver.detect({ ...options(), probe: async file => {
        if (file === path.join(root(), 'users')) {
          interleaved = true;
          if (kind === 'file') await second.persistLayoutDecision();
          else await fs.mkdir(marker());
        }
        return probe(file);
      } });
      if (kind === 'file') expect((await detection).getAnchorRoot()).toBe(root());
      else await expect(detection).rejects.toThrow('Portfolio layout record must be a regular file');
      expect(interleaved).toBe(true);
    });

    it.each([['file', false], ['junction', false], ['file', true], ['junction', true]] as const)('keeps per-user layout beside a legacy %s (recorded: %s)', async (kind, recorded) => {
      if (kind === 'file') await fs.writeFile(legacy(), 'Unchanged');
      else await fs.symlink(tmpHome, legacy(), 'junction');
      const skill = path.join(root(), 'users', 'u-1', 'portfolio', 'skills', 'user.md');
      await fs.mkdir(path.dirname(skill), { recursive: true });
      await fs.writeFile(skill, 'User content');
      if (recorded) await fs.writeFile(marker(), '');
      const guardedProbe = async (file: string) => {
        expect(file.startsWith(`${legacy()}${path.sep}`)).toBe(false);
        return probe(file);
      };
      const recovered = await LegacyDetectingPathResolver.detect({ ...options(), probe: guardedProbe });
      expect(recovered.getAnchorRoot()).toBe(root());
      await recovered.persistLayoutDecision();
      expect((await fs.lstat(marker())).isFile()).toBe(true);
      expect((await LegacyDetectingPathResolver.detect({ ...options(), probe: guardedProbe })).getAnchorRoot()).toBe(root());
    });

    it('keeps the recorded layout when legacy diagnostics cannot read the portfolio', async () => {
      await fs.mkdir(root());
      await fs.mkdir(legacy());
      await fs.writeFile(marker(), '');
      const warning = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      const detected = await LegacyDetectingPathResolver.detect({ ...options(), probe: async file => {
        if (file === path.join(legacy(), 'portfolio')) throw Object.assign(new Error('Private error'), { code: 'EACCES' });
        return probe(file);
      } });
      expect(detected.getAnchorRoot()).toBe(root());
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(`Could not inspect legacy portfolio at ${path.join(legacy(), 'portfolio')}`));
    });

    it.each(['file', 'junction'])('refuses a legacy root that is a %s', async kind => {
      if (kind === 'file') await fs.writeFile(legacy(), 'untouched');
      else await fs.symlink(tmpHome, legacy(), 'junction');
      await expect(LegacyDetectingPathResolver.detect(options())).rejects.toThrow('Legacy root must be a directory');
      await expect(fs.lstat(marker())).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not announce recovery when the portfolio root is inside the legacy root', async () => {
      const portfolioRoot = path.join(legacy(), 'nested');
      const skill = path.join(portfolioRoot, 'users', 'u-1', 'portfolio', 'skills', 'user.md');
      await fs.mkdir(path.dirname(skill), { recursive: true });
      await fs.writeFile(skill, 'User content');
      const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
      await expect(LegacyDetectingPathResolver.detect({ legacyRoot: legacy(), portfolioRoot }))
        .rejects.toThrow('Cannot record a fresh or recovered layout inside the legacy root');
      expect(info).not.toHaveBeenCalledWith(expect.stringContaining('Recovered the per-user layout'));
    });

    it.each(['', 'nested'])('refuses fresh/recovered roots inside legacy but preserves flat installs (%s)', async suffix => {
      const portfolioRoot = path.join(legacy(), suffix);
      const opts = { legacyRoot: legacy(), portfolioRoot };
      await expect(LegacyDetectingPathResolver.detect(opts)).rejects.toThrow('inside the legacy root');
      await fs.mkdir(legacy());
      const flat = await LegacyDetectingPathResolver.detect(opts);
      expect(flat.getLayout()).toBe('flat');
      await flat.persistLayoutDecision();
      const skill = path.join(portfolioRoot, 'users', 'u-1', 'portfolio', 'skills', 'user.md');
      await fs.mkdir(path.dirname(skill), { recursive: true });
      await fs.writeFile(skill, 'User content');
      await expect(LegacyDetectingPathResolver.detect(opts)).rejects.toThrow('inside the legacy root');
      await expect(fs.lstat(path.join(portfolioRoot, PORTFOLIO_LAYOUT_MARKER_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('throws at bootstrap when ContextTracker is not registered', async () => {
    const container = new FakeContainer();
    // Intentionally no ContextTracker registration.
    await expect(new PathsServiceRegistrar().bootstrapAndRegister(container))
      .rejects.toThrow(/ContextTracker must be registered/);
  });
});
