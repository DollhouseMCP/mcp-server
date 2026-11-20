#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReleaseMigrations } from './lib/release-migrations.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const runtimeAssetTrees = [
  { source: 'src/seed-elements', destination: 'dist/seed-elements', clean: false },
  { source: 'src/web/public', destination: 'dist/web/public', clean: true },
  { source: 'src/web-console/ui', destination: 'dist/web-console/ui', clean: true },
];

for (const tree of runtimeAssetTrees) {
  const source = join(projectRoot, tree.source);
  const destination = join(projectRoot, tree.destination);

  if (!existsSync(source)) {
    throw new Error(`Runtime asset source does not exist: ${tree.source}`);
  }
  if (tree.clean) {
    rmSync(destination, { recursive: true, force: true });
  }
  cpSync(source, destination, { recursive: true });
  console.log(`[copy-runtime-assets] ${tree.source} -> ${tree.destination}`);
}

// The runtime image ships dist without the SQL migrations. Record which
// migrations this build expects so the server can compare them with the
// database's applied-migration ledger.
const releaseMigrationsSource = 'src/database/migrations';
const releaseMigrationsDestination = 'dist/database/release-migrations.json';
const releaseMigrations = buildReleaseMigrations(join(projectRoot, releaseMigrationsSource));
mkdirSync(dirname(join(projectRoot, releaseMigrationsDestination)), { recursive: true });
writeFileSync(join(projectRoot, releaseMigrationsDestination), `${JSON.stringify(releaseMigrations)}\n`);
console.log(`[copy-runtime-assets] ${releaseMigrationsSource} -> ${releaseMigrationsDestination} (${releaseMigrations.length} migrations)`);
