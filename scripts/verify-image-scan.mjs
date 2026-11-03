import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

// Exact Grype 0.120.1 defaults from cmd/grype/cli/commands/root.go at
// 6f8d854af29d3a3086b11a84afa51554a2a245fe. No added ignore rules are accepted.
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

export function verifyOwnedScanPolicy(configuration, database, expectedDbCache, offline) {
  const emptyArrays = ['exclude', 'vex-documents', 'vex-add'];
  const databaseUrl = new URL(offline?.database?.url ?? database?.from ?? 'about:blank');
  if (offline) verifyOfflineProvenance(offline, database);
  if (!configuration || !expectedDbCache || configuration.distro !== '' ||
      configuration['check-for-app-update'] !== false || configuration.externalSources?.enable !== false ||
      emptyArrays.some(key => !isDeepStrictEqual(configuration[key], [])) ||
      configuration['only-fixed'] !== false || configuration['only-notfixed'] !== false ||
      configuration['ignore-wontfix'] !== '' ||
      !isDeepStrictEqual(configuration.ignore, defaultKernelIgnores) ||
      configuration.search?.scope !== 'squashed' ||
      configuration.search?.['unindexed-archives'] !== false ||
      configuration.search?.['indexed-archives'] !== true ||
      configuration.db?.['cache-dir'] !== expectedDbCache ||
      configuration.db?.['update-url'] !== 'https://grype.anchore.io/databases' ||
      configuration.db?.['auto-update'] !== false || configuration.db?.['require-update-check'] !== false ||
      configuration.db?.['validate-by-hash-on-start'] !== true ||
      configuration.db?.['validate-age'] !== true ||
      configuration.db?.['max-allowed-built-age'] !== 432000000000000 ||
      databaseUrl.origin !== 'https://grype.anchore.io' ||
      !databaseUrl.pathname.startsWith('/databases/v6/') ||
      !(offline ? /^[a-f0-9]{64}$/.test(offline.database.sha256) :
        /^sha256:[a-f0-9]{64}$/.test(databaseUrl.searchParams.get('checksum') ?? ''))) {
    throw new Error('Image scan effective configuration differs from the owned source/database/finding policy');
  }
}

function identityRoleMatches(graph) {
  const digest = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
  if (!graph || !digest(graph.store_id) || !digest(graph.config_digest)) return false;
  if (graph.store_id_role === 'config') return graph.store_id === graph.config_digest;
  if (graph.store_id_role === 'manifest') return digest(graph.manifest_digest) && graph.store_id === graph.manifest_digest;
  if (graph.store_id_role === 'index') return digest(graph.root_digest) && graph.store_id === graph.root_digest;
  return false;
}

