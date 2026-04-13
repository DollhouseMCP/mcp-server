/**
 * generate-hashes.mjs
 *
 * Generates data/HASHES.json — a SHA-256 manifest of every file in data/.
 * Run automatically as part of the build via the prebuild script.
 *
 * The manifest is used by DefaultElementProvider at seed time to verify
 * bundled elements and register them as trusted with ContentValidator,
 * suppressing false-positive CRITICAL security alerts on legitimate content
 * (e.g. `javascript:` as a YAML key, `wget` in a pentest report template).
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(__dirname, '..', 'data');
const outputPath = join(dataDir, 'HASHES.json');

function hashFile(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function collectFiles(dir, base = dir) {
  const entries = readdirSync(dir);
  const result = {};
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = relative(base, full).replace(/\\/g, '/'); // normalise Windows paths
    if (statSync(full).isDirectory()) {
      Object.assign(result, collectFiles(full, base));
    } else if (entry !== 'HASHES.json') {
      result[rel] = hashFile(full);
    }
  }
  return result;
}

const hashes = collectFiles(dataDir);
const output = JSON.stringify({ generated: new Date().toISOString(), files: hashes }, null, 2);
writeFileSync(outputPath, output, 'utf-8');
console.log(`[generate-hashes] Wrote ${Object.keys(hashes).length} entries to data/HASHES.json`);
