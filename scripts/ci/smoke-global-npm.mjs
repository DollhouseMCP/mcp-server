#!/usr/bin/env node
// Actual locally patched npm/npx consumers; synthetic files and offline execution only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inventory } from './prepare-global-npm.mjs';

export async function smokeGlobalNpm(root) {
  root = await realpath(root);
  const require = createRequire(join(root, 'package.json'));
  const receipt = JSON.parse(await readFile(join(root, '.dollhouse-security-patches.json'), 'utf8'));
  assert.equal(require('./package.json').version, '11.19.0');
  const current = await inventory(root);
  delete current['.dollhouse-security-patches.json'];
  assert.deepEqual(current, receipt.after, 'Installed npm tree differs from exact patched inventory');
  for (const patch of receipt.patches) assert.equal(require(`./node_modules/${patch.name}/package.json`).version, patch.to);
  const minimatch = require('./node_modules/minimatch');
  assert.equal(minimatch.minimatch('second.txt', '{first,second}.txt'), true);
  const socksRequire = createRequire(join(root, 'node_modules/socks/package.json'));
  assert.equal(socksRequire.resolve('ip-address'), require.resolve('./node_modules/ip-address'));
  assert.equal(new (socksRequire('ip-address').Address6)('2001:db8::1').correctForm(), '2001:db8::1');
  const queryRequire = createRequire(join(root, 'node_modules/@npmcli/query/package.json'));
  assert.equal(queryRequire.resolve('postcss-selector-parser'), require.resolve('./node_modules/postcss-selector-parser'));
  assert.equal(require('./node_modules/@npmcli/query').parser(':root > .dependencies').nodes.length, 1);
  const gypRequire = createRequire(join(root, 'node_modules/node-gyp/package.json'));
  assert.equal(gypRequire.resolve('undici'), require.resolve('./node_modules/undici'));
  const { MockAgent, fetch } = gypRequire('undici');
  const dispatcher = new MockAgent(); dispatcher.disableNetConnect();
  dispatcher.get('https://npm-smoke.invalid').intercept({ path: '/fixed' }).reply(200, 'offline-undici');
  try { assert.equal(await (await fetch('https://npm-smoke.invalid/fixed', { dispatcher })).text(), 'offline-undici'); }
  finally { await dispatcher.close(); }
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'npm-consumers-')));
  try {
    const fixture = join(directory, 'fixture'); await mkdir(fixture);
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'dollhouse-offline-tooling-proof', version: '1.0.0', bin: { 'dollhouse-npm-proof': 'bin.cjs' }, scripts: { prepack: 'node forbidden-script.cjs' } }));
    await writeFile(join(fixture, 'bin.cjs'), '#!/usr/bin/env node\nif(process.argv[2]!=="exact")process.exit(2);console.log("offline-npx-ok");\n', { mode: 0o755 });
    await writeFile(join(fixture, 'forbidden-script.cjs'), 'process.exit(99);\n');
    const userconfig = join(directory, 'npmrc'); await writeFile(userconfig, '');
    const cache = join(directory, 'cache');
    const env = { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory, npm_config_userconfig: userconfig, npm_config_cache: cache, npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
    const run = (bin, args) => {
      const result = spawnSync(process.execPath, [join(root, 'bin', bin), ...args], { cwd: directory, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
      assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout;
    };
    const packed = JSON.parse(run('npm-cli.js', ['pack', '--json', '--offline', '--ignore-scripts', fixture]));
    assert.equal(packed.length, 1);
    assert.equal(packed[0].filename, 'dollhouse-offline-tooling-proof-1.0.0.tgz');
    const archive = join(directory, 'dollhouse-offline-tooling-proof-1.0.0.tgz');
    const output = run('npx-cli.js', ['--offline', '--yes', '--ignore-scripts', `--package=${archive}`, '--', 'dollhouse-npm-proof', 'exact']);
    assert.equal(output.trim(), 'offline-npx-ok');
    return { npmCore: '11.19.0', actualOfflinePack: true, actualOfflineNpx: true, packageScriptsDisabled: true, minimatchBrace: true, socksIpAddress: true, nodeGypUndici: true, npmQuerySelector: true };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await smokeGlobalNpm('/usr/local/lib/node_modules/npm')));
}