export function verifyOfflineProvenance(provenance, database) {
  const record = provenance.database;
  const isolation = provenance.isolation;
  const runner = provenance.runner;
  const policy = isolation?.host_config;
  const capacity = provenance.capacity_admission;
  const rawDb = provenance.database_payload?.declared_payload_bytes;
  if (!record?.manifest || record.manifest.status !== 'active' ||
      record.manifest.schemaVersion !== 'v6.1.10' ||
      record.manifest.checksum !== `sha256:${record.sha256}` ||
      record.url !== `https://grype.anchore.io/databases/v6/${record.manifest.path}` ||
      database.from !== 'manual import' || database.built !== record.manifest.built ||
      database.schemaVersion !== record.manifest.schemaVersion ||
      provenance.scanner_archive?.sha256 !== '0a9ee97ef5ae2ee953b0a80098105052e846cdbe319a57d808b519c33cd1343d' ||
      !/^[a-f0-9]{64}$/.test(provenance.image_archive_sha256 ?? '') ||
      runner?.reference !== 'node@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66' ||
      runner.index_digest !== 'sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66' ||
      runner.manifest_digest !== 'sha256:c83040f7e24bacea68e58a0b96a484ba430bf24abb2973eab7ba4701144b7b63' ||
      runner.config_digest !== 'sha256:04f59b17d8d39a8fdeb138fecb8fcbaa6e208ed7b6db929c7e98ad9005e0a52f' ||
      !identityRoleMatches(runner.archive) || runner.archive.config_digest !== runner.config_digest ||
      !['classic-docker', 'oci-with-docker-manifest'].includes(runner.archive.format) ||
      (runner.archive.format === 'oci-with-docker-manifest' &&
        (runner.archive.manifest_digest !== runner.manifest_digest ||
         ![runner.index_digest, runner.manifest_digest].includes(runner.archive.root_digest))) ||
      runner.execution_reference !== runner.reference || runner.container_image_id !== runner.archive.store_id ||
      isolation?.runner_ref !== runner.reference || isolation?.runner_execution_reference !== runner.reference ||
      isolation?.runner_container_image_id !== runner.container_image_id ||
      (runner.archive.format === 'oci-with-docker-manifest' &&
        (!runner.archive.manifest_descriptor || !['digest', 'size', 'mediaType'].every(key =>
          isolation?.runner_manifest_descriptor?.[key] === runner.archive.manifest_descriptor[key]) ||
         runner.archive.manifest_descriptor.digest !== runner.manifest_digest)) ||
      !capacity || !Number.isInteger(capacity.target_uncompressed_size_bytes) ||
      capacity.target_uncompressed_size_bytes <= 0 || capacity.target_uncompressed_size_bytes > 1073741824 ||
      !Number.isInteger(rawDb) || rawDb <= 0 || rawDb > 2684354560 ||
      capacity.memory_limit_bytes !== 8589934592 || capacity.work_tmpfs_bytes !== 6442450944 ||
      !Number.isSafeInteger(capacity.available_memory_bytes) || capacity.available_memory_bytes < 9663676416 ||
      !Number.isSafeInteger(capacity.free_disk_bytes) || !Number.isSafeInteger(capacity.disk_required_bytes) ||
      capacity.disk_required_bytes <= 0 || capacity.free_disk_bytes < capacity.disk_required_bytes ||
      capacity.target_and_scratch_required_bytes !== 4294967296 + 2 * capacity.target_uncompressed_size_bytes ||
      capacity.target_and_scratch_required_bytes > 6442450944 ||
      isolation?.working_dir !== '/work' || !isDeepStrictEqual(isolation?.healthcheck?.Test, ['NONE']) ||
      isolation?.user !== '65532:65532' || policy?.NetworkMode !== 'none' ||
      policy?.ReadonlyRootfs !== true || policy?.Privileged !== false ||
      !isDeepStrictEqual(policy.CapDrop, ['ALL']) ||
      !policy.SecurityOpt?.includes('no-new-privileges=true') ||
      policy.NanoCpus !== 2000000000 || policy.Memory !== 8589934592 ||
      policy.MemorySwap !== 8589934592 || policy.PidsLimit !== 64 ||
      policy.Tmpfs?.['/work'] !== 'rw,noexec,nosuid,nodev,size=6g,mode=1777' ||
      isolation.mounts?.length !== 5 || isolation.mounts.some(mount => mount.Type !== 'bind' || mount.RW !== false)) {
    throw new Error('Offline database/archive/isolation provenance is missing or inconsistent');
  }
}

export function verifyImageScan(result, expectedStoreId, now = Date.now(), expectedDbCache, offline) {
  const descriptor = result?.descriptor;
  const database = descriptor?.db?.status;
  const built = Date.parse(database?.built);
  if (descriptor?.name !== 'grype' || descriptor.version !== '0.120.1' ||
      database?.valid !== true || !Number.isFinite(built) || built > now ||
      now - built > 120 * 60 * 60 * 1000) {
    throw new Error('Image scan unavailable: expected scanner and fresh valid database required');
  }
  verifyOwnedScanPolicy(descriptor.configuration, database, expectedDbCache, offline);
  const target = offline?.target;
  if (offline && (target?.store_id !== expectedStoreId || target?.store_id === offline.runner.container_image_id ||
      !identityRoleMatches(target) ||
      target.unpacked_layer_bytes !== offline.capacity_admission.target_uncompressed_size_bytes)) {
    throw new Error('Offline target store/manifest/config identity roles do not match their verified graph');
  }
  const expectedConfig = offline ? target.config_digest : expectedStoreId;
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedStoreId ?? '') ||
      result?.source?.type !== 'image' || result.source.target?.imageID !== expectedConfig) {
    throw new Error('Image scan does not identify the exact validated image config');
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
  console.log(JSON.stringify({ storeId: expectedStoreId, configDigest: expectedConfig, database, findings: result.matches.length, counts }));
  if (counts.Critical || counts.High) {
    throw new Error('Application image has unresolved high or critical vulnerability matches');
  }
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyImageScan(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3], Date.now(),
      '/work/db', JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[2]), 'offline-provenance.json'), 'utf8')));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
