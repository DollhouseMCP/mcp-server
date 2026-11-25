import { afterEach, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
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

it('reports the path when the fixture home does not exist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'server-env-')); roots.push(root);
  const missing = path.join(root, 'never-created');
  expect(() => isolatedServerEnv(missing)).toThrow(`Test server home does not exist: ${missing}`);
});

it('overrides inherited homes and confines a child native home lookup to the fixture', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'server-env-')); roots.push(root);
  const directory = path.join(root, '.dollhouse', 'security');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'blocked-agents.json'), 'fixture');
  const environment = isolatedServerEnv(root, { ...process.env, HOME: os.userInfo().homedir,
    DOLLHOUSE_HOME_DIR: os.userInfo().homedir, USERPROFILE: os.userInfo().homedir, DOLLHOUSE_STORAGE_BACKEND: 'database', OMIT_UNDEFINED: undefined });
  const result = JSON.parse(execFileSync(process.execPath, ['-e',
    "const os=require('node:os'),fs=require('node:fs'),path=require('node:path');console.log(JSON.stringify({home:os.homedir(),content:fs.readFileSync(path.join(os.homedir(),'.dollhouse','security','blocked-agents.json'),'utf8')}))",
  ], { env: environment, encoding: 'utf8' }));
  expect(environment).not.toHaveProperty('OMIT_UNDEFINED');
  expect(result).toEqual({ home: realpathSync.native(root), content: 'fixture' });
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

// Native Windows env lookups ignore case; copied JSON objects do not.
function environmentValue(environment: Record<string, string>, key: string): string | undefined {
  const actualKey = process.platform === 'win32'
    ? Object.keys(environment).find(candidate => candidate.toLowerCase() === key.toLowerCase())
    : key;
  return actualKey === undefined ? undefined : environment[actualKey];
}

it('isolates npm path settings in every inherited casing and retains fixture overrides', async () => {
  const root = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'npm-paths-'))); roots.push(root);
  const result = JSON.parse(execFileSync(process.execPath, ['-e', `
    const os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
    const settings=['cache','logs_dir','prefix','userconfig','globalconfig'];
    const keys=settings.flatMap(setting=>['npm_config_'+setting,('npm_config_'+setting).toUpperCase(),'NpM_CoNfIg_'+setting]);
    const before={};
    for(const key of keys){before[key]=path.join(os.userInfo().homedir,'developer-npm');process.env[key]=before[key];}
    const {isolatedServerEnv,isolateNativeHome}=require(process.argv[1]);
    const home=process.argv[2];
    const child=isolatedServerEnv(home,process.env);
    const nodeDirectory=path.dirname(process.execPath);
    const npmCli=[process.env.npm_execpath,
      path.join(nodeDirectory,'node_modules/npm/bin/npm-cli.js'),
      path.resolve(nodeDirectory,'../lib/node_modules/npm/bin/npm-cli.js')]
      .find(candidate=>candidate && path.basename(candidate)==='npm-cli.js' && require('node:fs').existsSync(candidate));
    if(!npmCli) throw new Error('Cannot locate npm-cli.js beside Node or through npm_execpath');
    const actualCache=cp.execFileSync(process.execPath,[npmCli,'config','get','cache'],{env:child,encoding:'utf8'}).trim();
    const restore=isolateNativeHome(home);
    const native=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
    restore();
    const explicit=path.join(home,'custom-cache');
    const preserved=isolatedServerEnv(home,{...process.env,npm_config_cache:explicit});
    console.log(JSON.stringify({child,native,actualCache,preserved,explicit,
      restored:keys.every(key=>process.env[key]===before[key])}));
  `, path.resolve('tests/helpers/isolated-server-env.cjs'), root], {
    env: isolatedServerEnv(root), encoding: 'utf8',
  }));
  expect(result.restored).toBe(true);
  expect(result.actualCache).toBe(path.join(root, '.npm'));
  for (const [key, value] of Object.entries(result.native)) {
    expect(environmentValue(result.child, key)).toBe(value);
    expect(path.relative(root, value as string).startsWith('..')).toBe(false);
  }
  for (const key of ['npm_config_cache', 'NPM_CONFIG_CACHE', 'NpM_CoNfIg_cache']) {
    expect(environmentValue(result.preserved, key)).toBe(result.explicit);
  }
});

it.each(['default', 'alias', 'canonical'] as const)(
  'uses canonical paths through a symlinked fixture home with %s npm overrides', async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aliased-home-')); roots.push(root);
    const real = path.join(root, 'real');
    const alias = path.join(root, 'alias');
    await fs.mkdir(real);
    await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const canonical = realpathSync.native(real);
    const result = JSON.parse(execFileSync(process.execPath, ['-e', `
      const path=require('node:path'),os=require('node:os');
      const {isolatedServerEnv,isolateNativeHome}=require(process.argv[1]);
      const [alias,canonical,mode]=process.argv.slice(2);
      const keys=['HOME','DOLLHOUSE_HOME_DIR','USERPROFILE','XDG_CONFIG_HOME','XDG_CACHE_HOME',
        'XDG_STATE_HOME','XDG_DATA_HOME','APPDATA','LOCALAPPDATA',
        'npm_config_cache','npm_config_logs_dir','npm_config_prefix','npm_config_userconfig','npm_config_globalconfig'];
      for(const key of keys.filter(key=>key.startsWith('npm_config_'))) delete process.env[key];
      if(mode!=='default') process.env.npm_config_cache=path.join(mode==='alias'?alias:canonical,'custom','cache');
      const before=process.env.npm_config_cache;
      const child=isolatedServerEnv(alias);
      const canonicalChild=isolatedServerEnv(canonical);
      const restore=isolateNativeHome(alias);
      const native=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
      const nativeHome=os.homedir();
      restore();
      console.log(JSON.stringify({child:Object.fromEntries(keys.map(key=>[key,child[key]])),
        canonicalChild:Object.fromEntries(keys.map(key=>[key,canonicalChild[key]])),native,nativeHome,
        restored:process.env.npm_config_cache===before}));
    `, path.resolve('tests/helpers/isolated-server-env.cjs'), alias, canonical, mode], {
      env: isolatedServerEnv(root), encoding: 'utf8',
    }));
    expect(result.nativeHome).toBe(canonical);
    expect(result.restored).toBe(true);
    expect(result.native).toEqual(result.child);
    expect(result.canonicalChild).toEqual(result.child);
    expect(result.child.npm_config_cache).toBe(path.join(canonical, ...(mode === 'default' ? ['.npm'] : ['custom', 'cache'])));
    for (const value of Object.values(result.native) as string[]) {
      const relative = path.relative(canonical, value);
      expect(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)).toBe(false);
    }
  });
