import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyImageScan, defaultKernelIgnores, readOwnedEvidence } from '../../scripts/verify-image-scan.mjs';

const image = `sha256:${'a'.repeat(64)}`;
const cache = '/owned/db';
const now = Date.parse('2026-10-28T20:00:00Z');
const result = () => ({
  descriptor: { name: 'grype', version: '0.120.1', configuration: {
    'check-for-app-update': false, externalSources: { enable: false },
    distro: '', exclude: [], 'vex-documents': [], 'vex-add': [],
    'only-fixed': false, 'only-notfixed': false, 'ignore-wontfix': '',
    ignore: structuredClone(defaultKernelIgnores),
    search: { scope: 'squashed', 'unindexed-archives': false, 'indexed-archives': true },
    db: { 'cache-dir': cache, 'update-url': 'https://grype.anchore.io/databases',
      'auto-update': false, 'require-update-check': false, 'validate-by-hash-on-start': true, 'validate-age': true,
      'max-allowed-built-age': 432000000000000 },
  }, db: { status: { valid: true, built: '2026-10-28T06:00:00Z',
    from: `https://grype.anchore.io/databases/v6/owned.tar.zst?checksum=sha256:${'a'.repeat(64)}` } } },
  source: { type: 'image', target: { imageID: image } },
  matches: [{ vulnerability: { id: 'fixture-low', severity: 'Low' }, artifact: { name: 'fixture' } }],
});

test('retains lower findings while qualifying a fresh image-bound report', () => {
  assert.deepEqual(verifyImageScan(result(), image, now, cache), { Low: 1 });
});
test('unavailable, invalid and stale database states refuse a clean report', () => {
  for (const status of [undefined, { valid: false, built: '2026-10-28T06:00:00Z' },
    { valid: true, built: '2026-10-01T06:00:00Z' }]) {
    const value = result(); value.descriptor.db.status = status;
    assert.throws(() => verifyImageScan(value, image, now, cache), /fresh valid database/);
  }
});
test('a different built image cannot borrow a successful report', () => {
  assert.throws(() => verifyImageScan(result(), `sha256:${'b'.repeat(64)}`, now, cache), /exact.*image/);
});
test('high findings refuse qualification while preserving the actual report', () => {
  const value = result(); value.matches[0].vulnerability.severity = 'High';
  assert.throws(() => verifyImageScan(value, image, now, cache), /unresolved high/);
  assert.equal(value.matches[0].vulnerability.id, 'fixture-low');
});
test('missing findings cannot be represented as a clean report', () => {
  const value = result(); delete value.matches;
  assert.throws(() => verifyImageScan(value, image, now, cache), /findings are missing/);
});
test('the command fails closed for an absent scanner output file', () => {
  const child = spawnSync(process.execPath, ['scripts/verify-image-scan.mjs', '/nonexistent/owned-scan.json', image], { encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: '' } });
  assert.equal(child.status, 1); assert.match(child.stderr, /Trusted Linux runner path required/);
});

test('unknown enum is retained; malformed severity labels fail closed', () => {
  const value = result(); value.matches[0].vulnerability.severity = 'Unknown';
  assert.deepEqual(verifyImageScan(value, image, now, cache), { Unknown: 1 });
  for (const severity of ['high', 'HIGH', '', 'Unrated', null, 1]) {
    value.matches[0].vulnerability.severity = severity;
    assert.throws(() => verifyImageScan(value, image, now, cache), /malformed/);
  }
});
test('suppressed findings cannot borrow a clean successful report', () => {
  for (const ignoredMatches of [[{ vulnerability: { id: 'hidden-high' } }], {}]) {
    const value = result(); value.ignoredMatches = ignoredMatches;
    assert.throws(() => verifyImageScan(value, image, now, cache), /suppressed/);
  }
  const value = result(); value.ignoredMatches = [];
  assert.deepEqual(verifyImageScan(value, image, now, cache), { Low: 1 });
});

