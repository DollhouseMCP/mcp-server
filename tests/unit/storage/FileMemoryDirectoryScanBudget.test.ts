import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Dir } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryDirectoryScanBudget, FileMemoryDirectoryScanLimitError, closeMemoryDirectoryInspection } from '../../../src/storage/FileMemoryDirectoryScanBudget.js';

const roots: string[] = [];
async function fixture(names: readonly string[] = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-scan-budget-'));
  roots.push(root);
  await Promise.all(names.map(name => fs.writeFile(path.join(root, name), 'fixture')));
  return root;
}
afterEach(async () => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('invocation-owned directory read-attempt budget', () => {
  it.each([0, -1, 1.5, 1001, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid limit %s before directory access', limit => {
    expect(() => new FileMemoryDirectoryScanBudget(limit)).toThrow(RangeError);
  });
  it('charges entries and EOF, and refuses a further read without fetching', async () => {
    const directory = await fs.opendir(await fixture(['a', 'b']));
    const read = jest.spyOn(directory, 'read');
    const budget = new FileMemoryDirectoryScanBudget(3);
    try {
      expect(Object.isFrozen(budget)).toBe(true);
      expect((await budget.read(directory))?.name).toBeDefined();
      expect((await budget.read(directory))?.name).toBeDefined();
      expect(await budget.read(directory)).toBeNull();
      expect(budget.consumed).toBe(3);
      await expect(budget.read(directory)).rejects.toBeInstanceOf(FileMemoryDirectoryScanLimitError);
      expect(read).toHaveBeenCalledTimes(3);
    } finally { await directory.close(); }
  });
  it('cannot prove EOF when the final available unit fetched an entry', async () => {
    const root = await fixture(['only']);
    const inspected: string[] = [];
    const budget = new FileMemoryDirectoryScanBudget(1);
    await expect(budget.scan(root, name => inspected.push(name))).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(inspected).toEqual(['only']);
    expect(budget.remaining).toBe(0);
  });
  it('burns failed read reservations without refund', async () => {
    const directory = await fs.opendir(await fixture());
    await directory.close();
    const read = jest.spyOn(directory, 'read');
    const budget = new FileMemoryDirectoryScanBudget(1);
    await expect(budget.read(directory)).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
    await expect(budget.read(directory)).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(budget.consumed).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('reserves synchronously across concurrent readers before either read settles', async () => {
    const first = await fs.opendir(await fixture(['first']));
    const second = await fs.opendir(await fixture(['second']));
    const firstRead = jest.spyOn(first, 'read');
    const secondRead = jest.spyOn(second, 'read');
    const budget = new FileMemoryDirectoryScanBudget(1);
    try {
      const outcomes = await Promise.allSettled([budget.read(first), budget.read(second)]);
      expect(outcomes[0].status).toBe('fulfilled');
      expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { code: 'EHEADRESOURCE' } });
      expect(firstRead).toHaveBeenCalledTimes(1);
      expect(secondRead).not.toHaveBeenCalled();
      expect(budget.consumed).toBe(1);
    } finally { await Promise.all([first.close(), second.close()]); }
  });
  it('closes exhausted scans and preserves the primary typed refusal if close also fails', async () => {
    const root = await fixture(['entry']);
    const closeFailure = new Error('close failure');
    const close = jest.spyOn(Dir.prototype, 'close').mockImplementation(async function(this: Dir) {
      // Close the real descriptor before injecting failure; Dir.close's promise
      // wrapper otherwise recursively calls its callback overload through this.
      this.closeSync();
      throw closeFailure;
    });
    const outcome = await new FileMemoryDirectoryScanBudget(1).scan(root, () => {}).catch(cause => cause);
    expect(close).toHaveBeenCalledTimes(1);
    expect(outcome).toBeInstanceOf(AggregateError);
    expect(outcome).toMatchObject({ code: 'EHEADRESOURCE', cause: expect.any(FileMemoryDirectoryScanLimitError) });
    expect(outcome.errors).toEqual([outcome.cause, closeFailure]);
  });
  it('does not report a successful empty scan when descriptor close fails', async () => {
    const root = await fixture();
    const closeFailure = new Error('close failure after EOF');
    jest.spyOn(Dir.prototype, 'close').mockImplementation(async function(this: Dir) {
      this.closeSync();
      throw closeFailure;
    });
    const budget = new FileMemoryDirectoryScanBudget(1);
    await expect(budget.scan(root, () => {})).rejects.toBe(closeFailure);
    expect(budget.consumed).toBe(1);
  });
  it.each([{ code: 42 }, Object.defineProperty({}, 'code', { get: () => { throw new Error('code getter'); } }), null, undefined])(
    'shared close preserves arbitrary primary and actual close failure', async primary => {
      const directory = await fs.opendir(await fixture());
      const secondary = new Error('after actual close');
      jest.spyOn(directory, 'close').mockImplementation(async () => { directory.closeSync(); throw secondary; });
      const result = await closeMemoryDirectoryInspection(directory, { cause: primary }, 'inspection close').catch(cause => cause);
      expect(result).toBeInstanceOf(AggregateError); expect(result.cause).toBe(primary);
      expect(result.errors).toEqual([primary, secondary]); expect(result.code).toBeUndefined();
    });

});
