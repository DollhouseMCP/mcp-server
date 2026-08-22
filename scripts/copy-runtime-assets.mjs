#!/usr/bin/env node

import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const runtimeAssetTrees = [
  { source: 'src/seed-elements', destination: 'dist/seed-elements', clean: true },
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
