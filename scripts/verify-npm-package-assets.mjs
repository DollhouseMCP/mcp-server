#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);

const REQUIRED_PACKAGE_ENTRIES = [
  'dist/index.js',
  'dist/web/public/setup.js',
  'dist/web/public/setup.css',
  'dist/web-console/ui/index.html',
  'dist/web-console/ui/app.js',
  'dist/web-console/ui/console.css',
  'dist/web-console/ui/dollhouse-logo.png',
  'dist/web-console/ui/fonts/manrope-xn7gYHE41ni1AdIRggOxSvfedN62Zw.woff2',
  'dist/web-console/ui/vendor/purify.min.js',
  'dist/seed-elements/memories',
  'scripts/pretooluse-dollhouse.sh',
  'scripts/permission-port-discovery.sh',
  'scripts/permission-hook-config.sh',
  'server.json',
  'oauth-helper.mjs',
  'oauth-state-coordinator.mjs',
  'oauth-state-coordinator.d.mts',
];

const CONSOLE_SOURCE_ROOT = join(projectRoot, 'src/web-console/ui');
const CONSOLE_PACKAGE_ROOT = 'dist/web-console/ui';

function run(command, args, cwd, env = process.env) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function listFiles(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    return entry.isDirectory() ? listFiles(root, path) : [relative(root, path)];
  });
}

function localAssetReferences(html) {
  const references = [];
  const attributePattern = /\b(?:href|src)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attributePattern)) {
    const value = match[1].split(/[?#]/, 1)[0];
    if (!value || value.startsWith('/') || value.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(value)) continue;
    references.push(value);
  }
  return references;
}

function escapesRoot(root, target) {
  const rel = relative(root, target);
  return rel === '..' || rel.startsWith(`..${sep}`);
}

function verifyConsoleAssets(packageRoot) {
  const packagedConsoleRoot = join(packageRoot, CONSOLE_PACKAGE_ROOT);
  const sourceFiles = listFiles(CONSOLE_SOURCE_ROOT).map(normalize);
  const missingSourceFiles = sourceFiles.filter(file => !existsSync(join(packagedConsoleRoot, file)));

  const indexPath = join(packagedConsoleRoot, 'index.html');
  const unresolvedReferences = existsSync(indexPath)
    ? localAssetReferences(readFileSync(indexPath, 'utf8')).filter(reference => {
      const target = resolve(packagedConsoleRoot, reference);
      return escapesRoot(packagedConsoleRoot, target) || !existsSync(target) || !statSync(target).isFile();
    })
    : ['index.html'];

  return { missingSourceFiles, unresolvedReferences };
}

let packedFile = null;
let extractDir = null;
let npmCacheDir = null;

try {
  npmCacheDir = mkdtempSync(join(tmpdir(), 'dollhouse-npm-cache-'));
  const packOutput = run('npm', ['pack', '--json'], projectRoot, {
    ...process.env,
    npm_config_cache: npmCacheDir,
  });
  const [packResult] = JSON.parse(packOutput);
  packedFile = packResult?.filename;

  if (!packedFile) {
    throw new Error('npm pack did not return a package filename');
  }

  extractDir = mkdtempSync(join(tmpdir(), 'dollhouse-package-check-'));
  run('tar', ['-xf', packedFile, '-C', extractDir], projectRoot);

  const packageRoot = join(extractDir, 'package');
  const missingEntries = REQUIRED_PACKAGE_ENTRIES.filter((entry) => !existsSync(join(packageRoot, entry)));
  const { missingSourceFiles, unresolvedReferences } = verifyConsoleAssets(packageRoot);

  if (missingEntries.length > 0 || missingSourceFiles.length > 0 || unresolvedReferences.length > 0) {
    console.error('❌ npm package is missing required runtime assets:');
    for (const entry of missingEntries) {
      console.error(`   - ${entry}`);
    }
    for (const entry of missingSourceFiles) {
      console.error(`   - ${CONSOLE_PACKAGE_ROOT}/${entry} (missing source asset)`);
    }
    for (const reference of unresolvedReferences) {
      console.error(`   - ${CONSOLE_PACKAGE_ROOT}/index.html -> ${reference} (unresolved reference)`);
    }
    process.exitCode = 1;
  } else {
    console.log('✅ npm package contains all required runtime assets and the complete web-console UI.');
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
  if (npmCacheDir) {
    rmSync(npmCacheDir, { recursive: true, force: true });
  }
}
