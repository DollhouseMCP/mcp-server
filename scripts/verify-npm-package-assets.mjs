#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);

const REQUIRED_PACKAGE_ENTRIES = [
  'dist/index.js',
  'dist/web/public/setup.js',
  'dist/web/public/setup.css',
  'dist/seed-elements/memories',
  'scripts/pretooluse-dollhouse.sh',
  'scripts/permission-port-discovery.sh',
  'server.json',
];

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

let packedFile = null;
let extractDir = null;

try {
  const packJson = run('npm', ['pack', '--json'], projectRoot);
  const [packResult] = JSON.parse(packJson);
  packedFile = packResult?.filename;

  if (!packedFile) {
    throw new Error('npm pack did not return a package filename');
  }

  extractDir = mkdtempSync(join(tmpdir(), 'dollhouse-package-check-'));
  run('tar', ['-xf', packedFile, '-C', extractDir], projectRoot);

  const packageRoot = join(extractDir, 'package');
  const missingEntries = REQUIRED_PACKAGE_ENTRIES.filter((entry) => !existsSync(join(packageRoot, entry)));

  if (missingEntries.length > 0) {
    console.error('❌ npm package is missing required runtime assets:');
    for (const entry of missingEntries) {
      console.error(`   - ${entry}`);
    }
    process.exitCode = 1;
  } else {
    console.log('✅ npm package contains all required runtime assets.');
    for (const entry of REQUIRED_PACKAGE_ENTRIES) {
      console.log(`   - ${entry}`);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`❌ Failed to verify npm package contents: ${message}`);
  process.exitCode = 1;
} finally {
  if (packedFile) {
    rmSync(join(projectRoot, packedFile), { force: true });
  }
  if (extractDir) {
    rmSync(extractDir, { recursive: true, force: true });
  }
}
