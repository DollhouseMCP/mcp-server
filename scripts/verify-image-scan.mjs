import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

// Exact Grype0.121.0 defaults from cmd/grype/cli/commands/root.go at
// afe2742527d98d822da06c9f32eed86fe3d193e0. No added ignore rules are accepted.
export const defaultKernelIgnores = [
  ['kernel-headers', 'kernel', 'rpm'],
  ['linux(-.*)?-headers-.*', 'linux.*', 'deb'],
  ['linux-libc-dev', 'linux', 'deb'],
  ['linux-kbuild-.*', 'linux.*', 'deb'],
].map(([name, upstream, type]) => ({
  vulnerability: '', 'include-aliases': false, reason: '', namespace: '', 'fix-state': '',
  package: { name, version: '', language: '', type, location: '', 'upstream-name': upstream },
  'vex-status': '', 'vex-justification': '', 'match-type': 'exact-indirect-match',
}));

export function verifyOwnedScanPolicy(configuration, database, expectedDbCache) {
  const emptyArrays = ['exclude', 'vex-documents', 'vex-add'];
  const databaseUrl = new URL(database?.from ?? 'about:blank');
  if (!configuration || !expectedDbCache || configuration.distro !== '' ||
      emptyArrays.some(key => !isDeepStrictEqual(configuration[key], [])) ||
      configuration['only-fixed'] !== false || configuration['only-notfixed'] !== false ||
      configuration['ignore-wontfix'] !== '' ||
      !isDeepStrictEqual(configuration.ignore, defaultKernelIgnores) ||
      configuration.search?.scope !== 'squashed' ||
      configuration.search?.['unindexed-archives'] !== false ||
      configuration.search?.['indexed-archives'] !== true ||
      configuration.db?.['cache-dir'] !== expectedDbCache ||
      configuration.db?.['update-url'] !== 'https://grype.anchore.io/databases' ||
      configuration.db?.['auto-update'] !== false ||
      configuration.db?.['validate-by-hash-on-start'] !== true ||
      configuration.db?.['validate-age'] !== true ||
      configuration.db?.['max-allowed-built-age'] !== 432000000000000 ||
      databaseUrl.origin !== 'https://grype.anchore.io' ||
      !databaseUrl.pathname.startsWith('/databases/v6/') ||
      !/^sha256:[a-f0-9]{64}$/.test(databaseUrl.searchParams.get('checksum') ?? '')) {
    throw new Error('Image scan effective configuration differs from the owned source/database/finding policy');
  }
}

export function verifyImageScan(result, expectedImageId, now = Date.now(), expectedDbCache) {
  const descriptor = result?.descriptor;
  const database = descriptor?.db?.status;
  const built = Date.parse(database?.built);
  if (descriptor?.name !== 'grype' || descriptor.version !== '0.121.0' ||
      database?.valid !== true || !Number.isFinite(built) || built > now ||
      now - built > 120 * 60 * 60 * 1000) {
    throw new Error('Image scan unavailable: expected scanner and fresh valid database required');
  }
  verifyOwnedScanPolicy(descriptor.configuration, database, expectedDbCache);
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedImageId ?? '') ||
      result?.source?.type !== 'image' || result.source.target?.imageID !== expectedImageId) {
    throw new Error('Image scan does not identify the exact image built by this job');
  }
  const severities = new Set(['Negligible', 'Low', 'Medium', 'High', 'Critical', 'Unknown']);
  if ((result.ignoredMatches !== undefined &&
      (!Array.isArray(result.ignoredMatches) || result.ignoredMatches.length !== 0)) ||
      !Array.isArray(result.matches) ||
      result.matches.some(match => !match?.vulnerability?.id ||
        !severities.has(match.vulnerability.severity) || !match?.artifact?.name)) {
    throw new Error('Image scan findings are missing, suppressed or malformed');
  }
  const counts = {};
  for (const { vulnerability } of result.matches) {
    counts[vulnerability.severity] = (counts[vulnerability.severity] ?? 0) + 1;
  }
  // Lower and unknown severities remain visible in the complete uploaded JSON.
  console.log(JSON.stringify({ imageId: expectedImageId, database, findings: result.matches.length, counts }));
  if (counts.Critical || counts.High) {
    throw new Error('Application image has unresolved high or critical vulnerability matches');
  }
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyImageScan(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3], Date.now(),
      path.resolve(path.dirname(process.argv[2]), '../db'));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
