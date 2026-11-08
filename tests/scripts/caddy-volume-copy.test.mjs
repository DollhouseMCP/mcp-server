import { test } from 'node:test';
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
