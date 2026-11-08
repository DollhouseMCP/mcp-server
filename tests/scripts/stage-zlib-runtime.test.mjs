import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { SHA256, VERSION, stage, validateControl, validateDigest, validatePayload } from '../../scripts/ci/stage-zlib-runtime.mjs';

const control = `Package: zlib1g\nSource: zlib (${VERSION})\nVersion: ${VERSION}\nArchitecture: amd64\nDescription: test\n`;

test('requires exact signed-package identity before extraction', () => {
  validateControl(control, 'amd64');
  for (const invalid of [control.replace('zlib1g', 'other'), control.replace(`Version: ${VERSION}`, 'Version: wrong'),
    control.replace('Architecture: amd64', 'Architecture: arm64'), control.replace('Source: zlib', 'Source: other')]) {
    assert.throws(() => validateControl(invalid, 'amd64'));
  }
  const bytes = Buffer.from('fixture');
  const expected = { amd64: createHash('sha256').update(bytes).digest('hex') };
  validateDigest(bytes, 'amd64', expected);
  assert.throws(() => validateDigest(Buffer.from('wrong'), 'amd64', expected));
  assert.throws(() => validateDigest(bytes, 'arm64', expected));
  assert.equal(SHA256.amd64.length, 64);
  assert.equal(SHA256.arm64.length, 64);
});

test('wrong package bytes refuse before creating extraction directories', (t) => {
  const root = mkdtempSync(join(os.tmpdir(), 'zlib-reject-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, 'wrong.deb');
  writeFileSync(archive, 'not the pinned package');
  assert.throws(() => stage(archive, 'amd64', join(root, 'overlay'), join(root, 'control')));
  assert.throws(() => lstatSync(join(root, 'overlay')));
  assert.throws(() => lstatSync(join(root, 'control')));
});

test('requires complete checksummed payload, native ELF and confined zlib link', (t) => {
  const root = mkdtempSync(join(os.tmpdir(), 'zlib-overlay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const relative = 'usr/lib/x86_64-linux-gnu/libz.so.1.3.1';
  const library = join(root, relative); mkdirSync(dirname(library), { recursive: true });
  const elf = Buffer.alloc(32); Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(elf); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(3, 16); elf.writeUInt16LE(62, 18);
  writeFileSync(library, elf); const link = join(dirname(library), 'libz.so.1'); symlinkSync('libz.so.1.3.1', link);
  const sums = `${createHash('md5').update(elf).digest('hex')}  ${relative}\n`;
  assert.equal(validatePayload(root, sums, 'amd64').files, 1);
  const wrongMachine = Buffer.from(elf); wrongMachine.writeUInt16LE(183, 18);
  writeFileSync(library, wrongMachine);
  const wrongMachineSums = `${createHash('md5').update(wrongMachine).digest('hex')}  ${relative}\n`;
  assert.throws(() => validatePayload(root, wrongMachineSums, 'amd64'));
  writeFileSync(library, elf);
  assert.throws(() => validatePayload(root, `${'0'.repeat(32)}  ${relative}\n`, 'amd64'));
  assert.throws(() => validatePayload(root, `${sums}${sums}`, 'amd64'));
  chmodSync(library, 0o666); assert.throws(() => validatePayload(root, sums, 'amd64')); chmodSync(library, 0o644);
  unlinkSync(library); assert.throws(() => validatePayload(root, sums, 'amd64')); writeFileSync(library, elf);
  writeFileSync(join(root, 'unlisted'), 'unexpected'); assert.throws(() => validatePayload(root, sums, 'amd64'));
  unlinkSync(join(root, 'unlisted')); unlinkSync(link); symlinkSync('../../../../outside', link);
  assert.throws(() => validatePayload(root, sums, 'amd64'));
});
