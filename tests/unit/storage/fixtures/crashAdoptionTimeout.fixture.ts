import { afterAll, afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { OwnedStorageCase } from './ownedStorageCase.js';

const root = process.env.STORAGE_CASE_PROOF_ROOT!;
const owner = new OwnedStorageCase();
const events: string[] = [];
const observer = { read: () => 'original' };
let child: ChildProcess | undefined;
let callbackClosed = false, childClosed = false;
beforeEach(() => owner.begin());
afterEach(async () => {
  events.push('teardown-enter');
  child?.stdin?.end(); // Actual Jest rejection is recorded before this hook.
  await owner.teardown(async checkpoint => {
    checkpoint();
    events.push('adoption-cleanup');
    expect(callbackClosed).toBe(true);
    checkpoint(); jest.restoreAllMocks();
    checkpoint(); await fs.rm(path.join(root, 'adoption'), { recursive: true });
    checkpoint();
  });
});
it('retains the original timeout while child work and callback cleanup settle', owner.own(async () => {
  await fs.mkdir(path.join(root, 'crash'));
  await fs.mkdir(path.join(root, 'adoption'));
  jest.spyOn(observer, 'read').mockReturnValue('installed');
  child = spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const closed = new Promise<void>((resolve, reject) => { child!.once('error', reject); child!.once('close', () => { childClosed = true; resolve(); }); });
  try {
    await closed;
    expect(observer.read()).toBe('installed');
    expect((await fs.stat(path.join(root, 'adoption'))).isDirectory()).toBe(true);
    events.push('child-closed-with-resources');
    owner.checkpoint();
    events.push('forbidden-recovery');
  } finally {
    events.push('crash-cleanup');
    await fs.rm(path.join(root, 'crash'), { recursive: true });
    callbackClosed = true;
    events.push('callback-closed');
  }
}), 10000);
it('admits subsequent work only after original callback and both cleanups', owner.own(async () => {
  events.push('next-body');
  expect(events).toEqual(['teardown-enter', 'child-closed-with-resources', 'crash-cleanup', 'callback-closed', 'adoption-cleanup', 'next-body']);
  expect(observer.read()).toBe('original');
  await expect(fs.stat(path.join(root, 'crash'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(path.join(root, 'adoption'))).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.mkdir(path.join(root, 'adoption')); // Preserve the same teardown contract for this case.
}));
afterAll(async () => {
  await fs.writeFile(path.join(root, 'events.json'), JSON.stringify(events));
  await fs.writeFile(path.join(root, 'child-cleanup.json'), JSON.stringify({ pid: child?.pid, childClosed, callbackClosed }));
});
