'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const argon2 = require('/app/node_modules/argon2');

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
  assert.ok(fs.readdirSync('/var/lib/dpkg/status.d').length > 0, 'Debian package inventory must remain available');
  for (const path of ['/app/tmp', '/app/logs', '/app/.memory-upgrade-control', '/home/dollhouse']) {
    const stat = fs.statSync(path);
    assert.ok(stat.isDirectory());
    assert.equal(stat.uid, 1001);
    assert.equal(stat.gid, 1001);
    assert.equal(stat.mode & 0o777, 0o700);
  }
  for (const path of ['/bin/sh', '/usr/bin/curl', '/usr/bin/apt-get', '/usr/bin/dpkg', '/usr/local/bin/npm', '/nodejs/bin/npm']) {
    assert.equal(fs.existsSync(path), false, `Unexpected runtime tool: ${path}`);
  }
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

main().catch((error) => { console.error(error); process.exitCode = 1; });
