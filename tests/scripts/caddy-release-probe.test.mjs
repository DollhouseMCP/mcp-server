import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../scripts/ci/caddy-image-runtime.mjs', import.meta.url), 'utf8');
const embedded = source.match(/const probeSource = String\.raw`\n([\s\S]*?)\n`;/)?.[1];
assert.ok(embedded);
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
