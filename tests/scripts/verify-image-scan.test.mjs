import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { verifyImageScan, defaultKernelIgnores } from '../../scripts/verify-image-scan.mjs';

const image = `sha256:${'a'.repeat(64)}`;
const cache = '/owned/db';
const now = Date.parse('2026-10-28T20:00:00Z');
const result = () => ({
  descriptor: { name: 'grype', version: '0.121.0', configuration: {
    distro: '', exclude: [], 'vex-documents': [], 'vex-add': [],
    'only-fixed': false, 'only-notfixed': false, 'ignore-wontfix': '',
    ignore: structuredClone(defaultKernelIgnores),
    search: { scope: 'squashed', 'unindexed-archives': false, 'indexed-archives': true },
    db: { 'cache-dir': cache, 'update-url': 'https://grype.anchore.io/databases',
      'auto-update': false, 'validate-by-hash-on-start': true, 'validate-age': true,
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
  assert.throws(() => verifyImageScan(result(), `sha256:${'b'.repeat(64)}`, now, cache), /exact image/);
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
  const child = spawnSync(process.execPath, ['scripts/verify-image-scan.mjs', '/nonexistent/owned-scan.json', image], { encoding: 'utf8' });
  assert.equal(child.status, 1); assert.match(child.stderr, /ENOENT/);
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
