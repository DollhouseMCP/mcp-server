import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const contracts = fileURLToPath(new URL('../../docker/caddy/', import.meta.url));
const helper = path.join(contracts, 'prepare-runtime.sh');
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
  write('bin/busybox', 'must stay in the Alpine stage');
  write('usr/bin/wget', 'must stay in the Alpine stage');
  const output = path.join(root, 'output');
  return {
    root, write, output,
    run: () => spawnSync('sh', [helper, root, contracts, output], { encoding: 'utf8' }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('stage the exact Caddy assets and configuration without Alpine utilities', () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const files = fs.readdirSync(f.output, { recursive: true, withFileTypes: true })
      .filter(entry => !entry.isDirectory())
      .map(entry => path.relative(f.output, path.join(entry.parentPath ?? entry.path, entry.name)))
      .sort();
    assert.deepEqual(files, [...assets, 'etc/passwd', 'etc/group'].sort());
    for (const name of assets) {
      assert.deepEqual(fs.readFileSync(path.join(f.output, name)), fs.readFileSync(path.join(f.root, name)));
    }
    assert.match(fs.readFileSync(path.join(f.output, 'etc/passwd'), 'utf8'), /^caddy:x:1001:1001:/m);
    assert.equal(fs.statSync(path.join(f.output, 'data/caddy')).mode & 0o777, 0o750);
    assert.equal(fs.statSync(path.join(f.output, 'config/caddy')).mode & 0o777, 0o750);
  } finally { f.cleanup(); }
});

for (const name of ['unknown baseline version', 'unexpected world root', 'symlink package database', 'symlink asset']) {
  test(`${name} refuses before staging files`, () => {
    const f = fixture();
    try {
      if (name === 'unknown baseline version') {
        f.write('lib/apk/db/installed', installed(lines('approved-packages.txt').map(x => x.startsWith('curl=') ? 'curl=99.0.0-r0' : x)));
      }
      if (name === 'unexpected world root') fs.appendFileSync(path.join(f.root, 'etc/apk/world'), 'unexpected\n');
      if (name === 'symlink package database') {
        fs.renameSync(path.join(f.root, 'lib/apk/db/installed'), path.join(f.root, 'original-db'));
        fs.symlinkSync(path.join(f.root, 'original-db'), path.join(f.root, 'lib/apk/db/installed'));
      }
      if (name === 'symlink asset') {
        fs.rmSync(path.join(f.root, assets[0]));
        fs.symlinkSync(path.join(f.root, assets[1]), path.join(f.root, assets[0]));
      }
      assert.notEqual(f.run().status, 0);
      assert.equal(fs.existsSync(f.output), false);
    } finally { f.cleanup(); }
  });
}
