import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseNpmOutput } from '../../scripts/ci/prune-safety-runtime.mjs';

const script = resolve('scripts/ci/prune-safety-runtime.mjs');
async function fixture(runtime) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'safety-prune-')));
  const safety = join(root, 'packages/safety');
  await mkdir(join(safety, 'dist'), { recursive: true });
  await mkdir(join(root, 'home'));
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: root,
    NPM_CONFIG_CACHE: join(root, 'cache'), NPM_CONFIG_USERCONFIG: join(root, 'npmrc') };
  await writeFile(join(root, 'npmrc'), '');
  const archives = {};
  const run = (command, args) => spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 15_000 });
  for (const name of ['runtime', 'optional', 'build-tool']) {
    const path = join(root, 'packages', name); await mkdir(path);
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: `fixture-${name}`, version: '1.0.0',
      type: 'module', main: 'index.js', scripts: { postinstall: 'node -e "process.exit(99)"' } }));
    await writeFile(join(path, 'index.js'), `export default ${JSON.stringify(name)};`);
    const packed = run('npm', ['pack', path, '--ignore-scripts', '--offline', '--json']);
    assert.equal(packed.status, 0, packed.stderr);
    archives[name] = 'file:' + join(root, JSON.parse(packed.stdout)[0].filename);
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', version: '1.0.0', private: true, workspaces: ['packages/safety'],
    dependencies: { '@dollhousemcp/safety': 'file:packages/safety', 'fixture-runtime': archives.runtime } }));
  await writeFile(join(safety, 'package.json'), JSON.stringify({ name: '@dollhousemcp/safety', version: '1.0.4', type: 'module',
    exports: './dist/index.js', devDependencies: { 'fixture-build-tool': archives['build-tool'] },
    ...(runtime ? { dependencies: { 'fixture-runtime': archives.runtime }, optionalDependencies: { 'fixture-optional': archives.optional } } : {}) }));
  const source = runtime ? "import a from 'fixture-runtime'; import b from 'fixture-optional'; export default a+'/'+b;" : "export default 'safety-runtime';";
  await writeFile(join(safety, 'dist/index.js'), source);
  await writeFile(join(safety, 'dist/runtime-asset.txt'), 'retained runtime asset');
  for (const args of [[], ['--prefix', safety, '--workspaces=false']]) {
    const result = run('npm', [...args, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
    assert.equal(result.status, 0, result.stderr);
  }
  const protectedPaths = ['package.json', 'package-lock.json', 'packages/safety/package.json', 'packages/safety/package-lock.json'];
  const before = await Promise.all(protectedPaths.map(name => readFile(join(root, name), 'utf8')));
  return { root, safety, run, source, protectedPaths, before };
}

for (const runtime of [false, true]) {
  test(`production prune preserves workspace exports/assets and ${runtime ? 'declared runtime/optional dependencies' : 'zero-runtime-dependency package'}`, async () => {
    const f = await fixture(runtime);
    try {
      const link = await realpath(join(f.root, 'node_modules/@dollhousemcp/safety'));
      await access(join(f.safety, 'node_modules/fixture-build-tool'));
      const result = f.run(process.execPath, [script, f.root]); assert.equal(result.status, 0, result.stderr);
      await assert.rejects(access(join(f.safety, 'node_modules/fixture-build-tool')));
      assert.equal(await realpath(join(f.root, 'node_modules/@dollhousemcp/safety')), link);
      assert.equal(await readFile(join(f.safety, 'dist/index.js'), 'utf8'), f.source);
      assert.equal(await readFile(join(f.safety, 'dist/runtime-asset.txt'), 'utf8'), 'retained runtime asset');
      assert.deepEqual(await Promise.all(f.protectedPaths.map(name => readFile(join(f.root, name), 'utf8'))), f.before);
      const imported = f.run(process.execPath, ['--input-type=module', '-e', "import value from '@dollhousemcp/safety'; console.log(value)"]);
      assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout.trim(), runtime ? 'runtime/optional' : 'safety-runtime');
      const rootImport = f.run(process.execPath, ['--input-type=module', '-e', "import value from 'fixture-runtime'; console.log(value)"]);
      assert.equal(rootImport.status, 0, rootImport.stderr); assert.equal(rootImport.stdout.trim(), 'runtime');
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test('missing production dependency refuses before pruning dev tools or changing manifests/locks', async () => {
  const f = await fixture(true);
  try {
    await rm(join(f.safety, 'node_modules/fixture-runtime'), { recursive: true });
    await rm(join(f.root, 'node_modules/fixture-runtime'), { recursive: true, force: true });
    const result = f.run(process.execPath, [script, f.root]);
    assert.equal(result.status, 1); assert.match(result.stderr, /refused during ls/);
    await access(join(f.safety, 'node_modules/fixture-build-tool'));
    assert.deepEqual(await Promise.all(f.protectedPaths.map(name => readFile(join(f.root, name), 'utf8'))), f.before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('npm dry-run parser accepts only an exact removal preamble and one complete summary', () => {
  const summary = { added: 0, changed: 0, removed: 1 };
  assert.deepEqual(parseNpmOutput('remove @fixture/dev 1.0.0\n' + JSON.stringify(summary), true), summary);
  for (const raw of ['remove dev 1.0.0\n{}', 'add dev 1.0.0\n{}', '{}\n{}', 'warning\n{}', 'remove dev 1.0.0 extra\n{}']) {
    assert.throws(() => parseNpmOutput(raw, true));
  }
});
