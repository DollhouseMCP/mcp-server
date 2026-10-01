import { afterEach, describe, expect, it as test, jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryAdoptionRecoveryScanBudget } from '../../../src/storage/FileMemoryAdoptionRecoveryScanBudget.js';

const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
const it = process.platform === 'win32' ? test.skip : test;
afterEach(async () => { jest.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function recordProof(file: string) {
  const stat = await fs.lstat(file, { bigint: true });
  return { raw: await fs.readFile(file, 'utf8'), identity: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.nlink] };
}
async function portfolio(count: number, nested: boolean, pair: boolean) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'adoption-capacity-'))); roots.push(root);
  const locator = nested ? 'Notes/head.yaml' : 'head.yaml', head = path.join(root, locator);
  if (nested) await fs.mkdir(path.dirname(head));
  const content = 'entries: []\n'; await fs.writeFile(head, content, { mode: 0o600 });
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
  const store = new FileMemoryOwnerSnapshots({ coordinator });
  const unowned = (await store.readHeadSnapshot(locator)).token as UnownedFileMemoryToken;
  const interrupted = new FileMemoryOwnerSnapshots({ coordinator, afterPublication: phase => {
    if (phase === (pair ? 'reserved-registry' : 'active-registry')) throw new Error('controlled initial adoption interruption');
  } });
  await expect(interrupted.adoptUnowned(unowned)).rejects.toThrow('controlled initial adoption interruption');
  const hash = createHash('sha256').update(path.basename(head)).digest('hex');
  const sidecar = path.join(path.dirname(head), `.${hash}.memory-owner.json`);
  const ownerId = JSON.parse(await fs.readFile(sidecar, 'utf8')).ownerId as string;
  const owners = path.join(root, '.memory-owners', 'owners'), registry = path.join(owners, `${ownerId}.json`);
  // Valid ACTIVE persisted fixtures qualify recovery, not ordinary adoption throughput.
  for (let index = 1; index < count; index++) {
    const siblingLocator = path.posix.join(path.posix.dirname(locator), `Existing${index}.yaml`), target = path.join(root, siblingLocator);
    await fs.writeFile(target, content, { mode: 0o600 });
    const stat = await fs.stat(target, { bigint: true }), siblingOwner = randomUUID();
    const raw = JSON.stringify({ schema: 1, state: 'ACTIVE', userId: USER, ownerId: siblingOwner, locator: siblingLocator,
      revision: '1', contentHash: createHash('sha256').update(content).digest('hex'), fileIdentity: {
        device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
      } });
    const siblingHash = createHash('sha256').update(path.basename(target)).digest('hex');
    await fs.writeFile(path.join(path.dirname(target), `.${siblingHash}.memory-owner.json`), raw, { mode: 0o600 });
    await fs.writeFile(path.join(owners, `${siblingOwner}.json`), raw, { mode: 0o600 });
  }
  expect((await store.readHeadSnapshot(path.posix.join(path.posix.dirname(locator), 'Existing1.yaml'))).token.ownership).toBe('owned');
  return { root, head, sidecar, registry, owners, store, request: { locator, ownerId } };
}

