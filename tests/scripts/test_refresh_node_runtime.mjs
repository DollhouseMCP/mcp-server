// Existing host Node only; every candidate is synthetic inert data and is never executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { artifactFor, refreshNode } from '../../docker/refresh-node-runtime.mjs';
import { inventory } from '../../scripts/ci/prepare-global-npm.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const realRecipe = JSON.parse(await readFile(new URL('../../docker/node-runtime-security-refresh.json', import.meta.url), 'utf8'));

async function fixture(body) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'node-inert-refresh-')));
  try {
    const root = join(directory, 'prefix'); const artifacts = join(directory, 'artifacts');
    for (const name of ['bin', 'include/node', 'lib/node_modules/npm/bin']) await mkdir(join(root, name), { recursive: true });
    await mkdir(artifacts);
    await writeFile(join(root, 'bin/node'), 'old inert node bytes');
    await writeFile(join(root, 'include/node/old-only.h'), 'old headers');
    await writeFile(join(root, 'lib/node_modules/npm/package.json'), JSON.stringify({ name: 'npm', version: '11.19.0' }));
    await writeFile(join(root, 'lib/node_modules/npm/bin/npm-cli.js'), 'core sentinel; never execute');
    await symlink('../lib/node_modules/npm/bin/npm-cli.js', join(root, 'bin/npm'));
    await symlink('/usr/local/bin/node', join(root, 'bin/nodejs'));
    const bytes = Buffer.from('signed artifact stand-in; never execute');
    const binary = Buffer.from('candidate stand-in; never execute');
    const header = Buffer.from('#define NODE_MAJOR_VERSION 24\n');
    const recipe = structuredClone(realRecipe); const artifact = recipe.artifacts.amd64;
    Object.assign(artifact, { bytes: bytes.length, sha256: hash(bytes), nodeBytes: binary.length,
      nodeSha256: hash(binary), headerFiles: 1, headerTreeSha256: hash(JSON.stringify([['node_version.h', hash(header)]])) });
    const archive = join(artifacts, artifact.filename); await writeFile(archive, bytes);
    let extracted = 0;
    const extract = async (source, stage, record) => {
      extracted++; assert.equal(source, archive); assert.equal(record, artifact);
      for (const name of ['bin', 'include/node/openssl/archs/linux-x86_64', 'include/node/openssl/archs/linux-aarch64']) await mkdir(join(stage, name), { recursive: true });
      await writeFile(join(stage, 'bin/node'), binary);
      await writeFile(join(stage, 'include/node/node_version.h'), header);
      // Non-target architecture data is removed, matching the official recipe.
      await writeFile(join(stage, 'include/node/openssl/archs/linux-aarch64/foreign.h'), 'foreign architecture');
    };
    await body({ root, artifacts, archive, recipe, artifact, extract, binary, extracted: () => extracted });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('exact recipe rejects other architecture, npm core and artifact source', () => {
  assert.equal(artifactFor(realRecipe, 'amd64').nodeArch, 'x64');
  assert.equal(artifactFor(realRecipe, 'arm64').nodeArch, 'arm64');
  assert.throws(() => artifactFor(realRecipe, 's390x'));
  for (const mutate of [r => { r.npmCore = '11.19.1'; },
    r => { r.artifacts.amd64.url = 'https://example.invalid/node.tar.gz'; },
    r => { r.artifacts.amd64.headerFiles = 4097; },
    r => { r.artifacts.amd64.nodeArch = 'arm64'; }]) {
    const recipe = structuredClone(realRecipe); mutate(recipe);
    assert.throws(() => artifactFor(recipe, 'amd64'));
  }
});

test('only binary and complete matching headers change; npm core and callers stay exact', async () => {
  await fixture(async f => {
    const before = await inventory(f.root);
    const receipt = await refreshNode(f.root, f.artifacts, f.recipe, 'amd64', f.extract);
    const after = await inventory(f.root);
    assert.equal(f.extracted(), 1);
    assert.equal(after['bin/node'].sha256, hash(f.binary));
    assert.equal(after['bin/node'].mode, 0o755);
    assert.equal(after['include/node/old-only.h'], undefined);
    assert.equal(after['include/node/openssl/archs/linux-aarch64'], undefined);
    assert.deepEqual(after['lib/node_modules/npm/bin/npm-cli.js'], before['lib/node_modules/npm/bin/npm-cli.js']);
    assert.deepEqual(after['lib/node_modules/npm/package.json'], before['lib/node_modules/npm/package.json']);
    assert.deepEqual(after['bin/npm'], before['bin/npm']);
    assert.deepEqual(after['bin/nodejs'], before['bin/nodejs']);
    assert.equal(receipt.candidateExecutedByHelper, false);
    assert.equal(receipt.officialImageClaim, false);
    assert.equal(receipt.npmCore, '11.19.0');
    await assert.rejects(refreshNode(f.root, f.artifacts, f.recipe, 'amd64', f.extract), /receipt already exists/u);
  });
});

test('tampered archive is rejected before extraction or original tree mutation', async () => {
  await fixture(async f => {
    const before = await inventory(f.root);
    await writeFile(f.archive, Buffer.alloc(f.artifact.bytes, 0));
    await assert.rejects(refreshNode(f.root, f.artifacts, f.recipe, 'amd64', f.extract), /checksum/u);
    assert.equal(f.extracted(), 0);
    assert.deepEqual(await inventory(f.root), before);
  });
});

test('wrong original npm core refuses before candidate staging', async () => {
  await fixture(async f => {
    await writeFile(join(f.root, 'lib/node_modules/npm/package.json'), JSON.stringify({ version: '11.19.1' }));
    const before = await inventory(f.root);
    await assert.rejects(refreshNode(f.root, f.artifacts, f.recipe, 'amd64', f.extract), /npm core/u);
    assert.equal(f.extracted(), 0);
    assert.deepEqual(await inventory(f.root), before);
  });
});

test('staged binary/hash/header/link/extra-path and extractor failures preserve original tree', async () => {
  for (const failure of ['binary', 'header', 'link', 'extra-path', 'extractor']) await fixture(async f => {
    const before = await inventory(f.root);
    const extract = async (...args) => {
      await f.extract(...args); const stage = args[1];
      if (failure === 'binary') await writeFile(join(stage, 'bin/node'), 'wrong binary');
      if (failure === 'header') await writeFile(join(stage, 'include/node/node_version.h'), 'wrong headers');
      if (failure === 'link') await symlink('/outside', join(stage, 'include/node/alias.h'));
      if (failure === 'extra-path') await writeFile(join(stage, 'npm-unexpected'), 'not allowed');
      if (failure === 'extractor') throw new Error('bounded tar failed');
    };
    await assert.rejects(refreshNode(f.root, f.artifacts, f.recipe, 'amd64', extract));
    assert.deepEqual(await inventory(f.root), before);
  });
});

test('both Docker recipes bind exact authenticated data and retain the existing base/npm helper', async () => {
  for (const file of ['Dockerfile', 'Dockerfile.prebuilt']) {
    const text = await readFile(new URL('../../docker/' + file, import.meta.url), 'utf8');
    for (const artifact of Object.values(realRecipe.artifacts)) assert.ok(text.includes(`ADD --checksum=sha256:${artifact.sha256} ${artifact.url} /${artifact.filename}`));
    assert.ok(text.includes('FROM ' + realRecipe.baseImage + ' AS node-base'));
    assert.ok(text.includes('RUN --network=none'));
    assert.ok(text.indexOf('refresh-node-runtime.mjs "$TARGETARCH"') < text.indexOf('FROM node-base AS'));
    assert.ok(text.includes('node /tmp/npm-tooling/prepare-global-npm.mjs'));
    assert.ok(text.includes('node /tmp/npm-tooling/smoke-global-npm.mjs'));
  }
});

test('production CLI refuses this host before any global prefix mutation', () => {
  const result = spawnSync(process.execPath, [new URL('../../docker/refresh-node-runtime.mjs', import.meta.url).pathname, 'amd64'],
    { timeout: 5000, maxBuffer: 32768, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exact original container runtime/u);
});
