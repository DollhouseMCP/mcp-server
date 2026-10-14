#!/usr/bin/env node
// Production-image packaging only. Preserve declared runtime dependencies and locks.
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function parseNpmOutput(raw, dryRun = false) {
  const lines = raw.trim().split('\n');
  let removed = 0;
  while (dryRun && lines[0]?.startsWith('remove ')) {
    // npm's reify-output emits one fixed action line per removal before JSON.
    if (!/^remove (?:@[a-z0-9._-]+\/)?[a-z0-9._-]+ [^\s{}]+$/.test(lines.shift())) {
      throw new Error('Invalid npm removal summary');
    }
    removed++;
  }
  const summary = JSON.parse(lines.join('\n'));
  if (dryRun && summary.removed !== removed) throw new Error('Ambiguous npm removal summary');
  return summary;
}

async function main() {
  const root = resolve(process.argv[2] ?? process.cwd());
  const safety = join(root, 'packages', 'safety');
  const protectedFiles = [
    join(root, 'package.json'), join(root, 'package-lock.json'),
    join(safety, 'package.json'), join(safety, 'package-lock.json'),
  ];
  const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  const before = await Promise.all(protectedFiles.map(digest));
  const common = ['--prefix', safety, '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--json', '--color=false', '--package-lock=false'];
  function npm(args) {
    const result = spawnSync('npm', [...common, ...(args[0] === 'prune' ? ['--workspaces=false'] : []), ...args], {
      cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Safety runtime packaging refused during ${args[0]}`);
    }
    return parseNpmOutput(result.stdout, args.includes('--dry-run'));
  }

  // Missing production dependencies must fail before mutation, never be repaired here.
  npm(['ls', '--all']);
  const plan = npm(['prune', '--dry-run']);
  if (plan.added !== 0 || plan.changed !== 0) {
    throw new Error('Safety runtime packaging would install or change dependencies');
  }
  const actual = npm(['prune']);
  if (actual.added !== 0 || actual.changed !== 0) {
    throw new Error('Safety runtime packaging unexpectedly installed or changed dependencies');
  }
  npm(['ls', '--all']);
  const after = await Promise.all(protectedFiles.map(digest));
  if (before.some((value, index) => value !== after[index])) {
    throw new Error('Safety runtime packaging changed package manifests or locks');
  }
  console.log(JSON.stringify({ productionDependenciesPreserved: true, removed: actual.removed }));

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
