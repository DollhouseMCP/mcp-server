import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { verifyImageScan } from '../../scripts/verify-image-scan.mjs';

const image = `sha256:${'a'.repeat(64)}`;
const now = Date.parse('2026-10-28T20:00:00Z');
const result = () => ({
  descriptor: { name: 'grype', version: '0.121.0', db: { status: { valid: true, built: '2026-10-28T06:00:00Z' } } },
  source: { type: 'image', target: { imageID: image } },
  matches: [{ vulnerability: { id: 'fixture-low', severity: 'Low' }, artifact: { name: 'fixture' } }],
});

test('retains lower findings while qualifying a fresh image-bound report', () => {
  assert.deepEqual(verifyImageScan(result(), image, now), { Low: 1 });
});
test('unavailable, invalid and stale database states refuse a clean report', () => {
  for (const status of [undefined, { valid: false, built: '2026-10-28T06:00:00Z' },
    { valid: true, built: '2026-10-01T06:00:00Z' }]) {
    const value = result(); value.descriptor.db.status = status;
    assert.throws(() => verifyImageScan(value, image, now), /fresh valid database/);
  }
});
test('a different built image cannot borrow a successful report', () => {
  assert.throws(() => verifyImageScan(result(), `sha256:${'b'.repeat(64)}`, now), /exact image/);
});
test('high findings refuse qualification while preserving the actual report', () => {
  const value = result(); value.matches[0].vulnerability.severity = 'High';
  assert.throws(() => verifyImageScan(value, image, now), /unresolved high/);
  assert.equal(value.matches[0].vulnerability.id, 'fixture-low');
});
test('missing findings cannot be represented as a clean report', () => {
  const value = result(); delete value.matches;
  assert.throws(() => verifyImageScan(value, image, now), /findings are missing/);
});
test('the command fails closed for an absent scanner output file', () => {
  const child = spawnSync(process.execPath, ['scripts/verify-image-scan.mjs', '/nonexistent/owned-scan.json', image], { encoding: 'utf8' });
  assert.equal(child.status, 1); assert.match(child.stderr, /ENOENT/);
});
