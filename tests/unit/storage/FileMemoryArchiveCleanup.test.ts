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
  const fence = new FileMemoryFence();
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER, fence });
  const owners = new FileMemoryOwnerSnapshots({ coordinator });
  const token = await owners.adoptUnowned((await owners.readHeadSnapshot(locator)).token as UnownedFileMemoryToken);
  const store = (afterCleanup?: (phase: ArchiveCleanupPhase) => Promise<void> | void) => new FileMemoryVolumeStore({ coordinator, owners, afterCleanup });
  const receipt = await store().createExclusive(token, { minimumVolume: 1, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-10-01') });
  const owner = path.join(token.tenantRoot, 'volumes', 'by-id', token.ownerId);
  return { root, token, owners, coordinator, fence, store, receipt, owner, slot: path.join(owner, 'v1'), intent: path.join(owner, 'v1.cleanup.json') };
}
function durableEvidence(receipt: Awaited<ReturnType<FileMemoryVolumeStore['createExclusive']>>) {
  const value = { ...receipt };
  Reflect.deleteProperty(value, 'operationId');
  return value;
}
afterEach(async () => { jest.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
describe('dormant exact protected file archive cleanup', () => {
  it.each([false, true])('removes only exact unreferenced archive, nested=%s', async nested => {
    const f = await fixture(nested);
    const before = await f.owners.readHeadSnapshot(f.token.locator);
    const result = await f.store().removeUnreferenced(f.token, f.receipt);
    expect(result).toMatchObject({ status: 'removed', receipt: durableEvidence(f.receipt) });
    expect(await fs.readdir(f.owner)).toEqual([]);
    expect(await f.owners.readHeadSnapshot(f.token.locator)).toEqual(before);
    expect(await f.store().removeUnreferenced(f.token, f.receipt)).toMatchObject({ status: 'absent' });
  });
  it('does not attribute removal when fence acquisition rejects before the operation', async () => {
    const f = await fixture(); const cause = new Error('controlled acquisition failure');
    const before = await fs.readdir(f.owner);
    const spy = jest.spyOn(f.fence, 'withTenantFence').mockRejectedValueOnce(cause);
    try {
      const result = await f.store().removeUnreferenced(f.token, f.receipt);
      expect(result).toEqual({ status: 'unknown', reason: 'query' });
      expect(result.cause).toBe(cause); expect(result).not.toHaveProperty('receipt');
      expect(await fs.readdir(f.owner)).toEqual(before);
      expect((await f.store().read(f.token, 1)).status).toBe('found');
    } finally { spy.mockRestore(); }
  });
  it('retains genuine removal after the real fence releases and its wrapper rejects', async () => {
    const f = await fixture(); const cause = new Error('controlled post-release failure');
    const original = f.fence.withTenantFence.bind(f.fence);
    const spy = jest.spyOn(f.fence, 'withTenantFence').mockImplementationOnce(async (root, operation) => {
      await original(root, operation);
      throw cause;
    });
    try {
      const result = await f.store().removeUnreferenced(f.token, f.receipt);
      expect(result).toMatchObject({ status: 'removed', reason: 'removed', receipt: durableEvidence(f.receipt) });
      expect(result.cause).toBe(cause); expect(await fs.readdir(f.owner)).toEqual([]);
      expect(await fs.readdir(path.join(f.root, '.memory-fences'))).not.toContain('tenant.lock');
      expect(await f.store().removeUnreferenced(f.token, f.receipt)).toEqual({ status: 'absent', reason: 'absent' });
    } finally { spy.mockRestore(); }
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
  it.each([false, true])('refuses reversed unrelated timestamps without changing evidence, retry=%s', async retry => {
    const f = await fixture();
    if (retry) await f.store(phase => { if (phase === 'intent-durable') throw new Error('controlled stop'); }).removeUnreferenced(f.token, f.receipt);
    const declaration = { volume: 2, file: `volumes/${f.token.ownerId}/v0002.yaml`, sha256: 'b'.repeat(64), entryCount: 0,
      sealedAt: '2026-10-01T00:00:00.000Z', firstEntryAt: '2026-10-01T01:00:00.000Z', lastEntryAt: '2026-10-01T00:00:00.000Z' };
    const token = await f.owners.updateOwnedHead(f.token, `volumes: ${JSON.stringify([declaration])}\nentries: []\n`);
    const payload = path.join(f.slot, `g-${f.receipt.generationId}`, 'payload.yaml');
    const bytes = await fs.readFile(payload); const identity = await fs.lstat(payload, { bigint: true });
    const names = await fs.readdir(f.owner); const head = await f.owners.readHeadSnapshot(token.locator);
    const intent = retry ? await fs.readFile(f.intent) : undefined;
    const result = await f.store().removeUnreferenced(token, f.receipt);
    expect(result).toMatchObject({ status: 'refused', reason: 'unsafe' }); expect(result).not.toHaveProperty('receipt');
    expect(await fs.readdir(f.owner)).toEqual(names); expect(await fs.readFile(payload)).toEqual(bytes);
    const after = await fs.lstat(payload, { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'] as const) expect(after[key]).toBe(identity[key]);
    if (retry) expect(await fs.readFile(f.intent)).toEqual(intent);
    expect(await f.owners.readHeadSnapshot(token.locator)).toEqual(head);
  });
  it.each([[null, null], ['2026-10-01T00:00:00.000Z', null], [null, '2026-10-01T00:00:00.000Z'],
    ['2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']])('accepts valid unrelated timestamp endpoints %s / %s', async (firstEntryAt, lastEntryAt) => {
    const f = await fixture();
    const declaration = { volume: 2, file: `volumes/${f.token.ownerId}/v0002.yaml`, sha256: 'b'.repeat(64), entryCount: 0,
      sealedAt: '2026-10-01T00:00:00.000Z', firstEntryAt, lastEntryAt };
    const token = await f.owners.updateOwnedHead(f.token, `volumes: ${JSON.stringify([declaration])}\nentries: []\n`);
    expect(await f.store().removeUnreferenced(token, f.receipt)).toMatchObject({ status: 'removed', receipt: durableEvidence(f.receipt) });
    expect(await fs.readdir(f.owner)).toEqual([]);
  });
  it.each(['fresh', 'intent-durable', 'after-metadata'])('refuses reversed archive metadata before further mutation (%s)', async boundary => {
    const f = await fixture(); const receipt = { ...f.receipt };
    const metadataPath = path.join(f.slot, `g-${receipt.generationId}`, 'metadata.json');
    if (boundary !== 'fresh') await f.store(phase => { if (phase === boundary) throw new Error('controlled stop'); }).removeUnreferenced(f.token, receipt);
    const firstEntryAt = '2026-10-01T01:00:00.000Z'; const lastEntryAt = '2026-10-01T00:00:00.000Z';
    if (boundary === 'fresh') {
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, firstEntryAt, lastEntryAt }));
      const stat = await fs.lstat(metadataPath, { bigint: true });
      receipt.metadataIdentity = { device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
    } else {
      const record = JSON.parse(await fs.readFile(f.intent, 'utf8'));
      Object.assign(record.metadata, { firstEntryAt, lastEntryAt }); await fs.writeFile(f.intent, JSON.stringify(record));
    }
    const names = await fs.readdir(f.owner); const selectedNames = await fs.readdir(f.slot);
    const head = await f.owners.readHeadSnapshot(f.token.locator);
    const evidence = async () => {
      const values = [];
      for (const named of [f.slot, path.join(f.slot, 'COMMITTED'), path.dirname(metadataPath),
        path.join(path.dirname(metadataPath), 'payload.yaml'), metadataPath]) {
        let stat;
        try { stat = await fs.lstat(named, { bigint: true }); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') { values.push({ named, absent: true }); continue; } throw cause; }
        values.push({ named, identity: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.nlink],
          bytes: stat.isFile() ? await fs.readFile(named) : undefined });
      }
      return values;
    };
    const original = await evidence();
    const intent = boundary === 'fresh' ? undefined : await fs.readFile(f.intent);
    const result = await f.store().removeUnreferenced(f.token, receipt);
    expect(result).toMatchObject({ status: 'refused', reason: 'unsafe' }); expect(result).not.toHaveProperty('receipt');
    expect(await fs.readdir(f.owner)).toEqual(names); expect(await fs.readdir(f.slot)).toEqual(selectedNames);
    if (intent) expect(await fs.readFile(f.intent)).toEqual(intent);
    expect(await evidence()).toEqual(original); expect(await f.owners.readHeadSnapshot(f.token.locator)).toEqual(head);
  });
  it('resumes immutable intent and never attributes a prior invocation removal', async () => {
    const f = await fixture(); const cause = new Error('controlled stop');
    const first = await f.store(phase => { if (phase === 'after-slot') throw cause; }).removeUnreferenced(f.token, f.receipt);
    expect(first).toMatchObject({ status: 'removed', receipt: durableEvidence(f.receipt) }); expect(first.cause).toBe(cause);
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
  it.each(['changed UUID', 'throwing getter'])('never persists or returns untrusted publication correlation (%s)', async kind => {
    const f = await fixture();
    const input = { ...f.receipt };
    const correlation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    if (kind === 'changed UUID') input.operationId = correlation;
    else Object.defineProperty(input, 'operationId', { get: () => { throw new Error('untrusted correlation'); } });
    const first = await f.store(phase => { if (phase === 'intent-durable') throw new Error('stop'); }).removeUnreferenced(f.token, input);
    expect(first.status).toBe('unknown'); expect(first).not.toHaveProperty('receipt');
    const record = JSON.parse(await fs.readFile(f.intent, 'utf8'));
    expect(record.receipt).toEqual(durableEvidence(f.receipt));
    expect(record.receipt).not.toHaveProperty('operationId');
    expect(record.operationId).toMatch(/^[0-9a-f-]{36}$/u); expect(record.operationId).not.toBe(correlation);
    const result = await f.store().removeUnreferenced(f.token, f.receipt);
    expect(result).toEqual({ status: 'removed', reason: 'removed', receipt: durableEvidence(f.receipt) });
    expect(result.receipt).not.toHaveProperty('operationId');
    expect(await fs.readdir(f.owner)).toEqual([]);
  });
  it.each([false, true])('rejects an altered receipt byte length before fresh or resumed cleanup (retry=%s)', async retry => {
    const f = await fixture();
    if (retry) {
      await f.store(phase => { if (phase === 'intent-durable') throw new Error('stop'); }).removeUnreferenced(f.token, f.receipt);
    }
    const receipt = { ...f.receipt, byteLength: f.receipt.byteLength + 1 };
    if (retry) {
      const record = JSON.parse(await fs.readFile(f.intent, 'utf8'));
      record.receipt.byteLength = receipt.byteLength;
      await fs.writeFile(f.intent, JSON.stringify(record));
    }
    const names = await fs.readdir(f.owner);
    const payloadPath = path.join(f.slot, `g-${f.receipt.generationId}`, 'payload.yaml');
    const before = await fs.lstat(payloadPath, { bigint: true });
    const bytes = await fs.readFile(payloadPath);
    const result = await f.store().removeUnreferenced(f.token, receipt);
    expect(result).toEqual({ status: 'refused', reason: 'mismatch' });
    expect(result).not.toHaveProperty('receipt');
    expect(await fs.readdir(f.owner)).toEqual(names); expect(await fs.readFile(payloadPath)).toEqual(bytes);
    const after = await fs.lstat(payloadPath, { bigint: true });
    expect([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs, after.nlink]).toEqual(
      [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs, before.nlink]);
    expect(await fs.readdir(f.slot)).toContain('COMMITTED');
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
  it.each(['v1.cleanupX', 'v1.cleanup.partial', 'v1unknown', 'v1.cleanup\nforeign'])('blocks unknown target residue %s in read, create and list', async residue => {
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
