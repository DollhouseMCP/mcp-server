import { afterEach, describe, expect, it as jestIt, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import { Dir, type Dirent } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryVolumeStore, type ArchiveCleanupPhase } from '../../../src/storage/FileMemoryVolumeStore.js';
const it = process.platform === 'win32' || !process.getuid ? jestIt.skip : jestIt;
const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
async function fixture(nested = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-cleanup-')); roots.push(root);
  const locator = nested ? 'Notes/Memory.yaml' : 'Memory.yaml';
  await fs.mkdir(path.dirname(path.join(root, locator)), { recursive: true });
  await fs.writeFile(path.join(root, locator), 'entries: []\n');
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
  const owners = new FileMemoryOwnerSnapshots({ coordinator });
  const token = await owners.adoptUnowned((await owners.readHeadSnapshot(locator)).token as UnownedFileMemoryToken);
  const store = (afterCleanup?: (phase: ArchiveCleanupPhase) => Promise<void> | void) => new FileMemoryVolumeStore({ coordinator, owners, afterCleanup });
  const receipt = await store().createExclusive(token, { minimumVolume: 1, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-10-01') });
  const owner = path.join(token.tenantRoot, 'volumes', 'by-id', token.ownerId);
  return { root, token, owners, coordinator, store, receipt, owner, slot: path.join(owner, 'v1'), intent: path.join(owner, 'v1.cleanup.json') };
}
afterEach(async () => { jest.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
describe('dormant exact protected file archive cleanup', () => {
  it.each([false, true])('removes only exact unreferenced archive, nested=%s', async nested => {
    const f = await fixture(nested);
    const before = await f.owners.readHeadSnapshot(f.token.locator);
    const result = await f.store().removeUnreferenced(f.token, f.receipt);
    expect(result).toMatchObject({ status: 'removed', receipt: f.receipt });
    expect(await fs.readdir(f.owner)).toEqual([]);
    expect(await f.owners.readHeadSnapshot(f.token.locator)).toEqual(before);
    expect(await f.store().removeUnreferenced(f.token, f.receipt)).toMatchObject({ status: 'absent' });
  });
  it('blocks target number even when its logical digest differs', async () => {
    const f = await fixture();
    const declaration = { volume: 1, file: `volumes/${f.token.ownerId}/v0001.yaml`, sha256: 'b'.repeat(64), entryCount: 0,
      sealedAt: '2026-10-01T00:00:00.000Z', firstEntryAt: null, lastEntryAt: null };
    const token = await f.owners.updateOwnedHead(f.token, `volumes: ${JSON.stringify([declaration])}\nentries: []\n`);
    const result = await f.store().removeUnreferenced(token, f.receipt);
    expect(result).toMatchObject({ status: 'refused', reason: 'referenced' });
    expect(await fs.readdir(f.owner)).toEqual(['v1']);
    expect((await f.store().read(token, 1)).status).toBe('found');
  });
  it('resumes immutable intent and never attributes a prior invocation removal', async () => {
    const f = await fixture(); const cause = new Error('controlled stop');
    const first = await f.store(phase => { if (phase === 'after-slot') throw cause; }).removeUnreferenced(f.token, f.receipt);
    expect(first).toMatchObject({ status: 'removed', receipt: f.receipt }); expect(first.cause).toBe(cause);
    const bytes = await fs.readFile(f.intent);
    const retry = await f.store().removeUnreferenced(f.token, f.receipt);
    expect(retry).toEqual({ status: 'absent', reason: 'absent' });
    expect(await fs.readdir(f.owner)).toEqual([]); expect(bytes.length).toBeLessThanOrEqual(8192);
  });
  it.each(['payload', 'directory'])('rejects a complete intent contradicting the original %s receipt', async kind => {
    const f = await fixture();
    await f.store(phase => { if (phase === 'intent-durable') throw new Error('stop'); }).removeUnreferenced(f.token, f.receipt);
    const record = JSON.parse(await fs.readFile(f.intent, 'utf8'));
    if (kind === 'payload') {
      const named = path.join(f.slot, `g-${f.receipt.generationId}`, 'payload.yaml');
      const bytes = await fs.readFile(named);
      await fs.rename(named, `${named}.original`); await fs.writeFile(named, bytes, { mode: 0o600 }); await fs.unlink(`${named}.original`);
      const value = await fs.lstat(named, { bigint: true });
      record.files.payload = { device: String(value.dev), inode: String(value.ino), size: String(value.size), mode: String(value.mode),
        uid: String(value.uid), nlink: String(value.nlink), type: 'file', mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs) };
    } else {
      const old = `${f.slot}.original`;
      await fs.rename(f.slot, old); await fs.mkdir(f.slot, { mode: 0o700 });
      for (const child of await fs.readdir(old)) await fs.rename(path.join(old, child), path.join(f.slot, child));
      await fs.rmdir(old);
      const value = await fs.lstat(f.slot, { bigint: true });
      record.namespace.S.identity = { device: String(value.dev), inode: String(value.ino), mode: String(value.mode), uid: String(value.uid), type: 'directory' };
    }
    await fs.writeFile(f.intent, JSON.stringify(record));
    const before = await fs.readFile(f.intent);
    expect(await f.store().removeUnreferenced(f.token, f.receipt)).toMatchObject({ status: 'refused', reason: 'mismatch' });
    expect(await fs.readFile(f.intent)).toEqual(before); expect(await fs.readdir(f.slot)).toContain('COMMITTED');
  });
  it('rejects marker metadata ABA across an interrupted invocation', async () => {
    const f = await fixture();
    await f.store(phase => { if (phase === 'intent-durable') throw new Error('stop'); }).removeUnreferenced(f.token, f.receipt);
    const marker = path.join(f.slot, 'COMMITTED'); const before = await fs.lstat(marker, { bigint: true });
    await fs.writeFile(path.join(marker, 'foreign'), 'x'); await fs.unlink(path.join(marker, 'foreign'));
    const changed = await fs.lstat(marker, { bigint: true }); expect(changed.ino).toBe(before.ino); expect(changed.ctimeNs).not.toBe(before.ctimeNs);
    expect(await f.store().removeUnreferenced(f.token, f.receipt)).toMatchObject({ status: 'refused', reason: 'unsafe' });
    expect(await fs.readdir(f.slot)).toContain('COMMITTED'); expect(await fs.readdir(marker)).toEqual([]);
  });
  it.each(['v1.cleanupX', 'v1.cleanup.partial', 'v1unknown'])('blocks unknown target residue %s in read, create and list', async residue => {
    const f = await fixture(); await fs.writeFile(path.join(f.owner, residue), 'foreign', { mode: 0o600 });
    await expect(f.store().read(f.token, 1)).rejects.toMatchObject({ code: 'EARCHIVEUNSAFE' });
    await expect(f.store().createExclusive(f.token, { minimumVolume: 1, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-10-01') })).rejects.toMatchObject({ code: 'EARCHIVEUNSAFE' });
    const list = await f.store().list(f.token);
    expect(list.complete).toBe(false); expect(list.entries).toHaveLength(0);
    expect(await fs.readFile(path.join(f.owner, residue), 'utf8')).toBe('foreign');
  });

  it.each([null, undefined, { code: 42 }, Object.defineProperty({}, 'code', { get: () => { throw new Error('getter'); } })])(
    'retains arbitrary primary cause without interrogating it into a replacement failure', async cause => {
      const f = await fixture();
      const result = await f.store(phase => { if (phase === 'intent-durable') throw cause; }).removeUnreferenced(f.token, f.receipt);
      expect(result.status).toBe('unknown'); expect(result.cause).toBe(cause);
      expect(Object.keys(result)).not.toContain('cause');
      expect(await fs.readdir(f.slot)).toContain('COMMITTED');
    });

  it('preserves a getter-bearing real read failure and actual descriptor close failure', async () => {
    const f = await fixture();
    const primary = Object.defineProperty({}, 'code', { get: () => { throw new Error('getter'); } });
    const secondary = new Error('close');
    (jest.spyOn(Dir.prototype, 'read') as unknown as ReturnType<typeof jest.fn<() => Promise<Dirent | null>>>).mockImplementation(async () => { throw primary; });
    jest.spyOn(Dir.prototype, 'close').mockImplementation(async function(this: Dir) { this.closeSync(); throw secondary; });
    const outcome = await f.store().removeUnreferenced(f.token, f.receipt);
    expect(outcome.status).toBe('refused'); expect(outcome.cause).toBeInstanceOf(AggregateError);
    expect((outcome.cause as AggregateError).cause).toBe(primary);
    expect((outcome.cause as AggregateError).errors).toEqual([primary, secondary]);
    expect(await fs.readdir(f.owner)).toEqual(['v1']);
  });

});
