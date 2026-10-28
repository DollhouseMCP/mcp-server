import { afterEach, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolatedServerEnv } from '../helpers/isolated-server-env.cjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it('refuses the real user home, including aliases', async () => {
  expect(() => isolatedServerEnv(os.userInfo().homedir)).toThrow('must not be the real user home');
  expect(() => isolatedServerEnv('relative')).toThrow('absolute fixture directory');
  if (process.platform === 'win32') return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'server-env-')); roots.push(root);
  const alias = path.join(root, 'alias');
  await fs.symlink(os.userInfo().homedir, alias);
  expect(() => isolatedServerEnv(alias)).toThrow('must not be the real user home');
});

it('overrides inherited homes and confines a child native home lookup to the fixture', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'server-env-')); roots.push(root);
  const directory = path.join(root, '.dollhouse', 'security');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'blocked-agents.json'), 'fixture');
  const environment = isolatedServerEnv(root, { ...process.env, HOME: os.userInfo().homedir,
    DOLLHOUSE_HOME_DIR: os.userInfo().homedir, USERPROFILE: os.userInfo().homedir, DOLLHOUSE_STORAGE_BACKEND: 'database', OMIT_UNDEFINED: undefined });
  const result = JSON.parse(execFileSync(process.execPath, ['-e',
    "const os=require('node:os'),fs=require('node:fs'),path=require('node:path');console.log(JSON.stringify({home:os.homedir(),content:fs.readFileSync(path.join(os.homedir(),'.dollhouse/security/blocked-agents.json'),'utf8')}))",
  ], { env: environment, encoding: 'utf8' }));
  expect(environment).not.toHaveProperty('OMIT_UNDEFINED');
  expect(result).toEqual({ home: await fs.realpath(root), content: 'fixture' });
  expect(environment.DOLLHOUSE_HOME_DIR).toBe(result.home);
  expect(environment.USERPROFILE).toBe(result.home);
});

const itWindows = process.platform === 'win32' ? it : it.skip;
itWindows('refuses a differently-cased Windows home path', () => {
  const home = os.userInfo().homedir;
  const alias = home === home.toUpperCase() ? home.toLowerCase() : home.toUpperCase();
  expect(alias).not.toBe(home);
  expect(() => isolatedServerEnv(alias)).toThrow('must not be the real user home');
});

function windowsShortHome(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const home = os.userInfo().homedir;
    const alias = execFileSync('cmd.exe', ['/d', '/v:off', '/c',
      'for %I in ("%DOLLHOUSE_TEST_REAL_HOME%") do @echo %~sI',
    ], { env: { ...process.env, DOLLHOUSE_TEST_REAL_HOME: home }, encoding: 'utf8', timeout: 5000 }).trim();
    return alias.includes('~') && alias.toLowerCase() !== home.toLowerCase() ? alias : undefined;
  } catch {
    // 8.3 names may be disabled or unavailable on the test volume.
    return undefined;
  }
}
const shortHome = windowsShortHome();
(shortHome ? it : it.skip)('refuses an available Windows short-name home alias', () => {
  expect(() => isolatedServerEnv(shortHome!)).toThrow('must not be the real user home');
});
