import { expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OwnedStorageCase } from './fixtures/ownedStorageCase.js';

it('preserves falsy original rejections', async () => {
  const owner = new OwnedStorageCase(); owner.begin();
  await expect(owner.own(async () => { throw undefined; })()).rejects.toBeUndefined();
  await owner.teardown(async () => {});
});


it('closes callback admission before a registered body enters its first microtask', async () => {
  const owner = new OwnedStorageCase(); owner.begin();
  const body = jest.fn(async () => {});
  const original = owner.own(body)();
  const cleanup = jest.fn(async () => {});
  const teardown = owner.teardown(cleanup);
  await expect(original).rejects.toThrow('Storage case work admission is closed');
  await teardown;
  expect(body).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledTimes(1);
});

// This NEW harness bound observes a nested unchanged 10s failure and its cleanup.
// No existing storage body or hook timeout is increased.
it('isolates actual timed-out Jest callbacks before cleanup and subsequent admission', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-case-proof-'));
  try {
    const require = createRequire(import.meta.url);
    const result = spawnSync(process.execPath, [require.resolve('jest/bin/jest'),
      '--config', 'tests/jest.config.cjs', '--runInBand', '--no-coverage',
      '--testMatch', '**/storageCaseTimeout.fixture.ts', '--json', '--outputFile', path.join(root, 'result.json')], {
      cwd: process.cwd(), env: { ...process.env, STORAGE_CASE_PROOF_ROOT: root },
      encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
    const report = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
    const cases = report.testResults[0].assertionResults;
    expect(cases.map((item: { status: string }) => item.status)).toEqual(['failed', 'passed', 'failed', 'failed']);
    expect(cases[0].failureMessages.join('\n')).toContain('Exceeded timeout of 10000 ms for a test');
    expect(cases[2].failureMessages.join('\n')).toContain('safe cleanup not established');
    expect(cases[3].failureMessages.join('\n')).toContain('Previous storage case has not completed safe cleanup');
    const events = JSON.parse(await fs.readFile(path.join(root, 'events.json'), 'utf8'));
    expect(events).toEqual(['teardown-enter', 'operation-settled-with-resources', 'body-settled', 'cleanup', 'next-body', 'teardown-enter', 'cleanup', 'late-settlement']);
    expect((await fs.stat(path.join(root, 'blocked'))).isDirectory()).toBe(true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 30000);
