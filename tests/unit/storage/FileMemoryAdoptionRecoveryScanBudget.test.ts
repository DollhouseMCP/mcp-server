import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Dir, type Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OwnedStorageCase } from './fixtures/ownedStorageCase.js';
import { FileMemoryAdoptionRecoveryScanBudget } from '../../../src/storage/FileMemoryAdoptionRecoveryScanBudget.js';

const roots: string[] = [];
const writes: Promise<void>[] = [];
const ownership = new OwnedStorageCase();
beforeEach(() => ownership.begin());
function cleanupDiagnostic(phase: string, accounting: object = {}): void {
  try { process.stderr.write(`ADOPTION fixture cleanup ${JSON.stringify({ phase, writes: writes.length, roots: roots.length, ...accounting })}\n`); }
  catch { /* Diagnostics never replace an original setup/body/cleanup failure. */ }
}
// Delegate synchronously and return the SAME promise to the original Promise.all.
// Retain siblings separately because that aggregate can reject before they settle.
function writeFixtureFile(...args: Parameters<typeof fs.writeFile>): Promise<void> {
  ownership.checkpoint();
  const write = fs.writeFile(...args);
  writes.push(write);
  void write.catch(() => undefined); // Observe siblings; original promise still rejects.
  return write;
}
afterEach(async () => {
  try {
    await ownership.teardown(async checkpoint => {
      checkpoint(); cleanupDiagnostic('write-drain-start');
      const settled = await Promise.allSettled(writes);
      checkpoint(); cleanupDiagnostic('write-drain-end', { rejected: settled.filter(item => item.status === 'rejected').length });
      checkpoint(); writes.splice(0);
      checkpoint(); jest.restoreAllMocks();
      while (roots.length) {
        checkpoint(); await fs.rm(roots[0], { recursive: true, force: true });
        checkpoint(); roots.shift();
      }
    });
  } finally { cleanupDiagnostic('teardown-returned'); }
});
async function fixture() {
  ownership.checkpoint();
  const allocated = await fs.mkdtemp(path.join(os.tmpdir(), 'recovery-resource-')); roots.push(allocated);
  ownership.checkpoint();
  const root = await fs.realpath(allocated);
  ownership.checkpoint();
  return root;
}
describe('recovery-private resource reservation', () => {
  it('deduplicates a root head, charges discovery once, and freezes the complete missing-directory suffix', ownership.own(async () => {
    const root = await fixture(), budget = new FileMemoryAdoptionRecoveryScanBudget();
    ownership.checkpoint();
    await budget.discover(root, root, '.head.memory-owner.json', 'owner');
    expect(budget.consumed).toBe(1);
    // T=H=3, O=2, R=3. Both-missing suffix: 51T+47O+40H+69R.
    budget.reserve(); expect(budget.limit).toBe(1 + 51 * 3 + 47 * 2 + 40 * 3 + 69 * 3);
    expect(() => budget.reserve()).toThrow();
    ownership.checkpoint();
    await expect(budget.discover(root, root, '.head.memory-owner.json', 'owner')).rejects.toThrow();
    await expect(fs.lstat(path.join(root, '.memory-owners'))).rejects.toMatchObject({ code: 'ENOENT' });
  }));
  it('rejects an unsupported head/ownership physical slot overlap before mutation', ownership.own(async () => {
    const root = await fixture(), parent = path.join(root, '.memory-owners');
    ownership.checkpoint(); await fs.mkdir(parent);
    ownership.checkpoint(); await fs.mkdir(path.join(parent, 'owners'));
    ownership.checkpoint();
    const budget = new FileMemoryAdoptionRecoveryScanBudget();
    ownership.checkpoint();
    await expect(budget.discover(root, parent, '.head.memory-owner.json', 'owner')).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(await fs.readdir(parent)).toEqual(['owners']);
  }));
  it('rejects a replaced shared role path during discovery without admitting a second generation', ownership.own(async () => {
    const root = await fixture(), saved = `${root}.saved`; roots.push(saved);
    const budget = new FileMemoryAdoptionRecoveryScanBudget();
    const roles = budget as unknown as { captureRole: (...args: unknown[]) => Promise<void> };
    const original = roles.captureRole;
    ownership.checkpoint();
    jest.spyOn(roles, 'captureRole').mockImplementation(async function(this: typeof roles, ...args) {
      if (args[0] === 'H') {
        ownership.checkpoint(); await fs.rename(root, saved);
        ownership.checkpoint(); await fs.mkdir(root);
        await writeFixtureFile(path.join(root, 'sentinel'), 'replacement evidence');
        ownership.checkpoint();
      }
      return original.apply(this, args);
    });
    ownership.checkpoint();
    await expect(budget.discover(root, root, '.head.memory-owner.json', 'owner')).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(await fs.readFile(path.join(root, 'sentinel'), 'utf8')).toBe('replacement evidence');
    expect(await fs.readdir(saved)).toEqual([]);
    await expect(fs.lstat(path.join(root, '.memory-owners'))).rejects.toMatchObject({ code: 'ENOENT' });
  }));
  it('charges failed reads without refunds, including primitive rejection causes', ownership.own(async () => {
    for (const cause of [null, undefined]) {
      const budget = new FileMemoryAdoptionRecoveryScanBudget();
      const directory = { read: async () => { throw cause; } } as unknown as Dir;
      await expect(budget.read(directory, 0, 4096)).rejects.toBe(cause);
      expect(budget.consumed).toBe(1);
    }
  }));
  it.each([null, undefined])('does not admit discovery after read %s and close both fail', ownership.own(async primary => {
    const root = await fixture(), secondary = new Error('controlled directory close failure');
    const budget = new FileMemoryAdoptionRecoveryScanBudget();
    const reads = Dir.prototype as unknown as { read: () => Promise<Dirent | null> };
    ownership.checkpoint();
    jest.spyOn(reads, 'read').mockRejectedValueOnce(primary);
    const close = Dir.prototype.close as () => Promise<void>;
    ownership.checkpoint();
    jest.spyOn(Dir.prototype, 'close').mockImplementationOnce(async function(this: Dir) {
      await close.call(this); throw secondary;
    });
    let observed: { cause: unknown } | undefined;
    try { ownership.checkpoint(); await budget.discover(root, root, '.head.memory-owner.json', 'owner'); }
    catch (cause) { observed = { cause }; }
    expect(observed).toBeDefined();
    const failure = observed!.cause as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError); expect(failure.cause).toBe(primary);
    expect(failure.errors).toEqual([primary, secondary]); expect(budget.consumed).toBe(1);
    expect(() => budget.reserve()).toThrow();
    await expect(fs.lstat(path.join(root, '.memory-owners'))).rejects.toMatchObject({ code: 'ENOENT' });
  }));
  // These two fixtures have separate approved 10-second setup bounds. Every
  // discovery/reservation check and artifact assertion stays in its 10-second case.
  describe('EOF census fixture', () => {
    let root: string;
    beforeEach(ownership.own(async () => {
      const started = performance.now();
      const diagnostic = (phase: string) => process.stderr.write(`ADOPTION EOF ${JSON.stringify({
        phase, scope: 'fixture', elapsedMs: performance.now() - started, node: process.version, pid: process.pid, noiseFiles: 4096 })}\n`);
      diagnostic('setup-start');
      try {
        root = await fixture();
        try { diagnostic('root-ready'); } catch { /* Evidence cannot change setup. */ }
        await Promise.all(Array.from({ length: 4096 }, (_, index) => writeFixtureFile(path.join(root, `n${index}`), 'x')));
        try { diagnostic('writes-fulfilled'); } catch { /* Evidence cannot change setup. */ }
      } finally { diagnostic('setup-end'); }
    }), 10000);
    it('requires room for EOF without creating artifacts', ownership.own(async () => {
      const started = performance.now();
      const diagnostic = (phase: string, accounting: object = {}) => process.stderr.write(`ADOPTION EOF ${JSON.stringify({
        phase, scope: 'operation-verification', elapsedMs: performance.now() - started, node: process.version, pid: process.pid, noiseFiles: 4096, ...accounting })}\n`);
      const budget = new FileMemoryAdoptionRecoveryScanBudget();
      diagnostic('discover-start');
      try {
        ownership.checkpoint();
        await expect(budget.discover(root, root, '.head.memory-owner.json', 'owner')).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
      } finally { diagnostic('discover-end', { chargedReads: budget.consumed, scanLimit: budget.limit }); }
      expect(budget.consumed).toBe(4096);
      await expect(fs.lstat(path.join(root, '.memory-owners'))).rejects.toMatchObject({ code: 'ENOENT' });
      diagnostic('assertions-complete', { chargedReads: budget.consumed, scanLimit: budget.limit });
    }), 10000);
  });
  describe('aggregate projection census fixture', () => {
    let root: string;
    beforeEach(ownership.own(async () => {
      const started = performance.now();
      const diagnostic = (phase: string) => process.stderr.write(`ADOPTION PROJECTION ${JSON.stringify({
        phase, scope: 'fixture', elapsedMs: performance.now() - started, noiseFiles: 4094 })}\n`);
      diagnostic('setup-start');
      root = await fixture();
      await Promise.all(Array.from({ length: 4094 }, (_, index) => writeFixtureFile(path.join(root, `n${index}`), 'x')));
      diagnostic('setup-end');
    }), 10000);
    it('rejects aggregate projection overflow after a complete admitted discovery', ownership.own(async () => {
      const started = performance.now();
      const diagnostic = (phase: string) => process.stderr.write(`ADOPTION PROJECTION ${JSON.stringify({
        phase, scope: 'operation-verification', elapsedMs: performance.now() - started, noiseFiles: 4094 })}\n`);
      const budget = new FileMemoryAdoptionRecoveryScanBudget();
      diagnostic('discover-start');
      ownership.checkpoint();
      await budget.discover(root, root, '.head.memory-owner.json', 'owner');
      diagnostic('discover-end');
      expect(budget.consumed).toBe(4095);
      expect(() => budget.reserve()).toThrow(expect.objectContaining({ code: 'EHEADRESOURCE' }));
      expect(budget.limit).toBe(4096); expect(budget.consumed).toBe(4095);
      await expect(fs.lstat(path.join(root, '.memory-owners'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readdir(root)).toHaveLength(4094);
      diagnostic('assertions-complete');
    }), 10000);
  });
  it('does not expand a frozen slot weight when foreign names appear later', ownership.own(async () => {
    const root = await fixture(), budget = new FileMemoryAdoptionRecoveryScanBudget();
    ownership.checkpoint();
    await budget.discover(root, root, '.head.memory-owner.json', 'owner'); budget.reserve();
    const limit = budget.limit, discovery = budget.consumed;
    await Promise.all(['a', 'b', 'c'].map(name => writeFixtureFile(path.join(root, name), 'x')));
    await expect(budget.scan(root, () => {})).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(budget.consumed).toBe(discovery + 3); expect(budget.limit).toBe(limit);
    expect((await fs.readdir(root)).sort()).toEqual(['a', 'b', 'c']);
  }));
});
