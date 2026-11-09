import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, append } from '../fixtures/legacy-handoff/harness.mjs';

const bytes = readFileSync(new URL('../fixtures/legacy-handoff/compiled-methods.json', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '30941ff7c199739f8f976294295a0a55a530f8c4bd013dda69fd8f90aa6bfc5d');
const record = JSON.parse(bytes);
const moduleBytes = readFileSync(new URL('../fixtures/legacy-handoff/compiled-fragments.mjs', import.meta.url), 'utf8');
for (const fragment of Object.values(record.fragments)) {
  assert.equal(createHash('sha256').update(fragment.compiled_bytes).digest('hex'), fragment.method_sha256);
  assert.equal(fragment.full_file_sha256, record.files[fragment.source]);
  assert.equal(moduleBytes.split(fragment.compiled_bytes).length, 2, 'exact compiled fragment must occur once');
}

test('archived fragments acknowledge and then exit zero with a deferred save', async () => {
  const script = fileURLToPath(new URL('../fixtures/legacy-handoff/exit-child.mjs', import.meta.url));
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-4096); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  let timedOut = false;
  let timer;
  let killWait;
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
        killWait = setTimeout(() => reject(new Error('fixture child did not close')), 2000);
      }, 5000);
    });
  } finally { clearTimeout(timer); clearTimeout(killWait); }
  assert.equal(timedOut, false);
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  const output = JSON.parse(stdout);
  assert.equal(output.receipt, 'entry');
  assert.equal(output.pending, 1);
  assert.equal(output.started, false);
  assert.deepEqual(output.warnings, []);
  assert.deepEqual(output.events, ['transport-close', 'dispose-services', 'memory-cleanup',
    'aql-cleanup', 'aql-cleanup', 'attachment-disposed', 'close-connections', 'http-close']);
});

test('archived pending-map flush misses a timer-started save but waits for a queued one', async () => {
  const active = fixture();
  try {
    await append(active);
    active.fire();
    assert.equal(active.saveStarted, true);
    assert.equal(active.handler.pendingSaves.size, 0);
    await active.handler.flushPendingSaves();
    assert.equal(active.saveFinished, false);
  } finally { active.release(); }
  // Drain the released fake persistence before leaving this case.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active.saveFinished, true);
  const queued = fixture();
  try {
    await append(queued);
    let settled = false;
    const flushing = queued.handler.flushPendingSaves().then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(queued.saveStarted, true);
    assert.equal(settled, false);
    queued.release();
    await flushing;
    assert.equal(queued.saveFinished, true);
  } finally { queued.release(); }
});
