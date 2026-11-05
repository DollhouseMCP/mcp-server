import { expect, it as jestIt } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const it = process.platform === 'win32' || !process.getuid ? jestIt.skip : jestIt;

it('keeps an actual inspection timeout failed while settling before mock and root cleanup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inspection-ownership-'));
  try {
    const require = createRequire(import.meta.url);
    const result = spawnSync(process.execPath, [require.resolve('jest/bin/jest'), '--config', 'tests/jest.config.cjs',
      '--runInBand', '--no-coverage', '--testMatch', '**/erasureInspectionTimeout.fixture.ts', '--json', '--outputFile', path.join(root, 'result.json')], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: root,
        NODE_OPTIONS: '--experimental-vm-modules --no-warnings', STORAGE_CASE_PROOF_ROOT: root }, encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
    const report = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
    const cases = report.testResults[0].assertionResults;
    expect(cases.map((item: { status: string }) => item.status)).toEqual(['failed', 'passed']);
    expect(cases[0].failureMessages.join('\n')).toContain('Exceeded timeout of 10000 ms for a test');
    const events = JSON.parse(await fs.readFile(path.join(root, 'events.json'), 'utf8'));
    expect(events).toEqual(['teardown-enter', 'open-released-with-resources', 'inspection-settled', 'callback-closed',
      'mock-reset', 'root-removed', 'next-body', 'teardown-enter', 'mock-reset', 'root-removed']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 30000);
