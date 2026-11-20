#!/usr/bin/env node
// Build-only exact npm leaf remediation. No package scripts or resolver is run.
import { readFile, writeFile, readdir, lstat, readlink, mkdir, rm, rename, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { join, resolve, posix, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageVendorPatches, inSequence } from './stage-global-npm-vendor-patches.mjs';

const NAMES = ['brace-expansion', 'http-cache-semantics', 'ip-address', 'postcss-selector-parser', 'undici'];
const CACHE_INDEX = 'node_modules/http-cache-semantics/index.js';
const CALLERS = new Set(['node_modules/make-fetch-happen/lib/cache/index.js', 'node_modules/make-fetch-happen/lib/cache/policy.js']);
const MAX_DOWNLOAD = 2 * 1024 * 1024;
const MAX_EXPANDED = 8 * 1024 * 1024;
const MAX_FILE = 1024 * 1024;
const MAX_ENTRIES = 1024;
const compareEntryKeys = ([left], [right]) => left.localeCompare(right);
const sameObject = (a, b) => JSON.stringify(Object.entries(a).sort(compareEntryKeys)) === JSON.stringify(Object.entries(b).sort(compareEntryKeys));
const hash = data => createHash('sha256').update(data).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const within = (name, root) => name === root || name.startsWith(`${root}/`);

// Walk/hash one file at a time: bounded I/O and deterministic preorder for both snapshots.
export async function inventory(root, prefix = '') {
  const result = {};
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const path = join(root, relative);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) result[relative] = { kind: 'link', target: await readlink(path) };
    else if (stat.isDirectory()) Object.assign(result, { [relative]: { kind: 'directory', mode: stat.mode & 0o777 } }, await inventory(root, relative));
    else if (stat.isFile()) result[relative] = { kind: 'file', mode: stat.mode & 0o777, sha256: hash(await readFile(path)) };
    else throw new Error('Unsupported npm bundle entry');
  }
  return result;
}

function canonicalEntry(entry, paths) {
  const name = entry.path.replace(/\/$/, '');
  if (!name.startsWith('package/') || /[\\\x00-\x20\x7f]/u.test(name) || name !== posix.normalize(name)) throw new Error('Unsafe package archive path');
  const relative = name.slice('package/'.length);
  if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..') || paths.has(relative)) throw new Error('Duplicate or invalid package archive path');
  if (!['File', 'Directory'].includes(entry.type) || entry.linkpath || (entry.type === 'Directory' && entry.size !== 0)) throw new Error('Package archive links/special entries refused');
  paths.set(relative, entry.type);
  return relative;
}

function validateParents(paths) {
  for (const name of paths.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (paths.get(parts.slice(0, i).join('/')) === 'File') throw new Error('Package archive file-parent collision');
    }
  }
}

function consumeEntry(entry, paths, accountBytes) {
  return new Promise((accept, reject) => {
    try {
      if (paths.size >= MAX_ENTRIES || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE) throw new Error('Package entry limit exceeded');
      const path = canonicalEntry(entry, paths);
      const chunks = [];
      let fileBytes = 0;
      entry.on('data', chunk => {
        fileBytes += chunk.length;
        if (fileBytes > MAX_FILE || !accountBytes(chunk.length)) reject(new Error('Package payload limit exceeded'));
        else chunks.push(chunk);
      });
      entry.on('error', reject);
      entry.on('end', () => {
        if (fileBytes !== entry.size) reject(new Error('Package entry size mismatch'));
        else accept({ path, type: entry.type, mode: entry.mode & 0o777, bytes: Buffer.concat(chunks) });
      });
    } catch (error) { entry.resume(); reject(error); }
  });
}

export async function readArchive(compressed, Parser) {
  if (compressed.length > MAX_DOWNLOAD) throw new Error('Package download too large');
  const raw = gunzipSync(compressed, { maxOutputLength: MAX_EXPANDED });
  const paths = new Map();
  const pending = [];
  let expanded = 0;
  const accountBytes = count => { expanded += count; return expanded <= MAX_EXPANDED; };
  await new Promise((accept, reject) => {
    const parser = new Parser({ strict: true });
    parser.on('error', reject);
    parser.on('meta', () => reject(new Error('Package extended archive metadata refused')));
    parser.on('ignoredEntry', () => reject(new Error('Package ignored archive entry refused')));
    parser.on('entry', entry => {
      const file = consumeEntry(entry, paths, accountBytes);
      file.catch(reject);
      pending.push(file);
    });
    parser.on('end', accept);
    parser.end(raw);
  });
  const files = await Promise.all(pending);
  validateParents(paths);
  return files;
}