test('effective exclusions, distro, VEX and alternative database policy refuse qualification', () => {
  const mutations = [
    config => { config.exclude = ['**/node_modules/**']; },
    config => { config.distro = 'alpine:0.1'; },
    config => { config['vex-documents'] = ['/tmp/unreviewed-vex.json']; },
    config => { config['only-fixed'] = true; },
    config => { config.externalSources.enable = true; },
    config => { config.db['require-update-check'] = true; },
    config => { config.db['update-url'] = 'https://other.example/databases'; },
    config => { config.db['validate-age'] = false; },
    config => { config.db['cache-dir'] = '/runner/inherited-cache'; },
    config => { config.ignore.push({ vulnerability: 'hidden-high' }); },
  ];
  for (const mutate of mutations) {
    const value = result(); mutate(value.descriptor.configuration);
    assert.throws(() => verifyImageScan(value, image, now, cache), /effective configuration/);
  }
  const value = result(); value.descriptor.db.status.from = 'https://other.example/old-db';
  assert.throws(() => verifyImageScan(value, image, now, cache), /effective configuration/);
});

test('offline local DB import requires bound Python manifest, image and actual isolation evidence', () => {
  const value = result();
  value.descriptor.db.status.from = 'manual import';
  value.descriptor.db.status.schemaVersion = 'v6.1.10';
  const proof = {
    runner: { reference: 'node@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66',
      index_digest: 'sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66',
      manifest_digest: 'sha256:c83040f7e24bacea68e58a0b96a484ba430bf24abb2973eab7ba4701144b7b63',
      config_digest: 'sha256:04f59b17d8d39a8fdeb138fecb8fcbaa6e208ed7b6db929c7e98ad9005e0a52f',
      execution_reference: 'node@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66',
      container_image_id: 'sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66',
      archive: { manifest_descriptor: { digest: 'sha256:c83040f7e24bacea68e58a0b96a484ba430bf24abb2973eab7ba4701144b7b63', size: 42, mediaType: 'application/vnd.oci.image.manifest.v1+json' }, format: 'oci-with-docker-manifest', store_id_role: 'index',
        store_id: 'sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66',
        root_digest: 'sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66', manifest_digest: 'sha256:c83040f7e24bacea68e58a0b96a484ba430bf24abb2973eab7ba4701144b7b63', config_digest: 'sha256:04f59b17d8d39a8fdeb138fecb8fcbaa6e208ed7b6db929c7e98ad9005e0a52f' } },
    capacity_admission: { target_uncompressed_size_bytes: 712633849,
      target_and_scratch_required_bytes: 4294967296 + 2 * 712633849, memory_limit_bytes: 8589934592,
      work_tmpfs_bytes: 6442450944, available_memory_bytes: 12 * 1024 ** 3,
      free_disk_bytes: 6 * 1024 ** 3, disk_required_bytes: 4 * 1024 ** 3 },
    database_payload: { declared_payload_bytes: 2541993984 },
    target: { store_id: image, store_id_role: 'config', config_digest: image, unpacked_layer_bytes: 712633849 },
    image_archive_sha256: 'b'.repeat(64),
    scanner_archive: { sha256: '0a9ee97ef5ae2ee953b0a80098105052e846cdbe319a57d808b519c33cd1343d' },
    database: { url: 'https://grype.anchore.io/databases/v6/owned.tar.zst', sha256: 'a'.repeat(64),
      manifest: { status: 'active', schemaVersion: 'v6.1.10', checksum: `sha256:${'a'.repeat(64)}`,
        path: 'owned.tar.zst', built: '2026-10-28T06:00:00Z' } },
    isolation: { runner_ref: 'node@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66',
      runner_execution_reference: 'node@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66',
      runner_container_image_id: 'sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66',
      runner_manifest_descriptor: { digest: 'sha256:c83040f7e24bacea68e58a0b96a484ba430bf24abb2973eab7ba4701144b7b63', size: 42, mediaType: 'application/vnd.oci.image.manifest.v1+json' }, user: '65532:65532', working_dir: '/work', healthcheck: { Test: ['NONE'] },
      mounts: Array.from({ length: 5 }, () => ({ Type: 'bind', RW: false })),
      host_config: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges=true'], NanoCpus: 2000000000, Memory: 8589934592,
        MemorySwap: 8589934592, PidsLimit: 64, Tmpfs: { '/work': 'rw,noexec,nosuid,nodev,size=6g,mode=1777' } } },
  };
  assert.deepEqual(verifyImageScan(value, image, now, cache, proof), { Low: 1 });
  const classic = structuredClone(proof);
  classic.runner.archive = { format: 'classic-docker', store_id_role: 'config',
    store_id: classic.runner.config_digest, config_digest: classic.runner.config_digest,
    root_digest: null, manifest_digest: null, manifest_descriptor: null };
  classic.runner.container_image_id = classic.runner.config_digest;
  classic.isolation.runner_container_image_id = classic.runner.config_digest;
  classic.isolation.runner_manifest_descriptor = null;
  assert.deepEqual(verifyImageScan(value, image, now, cache, classic), { Low: 1 });
  const modern = structuredClone(proof); modern.target.store_id_role = 'manifest';
  modern.target.store_id = `sha256:${'d'.repeat(64)}`; modern.target.manifest_digest = modern.target.store_id;
  assert.deepEqual(verifyImageScan(value, modern.target.store_id, now, cache, modern), { Low: 1 });
  const wrongRole = structuredClone(modern); wrongRole.target.store_id_role = 'config';
  assert.throws(() => verifyImageScan(value, modern.target.store_id, now, cache, wrongRole), /identity roles/);

  for (const mutate of [
    p => { p.runner.container_image_id = image; p.isolation.runner_container_image_id = image; },
    p => { p.isolation.runner_manifest_descriptor.digest = image; },
    p => { p.capacity_admission.target_uncompressed_size_bytes = 2 * 1024 ** 3; },
    p => { p.capacity_admission.available_memory_bytes = 3 * 1024 ** 3; },
    p => { p.database.sha256 = 'c'.repeat(64); },
    p => { p.isolation.host_config.NetworkMode = 'bridge'; },
    p => { p.isolation.mounts[0].RW = true; },
    p => { p.isolation.healthcheck.Test = ['CMD', 'node', 'app.js']; },
  ]) {
    const changed = structuredClone(proof); mutate(changed);
    assert.throws(() => verifyImageScan(value, image, now, cache, changed), /Offline/);
  }
});

