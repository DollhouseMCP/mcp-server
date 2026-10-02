import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Dir, type Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryAdoptionRecoveryScanBudget } from '../../../src/storage/FileMemoryAdoptionRecoveryScanBudget.js';

const roots: string[] = [];
afterEach(async () => { jest.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'recovery-resource-'))); roots.push(root);
  return root;
}
describe('recovery-private resource reservation', () => {
  it('deduplicates a root head, charges discovery once, and freezes the complete missing-directory suffix', async () => {
    const root = await fixture(), budget = new FileMemoryAdoptionRecoveryScanBudget();
    await budget.discover(root, root, '.head.memory-owner.json', 'owner');
    expect(budget.consumed).toBe(1);
    // T=H=3, O=2, R=3. Both-missing suffix: 51T+47O+40H+69R.
    budget.reserve(); expect(budget.limit).toBe(1 + 51 * 3 + 47 * 2 + 40 * 3 + 69 * 3);
    expect(() => budget.reserve()).toThrow();
    await expect(budget.discover(root, root, '.head.memory-owner.json', 'owner')).rejects.toThrow();
    await expect(fs.lstat(path.join(root, '.memory-owners'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects an unsupported head/ownership physical slot overlap before mutation', async () => {
    const root = await fixture(), parent = path.join(root, '.memory-owners');
    await fs.mkdir(parent); await fs.mkdir(path.join(parent, 'owners'));
    const budget = new FileMemoryAdoptionRecoveryScanBudget();
    await expect(budget.discover(root, parent, '.head.memory-owner.json', 'owner')).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(await fs.readdir(parent)).toEqual(['owners']);
  });
  it('rejects a replaced shared role path during discovery without admitting a second generation', async () => {
    const root = await fixture(), saved = `${root}.saved`; roots.push(saved);
    const budget = new FileMemoryAdoptionRecoveryScanBudget();
    const roles = budget as unknown as { captureRole: (...args: unknown[]) => Promise<void> };
    const original = roles.captureRole;
    jest.spyOn(roles, 'captureRole').mockImplementation(async function(this: typeof roles, ...args) {
      if (args[0] === 'H') {
        await fs.rename(root, saved); await fs.mkdir(root);
        await fs.writeFile(path.join(root, 'sentinel'), 'replacement evidence');
      }
      return original.apply(this, args);
    });
    await expect(budget.discover(root, root, '.head.memory-owner.json', 'owner')).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(await fs.readFile(path.join(root, 'sentinel'), 'utf8')).toBe('replacement evidence');
    expect(await fs.readdir(saved)).toEqual([]);
    await expect(fs.lstat(path.join(root, '.memory-owners'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('charges failed reads without refunds, including primitive rejection causes', async () => {
    for (const cause of [null, undefined]) {
      const budget = new FileMemoryAdoptionRecoveryScanBudget();
      const directory = { read: async () => { throw cause; } } as unknown as Dir;
      await expect(budget.read(directory, 0, 4096)).rejects.toBe(cause);
      expect(budget.consumed).toBe(1);
    }
  });
  it.each([null, undefined])('does not admit discovery after read %s and close both fail', async primary => {
    const root = await fixture(), secondary = new Error('controlled directory close failure');
    const budget = new FileMemoryAdoptionRecoveryScanBudget();
    const reads = Dir.prototype as unknown as { read: () => Promise<Dirent | null> };
    jest.spyOn(reads, 'read').mockRejectedValueOnce(primary);
    const close = Dir.prototype.close as () => Promise<void>;
    jest.spyOn(Dir.prototype, 'close').mockImplementationOnce(async function(this: Dir) {
      await close.call(this); throw secondary;
    });
    let observed: { cause: unknown } | undefined;
    try { await budget.discover(root, root, '.head.memory-owner.json', 'owner'); }
    catch (cause) { observed = { cause }; }
    expect(observed).toBeDefined();
    const failure = observed!.cause as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError); expect(failure.cause).toBe(primary);
    expect(failure.errors).toEqual([primary, secondary]); expect(budget.consumed).toBe(1);
    expect(() => budget.reserve()).toThrow();
    await expect(fs.lstat(path.join(root, '.memory-owners'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('requires room for EOF without creating artifacts', async () => {
    const started = performance.now();
    const diagnostic = (phase: string, accounting: object = {}) => process.stderr.write(`ADOPTION EOF ${JSON.stringify({
      phase, elapsedMs: performance.now() - started, node: process.version, pid: process.pid, noiseFiles: 4096, ...accounting })}\n`);
    diagnostic('setup-start');
    let root: string;
    try {
      root = await fixture();
      await Promise.all(Array.from({ length: 4096 }, (_, index) => fs.writeFile(path.join(root, `n${index}`), 'x')));
    } finally { diagnostic('setup-end'); }
    const budget = new FileMemoryAdoptionRecoveryScanBudget();
    try {
      await expect(budget.discover(root, root, '.head.memory-owner.json', 'owner')).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    } finally { diagnostic('discover-end', { chargedReads: budget.consumed, scanLimit: budget.limit }); }
    expect(budget.consumed).toBe(4096);
    await expect(fs.lstat(path.join(root, '.memory-owners'))).rejects.toMatchObject({ code: 'ENOENT' });
    diagnostic('assertions-complete', { chargedReads: budget.consumed, scanLimit: budget.limit });
  });
  it('rejects aggregate projection overflow after a complete admitted discovery', async () => {
    const root = await fixture();
    await Promise.all(Array.from({ length: 4094 }, (_, index) => fs.writeFile(path.join(root, `n${index}`), 'x')));
    const budget = new FileMemoryAdoptionRecoveryScanBudget();
    await budget.discover(root, root, '.head.memory-owner.json', 'owner');
    expect(budget.consumed).toBe(4095);
    expect(() => budget.reserve()).toThrow(expect.objectContaining({ code: 'EHEADRESOURCE' }));
    expect(budget.limit).toBe(4096); expect(budget.consumed).toBe(4095);
    await expect(fs.lstat(path.join(root, '.memory-owners'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(root)).toHaveLength(4094);
  });
  it('does not expand a frozen slot weight when foreign names appear later', async () => {
    const root = await fixture(), budget = new FileMemoryAdoptionRecoveryScanBudget();
    await budget.discover(root, root, '.head.memory-owner.json', 'owner'); budget.reserve();
    const limit = budget.limit, discovery = budget.consumed;
    await Promise.all(['a', 'b', 'c'].map(name => fs.writeFile(path.join(root, name), 'x')));
    await expect(budget.scan(root, () => {})).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(budget.consumed).toBe(discovery + 3); expect(budget.limit).toBe(limit);
    expect((await fs.readdir(root)).sort()).toEqual(['a', 'b', 'c']);
  });
});
