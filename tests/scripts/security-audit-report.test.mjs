import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { toSarif } from '../../scripts/security-audit-report.mjs';

const finding = { ruleId: 'DMCP-SEC-006', severity: 'low', message: 'Missing audit event',
  file: '/owned/repo/src/file name.ts', line: 12 };

test('retains low findings and declares every referenced SARIF rule', () => {
  const sarif = toSarif({ findings: [finding, { ...finding, severity: 'high' }] }, '/owned/repo');
  assert.deepEqual(sarif.runs[0].tool.driver.rules, [{ id: 'DMCP-SEC-006' }]);
  assert.equal(sarif.runs[0].results.length, 2);
  assert.deepEqual(sarif.runs[0].results.map(x => x.level), ['note', 'error']);
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'src/file%20name.ts');
});

test('a completed zero-finding audit remains explicitly empty', () => {
  const sarif = toSarif({ findings: [] });
  assert.deepEqual(sarif.runs[0].results, []);
  assert.deepEqual(sarif.runs[0].tool.driver.rules, []);
});

test('unavailable or malformed results never become a clean SARIF', () => {
  for (const input of [null, {}, { findings: [], error: 'Audit failed' },
    { findings: [{ ...finding, severity: 'unknown' }] },
    { findings: [{ ...finding, ruleId: '' }] }, { findings: [{ ...finding, line: 0 }] }]) {
    assert.throws(() => toSarif(input));
  }
});

test('CLI exits nonzero for malformed audit and leaves original findings untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-report-'));
  try {
    const input = join(dir, 'result.json'), output = join(dir, 'report.sarif');
    const original = JSON.stringify({ findings: [finding], error: 'Audit failed after collecting findings' });
    await writeFile(input, original);
    const child = spawnSync(process.execPath, ['scripts/security-audit-report.mjs', input, output], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.equal(await readFile(input, 'utf8'), original);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
