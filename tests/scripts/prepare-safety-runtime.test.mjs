import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/ci/prepare-safety-runtime.mjs');
async function fixture(declaration = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'safety-image-')));
  const safety = join(root, 'packages/safety');
  for (const dir of ['packages/safety/dist', 'packages/safety/node_modules/build-tool', 'node_modules/@dollhousemcp', 'node_modules/root-runtime']) {
    await mkdir(join(root, dir), { recursive: true });
  }
  const files = {
    'package.json': JSON.stringify({ name: 'fixture-root', private: true, type: 'module', workspaces: ['packages/safety'] }),
    'package-lock.json': 'root lock unchanged',
    'packages/safety/package.json': JSON.stringify({ name: '@dollhousemcp/safety', version: '1.0.4', type: 'module', exports: './dist/index.js', ...declaration }),
    'packages/safety/package-lock.json': 'safety lock unchanged',
    'packages/safety/dist/index.js': "export default 'compiled-safety';",
    'packages/safety/dist/runtime-asset.txt': 'retained runtime asset',
    'packages/safety/node_modules/build-tool/package.json': JSON.stringify({ name: 'build-tool', version: '1.0.0' }),
    'node_modules/root-runtime/package.json': JSON.stringify({ name: 'root-runtime', version: '1.0.0', type: 'module', main: 'index.js' }),
    'node_modules/root-runtime/index.js': "export default 'root-runtime';",
  };
  for (const [name, data] of Object.entries(files)) await writeFile(join(root, name), data);
  await symlink('../../packages/safety', join(root, 'node_modules/@dollhousemcp/safety'));
  const run = args => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root } });
  return { root, safety, files, run };
}

test('dependency-free packaging excludes build tools and preserves workspace imports, runtime assets, root modules and locks', async () => {
  const f = await fixture();
  try {
    const link = await realpath(join(f.root, 'node_modules/@dollhousemcp/safety'));
    const result = f.run([script]); assert.equal(result.status, 0, result.stderr);
    await assert.rejects(access(join(f.safety, 'node_modules')));
    assert.equal(await realpath(join(f.root, 'node_modules/@dollhousemcp/safety')), link);
    for (const [name, bytes] of Object.entries(f.files)) {
      if (!name.startsWith('packages/safety/node_modules/')) assert.equal(await readFile(join(f.root, name), 'utf8'), bytes);
    }
    const imported = f.run(['--input-type=module', '-e', "import s from '@dollhousemcp/safety'; import r from 'root-runtime'; console.log(s+'/'+r)"]);
    assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout.trim(), 'compiled-safety/root-runtime');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const [field, value] of [['dependencies', { runtime: '1.0.0' }], ['optionalDependencies', { optional: '1.0.0' }], ['peerDependencies', { peer: '1.0.0' }], ['bundledDependencies', ['bundled']], ['bundleDependencies', true]]) {
  test(`${field} refuses before deleting any dependency or changing package files`, async () => {
    const f = await fixture({ [field]: value });
    try {
      const result = f.run([script]); assert.equal(result.status, 1); assert.match(result.stderr, /require runtime packaging support/);
      for (const [name, bytes] of Object.entries(f.files)) assert.equal(await readFile(join(f.root, name), 'utf8'), bytes);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}
