#!/usr/bin/env node
/**
 * Publish-channel guard, run from prepublishOnly.
 *
 * This is the LAST line of defense and the only one that travels with the
 * package: it guards every `npm publish` — including a manual publish from a
 * developer laptop, where no CI workflow can intervene. A developer who is
 * technical enough to run `npm publish` but doesn't notice the checkout has a
 * prerelease version (e.g. 2.1.0-beta.1) would otherwise move the `latest`
 * dist-tag onto that prerelease, and every default install path
 * (`npx @dollhousemcp/mcp-server`, bare `npm install`, the `@latest` pin our
 * installer writes into client configs) would silently serve beta to stable
 * users on their next launch.
 *
 * Rules enforced (identical to the CI dist-tag mapping):
 *   stable X.Y.Z      → must publish to `latest` (the default)
 *   X.Y.Z-alpha.N     → must publish with --tag alpha
 *   X.Y.Z-beta[.N]    → must publish with --tag beta
 *   X.Y.Z-rc.N        → must publish with --tag next
 *   anything else     → refused (unknown channel)
 *
 * npm exposes the --tag flag to lifecycle scripts as npm_config_tag; when the
 * flag is omitted npm defaults the publish to `latest`.
 */
import { readFileSync } from 'node:fs';

const version = process.env.npm_package_version
  ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function expectedTagFor(v) {
  if (/-alpha\./.test(v)) return 'alpha';
  if (/-beta(\.|$)/.test(v)) return 'beta';
  if (/-rc\./.test(v)) return 'next';
  if (v.includes('-')) return null; // unrecognized prerelease channel
  return 'latest';
}

const expected = expectedTagFor(version);
const actual = process.env.npm_config_tag || 'latest';

if (expected === null) {
  console.error(`✖ Version ${version} has an unsupported prerelease suffix.`);
  console.error('  Supported channels: -alpha.N (alpha), -beta[.N] (beta), -rc.N (next).');
  process.exit(1);
}

if (actual !== expected) {
  console.error(`✖ Refusing to publish ${version} to dist-tag "${actual}".`);
  if (expected !== 'latest') {
    console.error('');
    console.error(`  This checkout is a PRERELEASE. Publishing it to "${actual}" would make`);
    console.error('  every default install (npx @dollhousemcp/mcp-server, npm install,');
    console.error('  and existing client configs pinned to @latest) serve this prerelease');
    console.error('  to stable users on their next launch.');
    console.error('');
    console.error(`  Publish it to its channel instead:`);
    console.error(`    npm publish --tag ${expected}`);
  } else {
    console.error('');
    console.error(`  This is a STABLE version — it belongs on "latest", not "${actual}".`);
    console.error('  Publish without a --tag flag (or with --tag latest).');
  }
  process.exit(1);
}

console.log(`✔ Publish channel OK: ${version} → dist-tag "${actual}"`);
