import { afterEach, describe, expect, it as jestIt, jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import { Dir, type Dirent, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryVolumeStore } from '../../../src/storage/FileMemoryVolumeStore.js';

const it = process.platform === 'win32' || !process.getuid ? jestIt.skip : jestIt;
const USER = '11111111-1111-4111-8111-111111111111';
const RAW = 'entries: []\n';
const roots: string[] = [];
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
function identity(stat: BigIntStats) {
  return { device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), mode: String(stat.mode),
    uid: String(stat.uid), links: String(stat.nlink), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) };
}
type Evidence = { target: string; identity: ReturnType<typeof identity>; bytes?: Buffer };
async function capture(target: string): Promise<Evidence> {
  const stat = await fs.lstat(target, { bigint: true });
  return { target, identity: identity(stat), bytes: stat.isFile() ? await fs.readFile(target) : undefined };
}
async function verify(evidence: readonly Evidence[]) {
  const changed: string[] = [];
  for (const before of evidence) {
    const stat = await fs.lstat(before.target, { bigint: true });
    if (!isDeepStrictEqual(identity(stat), before.identity) ||
      (before.bytes && !(await fs.readFile(before.target)).equals(before.bytes))) changed.push(before.target);
  }
  expect(changed).toEqual([]);
}
async function treeEvidence(root: string): Promise<Evidence[]> {
  const result: Evidence[] = [];
  async function walk(target: string) {
    const value = await capture(target); result.push(value);
    if (!value.bytes) for (const name of (await fs.readdir(target)).sort()) await walk(path.join(target, name));
  }
  await walk(root); return result;
}

async function fixture(nested: boolean, count: number) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'archive-cleanup-capacity-')));
  roots.push(root);
  const locator = nested ? 'Notes/Memory.yaml' : 'Memory.yaml';
  await fs.mkdir(path.dirname(path.join(root, locator)), { recursive: true });
  await fs.writeFile(path.join(root, locator), RAW);
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
  const owners = new FileMemoryOwnerSnapshots({ coordinator });
  const token = await owners.adoptUnowned((await owners.readHeadSnapshot(locator)).token as UnownedFileMemoryToken);
  const store = () => new FileMemoryVolumeStore({ coordinator, owners });
  const input = { minimumVolume: 1, rawContent: RAW, entryCount: 0, sealedAt: new Date('2026-10-01T00:00:00Z') };
  const receipt = await store().createExclusive(token, input);
  const foreignReceipt = await store().createExclusive(token, { ...input, minimumVolume: 2 });
  const owner = path.join(root, 'volumes', 'by-id', token.ownerId);
  const foreign = await treeEvidence(path.join(owner, `v${foreignReceipt.volume}`));
  const retained: Evidence[] = [];
  // Strict persistent fixture setup, not a claim about adoption throughput. Every
  // record binds the actual captured inode/bytes and uses the released ACTIVE format.
  for (let index = 0; index < count; index++) {
    const existing = path.posix.join(path.posix.dirname(locator), `Existing${index}.yaml`);
    const target = path.join(root, existing), ownerId = randomUUID();
    await fs.writeFile(target, RAW, { mode: 0o600 });
    const stat = await fs.lstat(target, { bigint: true });
    const record = JSON.stringify({ schema: 1, state: 'ACTIVE', userId: USER, ownerId, locator: existing, revision: '1',
      contentHash: hash(RAW), fileIdentity: { device: String(stat.dev), inode: String(stat.ino), size: String(stat.size),
        mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) } });
    const sidecar = path.join(path.dirname(target), `.${hash(path.posix.basename(existing))}.memory-owner.json`);
    const registry = path.join(root, '.memory-owners', 'owners', `${ownerId}.json`);
    const archiveOwner = path.join(root, 'volumes', 'by-id', ownerId);
    await fs.writeFile(sidecar, record, { mode: 0o600 });
    await fs.writeFile(registry, record, { mode: 0o600 });
    await fs.mkdir(archiveOwner, { mode: 0o700 });
    retained.push(await capture(target), await capture(sidecar), await capture(registry), await capture(archiveOwner));
  }
  expect((await owners.readHeadSnapshot(path.posix.join(path.posix.dirname(locator), 'Existing0.yaml'))).token.ownership).toBe('owned');
  const namespaces = await Promise.all([path.dirname(path.join(root, locator)), path.join(root, '.memory-owners', 'owners'),
    path.join(root, 'volumes', 'by-id')].map(async target => ({ target, names: (await fs.readdir(target)).sort() })));
  return { root, locator, owners, token, store, receipt, owner, retained, foreign, namespaces,
    slot: path.join(owner, 'v1'), intent: path.join(owner, 'v1.cleanup.json') };
}
function observeReads() {
  const methods = Dir.prototype as unknown as { read: () => Promise<Dirent | null> };
  const original = methods.read;
  const measured = { attemptedReads: 0, completedCensuses: 0 };
  const spy = jest.spyOn(methods, 'read').mockImplementation(async function(this: Dir) {
    measured.attemptedReads++;
    const entry = await original.call(this);
    if (!entry) measured.completedCensuses++;
    return entry;
  });
  return { measured, restore: () => spy.mockRestore() };
}

