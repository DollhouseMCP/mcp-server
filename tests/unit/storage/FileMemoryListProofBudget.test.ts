import { afterEach, describe, expect, it as test, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import { Dir } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryListProofBudget } from '../../../src/storage/FileMemoryListProofBudget.js';

const it = process.platform === 'win32' ? test.skip : test;
const roots: string[] = [];
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'list-proof-budget-'));
  roots.push(root); return root;
}
afterEach(async () => { jest.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe('private listing proof accounting', () => {
  it('charges real EOF, reserves once without reset and rejects growth without reseeding', async () => {
    const root = await directory(), budget = new FileMemoryListProofBudget();
    await budget.scan(root, () => { throw new Error('Empty directory has no entry'); });
    expect(budget.consumed).toBe(1); expect(budget.identityChecks).toBe(2);
    budget.reserve(root, root, []);
    expect(budget.limit).toBe(19); expect(budget.consumed).toBe(1);
    await budget.scan(root, () => { throw new Error('Empty directory has no entry'); });
    expect(budget.consumed).toBe(2);
    expect(() => budget.reserve(root, root, [])).toThrow('budget exhausted');
    await fs.writeFile(path.join(root, 'foreign'), 'preserved', { flag: 'wx' });
    const before = budget.consumed;
    await expect(budget.scan(root, () => {})).rejects.toMatchObject({ code: 'EARCHIVECHANGED' });
    expect(budget.consumed).toBe(before); expect(budget.limit).toBe(19);
    expect(await fs.readFile(path.join(root, 'foreign'), 'utf8')).toBe('preserved');
  });
  it('refuses a new slot after reservation and a pre-existing symlink before reading', async () => {
    const root = await directory(), other = await directory(), budget = new FileMemoryListProofBudget();
    await budget.scan(root, () => {}); budget.reserve(root, root, []);
    await expect(budget.scan(other, () => {})).rejects.toMatchObject({ code: 'EARCHIVECHANGED' });
    expect(budget.consumed).toBe(1);
    const link = path.join(other, 'link'); await fs.symlink(root, link);
    const initial = new FileMemoryListProofBudget();
    await expect(initial.scan(link, () => {})).rejects.toMatchObject({ code: 'EARCHIVEUNSAFE' });
    expect(initial.consumed).toBe(0);
  });
  it.each([null, undefined])('preserves primitive read failure %s plus an actual close failure', async primary => {
    const root = await directory(); await fs.writeFile(path.join(root, 'entry'), 'data');
    const prototype = Dir.prototype as unknown as { close: (callback?: (error: NodeJS.ErrnoException | null) => void) => Promise<void> | void };
    const original = prototype.close, secondary = new Error('controlled close failure');
    jest.spyOn(prototype, 'close').mockImplementation(function(this: typeof prototype, callback) {
      // Dir's promise overload calls its callback overload through this.close().
      if (callback) return original.call(this, callback);
      return Promise.resolve(original.call(this)).then(() => { throw secondary; });
    });
    jest.spyOn(Dir.prototype, 'read').mockRejectedValue(primary);
    const budget = new FileMemoryListProofBudget();
    const failure = await budget.scan(root, () => {}).catch(cause => ({ cause }));
    expect(failure).toEqual({ cause: expect.any(AggregateError) });
    const combined = (failure as { cause: AggregateError }).cause;
    expect(combined.cause).toBe(primary); expect(combined.errors).toEqual([primary, secondary]);
    expect(budget.consumed).toBe(1);
    expect(() => budget.reserve(root, root, [])).toThrow('budget exhausted');
  });
  it('does not admit EOF evidence when close alone fails', async () => {
    const root = await directory(), budget = new FileMemoryListProofBudget();
    const prototype = Dir.prototype as unknown as { close: (callback?: (error: NodeJS.ErrnoException | null) => void) => Promise<void> | void };
    const original = prototype.close, secondary = new Error('controlled close failure');
    jest.spyOn(prototype, 'close').mockImplementation(function(this: typeof prototype, callback) {
      // Dir's promise overload calls its callback overload through this.close().
      if (callback) return original.call(this, callback);
      return Promise.resolve(original.call(this)).then(() => { throw secondary; });
    });
    await expect(budget.scan(root, () => {})).rejects.toBe(secondary);
    expect(budget.consumed).toBe(1);
    expect(() => budget.reserve(root, root, [])).toThrow('budget exhausted');
  });
  it('does not record a census when named identity lookup fails after close', async () => {
    const root = await directory(), budget = new FileMemoryListProofBudget();
    const internals = budget as unknown as { identity: (location: string) => Promise<readonly string[]> };
    const original = internals.identity, cause = new Error('controlled final identity failure'); let calls = 0;
    jest.spyOn(internals, 'identity').mockImplementation(function(this: typeof internals, location) {
      calls++; return calls === 2 ? Promise.reject(cause) : original.call(this, location);
    });
    const close = jest.spyOn(Dir.prototype, 'close');
    await expect(budget.scan(root, () => {})).rejects.toBe(cause);
    expect(close).toHaveBeenCalled(); expect(budget.consumed).toBe(1);
    expect(() => budget.reserve(root, root, [])).toThrow('budget exhausted');
  });
  it('deduplicates a physical slot while charging every repeated real EOF', async () => {
    const root = await directory(), budget = new FileMemoryListProofBudget();
    await budget.scan(root, () => {}); await budget.scan(path.join(root, '.'), () => {});
    expect(budget.consumed).toBe(2); expect(budget.identityChecks).toBe(4);
    budget.reserve(root, root, []);
    expect(budget.limit).toBe(20); // Two spent EOF reads plus18 remaining scans of one slot.
    expect(budget.consumed).toBe(2);
  });
  it('refuses a real census without a free overflow/EOF read', async () => {
    const root = await directory();
    for (let index = 0; index < 4096; index++) await fs.mkdir(path.join(root, `child-${index}`));
    const budget = new FileMemoryListProofBudget(); let inspected = 0;
    await expect(budget.scan(root, () => { inspected++; })).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(inspected).toBe(4096); expect(budget.consumed).toBe(4096);
    expect(() => budget.reserve(root, root, [])).toThrow('budget exhausted');
    expect((await fs.readdir(root)).length).toBe(4096);
  });
});
