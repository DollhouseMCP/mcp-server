'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readDebianInventory } = require('./docker/runtime-contract.cjs');

test('reads Debian control records and counts bounded md5sums without parsing them', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-inventory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'libc6'), 'Package: libc6\nVersion: 2.41-12+deb13u4\nArchitecture: amd64\n');
  fs.writeFileSync(path.join(dir, 'libc6.md5sums'), 'fixture checksum bytes, not a control record\n');
  assert.deepEqual(readDebianInventory(dir), {
    fileCount: 2, md5sumFileCount: 1,
    packages: [{ package: 'libc6', version: '2.41-12+deb13u4', architecture: 'amd64' }],
  });
});

test('refuses malformed records, symlinks and oversized auxiliary files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-inventory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = path.join(dir, 'package');
  fs.writeFileSync(record, 'Package: test\nPackage: duplicate\nVersion: 1\nArchitecture: all\n');
  assert.throws(() => readDebianInventory(dir));
  fs.writeFileSync(record, 'Package: test\nVersion: 1\nArchitecture: all\n');
  const link = path.join(dir, 'test.md5sums');
  fs.symlinkSync(record, link);
  assert.throws(() => readDebianInventory(dir));
  fs.unlinkSync(link);
  fs.writeFileSync(link, Buffer.alloc(1024 * 1024 + 1));
  assert.throws(() => readDebianInventory(dir));
});
