import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { toSarif, isAuditComplete } from '../../scripts/security-audit-report.mjs';

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


test('completion requires successful audit, successful conversion and a valid actual result', () => {
  const success = { auditFailed: false, auditOutcome: 'success', sarifOutcome: 'success' };
  assert.equal(isAuditComplete({ findings: [finding] }, success), true);
  for (const state of [{ ...success, auditFailed: true }, { ...success, auditOutcome: 'skipped' },
    { ...success, auditOutcome: 'failure' }, { ...success, sarifOutcome: 'failure' }]) {
    assert.equal(isAuditComplete({ findings: [] }, state), false);
  }
  for (const result of [undefined, {}, { error: 'Unavailable', findings: [] }]) {
    assert.equal(isAuditComplete(result, success), false);
  }
});

test('actual workflow shell preserves high findings when the auditor exits one', async () => {
  const project = process.cwd();
  const workflow = await readFile(join(project, '.github/workflows/security-audit.yml'), 'utf8');
  const start = workflow.indexOf('          # Run the audit with error handling');
  const end = workflow.indexOf('\n      - name: Upload audit results', start);
  assert.ok(start >= 0 && end > start);
  const wrapper = workflow.slice(start, end).split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
  for (const withFinding of [true, false]) {
    const dir = await mkdtemp(join(tmpdir(), 'audit-wrapper-'));
    try {
      await mkdir(join(dir, 'scripts'));
      await copyFile(join(project, 'scripts/security-audit-report.mjs'), join(dir, 'scripts/security-audit-report.mjs'));
      const original = JSON.stringify({ findings: [{ ...finding, severity: 'high' }] });
      await writeFile(join(dir, 'run-audit.js'), (withFinding
        ? `require('fs').writeFileSync('security-audit-result.json', ${JSON.stringify(original)});` : '') + 'process.exitCode=1;');
      const envPath = join(dir, 'github-env');
      const child = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', wrapper], {
        cwd: dir, env: { ...process.env, GITHUB_ENV: envPath }, encoding: 'utf8',
      });
      assert.equal(child.status, 0, child.stderr);
      assert.match(await readFile(envPath, 'utf8'), /AUDIT_FAILED=true/);
      const kept = await readFile(join(dir, 'security-audit-result.json'), 'utf8');
      if (withFinding) assert.equal(kept, original);
      else assert.deepEqual(JSON.parse(kept), { error: 'Audit failed to complete' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});
