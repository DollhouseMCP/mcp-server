import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { removeOptionalRuntimeTools } from '../../docker/remove-optional-runtime-tools.mjs';

const toolPaths = ['/usr/bin/infocmp', '/usr/bin/nsenter', '/usr/bin/mount', '/usr/bin/umount'];

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'runtime-tools-'));
  const path = name => join(root, name);
  const files = {
    '/usr/bin/infocmp': 'synthetic infocmp',
    '/usr/bin/nsenter': 'synthetic nsenter',
    '/usr/bin/mount': 'synthetic mount',
    '/usr/bin/umount': 'synthetic umount',
    '/var/lib/dpkg/info/mount.list': '/usr/bin/mount\n/usr/bin/umount\n/usr/bin/other-mount-data\n',
    '/var/lib/dpkg/info/ncurses-bin.list': '/usr/bin/infocmp\n/usr/bin/tput\n',
    '/var/lib/dpkg/info/util-linux.list': '/usr/bin/nsenter\n/usr/bin/unshare\n',
    '/usr/bin/tput': 'keep terminal support',
    '/usr/bin/unshare': 'keep other tools',
    '/usr/lib/libtinfo.so': 'keep libraries',
    '/usr/lib/libmount.so': 'keep mount library',
    '/usr/lib/libacl.so': 'keep ACL library',
    '/usr/local/bin/npx': 'keep npm features',
  };
  for (const [name, bytes] of Object.entries(files)) {
    fs.mkdirSync(dirname(path(name)), { recursive: true });
    fs.writeFileSync(path(name), bytes, { mode: name.endsWith('.list') ? 0o644 : ['/usr/bin/mount', '/usr/bin/umount'].includes(name) ? 0o4755 : 0o755 });
    // Writing can clear setuid on the host; establish the synthetic image mode
    // after fixture bytes are complete. Production never changes tool modes.
    if (['/usr/bin/mount', '/usr/bin/umount'].includes(name)) fs.chmodSync(path(name), 0o4755);
  }
  const owners = new Map();
  const groups = new Map();
  const io = {
    lstatSync(name) {
      const stat = fs.lstatSync(path(name));
      // A rootless host fixture models the image's root ownership explicitly;
      // type, link count, mode, contents and removal use the real filesystem.
      return Object.assign(stat, { uid: owners.get(name) ?? 0, gid: groups.get(name) ?? 0 });
    },
    readFileSync: (name, encoding) => fs.readFileSync(path(name), encoding),
    unlinkSync: name => fs.unlinkSync(path(name)),
  };
  return { root, path, files, owners, groups, io, cleanup: () => fs.rmSync(root, { recursive: true }) };
}

function allRemain(f) {
  for (const name of toolPaths) {
    assert.equal(fs.readFileSync(f.path(name), 'utf8'), f.files[name]);
  }
}

test('removes exactly four tools, retaining other bytes, modes and package lists', () => {
  const f = fixture();
  try {
    const retained = Object.keys(f.files).filter(name => !toolPaths.includes(name));
    const before = retained.map(name => [name, fs.statSync(f.path(name)).mode]);
    removeOptionalRuntimeTools(f.io);
    for (const name of toolPaths) assert.throws(() => fs.lstatSync(f.path(name)), { code: 'ENOENT' });
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
  ['last tool wrong owner', f => f.owners.set('/usr/bin/umount', 1001)],
  ['last tool wrong group', f => f.groups.set('/usr/bin/umount', 1001)],
  ['last tool loses expected setuid mode', f => fs.chmodSync(f.path('/usr/bin/umount'), 0o755)],
  ['last tool hardlink alias', f => fs.linkSync(f.path('/usr/bin/umount'), f.path('/usr/bin/umount-alias'))],
  ['last tool missing ownership', f => fs.writeFileSync(f.path('/var/lib/dpkg/info/mount.list'), '/usr/bin/mount\n')],
  ['last tool duplicate ownership', f => fs.appendFileSync(f.path('/var/lib/dpkg/info/mount.list'), '/usr/bin/umount\n')],
  ['new package list wrong owner', f => f.owners.set('/var/lib/dpkg/info/mount.list', 1001)],
  ['new package list changed mode', f => fs.chmodSync(f.path('/var/lib/dpkg/info/mount.list'), 0o600)],
  ['last tool symlink alias', f => {
    fs.renameSync(f.path('/usr/bin/umount'), f.path('/usr/bin/real-umount'));
    fs.symlinkSync('real-umount', f.path('/usr/bin/umount'));
  }],
]) {
  test(`${label} refuses before any of the four tools is deleted`, () => {
    const f = fixture();
    try { change(f); assert.throws(() => removeOptionalRuntimeTools(f.io)); allRemain(f); }
    finally { f.cleanup(); }
  });
}

test('symlink tool refuses before the first deletion and retains its target', () => {
  const f = fixture();
  try {
    fs.renameSync(f.path('/usr/bin/nsenter'), f.path('/usr/bin/real-tool'));
    fs.symlinkSync('real-tool', f.path('/usr/bin/nsenter'));
    assert.throws(() => removeOptionalRuntimeTools(f.io)); allRemain(f);
    assert.equal(fs.readFileSync(f.path('/usr/bin/real-tool'), 'utf8'), 'synthetic nsenter');
  } finally { f.cleanup(); }
});

test('failed removal and an unexpectedly remaining tool both fail the build', () => {
  const f = fixture();
  try {
    assert.throws(() => removeOptionalRuntimeTools({ ...f.io, unlinkSync() { throw new Error('synthetic refusal'); } }), /synthetic refusal/);
    allRemain(f);
    assert.throws(() => removeOptionalRuntimeTools({ ...f.io, unlinkSync() {} }), /tool remains/);
    allRemain(f);
  } finally { f.cleanup(); }
});


test('nonregular last tool refuses before any deletion', () => {
  const f = fixture();
  try {
    fs.renameSync(f.path('/usr/bin/umount'), f.path('/usr/bin/real-umount'));
    fs.mkdirSync(f.path('/usr/bin/umount'));
    let deletions = 0;
    assert.throws(() => removeOptionalRuntimeTools({ ...f.io, unlinkSync() { deletions++; } }), /file identity/);
    assert.equal(deletions, 0);
    for (const name of toolPaths) assert.ok(fs.lstatSync(f.path(name)));
    assert.equal(fs.readFileSync(f.path('/usr/bin/real-umount'), 'utf8'), 'synthetic umount');
  } finally { f.cleanup(); }
});

test('unexpectedly retained last tool fails the build', () => {
  const f = fixture();
  try {
    assert.throws(() => removeOptionalRuntimeTools({ ...f.io, unlinkSync(name) {
      if (name !== '/usr/bin/umount') f.io.unlinkSync(name);
    } }), /tool remains/);
    assert.equal(fs.readFileSync(f.path('/usr/bin/umount'), 'utf8'), 'synthetic umount');
  } finally { f.cleanup(); }
});
