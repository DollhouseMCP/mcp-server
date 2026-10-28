// First-party Docker build staging. No downloaded code is evaluated here.
// npm callers apply returned bytes only after every official payload and local
// patch has validated. The exact three paths are the reviewed security scope.
import { createHash } from 'node:crypto';

const PATHS = [
  'node_modules/http-cache-semantics/index.js',
  'node_modules/make-fetch-happen/lib/cache/index.js',
  'node_modules/make-fetch-happen/lib/cache/policy.js',
];
const MAX_FILE = 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function stageVendorPatches(readSource, patches) {
  if (!Array.isArray(patches) || patches.length !== PATHS.length ||
      JSON.stringify(patches.map(patch => patch.path).sort()) !== JSON.stringify(PATHS)) {
    throw new Error('Unexpected local npm patch scope');
  }
  const staged = [];
  for (const patch of patches) {
    if (!/^[a-f0-9]{64}$/u.test(patch.beforeSha256) ||
        !/^[a-f0-9]{64}$/u.test(patch.afterSha256) ||
        patch.beforeSha256 === patch.afterSha256 ||
        !Array.isArray(patch.replacements) || !patch.replacements.length || patch.replacements.length > 8) {
      throw new Error('Unexpected local npm patch contract');
    }
    const before = await readSource(patch.path);
    if (!Buffer.isBuffer(before) || before.length > MAX_FILE || hash(before) !== patch.beforeSha256) {
      throw new Error('Unexpected original local npm patch bytes');
    }
    let text = before.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(before)) throw new Error('Invalid local npm source encoding');
    for (const replacement of patch.replacements) {
      if (typeof replacement.before !== 'string' || typeof replacement.after !== 'string' ||
          !replacement.before.length || replacement.before === replacement.after ||
          Buffer.byteLength(replacement.before) > MAX_FILE || Buffer.byteLength(replacement.after) > MAX_FILE) {
        throw new Error('Unexpected local npm replacement');
      }
      const first = text.indexOf(replacement.before);
      if (first < 0 || text.indexOf(replacement.before, first + 1) >= 0) {
        throw new Error('Local npm source anchor drifted');
      }
      text = text.slice(0, first) + replacement.after + text.slice(first + replacement.before.length);
    }
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_FILE || hash(bytes) !== patch.afterSha256) {
      throw new Error('Unexpected resulting local npm patch bytes');
    }
    staged.push({ path: patch.path, beforeSha256: patch.beforeSha256, afterSha256: patch.afterSha256, bytes });
  }
  return staged;
}
