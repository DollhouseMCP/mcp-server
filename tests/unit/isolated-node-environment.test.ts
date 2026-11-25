import { expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { allowsEnvironment } from '../helpers/environmentPragmas.cjs';
import { isolatedServerEnv } from '../helpers/isolated-server-env.cjs';

it('isolates the native home before the Jest clone and restores it at teardown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'environment-probe-'));
  try {
    const result = JSON.parse(execFileSync(process.execPath, ['-e', `
      const os = require('node:os'), fs = require('node:fs');
      const Environment = require(process.argv[1]);
      const original = os.homedir();
      const config = { projectConfig: { testEnvironmentOptions: {}, globals: {} } };
      (async () => {
        const environment = new Environment(config, { console });
        const home = os.homedir();
        const copied = environment.global.process.env.HOME;
        const profile = environment.global.process.env.USERPROFILE;
        environment.global.process.env.HOME = 'only-the-jest-copy';
        const nativeUnchanged = os.homedir() === home;
        await environment.teardown();
        console.log(JSON.stringify({ isolated: home !== original, copied, home, profile,
          nativeUnchanged, restored: os.homedir() === original, removed: !fs.existsSync(home) }));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `, path.resolve('tests', 'helpers', 'isolated-node-environment.cjs')], {
      env: isolatedServerEnv(root), encoding: 'utf8',
    }));
    expect(result).toMatchObject({ isolated: true, nativeUnchanged: true, restored: true, removed: true });
    expect(result.copied).toBe(result.home);
    expect(result.profile).toBe(result.home);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('uses an empty native fixture home without changing the account home identity', () => {
  expect(os.homedir()).toBe(process.env.HOME);
  expect(os.homedir()).toBe(process.env.USERPROFILE);
  expect(os.homedir()).not.toBe(os.userInfo().homedir);
});

it('isolates platform defaults and inherited product path overrides, then restores them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'platform-home-probe-'));
  try {
    const canonicalRoot = realpathSync.native(root);
    const result = JSON.parse(execFileSync(process.execPath, ['-e', `
      const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
      const sources = fs.readdirSync('src', {recursive:true}).filter(name => name.endsWith('.ts'));
      const keys = [...new Set(sources.flatMap(name => fs.readFileSync(path.join('src', name),'utf8').match(/\\bDOLLHOUSE_[A-Z_]+_DIR\\b/g) || []))];
      keys.push('XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','XDG_DATA_HOME','APPDATA','LOCALAPPDATA','DOLLHOUSE_LOG_FILE');
      for (const key of keys) process.env[key] = path.join(os.userInfo().homedir, 'developer-state');
      const before = Object.fromEntries(keys.map(key => [key,process.env[key]]));
      const Environment = require(process.argv[1]);
      const helper = require(process.argv[2]);
      (async () => {
        const childEnv = helper.isolatedServerEnv(process.argv[3], {...process.env,
          DOLLHOUSE_PORTFOLIO_DIR:path.join(process.argv[3],'explicit-portfolio')});
        const environment = new Environment({projectConfig:{testEnvironmentOptions:{},globals:{}}},{console});
        const {resolveDataDirectory} = await import('./dist/paths/resolveDataDirectory.js');
        const home = os.homedir();
        const guardUsesAccountAppData = environment.global[Symbol.for('dollhouse.test.accountAppData')] === before.APPDATA;
        const resolved = ['linux','darwin','win32'].flatMap(platform =>
          ['run','state','config','cache','logs','portfolio-root','shared-pool','shared-provenance'].map(key =>
            resolveDataDirectory(key,{platform})));
        const remaining = keys.filter(key => key.startsWith('DOLLHOUSE_') && key !== 'DOLLHOUSE_HOME_DIR' && process.env[key] !== undefined);
        const platformPaths = keys.filter(key => !key.startsWith('DOLLHOUSE_')).map(key => process.env[key]);
        await environment.teardown();
        console.log(JSON.stringify({home,resolved,remaining,platformPaths,childEnv,guardUsesAccountAppData,
          restored:keys.every(key => process.env[key]===before[key])}));
      })().catch(error => {console.error(error);process.exitCode=1;});
    `, path.resolve('tests/helpers/isolated-node-environment.cjs'),
    path.resolve('tests/helpers/isolated-server-env.cjs'), root], { env: isolatedServerEnv(root), encoding: 'utf8' }));
    expect(result.remaining).toEqual([]);
    expect(result.guardUsesAccountAppData).toBe(true);
    expect(result.restored).toBe(true);
    for (const resolved of [...result.resolved, ...result.platformPaths]) {
      const relative = path.relative(result.home, resolved);
      expect(relative.startsWith('..')).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
    }
    expect(result.childEnv.DOLLHOUSE_RUN_DIR).toBeUndefined();
    expect(result.childEnv.DOLLHOUSE_LOG_FILE).toBeUndefined();
    // Explicit product overrides retain their supplied spelling, unlike home defaults.
    expect(result.childEnv.DOLLHOUSE_PORTFOLIO_DIR).toBe(path.join(root, 'explicit-portfolio'));
    expect(result.childEnv.APPDATA).toBe(path.join(canonicalRoot, 'AppData', 'Roaming'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('allows only per-file pragmas resolving to the package isolated environment', async () => {
  const fs = await import('node:fs/promises');
  const offenders: string[] = [];
  for (const directory of ['tests', path.join('packages', 'safety', 'tests')]) {
    const names = await fs.readdir(directory, { recursive: true });
    const sources = names.filter(name => /\.[cm]?[jt]sx?$/.test(name));
    const contents = await Promise.all(sources.map(name => fs.readFile(path.join(directory, name), 'utf8')));
    sources.forEach((name, index) => {
      const packageRoot = path.resolve(directory === 'tests' ? '.' : 'packages/safety');
      const environment = path.join(packageRoot, 'tests', 'helpers', 'isolated-node-environment.cjs');
      if (!allowsEnvironment(contents[index], packageRoot, environment)) offenders.push(path.join(directory, name));
    });
  }
  expect(offenders).toEqual([]);
});

it.each(['node', 'jsdom', './tests/jest.setup.mjs', 'jest-environment-node/build/index.js'])(
  'refuses non-isolated environment pragma %s', value => {
    const root = process.cwd();
    expect(allowsEnvironment(`/** @jest-environment ${value} */`, root,
      path.join(root, 'tests/helpers/isolated-node-environment.cjs'))).toBe(false);
  });

it('refuses a pragma naming an unresolvable module', () => {
  const root = process.cwd();
  expect(allowsEnvironment('/** @jest-environment ./tests/helpers/does-not-exist.cjs */', root,
    path.join(root, 'tests/helpers/isolated-node-environment.cjs'))).toBe(false);
});

it('accepts a pragma resolving to the isolated environment', () => {
  const root = process.cwd();
  expect(allowsEnvironment('/** @jest-environment <rootDir>/tests/helpers/isolated-node-environment.cjs */', root,
    path.join(root, 'tests/helpers/isolated-node-environment.cjs'))).toBe(true);
});
