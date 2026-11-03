import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const jest = createRequire(import.meta.url).resolve('jest/bin/jest');
const baseArgs = [jest, '--config', 'tests/jest.config.cjs'];
const storage = name => `tests/unit/storage/${name}.test.ts`;
const helper = name => `tests/unit/scripts/${name}.test.ts`;

// These are the complete required Core owner-erasure and serial-storage steps,
// in their existing order. Their whole-file deadlines and internal work remain
// in the tests; only competition between unrelated suites is removed locally.
export const serialGroups = [
  ['owner-erasure-capacity', [storage('FileMemoryOwnedErasureCapacity')]],
  ['erasure-lifecycle', [storage('FileMemoryOwnedErasure')]],
  ['erasure-acceptance', [storage('FileMemoryOwnedErasureAcceptance')]],
  ['erasure-crash', [storage('FileMemoryOwnedErasureCrash')]],
  ['adoption-scan', [storage('FileMemoryAdoptionRecoveryScanBudget'), storage('AdoptionScanSetupOwnership')]],
  ['create', [storage('FileMemoryOwnedCreate')]],
  ['archive-cleanup', [storage('FileMemoryArchiveCleanupCapacity')]],
  ['rename', [storage('FileMemoryOwnedRename')]],
  ['delete', [storage('FileMemoryOwnedDeleteCapacity')]],
  ['hosted-stop', [helper('hostedGracefulStop'), helper('ownedFixtureProcess')]],
  ['stop-polling', [helper('hostedGracefulStopPolling')]],
];
const serialFiles = serialGroups.flatMap(([, files]) => files);
const names = serialFiles.map(file => path.basename(file, '.test.ts'));
export const ordinaryPattern = `^(?!.*(?:^|/)(?:${names.join('|')})[.]test[.]ts$).*`;
const sort = files => [...files].sort();

function unique(files) {
  assert.ok(Array.isArray(files) && files.length > 0, 'Missing or empty test inventory');
  assert.equal(new Set(files).size, files.length, 'Duplicate test file');
  for (const file of files) {
    assert.equal(typeof file, 'string');
    assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..') && /[.](?:test|spec)[.]ts$/u.test(file), 'Invalid unit test path');
  }
  return sort(files);
}

export function checkPartition(inventory, ordinaryShards) {
  const full = unique(inventory);
  assert.equal(ordinaryShards.length, 2, 'Both ordinary shards are required');
  const selected = [...serialFiles, ...ordinaryShards.flatMap(unique)];
  assert.deepEqual(unique(selected), full, 'Serial and ordinary union must equal actual discovery exactly');
}

