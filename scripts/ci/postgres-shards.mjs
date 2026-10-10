import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
// setup-node's qualified installation supplies Node and npm together. Avoid PATH lookup.
const npmCli = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const compare = (a, b) => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const read = file => JSON.parse(readFileSync(file, 'utf8'));

function identity() {
  const result = {
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    checkout: process.env.GITHUB_SHA,
    source: process.env.PG_SOURCE_HEAD,
  };
  for (const value of Object.values(result)) assert.ok(value, 'Missing workflow identity');
  assert.equal(spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), result.checkout);
  return result;
}

function relative(file) {
  const name = path.relative(root, file).split(path.sep).join('/');
  assert.ok(name.startsWith('tests/integration/') && !name.includes('../'), 'File outside integration tree');
  return name;
}

function unique(files) {
  assert.ok(Array.isArray(files) && files.length > 0, 'Empty or absent inventory');
  assert.equal(new Set(files).size, files.length, 'Duplicate inventory entry');
  for (const file of files) assert.ok(typeof file === 'string' && file.startsWith('tests/integration/') && !file.includes('..'));
  return [...files].sort(compare);
}

export function checkPartition(inventory, shards) {
  const full = unique(inventory);
  assert.equal(shards.length, 2, 'Exactly two shards required');
  const union = unique(shards.flatMap(unique));
  assert.deepEqual(union, full, 'Shard union must equal complete discovered inventory');
}

function discover(shard) {
  // Native Jest discovery and native default-sequencer partition; never a static filename list.
  const args = ['--silent', 'run', 'test:integration', '--', '--runInBand', '--listTests', '--json'];
  if (shard) args.push(`--shard=${shard}/2`);
  assert.ok(existsSync(npmCli), 'Qualified Node installation must include its npm CLI');
  const result = spawnSync(process.execPath, [npmCli, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, 'Native Jest discovery failed');
  return unique(JSON.parse(result.stdout).map(relative));
}

function checkFile(f) {
  // Preserve intentional existing pending cases/suites; never report them as executed passes.
  assert.ok(['passed', 'focused', 'skipped'].includes(f.status), 'Failed or absent file result');
  assert.equal(f.failed, 0);
  for (const value of [f.passed, f.failed, f.pending, f.todo]) assert.ok(Number.isInteger(value) && value >= 0);
  assert.ok(f.passed + f.pending + f.todo > 0, 'Empty suite evidence');
  // Jest's JSON reporter uses focused for successful files containing skipped cases.
  if (f.status === 'passed') assert.equal(f.pending, 0);
  if (f.status === 'focused') {
    assert.ok(f.pending > 0);
    assert.ok(f.passed + f.todo > 0);
  }
  if (f.status === 'skipped') {
    assert.equal(f.passed, 0);
    assert.equal(f.todo, 0);
  }
}

export function checkEvidence(evidence, expected) {
  assert.equal(evidence.length, 2, 'Both shard artifacts required');
  assert.deepEqual(evidence.map(e => e.shard).sort((a, b) => a - b), [1, 2]);
  assert.equal(new Set(evidence.map(e => e.service)).size, 2, 'Independent services required');
  for (const e of evidence) {
    assert.match(e.service, /^[a-f0-9]{12,64}$/);
    assert.deepEqual(e.identity, expected, 'Artifact provenance differs from this checkout/run/attempt/source');
    assert.equal(e.shardCount, 2);
    checkPartition(e.inventory, e.partitions);
    assert.equal(e.inventoryDigest, digest(unique(e.inventory)));
    assert.deepEqual(e.selected, e.partitions[e.shard - 1]);
    assert.equal(e.exitCode, 0, 'Jest process must finish successfully');
    assert.equal(e.finalSuite.success, true, 'Missing or failed final Jest result');
    assert.equal(e.finalSuite.failedSuites, 0);
    assert.equal(e.finalSuite.failedTests, 0);
    assert.ok(e.finalSuite.passedTests > 0);
    assert.equal(e.finalSuite.totalSuites, e.selected.length);
    assert.equal(e.files.length, e.selected.length);
    assert.deepEqual(unique(e.files.map(f => f.file)), e.selected, 'Missing, duplicate or extra file result');
    for (const f of e.files) checkFile(f);
    assert.equal(e.finalSuite.passedSuites, e.files.filter(f => f.status === 'passed' || f.status === 'focused').length);
    assert.equal(e.finalSuite.pendingSuites, e.files.filter(f => f.status === 'skipped').length);
    assert.equal(e.finalSuite.totalSuites, e.finalSuite.passedSuites + e.finalSuite.pendingSuites);
    for (const [total, field] of [['passedTests', 'passed'], ['pendingTests', 'pending'], ['todoTests', 'todo']]) {
      assert.equal(e.finalSuite[total], e.files.reduce((sum, f) => sum + f[field], 0), 'Final test counts differ from file evidence');
    }
    for (const field of ['directoryMarker', 'databaseMarker', 'teardownMarker', 'directoryAbsent', 'databaseAbsent', 'serviceRemoved']) {
      assert.equal(e.cleanup[field], true, `Missing positive cleanup: ${field}`);
    }
  }
  assert.deepEqual(evidence[0].inventory, evidence[1].inventory, 'Shard discoveries disagree');
  assert.deepEqual(evidence[0].partitions, evidence[1].partitions, 'Native partitions disagree');
  checkPartition(evidence[0].inventory, evidence.map(e => e.selected));
}

async function databaseAbsent() {
  const { default: postgres } = await import('postgres');
  const sql = postgres('postgres://dollhouse@localhost:5432/postgres', { max: 1, connect_timeout: 5 });
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Database absence verification deadline')), 8000);
    });
    const rows = await Promise.race([
      sql`SELECT datname FROM pg_database WHERE datname = 'dollhousemcp_test'`, deadline,
    ]);
    return rows.length === 0;
  } finally {
    clearTimeout(timer);
    // end's timeout rejects pending queries and destroys the connection before returning.
    await sql.end({ timeout: 2 });
  }
}

