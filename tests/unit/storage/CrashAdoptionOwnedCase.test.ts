import { expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { OwnedStorageCase } from './fixtures/ownedStorageCase.js';

it('retains evidence and refuses admission when the original operation cannot settle', async () => {
  const owner = new OwnedStorageCase(); owner.begin();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unsettled-storage-'));
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = owner.own(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); })();
  const cleanup = jest.fn(async () => { await fs.rm(root, { recursive: true }); });
  try {
    await started;
    await expect(owner.teardown(cleanup, 150)).rejects.toThrow('safe cleanup not established');
    expect(cleanup).not.toHaveBeenCalled();
    expect((await fs.stat(root)).isDirectory()).toBe(true);
    expect(() => owner.begin()).toThrow('Previous storage case');
    expect(() => owner.own(() => Promise.resolve())()).toThrow('admission is closed');
    release(); await pending;
    expect(cleanup).not.toHaveBeenCalled();
    expect(() => owner.begin()).toThrow('Previous storage case');
  } finally { release(); await pending; await fs.rm(root, { recursive: true, force: true }); }
});

// New outer observation bound; nested storage case retains its original 10s deadline.
it('settles actual timed-out child work before fixture teardown and next admission', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crash-adoption-ownership-'));
  try {
    const require = createRequire(import.meta.url);
    const result = spawnSync(process.execPath, [require.resolve('jest/bin/jest'), '--config', 'tests/jest.config.cjs',
      '--runInBand', '--no-coverage', '--testMatch', '**/crashAdoptionTimeout.fixture.ts', '--json', '--outputFile', path.join(root, 'result.json')], {
      cwd: process.cwd(), env: { ...process.env, STORAGE_CASE_PROOF_ROOT: root }, encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
    const report = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
    const cases = report.testResults[0].assertionResults;
    expect(cases.map((item: { status: string }) => item.status)).toEqual(['failed', 'passed']);
    expect(cases[0].failureMessages.join('\n')).toContain('Exceeded timeout of 10000 ms for a test');
    const events = JSON.parse(await fs.readFile(path.join(root, 'events.json'), 'utf8'));
    expect(events).toEqual(['teardown-enter', 'child-closed-with-resources', 'crash-cleanup', 'callback-closed', 'adoption-cleanup', 'next-body', 'teardown-enter', 'adoption-cleanup']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 30000);
