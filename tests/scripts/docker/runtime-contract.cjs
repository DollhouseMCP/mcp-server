'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { createRequire } = require('node:module');

function readDebianInventory(inventoryRoot) {
  const entries = fs.readdirSync(inventoryRoot, { withFileTypes: true });
  assert.ok(entries.length > 0 && entries.length <= 512, 'Debian inventory file count');
  let inventoryBytes = 0;
  let md5sumFileCount = 0;
  const packages = [];
  for (const entry of entries) {
    assert.ok(entry.isFile() && /^[A-Za-z0-9.+_-]+$/.test(entry.name), 'Invalid Debian inventory entry');
    const path = `${inventoryRoot}/${entry.name}`;
    const stat = fs.lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, 'Invalid Debian inventory file');
    inventoryBytes += stat.size;
    assert.ok(inventoryBytes <= 8 * 1024 * 1024, 'Debian inventory exceeds byte limit');
    if (entry.name.endsWith('.md5sums')) { md5sumFileCount++; continue; }
    const text = fs.readFileSync(path, 'utf8');
    const field = (name) => {
      const matches = [...text.matchAll(new RegExp(`^${name}: ([^\\r\\n]+)$`, 'gm'))];
      assert.equal(matches.length, 1, `Invalid Debian ${name} field`);
      const value = matches[0][1];
      assert.match(value, /^[A-Za-z0-9.+:~_-]{1,256}$/);
      return value;
    };
    packages.push({ package: field('Package'), version: field('Version'), architecture: field('Architecture') });
  }
  assert.ok(packages.length > 0, 'Debian inventory has no package records');
  return { fileCount: entries.length, md5sumFileCount, packages };

}

async function main() {
  assert.equal(process.version, 'v24.22.2');
  assert.equal(process.getuid(), 1001);
  assert.equal(process.getgid(), 1001);
  const user = os.userInfo();
  assert.equal(user.username, 'dollhouse');
  assert.equal(user.uid, 1001);
  assert.equal(user.gid, 1001);
  assert.equal(user.homedir, '/home/dollhouse');
  assert.equal(process.cwd(), '/app');
  assert.equal(process.env.HOME, '/home/dollhouse');
  assert.equal(process.env.SSL_CERT_FILE, '/etc/ssl/certs/ca-certificates.crt');
  assert.ok(fs.statSync(process.env.SSL_CERT_FILE).isFile());
  const paths = ['/app/tmp', '/app/logs', '/app/.memory-upgrade-control', '/home/dollhouse'];
  const directories = paths.map((path) => {
    try {
      const stat = fs.lstatSync(path);
      return { path, directory: stat.isDirectory(), symlink: stat.isSymbolicLink(),
        uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777, nlink: stat.nlink };
    } catch (error) {
      return { path, error: typeof error.code === 'string' ? error.code : 'UNKNOWN' };
    }
  });
  console.log(JSON.stringify({ privateDirectories: directories }));
  for (const item of directories) {
    assert.equal(item.error, undefined, `${item.path} lstat`);
    assert.equal(item.directory, true, `${item.path} must be a directory`);
    assert.equal(item.symlink, false, `${item.path} must not be a symlink`);
    assert.equal(item.uid, 1001, `${item.path} owner`);
    assert.equal(item.gid, 1001, `${item.path} group`);
    assert.equal(item.mode, 0o700, `${item.path} mode`);
  }
  console.log(JSON.stringify({ debianInventory: readDebianInventory('/var/lib/dpkg/status.d') }));
  for (const path of ['/bin/sh', '/usr/bin/curl', '/usr/bin/apt-get', '/usr/bin/dpkg', '/usr/local/bin/npm', '/nodejs/bin/npm']) {
    assert.equal(fs.existsSync(path), false, `Unexpected runtime tool: ${path}`);
  }
  const argon2 = createRequire('/app/package.json')('argon2');
  const hash = await argon2.hash('owned-runtime-fixture');
  assert.equal(await argon2.verify(hash, 'owned-runtime-fixture'), true);
  assert.equal(await argon2.verify(hash, 'different-owned-runtime-fixture'), false);
  const report = process.report.getReport();
  const sharedObjects = report.sharedObjects;
  assert.ok(Array.isArray(sharedObjects) && sharedObjects.length <= 256);
  assert.ok(sharedObjects.every((item) => typeof item === 'string' && item.length <= 512));
  const boundedHeader = (value) => {
    assert.ok(value === undefined || (typeof value === 'string' && value.length <= 128));
    return value ?? null;
  };
  console.log(JSON.stringify({
    node: process.versions.node,
    zlib: process.versions.zlib,
    sqlite: process.versions.sqlite ?? null,
    openssl: process.versions.openssl,
    napi: process.versions.napi,
    arch: process.arch,
    platform: process.platform,
    glibcVersionRuntime: boundedHeader(report.header.glibcVersionRuntime),
    glibcVersionCompiler: boundedHeader(report.header.glibcVersionCompiler),
    sharedObjects,
  }));
  console.log('Shell-free runtime, ownership and native Argon2 verified');
}

module.exports = { readDebianInventory };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