async function run(shard, directory) {
  assert.ok(process.env.GITHUB_ACTIONS === 'true', 'Execute only on the declared isolated hosted job');
  assert.ok(shard === 1 || shard === 2);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'evidence.json');
  const inventory = discover();
  const partitions = [discover(1), discover(2)];
  checkPartition(inventory, partitions);
  const evidence = {
    identity: identity(), shard, shardCount: 2, service: process.env.PG_CONTAINER_ID, inventory, partitions,
    inventoryDigest: digest(inventory), selected: partitions[shard - 1],
    exitCode: null, finalSuite: null, files: [], cleanup: {},
  };
  save(file, evidence);
  const resultPath = path.join(directory, 'jest-result.json');
  const args = ['run', 'test:integration', '--', '--runInBand', '--runTestsByPath', ...evidence.selected, '--json', '--outputFile', resultPath];
  assert.ok(existsSync(npmCli), 'Qualified Node installation must include its npm CLI');
  const child = spawn(process.execPath, [npmCli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const output = (stream, chunk) => {
    stream.write(chunk);
    tail = (tail + chunk.toString()).slice(-4096);
    evidence.cleanup.directoryMarker ||= tail.includes('Test directories cleaned up');
    evidence.cleanup.databaseMarker ||= tail.includes("Test database 'dollhousemcp_test' dropped");
    evidence.cleanup.teardownMarker ||= tail.includes('Teardown complete');
  };
  child.stdout.on('data', chunk => output(process.stdout, chunk));
  child.stderr.on('data', chunk => output(process.stderr, chunk));
  evidence.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(signal ? null : code));
  });
  // Child close is after the original global teardown. Its log alone is insufficient:
  // teardown currently catches cleanup errors, so verify real absence independently.
  evidence.cleanup.directoryAbsent = !existsSync(path.join(root, '.test-tmp'));
  try { evidence.cleanup.databaseAbsent = await databaseAbsent(); }
  catch { evidence.cleanup.databaseAbsent = false; }
  if (existsSync(resultPath)) {
    const result = read(resultPath);
    evidence.finalSuite = {
      success: result.success, totalSuites: result.numTotalTestSuites,
      passedSuites: result.numPassedTestSuites, failedSuites: result.numFailedTestSuites,
      pendingSuites: result.numPendingTestSuites, passedTests: result.numPassedTests,
      failedTests: result.numFailedTests, pendingTests: result.numPendingTests, todoTests: result.numTodoTests,
    };
    evidence.files = result.testResults.map(f => ({
      file: relative(f.name), status: f.status,
      passed: f.assertionResults.filter(a => a.status === 'passed').length,
      failed: f.assertionResults.filter(a => a.status === 'failed').length,
      pending: f.assertionResults.filter(a => a.status === 'pending').length,
      todo: f.assertionResults.filter(a => a.status === 'todo').length,
    })).sort((a, b) => compare(a.file, b.file));
  }
  // Only this sanitized inventory/count/outcome evidence is uploaded, not raw messages or logs.
  save(file, evidence);
  assert.equal(evidence.exitCode, 0, 'Required PostgreSQL shard failed');
  assert.ok(evidence.finalSuite?.success, 'Final Jest result missing or failed');
  assert.ok(evidence.cleanup.directoryMarker && evidence.cleanup.databaseMarker && evidence.cleanup.teardownMarker && evidence.cleanup.directoryAbsent && evidence.cleanup.databaseAbsent, 'Global cleanup evidence missing');
}

function stop(directory, container) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.match(container, /^[a-f0-9]{12,64}$/);
  // Each matrix job owns its own hosted service/cluster, including every DB and role.
  const removed = spawnSync('/usr/bin/docker', ['rm', '--force', '--volumes', container], { encoding: 'utf8', timeout: 30000 });
  assert.equal(removed.status, 0, 'Service removal failed');
  assert.equal(removed.stdout.trim(), container);
  const remaining = spawnSync('/usr/bin/docker', ['ps', '--all', '--quiet', '--filter', `id=${container}`], { encoding: 'utf8', timeout: 10000 });
  assert.equal(remaining.status, 0);
  assert.equal(remaining.stdout.trim(), '', 'Owned service still exists');
  const file = path.join(directory, 'evidence.json');
  if (existsSync(file)) {
    const evidence = read(file);
    assert.equal(evidence.service, container, 'Cleanup must remove this shard service');
    evidence.cleanup.serviceRemoved = true;
    save(file, evidence);
  }
}

function aggregate(directory) {
  assert.equal(process.env.PG_SHARDS_RESULT, 'success', 'Failed, cancelled, skipped or missing shard job');
  const names = readdirSync(directory);
  const prefix = `pg-integration-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-shard-`;
  assert.deepEqual(names.sort(compare), [prefix + '1', prefix + '2'].sort(compare), 'Both exact current-attempt artifacts required');
  const evidence = [1, 2].map(n => read(path.join(directory, prefix + n, 'evidence.json')));
  checkEvidence(evidence, identity());
  console.log(JSON.stringify({ inventoryFiles: evidence[0].inventory.length, shards: evidence.map(e => ({ shard: e.shard, ...e.finalSuite })), cleanupVerified: true }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, first, second] = process.argv.slice(2);
  try {
    if (command === 'run') await run(Number(first), second);
    else if (command === 'stop') stop(first, second);
    else if (command === 'aggregate') aggregate(first);
    else throw new Error('Expected run, stop or aggregate');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