async function download(patch) {
  const response = await fetch(patch.url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Fixed package download failed');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_DOWNLOAD) throw new Error('Package download too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validateManifest(manifest) {
  if (manifest.npmVersion !== '11.19.1' || JSON.stringify(manifest.patches.map(patch => patch.name).sort()) !== JSON.stringify(NAMES)) throw new Error('Unexpected npm patch manifest');
  for (const patch of manifest.patches) {
    if (patch.url !== `https://registry.npmjs.org/${patch.name}/-/${patch.name}-${patch.to}.tgz` || !/^sha512-[A-Za-z0-9+/]+=*$/u.test(patch.integrity)) throw new Error('Unexpected fixed package source');
  }
}

// Consumer checks stay bounded and finish before accepting this package's payload.
async function originalPackage(root, patch, semver) {
  const path = join(root, 'node_modules', patch.name);
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('Unexpected npm leaf path');
  const original = await json(join(path, 'package.json'));
  if (original.name !== patch.name || original.version !== patch.from || !sameObject(original.dependencies ?? {}, patch.runtimeDependencies)) throw new Error('Unexpected original npm leaf');
  for (const [consumer, range] of Object.entries(patch.consumers)) {
    const file = await json(join(root, consumer));
    if (file.dependencies?.[patch.name] !== range || !semver.satisfies(patch.to, range)) throw new Error('npm consumer range changed');
  }
}

async function stagePayload(patch, getPayload, Parser) {
  const bytes = await getPayload(patch);
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== patch.integrity || hash(bytes) !== patch.sha256) throw new Error('Package artifact integrity mismatch');
  const files = await readArchive(bytes, Parser);
  const record = files.find(file => file.path === 'package.json' && file.type === 'File');
  if (!record) throw new Error('Missing package manifest');
  const manifest = JSON.parse(record.bytes.toString('utf8'));
  if (manifest.name !== patch.name || manifest.version !== patch.to || !sameObject(manifest.dependencies ?? {}, patch.runtimeDependencies) || files.some(file => within(file.path, 'node_modules'))) throw new Error('Patched package closure changed');
  for (const field of ['optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) {
    if (manifest[field] !== undefined) throw new Error('Patched package additional dependency closure refused');
  }
  return files;
}

// Read manifests sequentially rather than creating unbounded pending file reads.
async function validateOccurrences(root, records, patches) {
  for (const patch of patches) {
    const occurrences = [];
    for (const [path, entry] of Object.entries(records)) {
      if (entry.kind !== 'file' || !path.endsWith('/package.json')) continue;
      const manifest = await json(join(root, path));
      if (manifest.name === patch.name) occurrences.push(path);
    }
    if (JSON.stringify(occurrences) !== JSON.stringify([`node_modules/${patch.name}/package.json`])) throw new Error('Unexpected duplicate npm leaf');
  }
}

function unchangedOutside(before, after, patches) {
  const keep = name => !CALLERS.has(name) && !patches.some(patch => within(name, `node_modules/${patch.name}`));
  const select = map => Object.fromEntries(Object.entries(map).filter(([name]) => keep(name)));
  if (JSON.stringify(select(before)) !== JSON.stringify(select(after))) throw new Error('Unexpected npm core/bundle change');
}

// Ordered parent/file creation and publication; no concurrent writes remain pending after rejection.
async function writePayload(root, patch, files) {
  const target = join(root, 'node_modules', patch.name);
  const stage = join(root, 'node_modules', `.dollhouse-${patch.name}`);
  await mkdir(stage);
  for (const file of files) {
    if (file.type === 'Directory') await mkdir(join(stage, file.path), { recursive: true, mode: file.mode });
    else {
      await mkdir(join(stage, posix.dirname(file.path)), { recursive: true });
      await writeFile(join(stage, file.path), file.bytes, { flag: 'wx', mode: file.mode });
    }
  }
  await rm(target, { recursive: true });
  await rename(stage, target);
}

async function callerSource(root, path, before) {
  if (!CALLERS.has(path) || before[path]?.kind !== 'file' || before[path].mode !== 0o644) throw new Error('Unexpected npm caller inventory');
  const target = join(root, path);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.nlink !== 1 || await realpath(target) !== target) throw new Error('Unexpected npm caller path');
  const bytes = await readFile(target);
  if (hash(bytes) !== before[path].sha256) throw new Error('npm caller changed during staging');
  return bytes;
}

async function readBundleContract(root, manifest, vendorManifest) {
  const core = await json(join(root, 'package.json'));
  if (core.name !== 'npm' || core.version !== manifest.npmVersion) throw new Error('Unexpected original npm core');
  if (core.dependencies?.tar !== '^7.5.22') throw new Error('Unexpected npm tar baseline');
  if (vendorManifest?.npmVersion !== core.version || vendorManifest.callerPackage?.path !== 'node_modules/make-fetch-happen/package.json' ||
      vendorManifest.callerPackage.name !== 'make-fetch-happen' || vendorManifest.callerPackage.version !== '15.0.6') throw new Error('Unexpected npm vendor manifest');
  const callerPackage = await json(join(root, vendorManifest.callerPackage.path));
  if (callerPackage.name !== 'make-fetch-happen' || callerPackage.version !== '15.0.6') throw new Error('Unexpected npm caller package');
  const require = createRequire(join(root, 'package.json'));
  const { Parser } = require('tar');
  const semver = require('semver');
  if (require('tar/package.json').version !== '7.5.22') throw new Error('Unexpected original npm tar');
  return { core, Parser, semver };
}

async function verifyPublication(root, before, manifest, vendor, cacheIndex) {
  const after = await inventory(root);
  await validateOccurrences(root, after, manifest.patches);
  await inSequence(manifest.patches, async patch => {
    const installed = await json(join(root, 'node_modules', patch.name, 'package.json'));
    if (installed.version !== patch.to) throw new Error('Patched package publication mismatch');
  });
  unchangedOutside(before, after, manifest.patches);
  for (const patch of vendor) {
    const entry = after[patch.path];
    const mode = patch.path === CACHE_INDEX ? cacheIndex.mode : before[patch.path].mode;
    if (entry?.kind !== 'file' || entry.mode !== mode || entry.sha256 !== patch.afterSha256) throw new Error('Local npm patch publication mismatch');
  }
  return after;
}

export async function prepareGlobalNpm(root, manifest, vendorManifest, getPayload = download) {
  validateManifest(manifest);
  root = await realpath(root);
  const { core, Parser, semver } = await readBundleContract(root, manifest, vendorManifest);
  const before = await inventory(root);
  await validateOccurrences(root, before, manifest.patches);
  for (const patch of manifest.patches) {
    if (Object.hasOwn(before, `node_modules/.dollhouse-${patch.name}`)) throw new Error('Existing npm patch staging path');
  }
  for (const path of CALLERS) {
    const stage = `${posix.dirname(path)}/.dollhouse-${posix.basename(path)}`;
    if (Object.hasOwn(before, stage)) throw new Error('Existing npm caller staging path');
  }
  if (Object.hasOwn(before, '.dollhouse-security-patches.json')) throw new Error('npm bundle already patched');
  // One download/parser at a time; validate ALL payloads before ANY replacement.
  const payloads = [];
  await inSequence(manifest.patches, async patch => {
    await originalPackage(root, patch, semver);
    payloads.push(await stagePayload(patch, getPayload, Parser));
  });
  const cacheFiles = payloads[manifest.patches.findIndex(patch => patch.name === 'http-cache-semantics')];
  const cacheIndex = cacheFiles.find(file => file.path === 'index.js' && file.type === 'File');
  if (!cacheIndex) throw new Error('Missing qualified cache policy source');
  const vendor = await stageVendorPatches(path => path === CACHE_INDEX ? cacheIndex.bytes : callerSource(root, path, before), vendorManifest.patches);
  const patchedIndex = vendor.find(patch => patch.path === CACHE_INDEX);
  cacheIndex.bytes = patchedIndex.bytes;
  const callers = vendor.filter(patch => CALLERS.has(patch.path));
  // Prepare BOTH caller files before replacing any leaf. No source is evaluated.
  await inSequence(callers, patch => {
    const target = join(root, patch.path);
    const stage = join(dirname(target), `.dollhouse-${basename(target)}`);
    return writeFile(stage, patch.bytes, { flag: 'wx', mode: before[patch.path].mode });
  });
  // Publish sequentially so no concurrent mutation remains on a failure.
  await inSequence(manifest.patches.map((patch, index) => ({ patch, files: payloads[index] })),
    item => writePayload(root, item.patch, item.files));
  await inSequence(callers, async patch => {
    await callerSource(root, patch.path, before);
    const target = join(root, patch.path);
    await rename(join(dirname(target), `.dollhouse-${basename(target)}`), target);
  });
  const after = await verifyPublication(root, before, manifest, vendor, cacheIndex);
  const receipt = { npmCore: core.version, locallyPatched: true, patches: manifest.patches,
    vendorPatches: { upstreamReference: vendorManifest.upstreamReference, upstreamHead: vendorManifest.upstreamHead,
      licenses: vendorManifest.licenses, scope: vendorManifest.scope,
      patches: vendor.map(({ path, beforeSha256, afterSha256 }) => ({ path, beforeSha256, afterSha256 })) }, before, after };
  await writeFile(join(root, '.dollhouse-security-patches.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await json(new URL('./global-npm-security-patches.json', import.meta.url));
  const vendorManifest = await json(new URL('./global-npm-vendor-patches.json', import.meta.url));
  await prepareGlobalNpm('/usr/local/lib/node_modules/npm', manifest, vendorManifest);
}
