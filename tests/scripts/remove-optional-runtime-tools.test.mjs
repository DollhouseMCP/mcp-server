import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { removeOptionalRuntimeTools } from '../../docker/remove-optional-runtime-tools.mjs';

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'runtime-tools-'));
  const path = name => join(root, name);
  const files = {
    '/usr/bin/infocmp': 'synthetic infocmp',
    '/usr/bin/nsenter': 'synthetic nsenter',
    '/var/lib/dpkg/info/ncurses-bin.list': '/usr/bin/infocmp\n/usr/bin/tput\n',
    '/var/lib/dpkg/info/util-linux.list': '/usr/bin/nsenter\n/usr/bin/unshare\n',
    '/usr/bin/tput': 'keep terminal support',
    '/usr/bin/unshare': 'keep other tools',
    '/usr/lib/libtinfo.so': 'keep libraries',
    '/usr/local/bin/npx': 'keep npm features',
  };
  for (const [name, bytes] of Object.entries(files)) {
    fs.mkdirSync(dirname(path(name)), { recursive: true });
    fs.writeFileSync(path(name), bytes, { mode: name.endsWith('.list') ? 0o644 : 0o755 });
  }
  const owners = new Map();
  const io = {
    lstatSync(name) {
      const stat = fs.lstatSync(path(name));
      // A rootless host fixture models the image's root ownership explicitly;
      // type, link count, mode, contents and removal use the real filesystem.
      return Object.assign(stat, { uid: owners.get(name) ?? 0, gid: 0 });
    },
    readFileSync: (name, encoding) => fs.readFileSync(path(name), encoding),
    unlinkSync: name => fs.unlinkSync(path(name)),
  };
  return { root, path, files, owners, io, cleanup: () => fs.rmSync(root, { recursive: true }) };
}

function bothRemain(f) {
  for (const name of ['/usr/bin/infocmp', '/usr/bin/nsenter']) {
    assert.equal(fs.readFileSync(f.path(name), 'utf8'), f.files[name]);
  }
}

test('removes exactly two tools, retaining other bytes, modes and package lists', () => {
  const f = fixture();
  try {
    const retained = Object.keys(f.files).filter(name => !['/usr/bin/infocmp', '/usr/bin/nsenter'].includes(name));
    const before = retained.map(name => [name, fs.statSync(f.path(name)).mode]);
    removeOptionalRuntimeTools(f.io);
    for (const name of ['/usr/bin/infocmp', '/usr/bin/nsenter']) assert.throws(() => fs.lstatSync(f.path(name)), { code: 'ENOENT' });
    for (const [name, mode] of before) {
      assert.equal(fs.readFileSync(f.path(name), 'utf8'), f.files[name]);
      assert.equal(fs.statSync(f.path(name)).mode, mode);
    }
  } finally { f.cleanup(); }
});

for (const [label, change] of [
  ['wrong tool owner', f => f.owners.set('/usr/bin/nsenter', 1001)],
  ['wrong package-list owner', f => f.owners.set('/var/lib/dpkg/info/util-linux.list', 1001)],
  ['changed mode', f => fs.chmodSync(f.path('/usr/bin/nsenter'), 0o4755)],
  ['missing ownership', f => fs.writeFileSync(f.path('/var/lib/dpkg/info/util-linux.list'), '/usr/bin/other\n')],
  ['duplicate ownership', f => fs.appendFileSync(f.path('/var/lib/dpkg/info/util-linux.list'), '/usr/bin/nsenter\n')],
  ['hardlink alias', f => fs.linkSync(f.path('/usr/bin/nsenter'), f.path('/usr/bin/alias'))],
]) {
  test(`${label} refuses before either tool is deleted`, () => {
    const f = fixture();
    try { change(f); assert.throws(() => removeOptionalRuntimeTools(f.io)); bothRemain(f); }
    finally { f.cleanup(); }
  });
}

test('symlink tool refuses before the first deletion and retains its target', () => {
  const f = fixture();
  try {
    fs.renameSync(f.path('/usr/bin/nsenter'), f.path('/usr/bin/real-tool'));
    fs.symlinkSync('real-tool', f.path('/usr/bin/nsenter'));
    assert.throws(() => removeOptionalRuntimeTools(f.io)); bothRemain(f);
    assert.equal(fs.readFileSync(f.path('/usr/bin/real-tool'), 'utf8'), 'synthetic nsenter');
  } finally { f.cleanup(); }
});

test('failed removal and an unexpectedly remaining tool both fail the build', () => {
  const f = fixture();
  try {
    assert.throws(() => removeOptionalRuntimeTools({ ...f.io, unlinkSync() { throw new Error('synthetic refusal'); } }), /synthetic refusal/);
    bothRemain(f);
    assert.throws(() => removeOptionalRuntimeTools({ ...f.io, unlinkSync() {} }), /tool remains/);
    bothRemain(f);
  } finally { f.cleanup(); }
});
