import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyVolumes, verifyVolumes, inventorySource, verifyFresh } from '../../scripts/hosted-deploy/caddy_volume_copy.mjs';

function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'caddy-volume-fixture-'));
  const dirs=Object.fromEntries(['sd','sc','td','tc'].map(n=>{ const p=path.join(root,n);fs.mkdirSync(p,{mode:0o700});return [n,p]; }));
  return {root,dirs,source:{data:dirs.sd,config:dirs.sc},target:{data:dirs.td,config:dirs.tc}};
}
test('copies and verifies every byte and mode, including certificates, while retaining source', () => {
  const f=fixture();try {
    fs.mkdirSync(path.join(f.dirs.sd,'certs'),{mode:0o700});
    fs.writeFileSync(path.join(f.dirs.sd,'certs','site.crt'),'fixture certificate',{mode:0o600});
    fs.writeFileSync(path.join(f.dirs.sc,'config.json'),'configuration',{mode:0o640});
    const result=copyVolumes(f.source,f.target,process.getuid(),process.getgid());
    assert.equal(result.entries,3); assert.equal(result.certificate_sha256.length,1);
    assert.equal(fs.readFileSync(path.join(f.dirs.td,'certs','site.crt'),'utf8'),'fixture certificate');
    assert.equal(fs.readFileSync(path.join(f.dirs.sd,'certs','site.crt'),'utf8'),'fixture certificate');
    assert.equal(fs.statSync(path.join(f.dirs.tc,'config.json')).mode & 0o777,0o640);
  } finally { fs.rmSync(f.root,{recursive:true,force:true}); }
});

