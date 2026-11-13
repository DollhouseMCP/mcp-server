import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import test, { before } from 'node:test';

const source = fs.readFileSync(new URL('../../scripts/ci/caddy-image-runtime.mjs', import.meta.url), 'utf8');
const embedded = source.match(/const probeSource = String\.raw`\n([\s\S]*?)\n`;/)?.[1];
before(() => assert.ok(embedded));
const token = 'a'.repeat(32);

for (const truncated of [false, true]) {
  test(`native probe ${truncated ? 'refuses truncated' : 'accepts complete'} response`, async () => {
    const server = net.createServer(socket => {
      socket.once('data', () => socket.end(`HTTP/1.1 200 OK\r\nX-Dollhouse-Verification: ${token}\r\nContent-Length: ${truncated ? 3 : 0}\r\n\r\n`));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const program = embedded.replace("host:'proxy',port:80", `host:'127.0.0.1',port:${server.address().port}`);
      const child = spawn(process.execPath, ['-e', program, 'allowed', token], {stdio:'ignore'});
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
      assert.equal(code, truncated ? 2 : 0);
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}

test('native probe passes through a hop that drops Content-Length: 0 from a GET', async () => {
  const received = [];
  const server = net.createServer(socket => {
    socket.once('data', data => {
      received.push(String(data));
      socket.end(`HTTP/1.1 200 OK\r\nX-Dollhouse-Verification: ${token}\r\nContent-Length: 0\r\n\r\n`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const program = embedded.replace("net.connect(80,'proxy'); let head", `net.connect(${port},'127.0.0.1'); let head`)
      .replace("host:'proxy',port:80", `host:'127.0.0.1',port:${port}`);
    const run = mode => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', program, mode, token], {stdio:'ignore'});
      child.on('error', reject); child.on('exit', resolve);
    });
    assert.equal(await run('allowed'), 0);
    assert.equal(await run('allowed-hop'), 0);
    assert.equal(received.length, 2);
    assert.match(received[0], /^GET \/healthz HTTP\/1\.1\r\n/);
    assert.match(received[0], /\r\ncontent-length: 0\r\n/i);
    assert.match(received[1], /^GET \/healthz HTTP\/1\.1\r\n/);
    assert.doesNotMatch(received[1], /content-length/i);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
