// First-party Docker build staging. No downloaded code is evaluated here.
// npm callers apply returned bytes only after every official payload and local
// patch has validated. The exact three paths are the reviewed security scope.
import { createHash } from 'node:crypto';

const PATHS = new Set([
  'node_modules/http-cache-semantics/index.js',
  'node_modules/make-fetch-happen/lib/cache/index.js',
  'node_modules/make-fetch-happen/lib/cache/policy.js',
]);
const MAX_FILE = 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// A rejected operation prevents every later operation from starting. No I/O is
// launched until its predecessor has settled; no detached writes survive failure.
export function inSequence(items, operation) {
  return items.reduce((completion, item) => completion.then(() => operation(item)), Promise.resolve());
}

function validateScope(patches) {
  if (!Array.isArray(patches) || patches.length !== PATHS.size) {
    throw new Error('Unexpected local npm patch scope');
  }
  const paths = new Set(patches.map(patch => patch.path));
  if (paths.size !== PATHS.size || [...paths].some(path => !PATHS.has(path))) {
    throw new Error('Unexpected local npm patch scope');
  }
}

function validateContract(patch) {
  if (!/^[a-f0-9]{64}$/u.test(patch.beforeSha256) ||
      !/^[a-f0-9]{64}$/u.test(patch.afterSha256) ||
      patch.beforeSha256 === patch.afterSha256 ||
      !Array.isArray(patch.replacements) || !patch.replacements.length || patch.replacements.length > 8) {
    throw new Error('Unexpected local npm patch contract');
  }
}

function applyReplacement(text, replacement) {
  if (typeof replacement.before !== 'string' || typeof replacement.after !== 'string' ||
      !replacement.before.length || replacement.before === replacement.after ||
      Buffer.byteLength(replacement.before) > MAX_FILE || Buffer.byteLength(replacement.after) > MAX_FILE) {
    throw new Error('Unexpected local npm replacement');
  }
  const first = text.indexOf(replacement.before);
  if (!text.includes(replacement.before) || text.includes(replacement.before, first + 1)) {
    throw new Error('Local npm source anchor drifted');
  }
  return text.slice(0, first) + replacement.after + text.slice(first + replacement.before.length);
}

async function stagePatch(readSource, patch) {
  validateContract(patch);
  const before = await readSource(patch.path);
  if (!Buffer.isBuffer(before) || before.length > MAX_FILE || hash(before) !== patch.beforeSha256) {
    throw new Error('Unexpected original local npm patch bytes');
  }
  const text = before.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(before)) throw new Error('Invalid local npm source encoding');
  const bytes = Buffer.from(patch.replacements.reduce(applyReplacement, text), 'utf8');
  if (bytes.length > MAX_FILE || hash(bytes) !== patch.afterSha256) {
    throw new Error('Unexpected resulting local npm patch bytes');
  }
  return { path: patch.path, beforeSha256: patch.beforeSha256, afterSha256: patch.afterSha256, bytes };
}

export async function stageVendorPatches(readSource, patches) {
  validateScope(patches);
  const staged = [];
  await inSequence(patches, async patch => { staged.push(await stagePatch(readSource, patch)); });
  return staged;
}
