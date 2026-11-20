import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { upstreamSource } from '../../scripts/ci/caddy-stream-upstream.mjs';

const body = '{"jsonrpc":"2.0","id":1,"method":"qualification"}';
const marker = ".listen(8081,'0.0.0.0');";

test('actual producer waits for a valid complete POST and refuses invalid or aborted bodies', { timeout: 8000 }, async () => {
  assert.equal(Buffer.byteLength(body), 49);
  assert.equal(upstreamSource.split(marker).length, 2);
  const source = upstreamSource.replace(marker, ".listen(0,'127.0.0.1',function(){console.error('FIXTURE_PORT='+this.address().port);});");
  const child = spawn(process.execPath, ['-e', source], { stdio:['ignore','pipe','pipe'] });
  let output = '';
  let errors = '';
  const close = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  let deadlineTimer;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error('producer test deadline exceeded')), 6000);
  });
  // This promise may reject while the fixture is performing synchronous setup.
  deadline.catch(() => {});
  const bounded = promise => Promise.race([promise, deadline]);
  const sockets = new Set();
  function request(length, method='POST', contentType='application/json') {
    const req = http.request({ host:'127.0.0.1', port, path:'/quiet', method,
      headers:{ 'content-type':contentType, 'content-length':String(length) } });
    req.on('socket', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    return req;
  }
  async function waitFor(predicate) {
    for (let i=0; i<100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(predicate(), 'fixture event was not observed before deadline');
  }
  let port;
  try {
    await bounded(waitFor(() => /FIXTURE_PORT=\d+/.test(errors)));
    port = Number(errors.match(/FIXTURE_PORT=(\d+)/)[1]);
    const req = request(Buffer.byteLength(body));
    const response = new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
    req.write(body.slice(0, 10));
    const early = await bounded(Promise.race([response.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 150))]));
    assert.equal(early, false, 'producer sent a response before the request ended');
    assert.ok(!output.includes('request-end'));
    req.end(body.slice(10));
    const res = await bounded(response);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream');
    const first = await bounded(new Promise((resolve, reject) => {
      let received = '';
      res.on('data', chunk => {
        received += chunk.toString();
        if (Buffer.byteLength(received) > 2048) reject(new Error('fixture event exceeded limit'));
        else if (received.includes('\n\n')) resolve(received);
      });
      res.once('error', reject);
      res.once('end', () => reject(new Error('fixture ended before the first event')));
    }));
    assert.match(first, /event: start\ndata: method=POST/);
    res.destroy();
    await bounded(waitFor(() => output.includes('response-close')));

    for (const [payload, expected, method, contentType] of [['x'.repeat(49), 400, 'POST', 'application/json'], ['x'.repeat(50), 413, 'POST', 'application/json'], [body, 400, 'GET', 'application/json'], [body, 400, 'POST', 'text/plain']]) {
      const invalid = request(Buffer.byteLength(payload), method, contentType);
      const received = new Promise((resolve, reject) => { invalid.once('response', resolve); invalid.once('error', reject); });
      invalid.end(payload);
      const rejected = await bounded(received);
      assert.equal(rejected.statusCode, expected);
      assert.notEqual(rejected.headers['content-type'], 'text/event-stream');
      const complete = new Promise(resolve => rejected.once('end', resolve));
      rejected.resume();
      await bounded(complete);
    }

    const abortCount = (output.match(/request-aborted/g) ?? []).length;
    const aborted = request(Buffer.byteLength(body));
    let abortedResponse = false;
    aborted.on('response', response => { abortedResponse = true; response.destroy(); });
    aborted.on('error', () => {});
    aborted.write(body.slice(0, 10));
    await bounded(new Promise(resolve => setTimeout(resolve, 50)));
    aborted.destroy();
    await bounded(waitFor(() => (output.match(/request-aborted/g) ?? []).length > abortCount));
    assert.equal(abortedResponse, false);
    assert.ok(!output.includes(body), 'fixture diagnostics leaked the request body');
  } finally {
    for (const socket of sockets) socket.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    clearTimeout(deadlineTimer);
    let closeTimer;
    try {
      await Promise.race([close, new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('fixture child failed to close')), 1000); })]);
    } finally { clearTimeout(closeTimer); }
  }
});