describe('populated RESERVED adoption recovery', () => {
  it.each([false, true])('covers ownership-directory disappearance after discovery (both=%s)', async both => {
    const f = await portfolio(2, false, true), originalHead = await recordProof(f.head);
    const internals = f.store as unknown as { recoverAdoptionAtScope: (...args: unknown[]) => Promise<unknown> };
    const recover = internals.recoverAdoptionAtScope;
    jest.spyOn(internals, 'recoverAdoptionAtScope').mockImplementationOnce(async function(this: typeof internals, ...args) {
      // Exact test-owned removal occurs after resource discovery/reservation,
      // before the unchanged recovery proof establishes its authority baseline.
      await fs.rm(both ? path.dirname(f.owners) : f.owners, { recursive: true });
      return recover.apply(this, args);
    });
    const reads = jest.spyOn(FileMemoryAdoptionRecoveryScanBudget.prototype, 'read');
    expect((await f.store.recoverReservedAdoption(f.request)).status).toBe('known-adopted');
    expect(await recordProof(f.head)).toEqual(originalHead);
    const budgets = new Set(reads.mock.contexts as FileMemoryAdoptionRecoveryScanBudget[]);
    expect(budgets.size).toBe(1);
    const budget = [...budgets][0]; expect(budget.consumed).toBeLessThanOrEqual(budget.limit);
    expect((await f.store.readHeadSnapshot(f.request.locator)).token.ownership).toBe('owned');
  });
  it.each([[false, false], [false, true], [true, false], [true, true]])(
    'prepares missing ownership directories among 1000 unrelated files (nested=%s, parentPresent=%s)', async (nested, parentPresent) => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'adoption-missing-capacity-'))); roots.push(root);
      const locator = nested ? 'Notes/head.yaml' : 'head.yaml', head = path.join(root, locator);
      if (nested) await fs.mkdir(path.dirname(head));
      await fs.writeFile(head, 'entries: []\n');
      const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
      const store = new FileMemoryOwnerSnapshots({ coordinator });
      const interrupted = new FileMemoryOwnerSnapshots({ coordinator, afterPublication: phase => {
        if (phase === 'reserved-sidecar') throw new Error('actual pre-directory interruption');
      } });
      await expect(interrupted.adoptUnowned((await store.readHeadSnapshot(locator)).token as UnownedFileMemoryToken)).rejects.toThrow('actual pre-directory interruption');
      const hash = createHash('sha256').update(path.basename(head)).digest('hex');
      const sidecar = path.join(path.dirname(head), `.${hash}.memory-owner.json`);
      const ownerId = JSON.parse(await fs.readFile(sidecar, 'utf8')).ownerId as string;
      const parent = path.join(root, '.memory-owners');
      if (parentPresent) await fs.mkdir(parent, { mode: 0o700 });
      // These files are unrelated evidence, not an ACTIVE portfolio lacking its registries.
      const names = Array.from({ length: 1000 }, (_, index) => `unrelated-${index}`);
      await Promise.all(names.map(name => fs.writeFile(path.join(path.dirname(head), name), 'preserved')));
      const sentinel = path.join(path.dirname(head), names[999]), original = await recordProof(sentinel);
      const originalHead = await recordProof(head);
      expect((await store.recoverReservedAdoption({ locator, ownerId })).status).toBe('known-adopted');
      expect(await recordProof(head)).toEqual(originalHead); expect(await recordProof(sentinel)).toEqual(original);
      for (const name of names) expect(await fs.readFile(path.join(path.dirname(head), name), 'utf8')).toBe('preserved');
      expect(await store.recoverReservedAdoption({ locator, ownerId })).toEqual({ status: 'already-clean-no-attribution' });
    });
  for (const count of [100, 250, 1000]) {
    it.each([[false, false], [false, true], [true, false], [true, true]])(
      `recovers ${count} memories (nested=%s, pair=%s)`, async (nested, pair) => {
        const f = await portfolio(count, nested, pair);
        const files = [f.head, f.sidecar, f.registry];
        const before = await Promise.all(files.map(recordProof));
        const directories = [f.root, path.dirname(f.head), path.dirname(f.owners), f.owners];
        const names = await Promise.all(directories.map(directory => fs.readdir(directory).then(value => value.sort())));
        const read = jest.spyOn(FileMemoryAdoptionRecoveryScanBudget.prototype, 'read');
        const start = performance.now();
        let failure: { cause: unknown } | undefined;
        let result;
        try { result = await f.store.recoverReservedAdoption(f.request); } catch (cause) { failure = { cause }; }
        if (failure) {
          const error = failure.cause as { code?: string; cause?: { code?: string }; adopted?: boolean; token?: unknown };
          expect(error).toMatchObject({ code: 'EADOPTIONPENDING', cause: { code: 'EHEADRESOURCE' } });
          expect(error.adopted).not.toBe(true); expect(error.token).toBeUndefined();
          expect(await Promise.all(files.map(recordProof))).toEqual(before);
          expect(await Promise.all(directories.map(directory => fs.readdir(directory).then(value => value.sort())))).toEqual(names);
          const budget = read.mock.contexts[0] as FileMemoryAdoptionRecoveryScanBudget | undefined;
          process.stderr.write(`Adoption capacity negative ${JSON.stringify({ count, nested, pair, consumed: budget?.consumed, readCalls: read.mock.calls.length, code: error.code, causeCode: error.cause?.code, elapsedMs: performance.now() - start })}\n`);
          throw failure.cause;
        }
        expect(result).toMatchObject({ status: 'known-adopted' });
        const budgets = new Set(read.mock.contexts as FileMemoryAdoptionRecoveryScanBudget[]);
        expect(budgets.size).toBe(1);
        const budget = [...budgets][0];
        expect(budget.consumed).toBe(read.mock.calls.length);
        expect(budget.consumed).toBeLessThanOrEqual(budget.limit);
        expect(budget.limit).toBeLessThanOrEqual(376832);
        process.stderr.write(`Adoption capacity positive ${JSON.stringify({ count, nested, pair, consumed: budget.consumed, limit: budget.limit, elapsedMs: performance.now() - start })}\n`);
        expect(await recordProof(f.head)).toEqual(before[0]);
        const token = (result as { token: unknown }).token;
        expect((await f.store.readHeadSnapshot(f.request.locator)).token).toEqual(token);
        await expect(f.store.recoverReservedAdoption(f.request)).resolves.toEqual({ status: 'already-clean-no-attribution' });
      });
  }
});
