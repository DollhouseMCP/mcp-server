'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
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
      const matches = [...text.matchAll(new RegExp(String.raw`^${name}: ([^\r\n]+)$`, 'gm'))];
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
  const paths = ['/app', '/app/dist', '/app/tmp', '/app/logs', '/app/.memory-upgrade-control', '/home/dollhouse'];
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
    const expectedMode = item.path === '/app' || item.path === '/app/dist' ? 0o750 : 0o700;
    assert.equal(item.mode, expectedMode, `${item.path} mode`);
  }
  const index = fs.lstatSync('/app/dist/index.js');
  assert.ok(index.isFile() && !index.isSymbolicLink(), '/app/dist/index.js must be a regular file');
  const debianInventory = readDebianInventory('/var/lib/dpkg/status.d');
  const zlibRecords = debianInventory.packages.filter((item) => item.package === 'zlib1g');
  assert.equal(zlibRecords.length, 1, 'Expected one zlib1g record');
  assert.equal(zlibRecords[0].version, '1:1.3.dfsg+really1.3.1-1+deb13u1');
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  assert.ok(arch === 'amd64' || arch === 'arm64');
  assert.equal(zlibRecords[0].architecture, arch);
  const receiptPath = '/app/.zlib-runtime-receipt.json';
  const receiptStat = fs.lstatSync(receiptPath);
  assert.ok(receiptStat.isFile() && !receiptStat.isSymbolicLink() && receiptStat.size <= 64 * 1024,
    'Invalid zlib receipt');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const expectedDeb = {
    amd64: '8c27c342230503b73dfde629642c3b352e87b554e06d60cf58772f236a305ceb',
    arm64: '0e41b3d7ad8ad7fcd36dd4d61ca91a70018478fc4af652e044f4be770784ddff',
  };
  assert.equal(receipt.package, 'zlib1g');
  assert.equal(receipt.version, zlibRecords[0].version);
  assert.equal(receipt.architecture, arch);
  assert.equal(receipt.debSha256, expectedDeb[arch]);
  const triplet = arch === 'amd64' ? 'x86_64-linux-gnu' : 'aarch64-linux-gnu';
  const library = `/usr/lib/${triplet}/libz.so.1`;
  assert.equal(fs.readlinkSync(library), 'libz.so.1.3.1');
  const libraryStat = fs.statSync(library);
  assert.ok(libraryStat.isFile() && libraryStat.size <= 16 * 1024 * 1024, 'Invalid zlib library');
  const libraryBytes = fs.readFileSync(library);
  assert.equal(libraryBytes.length, libraryStat.size);
  assert.equal(createHash('sha256').update(libraryBytes).digest('hex'), receipt.librarySha256);
  console.log(JSON.stringify({ debianInventory, zlibRuntime: receipt }));
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