// Inject only the proc-fd path adapter on non-Linux hosts; real fixture FDs,
// lstat, nofollow opens and bounded reads remain in use. Production has no fallback.
function evidenceFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-evidence-')));
  const reports = path.join(root, 'image-security', 'reports'); fs.mkdirSync(reports, { recursive: true });
  const report = path.join(reports, 'application-image-vulnerabilities.json');
  const provenance = path.join(reports, 'offline-provenance.json');
  fs.writeFileSync(report, JSON.stringify({ matches: [] })); fs.writeFileSync(provenance, JSON.stringify({ valid: true }));
  const paths = new Map(); const closed = []; let onRead = null; let onOpen = null; let opened = 0;
  const resolve = name => name.replace(/^\/proc\/self\/fd\/(\d+)(?=\/)/, (_, fd) => paths.get(Number(fd)));
  const backend = { ...fs,
    realpathSync: fs.realpathSync,
    lstatSync: (name, opts) => fs.lstatSync(resolve(name), opts),
    openSync: (name, flags) => { const resolved = path.normalize(resolve(name)); if (onOpen) onOpen(resolved); const fd = fs.openSync(resolved, flags); opened++; paths.set(fd, resolved); return fd; },
    readSync: (...args) => { const count = fs.readSync(...args); if (onRead) onRead(); return count; },
    closeSync: fd => { closed.push(fd); paths.delete(fd); fs.closeSync(fd); },
  };
  return { root, reports, report, provenance, backend, closed, openCount: () => opened, setRead: fn => { onRead = fn; }, setOpen: fn => { onOpen = fn; }, cleanup: () => fs.rmSync(root, { recursive:true, force:true }) };
}

test('fixed evidence accepts bounded fixture files and closes every descriptor', () => {
  const f = evidenceFixture();
  try {
    assert.deepEqual(readOwnedEvidence(f.report, f.root, f.backend, 'linux'), { report: { matches: [] }, provenance: { valid: true } });
    assert.equal(f.openCount(), f.closed.length);
  } finally { f.cleanup(); }
});

test('trusted fixed location rejects path substitution and unsupported hosts', () => {
  const f = evidenceFixture();
  try {
    for (const [report, root, platform] of [
      [f.report, undefined, 'linux'], [f.report, f.root, 'darwin'], ['relative.json', f.root, 'linux'],
      [f.report.replace('/reports/', '/reports/../reports/'), f.root, 'linux'],
      [path.join(f.reports, 'other.json'), f.root, 'linux'], [f.report + '.other', f.root, 'linux'],
      [path.join(f.root + '-lookalike', 'image-security/reports/application-image-vulnerabilities.json'), f.root, 'linux'],
    ]) assert.throws(() => readOwnedEvidence(report, root, f.backend, platform));
    assert.equal(f.closed.length, 0);
  } finally { f.cleanup(); }
});