afterEach(async () => { jest.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
describe('dormant head DELETE populated owner portfolios', () => {
  it.each([100, 250, 1000].flatMap(count => [false, true].map(nested => [count, nested] as const)))(
    'retains all foreign owner evidence at %i existing owners, nested=%s', async (count, nested) => {
      const f = await fixture(nested, count);
      const archived = await treeEvidence(f.owner), reads = observeReads(), started = performance.now();
      let result;
      try { result = await f.owners.deleteOwned({ operationId: randomUUID(), expectedToken: f.token }); }
      finally { reads.restore(); }
      expect(result.status).toBe('head-deleted');
      expect(reads.measured.attemptedReads).toBeGreaterThan(0);
      expect(reads.measured.completedCensuses).toBeGreaterThan(0);
      expect(reads.measured.attemptedReads).toBeLessThanOrEqual(532480);
      console.info(JSON.stringify({ label: 'DELETE populated fixture', count, nested, operationMs: performance.now() - started, ...reads.measured }));
      await verify(f.retained); await verify(archived);
      const parent = path.dirname(path.join(f.root, f.locator));
      const sidecarName = `.${hash(path.posix.basename(f.locator))}.memory-owner.json`;
      for (const namespace of f.namespaces) {
        const expected = namespace.target === parent ? namespace.names.filter(name => name !== path.basename(f.locator) && name !== sidecarName) : namespace.names;
        expect((await fs.readdir(namespace.target)).sort()).toEqual(expected);
      }
      await expect(fs.lstat(path.join(f.root, f.locator))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  it.each([[false, 'pair-durable'], [true, 'pair-durable'], [true, 'head-durable']] as const)(
    'retains populated recovery authority at 1,000 owners, nested=%s phase=%s', async (nested, phase) => {
      const f = await fixture(nested, 1000), archived = await treeEvidence(f.owner);
      let stop = true, reached = false; const cause = new Error('actual durable portfolio interruption');
      const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: f.root, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
      const owners = new FileMemoryOwnerSnapshots({ coordinator, afterDeletePublication: current => { if (stop && current === phase) { reached = true; throw cause; } } });
      const request = { operationId: randomUUID(), expectedToken: f.token };
      await expect(owners.deleteOwned(request)).rejects.toMatchObject({ cause }); expect(reached).toBe(true); stop = false;
      const reads = observeReads(); let result;
      try { result = await owners.deleteOwned(request); } finally { reads.restore(); }
      expect(result.status).toBe(phase === 'head-durable' ? 'already-head-deleted' : 'head-deleted');
      if (phase === 'head-durable') expect(result.evidence).not.toHaveProperty('locator');
      expect(reads.measured.attemptedReads).toBeGreaterThan(0);
      expect(reads.measured.attemptedReads).toBeLessThanOrEqual(532480);
      await verify(f.retained); await verify(archived);
      for (const namespace of f.namespaces) {
        const parent = path.dirname(path.join(f.root, f.locator)), sidecar = `.${hash(path.posix.basename(f.locator))}.memory-owner.json`;
        const expected = namespace.target === parent ? namespace.names.filter(name => name !== path.basename(f.locator) && name !== sidecar) : namespace.names;
        expect((await fs.readdir(namespace.target)).sort()).toEqual(expected);
      }
    });

});
