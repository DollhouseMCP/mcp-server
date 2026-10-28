import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stageVendorPatches } from '../../scripts/ci/stage-global-npm-vendor-patches.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const { patches } = JSON.parse(await readFile(new URL('../../docker/global-npm-vendor-patches.json', import.meta.url), 'utf8'));
const preimages = {
  'node_modules/http-cache-semantics/index.js': 'http-cache-semantics-index.js.txt',
  'node_modules/make-fetch-happen/lib/cache/policy.js': 'make-fetch-cache-policy.js.txt',
  'node_modules/make-fetch-happen/lib/cache/index.js': 'make-fetch-cache-index.js.txt',
};
const source = new Map(await Promise.all(patches.map(async patch => [patch.path,
  await readFile(new URL('../fixtures/global-npm-vendor/' + preimages[patch.path], import.meta.url))])));
const read = async path => source.get(path);
test('stages all three exact source changes without modifying original buffers', async () => {
  const original = new Map([...source].map(([path, bytes]) => [path, hash(bytes)]));
  const staged = await stageVendorPatches(read, patches);
  for (const patch of staged) {
    assert.equal(hash(patch.bytes), patch.afterSha256);
    assert.equal(hash(source.get(patch.path)), original.get(patch.path));
  }
});
for (const name of ['missing path', 'duplicate path', 'outside path', 'wrong before hash', 'wrong after hash', 'missing anchor', 'duplicate anchor', 'non-buffer source', 'oversized source']) {
  test(`refuses ${name} without any original source mutation`, async () => {
    const proposed = structuredClone(patches);
    let getSource = read;
    if (name === 'missing path') proposed.pop();
    if (name === 'duplicate path') proposed[2].path = proposed[1].path;
    if (name === 'outside path') proposed[2].path = 'bin/npm-cli.js';
    if (name === 'wrong before hash') proposed[0].beforeSha256 = '0'.repeat(64);
    if (name === 'wrong after hash') proposed[0].afterSha256 = '0'.repeat(64);
    if (name === 'missing anchor') proposed[0].replacements[0].before = 'missing exact anchor';
    if (name === 'duplicate anchor') proposed[0].replacements[0].before = 'return';
    if (name === 'non-buffer source') getSource = async () => 'not bytes';
    if (name === 'oversized source') getSource = async () => Buffer.alloc(1024 * 1024 + 1);
    const original = new Map([...source].map(([path, bytes]) => [path, hash(bytes)]));
    await assert.rejects(stageVendorPatches(getSource, proposed));
    for (const [path, bytes] of source) assert.equal(hash(bytes), original.get(path));
  });
}
