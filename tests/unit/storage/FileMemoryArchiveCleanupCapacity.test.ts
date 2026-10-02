import { afterEach, describe, expect, it as jestIt, jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import { Dir, type Dirent, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type OwnedFileMemoryToken, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryVolumeStore, type ArchiveCleanupPhase } from '../../../src/storage/FileMemoryVolumeStore.js';

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
  const store = (afterCleanup?: (phase: ArchiveCleanupPhase) => void | Promise<void>) => new FileMemoryVolumeStore({ coordinator, owners, afterCleanup });
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
async function verifyRetained(f: Awaited<ReturnType<typeof fixture>>) {
  await verify(f.retained); await verify(f.foreign);
  for (const namespace of f.namespaces) expect((await fs.readdir(namespace.target)).sort()).toEqual(namespace.names);
}
afterEach(async () => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('file protected cleanup populated portfolios', () => {
  it.each([
    [false, 100, false], [false, 250, false], [false, 1000, false],
    [true, 100, false], [true, 250, false], [true, 1000, false],
    [false, 100, true], [false, 250, true], [false, 1000, true],
    [true, 100, true], [true, 250, true], [true, 1000, true],
  ] as const)('qualifies nested=%s owners=%i referenced=%s without altering foreign evidence', async (nested, count, referenced) => {
    const f = await fixture(nested, count);
    let token = f.token;
    if (referenced) token = await f.owners.updateOwnedHead(token, `volumes: ${JSON.stringify([{
      volume: 1, file: `volumes/${token.ownerId}/v0001.yaml`, sha256: 'b'.repeat(64), entryCount: 0,
      sealedAt: '2026-10-01T00:00:00.000Z', firstEntryAt: null, lastEntryAt: null,
    }])}\nentries: []\n`);
    const targetBefore = await treeEvidence(f.slot), headBefore = await f.owners.readHeadSnapshot(f.locator);
    const observed = observeReads(), started = performance.now();
    let result;
    try { result = await f.store().removeUnreferenced(token, f.receipt); }
    finally { observed.restore(); }
    const operationMs = performance.now() - started;
    expect(observed.measured.attemptedReads).toBeGreaterThan(0);
    expect(observed.measured.completedCensuses).toBeGreaterThan(0);
    expect(observed.measured.attemptedReads).toBeLessThanOrEqual(2_109_440);
    if (referenced) {
      expect(result).toMatchObject({ status: 'refused', reason: 'referenced' });
      await verify(targetBefore);
      expect(await fs.readdir(f.owner)).toEqual(['v1', 'v2']);
    } else {
      expect(result).toMatchObject({ status: 'removed', receipt: f.receipt });
      expect(await fs.readdir(f.owner)).toEqual(['v2']);
    }
    expect(await f.owners.readHeadSnapshot(f.locator)).toEqual(headBefore);
    await verifyRetained(f);
    process.stderr.write(`Cleanup capacity ${JSON.stringify({ nested, count, referenced, operationMs, ...observed.measured })}\n`);
  });
  it.each([[false, 'after-payload'], [true, 'after-payload'], [true, 'after-slot']] as const)(
    'retries nested=%s at %s with 1000 owners and fresh revision authority', async (nested, stop) => {
      const f = await fixture(nested, 1000), cause = new Error('controlled populated prefix');
      const first = await f.store(phase => { if (phase === stop) throw cause; }).removeUnreferenced(f.token, f.receipt);
      expect(first.status).toBe(stop === 'after-slot' ? 'removed' : 'unknown');
      expect(first.cause).toBe(cause);
      const originalIntent = await capture(f.intent);
      expect(originalIntent.bytes!.length).toBeLessThanOrEqual(8192);
      const current = (await f.owners.readHeadSnapshot(f.locator)).token as OwnedFileMemoryToken;
      const updated = await f.owners.updateOwnedHead(current, 'entries: []\nname: FreshRetry\n');
      expect(BigInt(updated.revision)).toBe(BigInt(f.token.revision) + 1n);
      const fresh = (await f.owners.readHeadSnapshot(f.locator)).token as OwnedFileMemoryToken;
      const observed = observeReads(), started = performance.now();
      let result;
      try { result = await f.store().removeUnreferenced(fresh, f.receipt); }
      finally { observed.restore(); }
      const operationMs = performance.now() - started;
      expect(result.status).toBe(stop === 'after-slot' ? 'absent' : 'removed');
      if (stop === 'after-slot') expect(result).not.toHaveProperty('receipt');
      else expect(result.receipt).toEqual(f.receipt);
      expect(await fs.readdir(f.owner)).toEqual(['v2']);
      expect((await f.owners.readHeadSnapshot(f.locator)).token).toEqual(updated);
      await verifyRetained(f);
      process.stderr.write(`Cleanup populated retry ${JSON.stringify({ nested, stop, operationMs, ...observed.measured })}\n`);
    });
});
