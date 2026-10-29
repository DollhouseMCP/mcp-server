import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bindSource, verifyRuntimeConfig, waitForReady, hardenedRuntimeConfig } from '../../scripts/ci/export-tested-caddy-image.mjs';

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