test('rechecks copied contents and root modes without mutation', () => {
  const f = fixture();
  try {
    const cert = path.join(f.dirs.sd, 'site.crt');
    fs.writeFileSync(cert, 'original', { mode: 0o600 });
    const expected = copyVolumes(f.source, f.target, process.getuid(), process.getgid());
    assert.deepEqual(verifyVolumes(f.source, f.target, process.getuid(), process.getgid()), expected);
    assert.deepEqual(inventorySource(f.source), expected);
    fs.writeFileSync(path.join(f.dirs.td, 'site.crt'), 'changed');
    assert.throws(() => verifyVolumes(f.source, f.target, process.getuid(), process.getgid()));
    assert.equal(fs.readFileSync(cert, 'utf8'), 'original');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('fresh volumes have the qualified empty image layout', () => {
  const f = fixture();
  try {
    for (const root of [f.dirs.td, f.dirs.tc]) {
      fs.chmodSync(root, 0o750);
      fs.mkdirSync(path.join(root, 'caddy'), { mode: 0o750 });
    }
    assert.equal(verifyFresh(f.target, process.getuid(), process.getgid()).schema, 'caddy-fresh-volumes-v1');
    fs.writeFileSync(path.join(f.dirs.td, 'caddy', 'unexpected'), 'x');
    assert.throws(() => verifyFresh(f.target, process.getuid(), process.getgid()));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test('refuses symlinks, hardlinks, nonempty destinations and unsafe source modes', () => {
  for (const kind of ['symlink','hardlink','occupied','unreadable']) {
    const f=fixture();try {
      if(kind==='symlink') fs.symlinkSync('/tmp',path.join(f.dirs.sd,'link'));
      if(kind==='hardlink') { fs.writeFileSync(path.join(f.dirs.sd,'file'),'x');fs.linkSync(path.join(f.dirs.sd,'file'),path.join(f.dirs.sd,'alias')); }
      if(kind==='occupied') fs.writeFileSync(path.join(f.dirs.td,'existing'),'x');
      if(kind==='unreadable') fs.writeFileSync(path.join(f.dirs.sd,'file'),'x',{mode:0o000});
      assert.throws(()=>copyVolumes(f.source,f.target,process.getuid(),process.getgid()));
    } finally { fs.rmSync(f.root,{recursive:true,force:true}); }
  }
});

test('refuses aliased roots before changing any original, including empty and cross aliases', () => {
  for (const cross of [false,true]) {
    const f=fixture();try {
      fs.writeFileSync(path.join(f.dirs.sc,'sentinel'),'unchanged',{mode:0o600});
      const before=fs.statSync(f.dirs.sd);
      const target=cross ? {data:f.dirs.sc,config:f.dirs.td} : {data:f.dirs.sd,config:f.dirs.tc};
      assert.throws(()=>copyVolumes(f.source,target,process.getuid(),process.getgid()),/distinct/);
      assert.equal(fs.readFileSync(path.join(f.dirs.sc,'sentinel'),'utf8'),'unchanged');
      const after=fs.statSync(f.dirs.sd);
      assert.equal(after.mode,before.mode);assert.equal(after.uid,before.uid);assert.equal(after.gid,before.gid);
    } finally { fs.rmSync(f.root,{recursive:true,force:true}); }
  }
});
test('refuses directories without owner read, write and search permission', () => {
  for (const nested of [false,true]) {
    const f=fixture();try {
      const dir=nested ? path.join(f.dirs.sd,'nested') : f.dirs.sd;
      if(nested) fs.mkdirSync(dir,{mode:0o700});
      fs.chmodSync(dir,0o500);
      assert.throws(()=>copyVolumes(f.source,f.target,process.getuid(),process.getgid()),/directory/);
      fs.chmodSync(dir,0o700);
    } finally { fs.rmSync(f.root,{recursive:true,force:true}); }
  }
});

// Synthetic ownership for portable unit tests; rootful native CI creates the
// actual root-owned legacy layout and runs the unmocked helper on both arches.
function legacyFixture() {
  const f = fixture();
  const sticky = ['sd', 'sc'].map(key => path.join(f.dirs[key], 'caddy'));
  for (const dir of sticky) {
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o1777);
    fs.writeFileSync(path.join(dir, 'site.crt'), 'disposable certificate', { mode: 0o600 });
  }
  const lstat = fs.lstatSync;
  const patch = mock.method(fs, 'lstatSync', (location, ...args) => {
    const st = lstat(location, ...args);
    if (sticky.includes(location)) Object.defineProperties(st, { uid: { value: 0 }, gid: { value: 0 } });
    return st;
  });
  return { ...f, sticky, restore: () => patch.mock.restore() };
}

test('legacy exact sticky dirs retain raw evidence and copy only to hardened modes', () => {
  const f = legacyFixture();
  try {
    const source = inventorySource(f.source);
    assert.deepEqual(source.legacy_directory_modes, { 'data/caddy': 0o1777, 'config/caddy': 0o1777 });
    const copied = copyVolumes(f.source, f.target, process.getuid(), process.getgid());
    assert.deepEqual(copied, source);
    assert.deepEqual(verifyVolumes(f.source, f.target, process.getuid(), process.getgid()), source);
    for (const key of ['sd', 'sc']) assert.equal(fs.statSync(path.join(f.dirs[key], 'caddy')).mode & 0o7777, 0o1777);
    for (const key of ['td', 'tc']) assert.equal(fs.statSync(path.join(f.dirs[key], 'caddy')).mode & 0o7777, 0o750);
    fs.chmodSync(path.join(f.dirs.td, 'caddy'), 0o1777);
    assert.throws(() => verifyVolumes(f.source, f.target, process.getuid(), process.getgid()), /directory/);
  } finally { f.restore(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('legacy compatibility refuses every other unsafe mode and nested sticky directory', () => {
  for (const mode of [0o777, 0o1775, 0o3777, 0o1770, 0o775]) {
    const f = legacyFixture();
    try {
      fs.chmodSync(f.sticky[0], mode);
      assert.throws(() => inventorySource(f.source), /directory/);
      assert.throws(() => copyVolumes(f.source, f.target, process.getuid(), process.getgid()), /directory/);
    } finally { f.restore(); fs.rmSync(f.root, { recursive: true, force: true }); }
  }
  const f = legacyFixture();
  try {
    fs.mkdirSync(path.join(f.sticky[0], 'nested'), { mode: 0o700 });
    fs.chmodSync(path.join(f.sticky[0], 'nested'), 0o1777);
    assert.throws(() => inventorySource(f.source), /directory/);
  } finally { f.restore(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('sticky exception rejects non-root ownership, volume roots and alternate paths', () => {
  for (const location of ['owner', 'group', 'root', 'other']) {
    const f = fixture();
    const dir = location === 'root' ? f.dirs.sd : path.join(f.dirs.sd, location === 'other' ? 'other' : 'caddy');
    if (location !== 'root') fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o1777);
    const lstat = fs.lstatSync;
    const patch = mock.method(fs, 'lstatSync', (file, ...args) => {
      const st = lstat(file, ...args);
      if (file === dir) Object.defineProperties(st, {
        uid: { value: location === 'owner' ? 1 : 0 }, gid: { value: location === 'group' ? 1 : 0 },
      });
      return st;
    });
    try { assert.throws(() => inventorySource(f.source), /directory/); }
    finally { patch.mock.restore(); fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});
