import { afterEach, beforeEach, describe, expect, it as jestIt, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type DeletePublication, type UnownedFileMemoryToken, type FileMemorySnapshot } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryOwnedDelete } from '../../../src/storage/FileMemoryOwnedDelete.js';
import { FileMemoryVolumeStore } from '../../../src/storage/FileMemoryVolumeStore.js';
const it = process.platform === 'win32' || !process.getuid ? jestIt.skip : jestIt;
const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
async function fixture(nested = false, hook?: (phase: DeletePublication) => Promise<void> | void, overrideLocator?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-delete-')); roots.push(root);
  const locator = overrideLocator ?? (nested ? 'Notes/Memory.yaml' : 'Memory.yaml');
  await fs.mkdir(path.dirname(path.join(root, locator)), { recursive: true }); await fs.writeFile(path.join(root, locator), 'entries: []\n');
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
  const owners = new FileMemoryOwnerSnapshots({ coordinator, afterDeletePublication: hook });
  const token = await owners.adoptUnowned((await owners.readHeadSnapshot(locator)).token as UnownedFileMemoryToken);
  const archives = new FileMemoryVolumeStore({ coordinator, owners });
  const archive = await archives.createExclusive(token, { minimumVolume: 1, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-10-01') });
  const request = { operationId: randomUUID(), expectedToken: token };
  const archiveRoot = path.join(token.tenantRoot, 'volumes', 'by-id', token.ownerId);
  return { root, token, owners, archives, archive, request, coordinator, archiveRoot };
}
async function tree(root: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await fs.readdir(root)).filter(name => name !== '.memory-fences').sort()) {
    const named = path.join(root, name), stat = await fs.lstat(named, { bigint: true });
    result.push({ name, identity: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.nlink],
      bytes: stat.isFile() ? await fs.readFile(named) : undefined, children: stat.isDirectory() ? await tree(named) : undefined });
  }
  return result;
}
afterEach(async () => { jest.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
describe('dormant exact head DELETE with owner erasure pending', () => {
  it.each([false, true])('deletes only the exact head and leaves minimal old-owner tombstone, nested=%s', async nested => {
    const f = await fixture(nested);
    await fs.mkdir(path.join(f.archiveRoot, 'v99.partial'), { mode: 0o700 });
    await fs.writeFile(path.join(f.archiveRoot, 'v99.partial', 'unindexed.bin'), Buffer.from([0, 255, 17]));
    await fs.writeFile(path.join(f.archiveRoot, 'v17.cleanup.json'), '{malformed pending cleanup');
    await fs.writeFile(path.join(f.archiveRoot, 'unknown.tmp'), 'unindexed temporary bytes');
    const archive = await tree(f.archiveRoot);
    const result = await f.owners.deleteOwned(f.request);
    expect(result).toMatchObject({ status: 'head-deleted', erasure: 'pending', evidence: { ownerId: f.token.ownerId, operationId: f.request.operationId } });
    await expect(fs.lstat(path.join(f.root, f.token.locator))).rejects.toMatchObject({ code: 'ENOENT' });
    const tombstone = JSON.parse(await fs.readFile(path.join(f.root, '.memory-owners', 'owners', `${f.token.ownerId}.json`), 'utf8'));
    expect(tombstone).toEqual({ schema: 1, state: 'HEAD_DELETED', userId: USER, ownerId: f.token.ownerId, operationId: f.request.operationId });
    expect(await tree(f.archiveRoot)).toEqual(archive);
    expect(await f.owners.deleteOwned(f.request)).toMatchObject({ status: 'already-head-deleted', erasure: 'pending' });
  });
  it.each(['base-durable', 'registry-durable', 'pair-durable', 'head-durable', 'terminal-durable'] as DeletePublication[])(
    'retries only complete durable phase %s without touching archives', async boundary => {
      let stop = true; const cause = new Error('controlled durable-phase stop');
      const f = await fixture(false, phase => { if (stop && phase === boundary) throw cause; });
      const archive = await tree(f.archiveRoot);
      await expect(f.owners.deleteOwned(f.request)).rejects.toMatchObject({ cause }); stop = false;
      expect(await tree(f.archiveRoot)).toEqual(archive);
      expect(await f.owners.deleteOwned(f.request)).toMatchObject({ status: ['head-durable', 'terminal-durable'].includes(boundary) ? 'already-head-deleted' : 'head-deleted', erasure: 'pending' });
      expect(await tree(f.archiveRoot)).toEqual(archive);
    });
  it('same-name CREATE receives a different UUID and an old-owner retry preserves it', async () => {
    const f = await fixture(); await f.owners.deleteOwned(f.request);
    const created = await f.owners.createOwned({ operationId: randomUUID(), locator: f.token.locator, content: `entries: []\n#${'x'.repeat(9000)}\n` });
    expect(created.ownerId).not.toBe(f.token.ownerId); const current = await f.owners.readHeadSnapshot(created.locator);
    expect(await f.owners.deleteOwned(f.request)).toMatchObject({ status: 'already-head-deleted' });
    expect(await f.owners.readHeadSnapshot(created.locator)).toEqual(current);
    await expect(f.archives.createExclusive(f.token, { minimumVolume: 2, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-10-01') })).rejects.toBeDefined();
  });
  it.each([false, true])('checks full original identity rather than only reused inode, exactOriginal=%s', async exactOriginal => {
    const f = await fixture(); await f.owners.deleteOwned(f.request);
    const created = await f.owners.createOwned({ operationId: randomUUID(), locator: f.token.locator, content: 'entries: []\n# genuinely different replacement content\n' });
    expect(created.ownerId).not.toBe(f.token.ownerId);
    const current = await f.owners.readHeadSnapshot(created.locator);
    expect(current.token.fileIdentity).not.toEqual(f.token.fileIdentity);
    const before = await tree(f.root), target = path.join(f.token.tenantRoot, f.token.locator);
    type Identity = typeof f.token.fileIdentity;
    type Actual = { identity: Identity; [key: string]: unknown };
    type Internals = { read: (target: string, limit: number, links?: string, privateFile?: boolean) => Promise<Actual> };
    const internals = FileMemoryOwnedDelete.prototype as unknown as Internals, originalRead = internals.read;
    let observations = 0, ordinaryReads = 0;
    const reused = (actual: Identity): Identity => exactOriginal ? { ...f.token.fileIdentity } :
      { ...actual, device: f.token.fileIdentity.device, inode: f.token.fileIdentity.inode };
    // Disclosed descriptor/token observation injection, not a real inode-allocation guarantee.
    // All tracked head rereads agree; full real-tree verification stays outside the spy.
    jest.spyOn(internals, 'read').mockImplementation(async function(this: Internals, named, limit, links, privateFile) {
      const actual = await originalRead.call(this, named, limit, links, privateFile);
      if (named !== target) return actual;
      observations++; return { ...actual, identity: reused(actual.identity) };
    });
    type Reader = { readAtRoot: (...args: unknown[]) => Promise<FileMemorySnapshot> };
    const reader = f.owners as unknown as Reader, originalSnapshot = reader.readAtRoot;
    jest.spyOn(reader, 'readAtRoot').mockImplementation(async function(this: Reader, ...args) {
      const actual = await originalSnapshot.apply(this, args); ordinaryReads++;
      expect(actual.token.ownership).toBe('owned');
      return { ...actual, token: { ...actual.token, fileIdentity: reused(actual.token.fileIdentity) } };
    });
    const outcome = await f.owners.deleteOwned(f.request).catch(value => value);
    expect(observations).toBeGreaterThan(0);
    if (exactOriginal) {
      expect(ordinaryReads).toBe(0); expect(outcome.code).toBe('EHEADCONFLICT');
      expect(outcome).not.toHaveProperty('result');
    } else {
      expect(ordinaryReads).toBe(1);
      expect(outcome).toEqual({ status: 'already-head-deleted', erasure: 'pending', evidence: {
        tenantRoot: f.token.tenantRoot, userId: USER, ownerId: f.token.ownerId, operationId: f.request.operationId } });
      expect(outcome.evidence).not.toHaveProperty('locator');
    }
    jest.restoreAllMocks(); expect(await tree(f.root)).toEqual(before);
    expect(await f.owners.readHeadSnapshot(created.locator)).toEqual(current);
  });
  it.each(['after-registry', 'after-sidecar', 'after-head-unlink', 'after-terminal-registry'] as DeletePublication[])(
    'preserves unrecorded mutation gap %s rather than promoting its phase', async boundary => {
      let stop = true; const f = await fixture(false, phase => { if (stop && phase === boundary) throw new Error('gap'); });
      await expect(f.owners.deleteOwned(f.request)).rejects.toBeDefined(); stop = false;
      const before = await tree(f.root);
      await expect(f.owners.deleteOwned(f.request)).rejects.toBeDefined();
      expect(await tree(f.root)).toEqual(before);
    });
  it('terminal observation contains no caller-supplied locator or historical head fields', async () => {
    const f = await fixture(); await f.owners.deleteOwned(f.request);
    const observed = await f.owners.deleteOwned(f.request);
    expect(observed.evidence).toEqual({ tenantRoot: f.token.tenantRoot, userId: USER, ownerId: f.token.ownerId, operationId: f.request.operationId });
  });
  it('refuses an unowned same-name replacement and preserves its bytes', async () => {
    const f = await fixture(); await f.owners.deleteOwned(f.request);
    const target = path.join(f.root, f.token.locator); await fs.writeFile(target, 'unowned replacement\n');
    const before = await tree(f.root);
    await expect(f.owners.deleteOwned(f.request)).rejects.toBeDefined();
    expect(await tree(f.root)).toEqual(before);
  });
  it('preserves the exact direct postcapture failure through both public wrappers', async () => {
    const cause = new Error('actual postcapture audit boundary');
    const f = await fixture(false, phase => { if (phase === 'after-audit') throw cause; });
    const error = await f.owners.deleteOwned(f.request).catch(value => value);
    expect(error).toMatchObject({ code: 'EHEADDELETED', headDeleted: true, cause });
    expect(error.cause).toBe(cause);
    expect(error.result.status).toBe('head-deleted');
  });

  it('observes a genuinely owned large replacement with supported public head mode', async () => {
    const f = await fixture(); await f.owners.deleteOwned(f.request);
    const target = path.join(f.root, f.token.locator);
    await fs.writeFile(target, `entries: []\n#${'x'.repeat(9000)}\n`, { mode: 0o644 });
    const replacement = await f.owners.adoptUnowned((await f.owners.readHeadSnapshot(f.token.locator)).token as UnownedFileMemoryToken);
    expect(replacement.ownerId).not.toBe(f.token.ownerId);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o644);
    const before = await tree(f.root);
    expect(await f.owners.deleteOwned(f.request)).toMatchObject({ status: 'already-head-deleted' });
    expect(await tree(f.root)).toEqual(before);
  });

  it('refuses an old-owner sidecar beside a clean terminal tombstone', async () => {
    const f = await fixture();
    const ownerDir = path.dirname(path.join(f.root, f.token.locator));
    const sideName = (await fs.readdir(ownerDir)).find(name => name.endsWith('.memory-owner.json'))!;
    const sidePath = path.join(ownerDir, sideName), raw = await fs.readFile(sidePath);
    await f.owners.deleteOwned(f.request); await fs.writeFile(sidePath, raw, { mode: 0o600 });
    const before = await tree(f.root);
    await expect(f.owners.deleteOwned(f.request)).rejects.toBeDefined();
    expect(await tree(f.root)).toEqual(before);
  });
  it('does not attribute an older genuine deletion error to a new captured result', async () => {
    let replay: unknown; const firstCause = new Error('first late cause');
    const f = await fixture(false, phase => { if (phase === 'after-audit') throw replay ?? firstCause; });
    const first = await f.owners.deleteOwned(f.request).catch(value => value);
    expect(first).toMatchObject({ code: 'EHEADDELETED', headDeleted: true, cause: firstCause, result: { status: 'head-deleted' } }); replay = first;
    const token = await f.owners.createOwned({ operationId: randomUUID(), locator: f.token.locator, content: 'entries: []\n' });
    const second = await f.owners.deleteOwned({ operationId: randomUUID(), expectedToken: token }).catch(value => value);
    expect(second).not.toBe(first); expect(second.cause).toBe(first);
    expect(second.result.evidence.ownerId).toBe(token.ownerId);
    expect(second.result).not.toBe(first.result);
  });
  it.each([false, true])('canonical generated metadata ignores request identity insertion order, reversed=%s', async reversed => {
    let stop = true, reached = false; const cause = new Error('durable stop');
    const f = await fixture(false, phase => { if (stop && phase === 'pair-durable') { reached = true; throw cause; } });
    const original = f.token.fileIdentity;
    const fileIdentity = reversed ? { ctimeNs: original.ctimeNs, mtimeNs: original.mtimeNs, size: original.size, inode: original.inode, device: original.device } : { ...original };
    const request = { ...f.request, expectedToken: { ...f.token, fileIdentity } };
    await expect(f.owners.deleteOwned(request)).rejects.toMatchObject({ cause }); expect(reached).toBe(true); stop = false;
    expect(await f.owners.deleteOwned(request)).toMatchObject({ status: 'head-deleted' });
  });

  (process.platform === 'darwin' ? it : jestIt.skip)('refuses generated stage PATH_MAX overflow before publishing an intent', async () => {
    const f = await fixture();
    const canonicalRoot = f.token.tenantRoot;
    let remaining = 1024 - 140 - Buffer.byteLength(canonicalRoot) - 1;
    const components: string[] = [];
    while (remaining > 120) { components.push('d'.repeat(120)); remaining -= 121; }
    components.push('d'.repeat(remaining));
    const locator = `${components.join('/')}/Long.yaml`, target = path.join(canonicalRoot, locator);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'entries: []\n');
    const token = await f.owners.adoptUnowned((await f.owners.readHeadSnapshot(locator)).token as UnownedFileMemoryToken);
    const before = await tree(f.root);
    const error = await f.owners.deleteOwned({ operationId: randomUUID(), expectedToken: token }).catch(value => value);
    expect(error).toMatchObject({ code: 'EHEADCONFLICT', cause: { code: 'EHEADRESOURCE' } });
    expect(await tree(f.root)).toEqual(before);
  });

  it('refuses contradictory terminal metadata while the original head and sidecar survive', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, '.memory-owners', 'owners', `${f.token.ownerId}.json`), JSON.stringify({ schema: 1, state: 'HEAD_DELETED', userId: USER, ownerId: f.token.ownerId, operationId: f.request.operationId }));
    const before = await tree(f.root);
    await expect(f.owners.deleteOwned(f.request)).rejects.toBeDefined();
    expect(await tree(f.root)).toEqual(before);
  });
  it.each(['head-mode', 'prior-size'] as const)('refuses malformed persisted %s before another mutation', async kind => {
    let stop = true, reached = false; const boundary = kind === 'head-mode' ? 'base-durable' : 'registry-durable', cause = new Error('complete record stop');
    const f = await fixture(false, phase => { if (stop && phase === boundary) { reached = true; throw cause; } });
    await expect(f.owners.deleteOwned(f.request)).rejects.toMatchObject({ cause }); expect(reached).toBe(true); stop = false;
    const journal = path.join(path.dirname(path.join(f.root, f.token.locator)), `.${createHash('sha256').update(path.basename(f.token.locator)).digest('hex')}.memory-write.json`);
    const record = JSON.parse(await fs.readFile(journal, 'utf8'));
    if (kind === 'head-mode') record.baseline.originalChildren.head.mode = '0'; else record.prior.identity.size = '8193';
    await fs.writeFile(journal, JSON.stringify(record)); const before = await tree(f.root);
    await expect(f.owners.deleteOwned(f.request)).rejects.toBeDefined();
    expect(await tree(f.root)).toEqual(before);
  });
  it('rechecks active operation authority before unlinking the original head', async () => {
    let revoked = false;
    const f = await fixture(false, phase => { if (phase === 'before-head-unlink') revoked = true; });
    const original = f.coordinator.requireActiveOperationScope.bind(f.coordinator);
    const cause = Object.assign(new Error('controlled operation revocation'), { code: 'ELEASEEXPIRED' });
    jest.spyOn(f.coordinator, 'requireActiveOperationScope').mockImplementation(scope => { const valid = original(scope); if (revoked) throw cause; return valid; });
    const headIdentity = await fs.lstat(path.join(f.root, f.token.locator), { bigint: true });
    const headBefore = await fs.readFile(path.join(f.root, f.token.locator)), archiveBefore = await tree(f.archiveRoot);
    await expect(f.owners.deleteOwned(f.request)).rejects.toMatchObject({ cause }); expect(revoked).toBe(true);
    expect(await fs.readFile(path.join(f.root, f.token.locator))).toEqual(headBefore);
    const after = await fs.lstat(path.join(f.root, f.token.locator), { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'] as const) expect(after[key]).toBe(headIdentity[key]);
    expect(await tree(f.archiveRoot)).toEqual(archiveBefore);
  });
  it('retains null primary and actual close failure identities at the partial intent', async () => {
    let partial = false; const secondary = new Error('controlled real close failure');
    const f = await fixture(false, phase => { if (phase === 'partial-base') { partial = true; throw null; } });
    type Internals = { closed: (handle: fs.FileHandle, body: () => Promise<unknown>) => Promise<unknown> };
    const internals = FileMemoryOwnedDelete.prototype as unknown as Internals, original = internals.closed;
    jest.spyOn(internals, 'closed').mockImplementation(function(this: Internals, handle, body) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); if (partial) throw secondary; };
      return original.call(this, handle, body);
    });
    const error = await f.owners.deleteOwned(f.request).catch(value => value);
    expect(partial).toBe(true); expect(error.cause).toBeNull(); expect(error.closeCause).toBe(secondary);
    expect(error).not.toHaveProperty('result');
    expect(await fs.readFile(path.join(f.root, f.token.locator), 'utf8')).toBe('entries: []\n');
  });

  it('keeps final directory close refusal ambiguous without capturing a head-deleted result', async () => {
    let final = false, refused = false;
    const cause = new Error('controlled final directory close refusal');
    const f = await fixture(false, phase => { if (phase === 'after-intent-retirement') final = true; });
    const archive = await tree(f.archiveRoot);
    type Internals = { closed: (handle: fs.FileHandle, body: () => Promise<unknown>) => Promise<unknown> };
    const internals = FileMemoryOwnedDelete.prototype as unknown as Internals, original = internals.closed;
    jest.spyOn(internals, 'closed').mockImplementation(function(this: Internals, handle, body) {
      if (final) {
        const sync = handle.sync.bind(handle), close = handle.close.bind(handle);
        let synced = false;
        handle.sync = async () => { await sync(); synced = true; };
        handle.close = async () => { await close(); if (synced) { refused = true; throw cause; } };
      }
      return original.call(this, handle, body);
    });
    const error = await f.owners.deleteOwned(f.request).catch(value => value);
    expect(final).toBe(true); expect(refused).toBe(true);
    expect(error).toMatchObject({ code: 'EHEADCOMMITUNKNOWN' }); expect(error.cause).toBe(cause);
    expect(error).not.toHaveProperty('result'); expect(error).not.toHaveProperty('headDeleted');
    await expect(fs.lstat(path.join(f.token.tenantRoot, f.token.locator))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await fs.readFile(path.join(f.token.tenantRoot, '.memory-owners', 'owners', `${f.token.ownerId}.json`), 'utf8')))
      .toEqual({ schema: 1, state: 'HEAD_DELETED', userId: USER, ownerId: f.token.ownerId, operationId: f.request.operationId });
    expect(await tree(f.archiveRoot)).toEqual(archive);
  });

  it('refuses a complete phase envelope overflow before the first intent artifact', async () => {
    const f = await fixture(), locator = `${Array.from({ length: 70 }, () => 'd').join('/')}/Deep.yaml`;
    const target = path.join(f.root, locator); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'entries: []\n');
    const token = await f.owners.adoptUnowned((await f.owners.readHeadSnapshot(locator)).token as UnownedFileMemoryToken);
    const before = await tree(f.root);
    const error = await f.owners.deleteOwned({ operationId: randomUUID(), expectedToken: token }).catch(value => value);
    expect(error).toMatchObject({ code: 'EHEADCONFLICT', cause: { code: 'EHEADRESOURCE' } });
    expect(await tree(f.root)).toEqual(before);
  });
  describe('overflowing admission census fixture', () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    // Approved scoped contract: fixture creation has its own 10-second bound;
    // both complete trees, refusal and equality remain in the 10-second case.
    beforeEach(async () => {
      const started = process.hrtime.bigint();
      const mark = (phase: string) => process.stderr.write(`[owned-delete-overflow] scope=fixture ${phase} elapsedMs=${Number(process.hrtime.bigint() - started) / 1e6}\n`);
      mark('fixture-BEGIN');
      f = await fixture();
      mark('fixture-END');
      mark('4100-setup-BEGIN');
      for (let offset = 0; offset < 4100; offset += 16) {
        const batch = await Promise.allSettled(Array.from({ length: Math.min(16, 4100 - offset) }, (_, index) => fs.writeFile(path.join(f.root, `Foreign${offset + index}`), 'unchanged')));
        for (const entry of batch) if (entry.status === 'rejected') throw entry.reason;
      }
      mark('4100-setup-END');
    }, 10000);
    it('refuses an overflowing admission census before intent publication', async () => {
      const started = process.hrtime.bigint();
      const mark = (phase: string) => process.stderr.write(`[owned-delete-overflow] scope=operation-verification ${phase} elapsedMs=${Number(process.hrtime.bigint() - started) / 1e6}\n`);
      mark('before-tree-BEGIN');
      const before = await tree(f.root);
      mark('before-tree-END');
      mark('delete-refusal-BEGIN');
      await expect(f.owners.deleteOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT', cause: { code: 'EHEADRESOURCE' } });
      mark('delete-refusal-END');
      mark('after-tree-BEGIN');
      const after = await tree(f.root);
      mark('after-tree-END');
      mark('equality-BEGIN');
      expect(after).toEqual(before);
      mark('equality-END');
    }, 10000);
  });

  it.each(['read', 'update', 'archive'] as const)('pending DELETING owner blocks ordinary %s without changing residual evidence', async action => {
    const cause = new Error('actual registry durable interruption'); let reached = false;
    const f = await fixture(false, phase => { if (phase === 'registry-durable') { reached = true; throw cause; } });
    await expect(f.owners.deleteOwned(f.request)).rejects.toMatchObject({ cause }); expect(reached).toBe(true);
    const before = await tree(f.root);
    const operation = action === 'read' ? f.owners.readHeadSnapshot(f.token.locator) : action === 'update' ? f.owners.updateOwnedHead(f.token, 'name: forbidden\nentries: []\n') :
      f.archives.createExclusive(f.token, { minimumVolume: 2, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-10-01') });
    await expect(operation).rejects.toBeDefined(); expect(await tree(f.root)).toEqual(before);
  });

  it('rejects an unsupported platform before acquiring a tenant fence', async () => {
    const f = await fixture(), before = await tree(f.root);
    const acquire = jest.spyOn(FileMemoryFence.prototype, 'withFence');
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'freebsd' });
    try {
      await expect(f.owners.deleteOwned(f.request)).rejects.toThrow('Managed DELETE supports Linux and Darwin only');
      expect(acquire).not.toHaveBeenCalled(); expect(await tree(f.root)).toEqual(before);
    } finally { Object.defineProperty(process, 'platform', descriptor); }
  });

  it.each(['.memory-owners', '.memory-owners/owners'])('refuses canonical archive identity aliasing captured directory %s', async locator => {
    const f = await fixture(), before = await tree(f.root);
    const canonical = await fs.lstat(path.join(f.root, locator), { bigint: true });
    type Internals = {
      canonicalVolume(): Promise<BigIntStats | undefined>;
      validateConfinement(before: BigIntStats[], after: BigIntStats[], volumeBefore?: BigIntStats, volumeAfter?: BigIntStats): void;
    };
    const internals = FileMemoryOwnedDelete.prototype as unknown as Internals;
    const observe = internals.canonicalVolume, validate = internals.validateConfinement;
    let observations = 0, reached = false, result: unknown;
    // Observe the real canonical archive first, then model its physical O/R alias using actual directory stats.
    // No privileged bind mount is created; both canonical observations receive the same disclosed identity.
    const observer = jest.spyOn(internals, 'canonicalVolume').mockImplementation(async function(this: Internals) {
      const actual = await observe.call(this); expect(actual?.isDirectory()).toBe(true); observations++;
      return canonical;
    });
    const comparison = jest.spyOn(internals, 'validateConfinement').mockImplementation(function(this: Internals, first, last, volumeBefore, volumeAfter) {
      reached = true; expect(volumeBefore).toBe(canonical); expect(volumeAfter).toBe(canonical);
      validate.call(this, first, last, volumeBefore, volumeAfter);
    });
    try {
      await expect(f.owners.deleteOwned(f.request).then(value => { result = value; })).rejects.toMatchObject({ code: 'EHEADCONFLICT', cause: { code: 'EHEADCONFLICT' } });
    } finally { observer.mockRestore(); comparison.mockRestore(); }
    expect(observations).toBe(2); expect(reached).toBe(true); expect(result).toBeUndefined();
    expect(await tree(f.root)).toEqual(before);
    expect((await f.owners.readHeadSnapshot(f.token.locator)).token).toEqual(f.token);
  });

  it('refuses a deeper source ancestor colliding with canonical fence identity before mutation', async () => {
    const f = await fixture(false, undefined, 'Notes/Inner/Memory.yaml'), before = await tree(f.root);
    const fence = await fs.lstat(path.join(f.root, '.memory-fences'), { bigint: true }); let injected = false;
    type Descriptor = { identity: { device: string; inode: string }; [key: string]: unknown };
    type Internals = { observe: (locator: string, full?: boolean) => Promise<Descriptor> };
    const internals = FileMemoryOwnedDelete.prototype as unknown as Internals, original = internals.observe;
    // Descriptor-collision injection after a genuine complete observation; no mount or alias is created.
    jest.spyOn(internals, 'observe').mockImplementation(async function(this: Internals, locator, full) {
      const actual = await original.call(this, locator, full);
      if (locator !== 'Notes/Inner') return actual;
      injected = true; return { ...actual, identity: { ...actual.identity, device: String(fence.dev), inode: String(fence.ino) } };
    });
    await expect(f.owners.deleteOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT', cause: { code: 'EHEADCONFLICT' } });
    expect(injected).toBe(true); expect(await tree(f.root)).toEqual(before);
  });

  it.each(['.', '.memory-owners/owners'])('binds fresh original artifacts to containing directory device %s before BASE', async locator => {
    const f = await fixture(), before = await tree(f.root); let injected = false;
    type Descriptor = { identity: { device: string; inode: string }; [key: string]: unknown };
    type Internals = { observe: (locator: string, full?: boolean) => Promise<Descriptor> };
    const internals = FileMemoryOwnedDelete.prototype as unknown as Internals, original = internals.observe;
    // A consistent observation-descriptor device mismatch; no mount is created.
    jest.spyOn(internals, 'observe').mockImplementation(async function(this: Internals, selected, full) {
      const actual = await original.call(this, selected, full); if (selected !== locator) return actual;
      injected = true; return { ...actual, identity: { ...actual.identity, device: String(BigInt(actual.identity.device) + 1n) } };
    });
    await expect(f.owners.deleteOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT', cause: { code: 'EOWNERRECOVERY' } });
    expect(injected).toBe(true); expect(await tree(f.root)).toEqual(before);
  });
  it('refuses a persisted original artifact device inconsistent with its namespace commitment', async () => {
    let stop = true, reached = false; const cause = new Error('actual BASE durable stop');
    const f = await fixture(false, phase => { if (stop && phase === 'base-durable') { reached = true; throw cause; } });
    await expect(f.owners.deleteOwned(f.request)).rejects.toMatchObject({ cause }); expect(reached).toBe(true); stop = false;
    const journal = path.join(f.root, `.${createHash('sha256').update(path.basename(f.token.locator)).digest('hex')}.memory-write.json`);
    const record = JSON.parse(await fs.readFile(journal, 'utf8'));
    record.baseline.namespace.find((item: { locator: string }) => item.locator === '.').device = String(BigInt(f.token.fileIdentity.device) + 1n);
    await fs.writeFile(journal, JSON.stringify(record)); const before = await tree(f.root);
    await expect(f.owners.deleteOwned(f.request)).rejects.toBeDefined(); expect(await tree(f.root)).toEqual(before);
  });

  it('classifies an observed exact malformed journal as preserved recovery evidence without authority', async () => {
    const f = await fixture(), journal = path.join(f.root, `.${createHash('sha256').update(path.basename(f.token.locator)).digest('hex')}.memory-write.json`);
    await fs.writeFile(journal, '{partial DELETE', { mode: 0o600 }); const before = await tree(f.root);
    const error = await f.owners.deleteOwned(f.request).catch(value => value);
    expect(error.code).toBe('EOWNERRECOVERY'); expect(error.cause).toBeInstanceOf(SyntaxError);
    expect(error).not.toHaveProperty('result'); expect(error).not.toHaveProperty('headDeleted');
    expect(await tree(f.root)).toEqual(before);
  });

  it.each(['journal', 'registry', 'sidecar'])('binds current recovered %s to its observed containing device', async selected => {
    let stop = true, reached = false; const cause = new Error('actual pair durable device stop');
    const f = await fixture(false, phase => { if (stop && phase === 'pair-durable') { reached = true; throw cause; } });
    await expect(f.owners.deleteOwned(f.request)).rejects.toMatchObject({ cause }); expect(reached).toBe(true); stop = false;
    const prefix = `.${createHash('sha256').update(path.basename(f.token.locator)).digest('hex')}`;
    const journal = path.join(f.token.tenantRoot, `${prefix}.memory-write.json`);
    const target = selected === 'journal' ? journal : selected === 'registry' ? path.join(f.token.tenantRoot, '.memory-owners', 'owners', `${f.token.ownerId}.json`) : path.join(f.token.tenantRoot, `${prefix}.memory-owner.json`);
    const foreignDevice = String(BigInt(f.token.fileIdentity.device) + 1n);
    if (selected !== 'journal') {
      const record = JSON.parse(await fs.readFile(journal, 'utf8')); record[selected].identity.device = foreignDevice;
      await fs.writeFile(journal, JSON.stringify(record));
    }
    const before = await tree(f.root); let injected = false;
    type Artifact = { identity: { device: string }; [key: string]: unknown };
    type Internals = { read: (target: string, limit: number, links?: string, privateFile?: boolean) => Promise<Artifact> };
    const internals = FileMemoryOwnedDelete.prototype as unknown as Internals, original = internals.read;
    // Consistent actual-read descriptor injection plus persisted generated history, not a real mount.
    jest.spyOn(internals, 'read').mockImplementation(async function(this: Internals, named, limit, links, privateFile) {
      const actual = await original.call(this, named, limit, links, privateFile);
      if (named !== target) return actual;
      injected = true; return { ...actual, identity: { ...actual.identity, device: foreignDevice } };
    });
    const error = await f.owners.deleteOwned(f.request).catch(value => value);
    expect(injected).toBe(true); expect(error).toMatchObject({ code: 'EOWNERRECOVERY', cause: { code: 'EOWNERRECOVERY' } });
    expect(error).not.toHaveProperty('result'); expect(await tree(f.root)).toEqual(before);
  });

});
