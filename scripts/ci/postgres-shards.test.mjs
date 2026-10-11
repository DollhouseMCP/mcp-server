import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { checkEvidence, checkPartition } from './postgres-shards.mjs';

const identity = { run: '100', attempt: '1', checkout: 'commit', source: 'head' };
const inventory = ['tests/integration/a.test.ts', 'tests/integration/future.test.ts'];
const partitions = inventory.map(file => [file]);
function valid() {
  return [1, 2].map(shard => ({
    identity, shard, shardCount: 2, service: String(shard).repeat(64), inventory, partitions,
    inventoryDigest: createHash('sha256').update(JSON.stringify(inventory)).digest('hex'),
    selected: partitions[shard - 1], exitCode: 0,
    finalSuite: { success: true, totalSuites: 1, passedSuites: 1, pendingSuites: 0, failedSuites: 0, passedTests: 1, failedTests: 0, pendingTests: 1, todoTests: 0 },
    files: [{ file: inventory[shard - 1], status: 'focused', passed: 1, failed: 0, pending: 1, todo: 0 }],
    cleanup: { directoryMarker: true, databaseMarker: true, teardownMarker: true, directoryAbsent: true, databaseAbsent: true, serviceRemoved: true },
  }));
}

test('complete future inventory and intentional pending cases retain honest coverage', () => {
  checkEvidence(valid(), identity);
  const e = valid();
  e[0].files[0] = { ...e[0].files[0], status: 'skipped', passed: 0 };
  e[0].finalSuite = { ...e[0].finalSuite, passedSuites: 0, pendingSuites: 1, passedTests: 0 };
  assert.throws(() => checkEvidence(e, identity)); // Empty execution is not a successful shard.
});

function validWithSkippedFile() {
  const e = structuredClone(valid());
  const skipped = 'tests/integration/skipped.test.ts';
  const full = [...inventory, skipped];
  const parts = [[inventory[0], skipped], partitions[1]];
  for (const entry of e) {
    entry.inventory = full;
    entry.partitions = parts;
    entry.inventoryDigest = createHash('sha256').update(JSON.stringify(full)).digest('hex');
    entry.selected = parts[entry.shard - 1];
  }
  e[0].files.push({ file: skipped, status: 'skipped', passed: 0, failed: 0, pending: 2, todo: 0 });
  e[0].finalSuite = { ...e[0].finalSuite, totalSuites: 2, pendingSuites: 1, pendingTests: 3 };
  return e;
}

test('Jest skipped file remains visible alongside executed files', () => {
  const e = validWithSkippedFile();
  checkEvidence(e, identity);
  e[0].files[1].passed = 1;
  e[0].finalSuite.passedTests += 1;
  assert.throws(() => checkEvidence(e, identity));
});

test('focused file cannot consist solely of pending assertions', () => {
  const e = validWithSkippedFile();
  e[0].files[1].status = 'focused';
  e[0].finalSuite.passedSuites = 2;
  e[0].finalSuite.pendingSuites = 0;
  assert.throws(() => checkEvidence(e, identity));
});

test('skipped file cannot contain todo assertions', () => {
  const e = validWithSkippedFile();
  e[0].files[1].pending = 1;
  e[0].files[1].todo = 1;
  e[0].finalSuite.pendingTests = 2;
  e[0].finalSuite.todoTests = 1;
  assert.throws(() => checkEvidence(e, identity));
});

for (const [name, mutate] of [
  ['missing shard artifact', e => e.pop()],
  ['missing inventory digest', e => { delete e[0].inventoryDigest; }],
  ['wrong attempt', e => { e[0].identity = { ...identity, attempt: '2' }; }],
  ['wrong source', e => { e[0].identity = { ...identity, source: 'other' }; }],
  ['shared service', e => { e[1].service = e[0].service; }],
  ['overlapping native partitions', e => { e[0].partitions = [partitions[0], partitions[0]]; }],
  ['omitted future file', e => { e[0].partitions = [partitions[0], []]; }],
  ['disagreeing inventories', e => { e[1].inventory = [inventory[0]]; }],
  ['failed process', e => { e[0].exitCode = 1; }],
  ['cancelled process', e => { e[0].exitCode = null; }],
  ['missing final suite', e => { e[0].finalSuite = null; }],
  ['failed final suite', e => { e[0].finalSuite.success = false; }],
  ['missing file result', e => { e[0].files = []; }],
  ['extra file result', e => { e[0].files.push(e[0].files[0]); }],
  ['passed label with pending assertions', e => { e[0].files[0].status = 'passed'; }],
  ['focused label without pending assertions', e => { e[0].files[0].pending = 0; e[0].finalSuite.pendingTests = 0; }],
  ['failed file', e => { e[0].files[0].status = 'failed'; }],
  ['incorrect rollup', e => { e[0].finalSuite.passedTests = 2; }],
  ['missing cleanup marker', e => { delete e[0].cleanup.databaseMarker; }],
  ['failed database cleanup', e => { e[0].cleanup.databaseAbsent = false; }],
  ['failed directory cleanup', e => { e[0].cleanup.directoryAbsent = false; }],
  ['missing service removal', e => { delete e[0].cleanup.serviceRemoved; }],
]) {
  test(`aggregate refuses ${name}`, () => {
    const evidence = structuredClone(valid());
    mutate(evidence);
    assert.throws(() => checkEvidence(evidence, identity));
  });
}

test('partition refuses an omitted or duplicate discovered file', () => {
  assert.throws(() => checkPartition(inventory, [[inventory[0]], [inventory[0]]]));
  assert.throws(() => checkPartition(inventory, [[inventory[0]], []]));
});
