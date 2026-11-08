import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bindSource, verifyRuntimeConfig, waitForReady, hardenedRuntimeConfig } from '../../scripts/ci/export-tested-caddy-image.mjs';
import { writeNativeCaddyfile } from '../../scripts/ci/caddy-native-render.mjs';
import { clientExecFailure, collectOwnedDiagnostics, observeStream, observeUnsettledExit, observeRequestClose, parseClientOutput } from '../../scripts/ci/caddy-stream-guard.mjs';
import { clientSource } from '../../scripts/ci/caddy-stream-client.mjs';

test('actual client refuses a truncated local HTTP stream', { timeout: 5000 }, async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: start\ndata: partial\n\n');
    setTimeout(() => response.destroy(), 25);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let child;
  try {
    const options = { host:'127.0.0.1', port:server.address().port, path:'/quiet', method:'POST' };
    child = spawn(process.execPath, ['-e', clientSource, JSON.stringify(options)], { stdio:['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 4000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        if (timedOut) reject(new Error('fixture child timed out'));
        else resolve(code);
      });
    });
    assert.equal(status, 1);
    assert.equal(stdout, '');
    const lines = stderr.trim().split('\n');
    assert.equal(lines.length, 1);
    const failure = JSON.parse(lines[0]);
    assert.equal(failure.success, false);
    assert.equal(failure.status, 200);
    assert.equal(failure.protocol, 'http/1.1');
    assert.equal(failure.headers['content-type'], 'text/event-stream');
    assert.equal(failure.receivedBytes, Buffer.byteLength('event: start\ndata: partial\n\n'));
    assert.equal(failure.eventCount, 1);
    assert.ok(failure.elapsedMs >= 0);
    assert.ok(!stderr.includes('partial'));
    assert.ok(['response-aborted', 'response-error', 'response-closed-before-end'].includes(failure.reason));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('stream guard distinguishes completion from aborted, failed and premature closes', () => {
  for (const [events, expected] of [
    [['end', 'close'], []],
    [['aborted', 'close'], ['response-aborted']],
    [['error'], ['response-error']],
    [['close'], ['response-closed-before-end']],
  ]) {
    const stream = new EventEmitter();
    const failures = [];
    observeStream(stream, reason => failures.push(reason));
    for (const event of events) stream.emit(event, ...(event === 'error' ? [new Error('fixture')] : []));
    assert.deepEqual(failures, expected);
  }
});

test('unsettled exit and invalid engine output remain explicit failures', () => {
  for (const settled of [false, true]) {
    const processObject = new EventEmitter();
    const failures = [];
    observeUnsettledExit(processObject, () => settled, reason => failures.push(reason));
    processObject.emit('beforeExit');
    assert.deepEqual(failures, settled ? [] : ['client-exited-before-completion']);
  }
  const options = { method:'POST', h2:false };
  for (const [stdout, phase] of [['', 'engine-empty-output'], ['{', 'engine-invalid-output'], ['[]', 'engine-invalid-output']]) {
    assert.throws(() => parseClientOutput(options, { stdout, stderr:'fixture\u0000error' }, 12), error => {
      const detail = JSON.parse(error.message);
      assert.equal(detail.phase, phase);
      assert.equal(detail.protocol, 'http/1.1');
      assert.equal(detail.method, 'POST');
      assert.equal(detail.stdoutBytes, Buffer.byteLength(stdout));
      assert.equal(detail.stderrTail, 'fixture?error');
      return true;
    });
  }
  assert.deepEqual(parseClientOutput({h2:true}, {stdout:'{"status":200}', stderr:''}, 1), {status:200});
});

test('request close before response is refused without rejecting normal close', () => {
  for (const responded of [false, true]) {
    const request = new EventEmitter();
    const failures = [];
    observeRequestClose(request, () => responded, reason => failures.push(reason));
    request.emit('close');
    assert.deepEqual(failures, responded ? [] : ['request-closed-before-response']);
  }
});

test('native renderer uses its private work directory and propagates failures', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-render-test-'));
  try {
    const file = path.join(work, 'Caddyfile');
    writeNativeCaddyfile(work, file, 'caddy-http', '');
    assert.match(fs.readFileSync(file, 'utf8'), /http:\/\/fixture\.local:80/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    assert.throws(() => writeNativeCaddyfile(path.join(work, 'missing'), file, 'caddy-http', ''));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

const tree = 'a'.repeat(40);
const checkout = 'b'.repeat(40);
const head = 'c'.repeat(40);
const base = 'd'.repeat(40);
const raw = `tree ${tree}\nparent ${base}\nparent ${head}\nauthor fixture\n\nmessage\n`;
test('raw header binding retains both synthetic parents even with a shallow checkout', () => {
  assert.deepEqual(bindSource(raw, checkout, tree, head, 'pull_request').testedCheckoutParents, [base, head]);
});
test('a commit message cannot masquerade as a source-head parent', () => {
  const fake = `tree ${tree}\nparent ${base}\nauthor fixture\n\nparent ${head}\n`;
  assert.throws(() => bindSource(fake, checkout, tree, head, 'pull_request'));
});
test('push head must equal actual tested checkout and malformed parent/tree is refused', () => {
  assert.throws(() => bindSource(raw, checkout, tree, head, 'push'));
  assert.throws(() => bindSource(raw.replace(`parent ${base}`, 'parent invalid'), checkout, tree, head, 'pull_request'));
  assert.throws(() => bindSource(raw, checkout, base, head, 'pull_request'));
  assert.equal(bindSource(raw, checkout, tree, checkout, 'push').sourceHeadSha, checkout);
});
const config = JSON.parse(fs.readFileSync(new URL('../../docker/caddy/approved-runtime-config.json', import.meta.url), 'utf8'));
test('exact inherited runtime config accepts only the engine default-user representation difference', () => {
  verifyRuntimeConfig({ ...config, User:'' }, config);
  assert.throws(() => verifyRuntimeConfig({ ...config, User:'1001' }, config));
});
test('unexpected environment values, duplicate keys, builder command and exposed ports are refused', () => {
  for (const change of [
    { Env:[...config.Env, 'UNEXPECTED=value'] },
    { Env:[...config.Env, config.Env[0]] },
    { Cmd:['go', 'build'] },
    { ExposedPorts:{ ...config.ExposedPorts, '8080/tcp':{} } },
  ]) assert.throws(() => verifyRuntimeConfig({ ...config, ...change }, config));
});

test('hardened profile changes only USER and refuses inherited root execution', () => {
  const expected=hardenedRuntimeConfig(config);
  assert.equal(config.User,null);
  assert.equal(expected.User,'1001:1001');
  assert.deepEqual({ ...expected, User:config.User },config);
  verifyRuntimeConfig(expected,expected);
  assert.throws(() => verifyRuntimeConfig(config,expected));
});

test('startup polling is sequential, admits success once, and never launches after readiness', async () => {
  const events=[];
  let count=0;
  const result=await waitForReady(() => { events.push('request'); return { status:++count===3 ? 200 : 503 }; }, {}, {
    attempts:3, pause:() => { events.push('pause'); return Promise.resolve(); },
  });
  assert.equal(result.status,200);
  assert.deepEqual(events,['request','pause','request','pause','request']);
});

test('failed startup keeps the last actual cause and respects the unchanged attempt limit', async () => {
  let requests=0;
  let pauses=0;
  const failure=new Error('controlled connection failure');
  await assert.rejects(waitForReady(() => { requests++; throw failure; }, {}, {
    pause:() => { pauses++; return Promise.resolve(); },
  }), error => error.cause===failure);
  assert.equal(requests,30);
  assert.equal(pauses,30);
});

const checker = fileURLToPath(new URL('../../docker/caddy/check-build-info.awk', import.meta.url));
const good = '\tdep\tgithub.com/caddyserver/caddy/v2\tv2.11.9\n\t=>\t../caddy-overlay\t(devel)\t\n';
function check(input) {
  const child = spawnSync('awk', ['-f', checker], { input, encoding: 'utf8' });
  assert.equal(child.error, undefined);
  return child.status;
}
test('build identity accepts the exact module and immediately bound replacement', () => {
  assert.equal(check(good), 0);
});
test('build identity refuses missing, duplicate, altered or unbound modules and JOSE v3', () => {
  for (const value of ['', good + good, good.replace('v2.11.9', 'v2.11.7'),
    good.replace('../caddy-overlay', '../other'), good.replace('(devel)', 'v2.11.9'),
    good.replace('\t=>', '\tother'),
    good + '\tdep\tgithub.com/go-jose/go-jose/v3\tv3.0.5\th1:fixture\n',
    good + '\t=>\tgithub.com/go-jose/go-jose/v3\tv3.0.5\n']) {
    assert.equal(check(value), 1);
  }
});


test('diagnostics inspect only exact owned containers and bound failures', () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args[0] === 'inspect') return { status:0, stdout:JSON.stringify({ Running:true, Status:'running', Error:'', Secret:'not retained' }) };
    return { status:0, stdout:'x'.repeat(70000), stderr:'' };
  };
  for (const ids of [[first, first], [first, second, first], ['bad'], [second]]) {
    assert.deepEqual(collectOwnedDiagnostics(ids, [first], run), [{ error:'invalid-owned-diagnostic-targets' }]);
  }
  assert.equal(calls.length, 0);
  const result = collectOwnedDiagnostics([first], [first], run);
  assert.deepEqual(calls, [['inspect', '--format', '{{json .State}}', first], ['logs', '--tail', '80', first]]);
  assert.deepEqual(result[0].state, { Running:true, Status:'running', Error:'' });
  assert.equal(result[0].logs.stdout.length, 65536);
  const failures = collectOwnedDiagnostics([first], [first], args => {
    if (args[0] === 'inspect') return { status:0, stdout:'not JSON' };
    throw new Error('timed out');
  });
  assert.deepEqual(failures, [{ id:first, stateError:'unavailable', logs:{ error:'unavailable' } }]);
});


test('client failure context preserves all bounded framing headers', () => {
  const names = ['content-type', 'content-length', 'transfer-encoding', 'content-encoding', 'connection'];
  const headers = Object.fromEntries(names.map(name => [name, 'a'.repeat(128)]));
  const stderr = JSON.stringify({ success:false, reason:'response-aborted', status:200, protocol:'http/1.1', headers, receivedBytes:7, eventCount:1 });
  const detail = JSON.parse(clientExecFailure({method:'POST'}, {stdout:'', stderr}, 10));
  const context = JSON.parse(detail.stderrTail);
  assert.equal(context.status, 200);
  assert.deepEqual(context.headers, headers);
  assert.ok(!detail.stderrTail.includes('payload-marker'));
});
