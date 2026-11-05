import { afterAll, afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import * as realFs from 'node:fs/promises';
import * as path from 'node:path';
import { OwnedStorageCase } from './ownedStorageCase.js';

const root = process.env.STORAGE_CASE_PROOF_ROOT!;
const owner = new OwnedStorageCase(), events: string[] = [];
const open = jest.fn(realFs.open);
jest.unstable_mockModule('node:fs/promises', () => ({ ...realFs, open }));
const { ErasureAccounting, ErasureInspection } = await import('../../../../src/storage/FileMemoryErasureInspection.js');
let release: (() => void) | undefined, callbackClosed = false;
const selected = path.join(root, 'inspection');

beforeEach(() => owner.begin());
afterEach(async () => {
  events.push('teardown-enter');
  release?.(); // Jest has already recorded the unchanged 10s case failure.
  await owner.teardown(async checkpoint => {
    checkpoint(); expect(callbackClosed).toBe(true);
    open.mockReset(); open.mockImplementation(realFs.open); events.push('mock-reset');
    checkpoint(); await realFs.rm(selected, { recursive: true });
    checkpoint(); events.push('root-removed');
  });
});

it('retains the original timeout until actual inspection and callback settle', owner.own(async () => {
  await realFs.mkdir(selected, { mode: 0o700 });
  await realFs.writeFile(path.join(selected, 'record'), 'retained', { mode: 0o600 });
  const stat = await realFs.lstat(selected, { bigint: true });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const installed: typeof realFs.open = async (...args) => {
    await gate;
    expect(open.getMockImplementation()).toBe(installed);
    expect((await realFs.stat(selected)).isDirectory()).toBe(true);
    events.push('open-released-with-resources');
    return realFs.open(...args);
  };
  open.mockImplementation(installed);
  try {
    const inspection = new ErasureInspection(selected, String(stat.dev), new ErasureAccounting(), () => {});
    await inspection.file('record');
    events.push('inspection-settled');
    owner.checkpoint(); // Closed admission must prevent further test work.
    events.push('forbidden-verification');
  } finally { callbackClosed = true; events.push('callback-closed'); }
}), 10000);

it('admits the next case only after the old callback, mock and root are settled', owner.own(async () => {
  events.push('next-body');
  expect(callbackClosed).toBe(true); expect(open).not.toHaveBeenCalled();
  expect(open.getMockImplementation()).toBe(realFs.open);
  await expect(realFs.stat(selected)).rejects.toMatchObject({ code: 'ENOENT' });
  await realFs.mkdir(selected, { mode: 0o700 });
}));

afterAll(async () => { await realFs.writeFile(path.join(root, 'events.json'), JSON.stringify(events)); });
