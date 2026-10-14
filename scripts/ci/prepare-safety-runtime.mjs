#!/usr/bin/env node
// Build-stage packaging only: this workspace currently has no runtime dependencies.
import { readFile, rm } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('./packages/safety/package.json', 'utf8'));
if (manifest.name !== '@dollhousemcp/safety') throw new Error('Expected safety workspace at the fixed packaging path');
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  const value = manifest[field];
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length)) {
    throw new Error(`Safety ${field} require runtime packaging support before excluding node_modules`);
  }
}
for (const field of ['bundledDependencies', 'bundleDependencies']) {
  const value = manifest[field];
  if (value !== undefined && value !== false && (!Array.isArray(value) || value.length)) {
    throw new Error(`Safety ${field} require runtime packaging support before excluding node_modules`);
  }
}
// Only the dependency-free workspace's build tools are removed. The complete
// package, compiled exports/assets, and root production dependencies stay intact.
await rm('./packages/safety/node_modules', { recursive: true, force: true });
