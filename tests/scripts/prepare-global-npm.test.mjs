import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, realpath, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { inventory, readArchive, prepareGlobalNpm } from '../../scripts/ci/prepare-global-npm.mjs';

// Use only the Node installation's existing npm reader, never install test deps.
async function installedNpm() {
  for (const root of [join(dirname(dirname(process.execPath)), 'lib/node_modules/npm'), join(dirname(process.execPath), 'node_modules/npm')]) {
    try { await access(join(root, 'package.json')); return realpath(root); } catch { /* next standard Node layout */ }
  }
  throw new Error('Node installation must include npm for build-tool tests');
}
const npmRoot = await installedNpm();
const require = createRequire(join(npmRoot, 'package.json'));
const { Parser } = require('tar');
const fixedManifest = JSON.parse(await readFile(resolve('docker/global-npm-security-patches.json'), 'utf8'));
function archive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.bytes ?? 'fixed');
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, 'utf8');
    const octal = (value, offset, length) => header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
    octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(data.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header.write(entry.type ?? '0', 156, 1); header.write(entry.link ?? '', 157, 100); header.write('ustar\0', 257, 6); header.write('00', 263, 2);
    const sum = header.reduce((a, b) => a + b, 0); header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test('bounded archive reader preserves regular payload bytes', async () => {
  const files = await readArchive(archive([{ path: 'package/a.js', bytes: 'exact bytes' }]), Parser);
  assert.equal(files.length, 1); assert.equal(files[0].path, 'a.js'); assert.equal(files[0].bytes.toString(), 'exact bytes');
});
for (const [name, entries] of [
  ['parent traversal', [{ path: 'package/../escape' }]],
  ['absolute path', [{ path: '/package/escape' }]],
  ['normalized alias', [{ path: 'package/a/../same' }]],
  ['duplicate path', [{ path: 'package/same' }, { path: 'package/same' }]],
  ['file-parent collision', [{ path: 'package/parent' }, { path: 'package/parent/child' }]],
  ['symlink', [{ path: 'package/link', type: '2', link: 'outside' }]],
  ['hardlink', [{ path: 'package/link', type: '1', link: 'package/other' }]],
  ['special file', [{ path: 'package/device', type: '3' }]],
  ['unknown entry type', [{ path: 'package/unknown', type: 'Z' }]],
  ['per-file bound', [{ path: 'package/large', bytes: Buffer.alloc(1024 * 1024 + 1) }]],
  ['entry-count bound', Array.from({ length: 1025 }, (_, i) => ({ path: `package/f${i}` }))],
]) test(`archive refuses ${name} before any extraction`, async () => assert.rejects(readArchive(archive(entries), Parser)));
test('compressed and expanded bounds refuse before extraction', async () => {
  await assert.rejects(readArchive(Buffer.alloc(2 * 1024 * 1024 + 1), Parser));
  await assert.rejects(readArchive(gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1)), Parser));
});

// Synthetic exact-contract fixture. Actual npm11.19 artifact/consumer proof is
// separate: the Docker build runs the fixed preparer and real offline smoke.
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'npm-patch-test-')));
  const root = join(directory, 'npm'); await cp(npmRoot, root, { recursive: true });
  const manifest = structuredClone(fixedManifest); const payloads = new Map();
  const update = async (path, change) => { const p = join(root, path); const j = JSON.parse(await readFile(p, 'utf8')); change(j); await writeFile(p, JSON.stringify(j)); };
  await update('package.json', j => { j.version = manifest.npmVersion; });
  for (const patch of manifest.patches) {
    await update(`node_modules/${patch.name}/package.json`, j => { j.version = patch.from; j.dependencies = patch.runtimeDependencies; });
    for (const [consumer, range] of Object.entries(patch.consumers)) await update(consumer, j => { j.dependencies[patch.name] = range; });
    const payload = archive([{ path: 'package/package.json', bytes: JSON.stringify({ name: patch.name, version: patch.to, dependencies: patch.runtimeDependencies }) }, { path: 'package/index.js', bytes: 'module.exports = "synthetic";' }]);
    patch.sha256 = createHash('sha256').update(payload).digest('hex'); patch.integrity = `sha512-${createHash('sha512').update(payload).digest('base64')}`; payloads.set(patch.name, payload);
  }
  return { root, directory, manifest, payloads, close: () => rm(directory, { recursive: true, force: true }) };
}
test('full publication changes only five leaves; npm core, bins, other files and links stay exact', async () => {
  const f = await fixture();
  try {
    const result = await prepareGlobalNpm(f.root, f.manifest, patch => f.payloads.get(patch.name));
    const allowed = name => f.manifest.patches.some(p => name === `node_modules/${p.name}` || name.startsWith(`node_modules/${p.name}/`));
    for (const [name, entry] of Object.entries(result.before)) if (!allowed(name)) assert.deepEqual(result.after[name], entry);
    assert.deepEqual(result.after['bin/npm-cli.js'], result.before['bin/npm-cli.js']);
    assert.deepEqual(result.after['bin/npx-cli.js'], result.before['bin/npx-cli.js']);
    await assert.rejects(prepareGlobalNpm(f.root, f.manifest, patch => f.payloads.get(patch.name)), /already patched|original npm leaf/);
  } finally { await f.close(); }
});
for (const kind of ['wrong original', 'integrity', 'changed closure', 'consumer range', 'unsafe last payload', 'payload dependency change', 'payload optional dependency', 'duplicate leaf', 'staging collision']) {
  test(`${kind} refuses with the entire original bundle unchanged`, async () => {
    const f = await fixture();
    try {
      if (kind === 'wrong original') f.manifest.patches[0].from = '0.0.0';
      if (kind === 'integrity') f.payloads.set('undici', Buffer.from('tampered'));
      if (kind === 'changed closure') f.manifest.patches[0].runtimeDependencies = { extra: '^1.0.0' };
      if (kind === 'consumer range') f.manifest.patches[0].consumers['node_modules/minimatch/package.json'] = '^99.0.0';
      if (kind === 'unsafe last payload') {
        const bytes = archive([{ path: 'package/../escape' }]); const p = f.manifest.patches.find(p => p.name === 'undici');
        p.integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`; p.sha256 = createHash('sha256').update(bytes).digest('hex'); f.payloads.set(p.name, bytes);
      }
      if (kind === 'payload dependency change' || kind === 'payload optional dependency') {
        const p = f.manifest.patches.find(p => p.name === 'undici');
        const record = { name: p.name, version: p.to, dependencies: {} };
        if (kind === 'payload dependency change') record.dependencies.extra = '^1.0.0';
        else record.optionalDependencies = { extra: '^1.0.0' };
        const bytes = archive([{ path: 'package/package.json', bytes: JSON.stringify(record) }]);
        p.integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`; p.sha256 = createHash('sha256').update(bytes).digest('hex'); f.payloads.set(p.name, bytes);
      }
      if (kind === 'duplicate leaf') { const p = join(f.root, 'node_modules/extra/node_modules/undici'); await mkdir(p, { recursive: true }); await writeFile(join(p, 'package.json'), '{"name":"undici","version":"6.27.0"}'); }
      if (kind === 'staging collision') await mkdir(join(f.root, 'node_modules/.dollhouse-undici'));
      const before = await inventory(f.root);
      await assert.rejects(prepareGlobalNpm(f.root, f.manifest, patch => f.payloads.get(patch.name)));
      assert.deepEqual(await inventory(f.root), before);
    } finally { await f.close(); }
  });
}