test('symlinks, nonregular files, oversize and malformed data fail closed', () => {
  for (const scenario of ['report-link', 'parent-link', 'directory', 'oversize', 'provenance-oversize', 'malformed']) {
    const f = evidenceFixture();
    try {
      if (scenario === 'report-link') { fs.unlinkSync(f.report); fs.symlinkSync(f.provenance, f.report); }
      if (scenario === 'parent-link') { fs.renameSync(f.reports, f.reports + '-real'); fs.symlinkSync(f.reports + '-real', f.reports); }
      if (scenario === 'directory') { fs.unlinkSync(f.report); fs.mkdirSync(f.report); }
      if (scenario === 'oversize' || scenario === 'provenance-oversize') fs.truncateSync(scenario === 'oversize' ? f.report : f.provenance, scenario === 'oversize' ? 32 * 1024 ** 2 + 1 : 1024 ** 2 + 1);
      if (scenario === 'malformed') fs.writeFileSync(f.report, '{');
      assert.throws(() => readOwnedEvidence(f.report, f.root, f.backend, 'linux'));
      assert.ok(f.closed.length > 0);
    } finally { f.cleanup(); }
  }
});

test('replacement, growth and postread changes refuse and close descriptors', () => {
  for (const scenario of ['replace', 'grow', 'mutate']) {
    const f = evidenceFixture(); let changed = false;
    try {
      f.setRead(() => {
        if (changed) return; changed = true;
        if (scenario === 'replace') { fs.renameSync(f.report, f.report + '.old'); fs.writeFileSync(f.report, '{}'); }
        if (scenario === 'grow') fs.appendFileSync(f.report, ' ');
        if (scenario === 'mutate') fs.writeFileSync(f.report, '{"other":true}');
      });
      assert.throws(() => readOwnedEvidence(f.report, f.root, f.backend, 'linux'), /changed/);
      assert.equal(f.openCount(), f.closed.length);
    } finally { f.cleanup(); }
  }
});


test('pre-open replacement and directory rename refuse and close all opened FDs', () => {
  for (const scenario of ['pre-open', 'directory-rename']) {
    const f = evidenceFixture(); let changed = false;
    try {
      if (scenario === 'pre-open') f.setOpen(name => {
        if (name === f.report && !changed) { changed = true; fs.renameSync(f.report, f.report + '.old'); fs.writeFileSync(f.report, '{}'); }
      });
      if (scenario === 'directory-rename') f.setRead(() => {
        if (!changed) { changed = true; fs.renameSync(f.reports, f.reports + '-old'); fs.mkdirSync(f.reports); }
      });
      assert.throws(() => readOwnedEvidence(f.report, f.root, f.backend, 'linux'));
      assert.equal(f.openCount(), f.closed.length);
    } finally { f.cleanup(); }
  }
});

test('native Linux proc-fd backend reads and rejects symlinks', { skip: process.platform !== 'linux' && 'Native /proc/self/fd backend requires Linux' }, () => {
  const f = evidenceFixture();
  try {
    assert.deepEqual(readOwnedEvidence(f.report, f.root), { report: { matches: [] }, provenance: { valid: true } });
    fs.unlinkSync(f.report); fs.symlinkSync(f.provenance, f.report);
    assert.throws(() => readOwnedEvidence(f.report, f.root));
    fs.unlinkSync(f.report); fs.writeFileSync(f.report, '{}');
    let replaced = false;
    const preopen = { ...fs, openSync(name, flags) {
      if (!replaced && name.endsWith('/application-image-vulnerabilities.json')) {
        replaced = true; fs.renameSync(f.report, f.report + '.old'); fs.writeFileSync(f.report, '{}');
      }
      return fs.openSync(name, flags);
    } };
    assert.throws(() => readOwnedEvidence(f.report, f.root, preopen, 'linux'), /changed/);
    let moved = false;
    const duringRead = { ...fs, readSync(...args) {
      const count = fs.readSync(...args);
      if (!moved) { moved = true; fs.renameSync(f.reports, f.reports + '-old'); fs.mkdirSync(f.reports); }
      return count;
    } };
    assert.throws(() => readOwnedEvidence(f.report, f.root, duringRead, 'linux'));
  } finally { f.cleanup(); }
});
