import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const contracts = fileURLToPath(new URL('../../docker/caddy/', import.meta.url));
const helper = path.join(contracts, 'remove-curl.sh');
const assets = ['etc/ssl/certs/ca-certificates.crt', 'etc/mime.types', 'etc/caddy/Caddyfile', 'usr/share/caddy/index.html'];
const lines = name => fs.readFileSync(path.join(contracts, name), 'utf8').trim().split('\n');
const installed = packages => packages.map(line => {
  const [name, version] = line.split('=');
  return `P:${name}\nV:${version}\nA:synthetic\n`;
}).join('\n');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-packages-'));
  const write = (name, data, mode = 0o644) => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { mode });
  };
  write('lib/apk/db/installed', installed(lines('approved-packages.txt')));
  write('etc/apk/world', lines('approved-world.txt').join('\n') + '\n');
  write('usr/bin/curl', 'synthetic removed command');
  for (const name of assets) write(name, `retained ${name}\n`);
  write('next-installed', installed(lines('runtime-packages.txt')));
  write('next-world', lines('runtime-world.txt').join('\n') + '\n');
  write('sbin/apk', '#!/bin/sh\nset -eu\n[ "$1" = --root ]\nr=$2\nshift 2\n[ "$*" = "--no-network del curl" ]\nprintf invoked > "$r/apk-invoked"\ncp "$r/next-installed" "$r/lib/apk/db/installed"\ncp "$r/next-world" "$r/etc/apk/world"\nrm "$r/usr/bin/curl"\n', 0o755);
  return { root, write, run: () => spawnSync('sh', [helper, root, contracts], { encoding: 'utf8' }), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('exact offline nine-package removal preserves ssl_client and protected data', () => {
  const f = fixture();
  try {
    const before = new Map(assets.map(name => [name, fs.readFileSync(path.join(f.root, name))]));
    const result = f.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(fs.readFileSync(path.join(f.root, 'lib/apk/db/installed'), 'utf8'), /P:ssl_client\nV:1.37.0-r30/);
    for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(f.root, name)), bytes);
  } finally { f.cleanup(); }
});

for (const name of ['unknown baseline version', 'unexpected world root', 'symlink package database']) {
  test(`${name} refuses before invoking APK`, () => {
    const f = fixture();
    try {
      if (name === 'unknown baseline version') f.write('lib/apk/db/installed', installed(lines('approved-packages.txt').map(x => x.startsWith('curl=') ? 'curl=99.0.0-r0' : x)));
      if (name === 'unexpected world root') fs.appendFileSync(path.join(f.root, 'etc/apk/world'), 'unexpected\n');
      if (name === 'symlink package database') {
        fs.renameSync(path.join(f.root, 'lib/apk/db/installed'), path.join(f.root, 'original-db'));
        fs.symlinkSync(path.join(f.root, 'original-db'), path.join(f.root, 'lib/apk/db/installed'));
      }
      assert.notEqual(f.run().status, 0);
      assert.equal(fs.existsSync(path.join(f.root, 'apk-invoked')), false);
      assert.equal(fs.readFileSync(path.join(f.root, 'usr/bin/curl'), 'utf8'), 'synthetic removed command');
    } finally { f.cleanup(); }
  });
}

for (const name of ['drops ssl_client', 'upgrades retained package', 'leaves curl installed', 'leaves curl executable', 'changes world root', 'changes CA data', 'APK fails']) {
  test(`${name} cannot produce a qualified result`, () => {
    const f = fixture();
    try {
      if (name === 'drops ssl_client') f.write('next-installed', installed(lines('runtime-packages.txt').filter(x => !x.startsWith('ssl_client='))));
      if (name === 'upgrades retained package') f.write('next-installed', installed(lines('runtime-packages.txt').map(x => x.startsWith('musl=') ? 'musl=99.0.0-r0' : x)));
      if (name === 'leaves curl installed') f.write('next-installed', installed([...lines('runtime-packages.txt'), 'curl=8.22.0-r0']));
      if (name === 'leaves curl executable') f.write('sbin/apk', fs.readFileSync(path.join(f.root, 'sbin/apk'), 'utf8').replace('rm "$r/usr/bin/curl"', ': # intentionally retain executable'), 0o755);
      if (name === 'changes world root') fs.appendFileSync(path.join(f.root, 'next-world'), 'unexpected\n');
      if (name === 'changes CA data') fs.appendFileSync(path.join(f.root, 'sbin/apk'), 'printf changed > "$r/etc/ssl/certs/ca-certificates.crt"\n');
      if (name === 'APK fails') f.write('sbin/apk', '#!/bin/sh\nexit 23\n', 0o755);
      assert.notEqual(f.run().status, 0);
      if (name !== 'APK fails') assert.equal(fs.readFileSync(path.join(f.root, 'apk-invoked'), 'utf8'), 'invoked');
    } finally { f.cleanup(); }
  });
}