export function checkCoreSchedule(workflow) {
  const start = workflow.indexOf('\n  owner-erasure-capacity:');
  const end = workflow.indexOf('\n  postgres-', start);
  assert.ok(start >= 0 && end > start, 'Required Core storage jobs are missing');
  const commands = [...workflow.slice(start, end).matchAll(/run: npm test -- --runInBand --runTestsByPath ([^\n]+)/g)]
    .map(match => match[1].trim().split(/\s+/));
  assert.deepEqual(commands, serialGroups.map(([, files]) => files), 'Local serial schedule differs from required Core steps');
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

/** Own every Node/Jest invocation through close, including discovery. */
export class UnitSubprocessOwner {
  interrupted;
  active;
  handlers = new Map();

  constructor() {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        this.interrupted ??= signal;
        // A catchable parent-only signal must not abandon the active child.
        // Completion still awaits close below; cancellation never permits the
        // next group or converts a child's late exit0 into qualification.
        if (this.active && this.active.exitCode === null && this.active.signalCode === null) this.active.kill(signal);
      };
      this.handlers.set(signal, handler); process.on(signal, handler);
    }
  }

  async runNode(args, { capture = false, timeoutMs } = {}) {
    assert.ok(!this.interrupted, 'Unit qualification interrupted; further subprocess admission refused');
    assert.equal(this.active, undefined, 'Prior unit subprocess has not closed');
    const child = spawn(process.execPath, args, { cwd: root, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    this.active = child;
    let stdout = '', stderr = '', failure, bytes = 0, timer;
    const collect = (name, chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { failure ??= new Error('Jest discovery output exceeded its bound'); child.kill('SIGTERM'); return; }
      if (name === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    if (capture) { child.stdout.on('data', chunk => collect('stdout', chunk)); child.stderr.on('data', chunk => collect('stderr', chunk)); }
    if (timeoutMs) timer = setTimeout(() => { failure ??= new Error('Jest discovery exceeded its existing 60s bound'); child.kill('SIGTERM'); }, timeoutMs);
    const result = await new Promise(resolve => {
      child.once('error', error => { failure ??= error; });
      child.once('close', (status, signal) => resolve({ status, signal }));
    });
    clearTimeout(timer); this.active = undefined;
    assert.ok(!this.interrupted, `Unit qualification interrupted by ${this.interrupted}; child closed and further admission refused`);
    if (failure) throw failure;
    return { ...result, stdout, stderr };
  }

  dispose() {
    assert.equal(this.active, undefined, 'Cannot release ownership before subprocess close');
    for (const [signal, handler] of this.handlers) process.removeListener(signal, handler);
  }
}

async function discover(owner, args = []) {
  const result = await owner.runNode([...baseArgs, ...args, '--listTests', '--json'], { capture: true, timeoutMs: 60000 });
  assert.equal(result.signal, null, 'Jest discovery was interrupted');
  assert.equal(result.status, 0, 'Jest discovery failed');
  return unique(JSON.parse(result.stdout).map(relative));
}

export function checkResult(result, expected, exitCode) {
  assert.equal(exitCode, 0, 'Required Jest subprocess failed');
  assert.equal(result.success, true, 'Required final Jest result is not successful');
  assert.equal(result.numFailedTests, 0);
  assert.equal(result.numFailedTestSuites, 0);
  assert.equal(result.numRuntimeErrorTestSuites, 0);
  assert.deepEqual(unique(result.testResults.map(file => relative(file.name))), unique(expected), 'Missing, duplicate or extra suite result');
  let passed = 0, pending = 0, todo = 0;
  for (const file of result.testResults) {
    assert.ok(['passed', 'focused', 'skipped'].includes(file.status), 'Failed suite result');
    assert.ok(file.assertionResults.length > 0, 'Empty suite result');
    for (const test of file.assertionResults) {
      assert.ok(['passed', 'pending', 'todo'].includes(test.status), 'Failed or unknown assertion result');
      if (test.status === 'passed') passed++;
      else if (test.status === 'pending') pending++;
      else todo++;
    }
  }
  assert.equal(result.numPassedTests, passed, 'Passed count differs from assertion evidence');
  assert.equal(result.numPendingTests, pending, 'Pending count differs from assertion evidence');
  assert.equal(result.numTodoTests, todo, 'Todo count differs from assertion evidence');
  assert.equal(result.numTotalTests, passed + pending + todo);
  assert.equal(result.numTotalTestSuites, expected.length);
  return { passed, pending, todo, suites: expected.length };
}

export function explicitJestArgs(args) {
  // Existing targeted/CLI invocations, including every CI serial command, keep
  // their exact Jest arguments. Only argument-free npm test is the full plan.
  return [...baseArgs, ...args];
}

async function execute(owner) {
  const args = process.argv.slice(2);
  if (args.length) {
    const child = await owner.runNode(explicitJestArgs(args));
    assert.equal(child.signal, null, 'Targeted Jest run was interrupted');
    return child.status ?? 1;
  }
  checkCoreSchedule(readFileSync(path.join(root, '.github/workflows/core-build-test.yml'), 'utf8'));
  const inventory = await discover(owner);
  const ordinaryArgs = shard => [`--shard=${shard}/2`, `--testPathPatterns=${ordinaryPattern}`];
  const ordinaryShards = [await discover(owner, ordinaryArgs(1)), await discover(owner, ordinaryArgs(2))];
  checkPartition(inventory, ordinaryShards);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dollhouse-unit-qualification-'));
  const receipt = { context: 'local working tree; bind source separately', node: process.version, platform: process.platform,
    inventory, inventorySha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex'), steps: [] };
  const save = () => writeFileSync(path.join(directory, 'qualification.json'), JSON.stringify(receipt, null, 2) + '\n');
  save();
  console.info(`Complete unit qualification evidence: ${directory}`);
  const groups = [
    ...serialGroups.map(([name, files]) => ({ name, files, args: ['--runInBand', '--runTestsByPath', ...files] })),
    ...ordinaryShards.map((files, index) => ({ name: `ordinary-${index + 1}`, files, args: ordinaryArgs(index + 1) })),
  ];
  for (const group of groups) {
    const report = path.join(directory, `${group.name}.json`);
    const step = { name: group.name, files: group.files, status: 'running', exitCode: null };
    receipt.steps.push(step); save();
    console.info(`Required unit group: ${group.name}`);
    let child;
    try { child = await owner.runNode([...baseArgs, ...group.args, '--json', '--outputFile', report]); }
    catch (error) { step.status = 'interrupted'; step.failure = error.message; save(); throw error; }
    step.exitCode = child.status;
    if (child.signal) {
      step.status = 'interrupted'; save();
      throw new Error(`Jest interrupted by ${child.signal}`);
    }
    try { step.counts = checkResult(JSON.parse(readFileSync(report, 'utf8')), group.files, child.status); step.status = 'passed'; }
    catch (error) { step.status = 'failed'; step.failure = error.message; }
    save();
  }
  assert.equal(receipt.steps.length, groups.length, 'Missing required subprocess');
  assert.ok(receipt.steps.every(step => step.status === 'passed'), `Required unit qualification failed; retained evidence: ${directory}`);
  console.info(`Complete discovered unit inventory qualified: ${inventory.length} files; existing pending cases remain separately counted.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const owner = new UnitSubprocessOwner();
  try { process.exitCode = await execute(owner); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { owner.dispose(); }
}
