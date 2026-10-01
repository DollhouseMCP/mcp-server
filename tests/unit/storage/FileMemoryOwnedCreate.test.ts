import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type CreatePublication } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryCreateScanBudget } from '../../../src/storage/FileMemoryCreateScanBudget.js';
import { FileMemoryOwnedCreate, commitCreateDirectory } from '../../../src/storage/FileMemoryOwnedCreate.js';

const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
async function fixture(locator = 'Notes/Created.yaml') {
  const tenantRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-exclusive-create-'));
  roots.push(tenantRoot);
  await fs.mkdir(path.dirname(path.join(tenantRoot, locator)), { recursive: true });
  const request = { operationId: randomUUID(), locator, content: 'name: Created\ncontent: hello\n' };
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
  const store = (hook?: (phase: CreatePublication) => void) => new FileMemoryOwnerSnapshots({
    coordinator, afterCreatePublication: hook,
  });
  return { tenantRoot, request, store, coordinator, head: path.join(tenantRoot, locator) };
}
afterEach(async () => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
describe('exclusive owned CREATE', () => {
  if (process.platform === 'win32') {
    it('refuses unsupported non-POSIX ownership storage', () => {
      expect(() => new FileMemoryOwnerSnapshots({ tenantRoot: 'C:\\', getCurrentUserId: () => USER, fence: new FileMemoryFence() })).toThrow('requires POSIX');
    });
    return;
  }
  it.each(['Notes/Created.yaml', 'Created.yaml'])('creates and freshly verifies %s', async locator => {
    const f = await fixture(locator);
    const token = await f.store().createOwned(f.request);
    expect(token.ownership).toBe('owned');
    expect(token.revision).toBe('1');
    expect(await fs.readFile(f.head, 'utf8')).toBe(f.request.content);
    expect((await f.store().readHeadSnapshot(locator)).token).toEqual(token);
    expect((await fs.readdir(path.dirname(f.head))).filter(name => name.includes('memory-write'))).toEqual([]);
  });
  it.each(['prepared', 'linked', 'published'] as const)('resumes exact persisted %s evidence', async stop => {
    const f = await fixture();
    const cause = new Error('controlled interruption');
    await expect(f.store(phase => { if (phase === stop) throw cause; }).createOwned(f.request))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY', cause });
    const token = await f.store().createOwned(f.request);
    expect((await f.store().readHeadSnapshot(f.request.locator)).token).toEqual(token);
    expect(await fs.readFile(f.head, 'utf8')).toBe(f.request.content);
  });
  it('preserves an existing same-content target and never reconstructs a creation receipt', async () => {
    const f = await fixture();
    const token = await f.store().createOwned(f.request);
    const before = await fs.stat(f.head, { bigint: true });
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect(await fs.stat(f.head, { bigint: true })).toEqual(before);
    expect((await f.store().readHeadSnapshot(f.request.locator)).token).toEqual(token);
  });
  it('refuses an orphan content stage before creating ownership directories', async () => {
    const f = await fixture();
    const hash = createHash('sha256').update(path.basename(f.head)).digest('hex');
    const stage = path.join(path.dirname(f.head), `.${hash}.memory-write.json.create-${f.request.operationId}.head.tmp`);
    await fs.writeFile(stage, 'partial content', { flag: 'wx', mode: 0o600 });
    expect(await fs.readFile(stage, 'utf8')).toBe('partial content');
    const before = await fs.stat(stage, { bigint: true });
    const names = await fs.readdir(path.dirname(f.head));
    const failure = await f.store().createOwned(f.request).catch(error => error);
    expect(failure).toMatchObject({ code: 'EHEADCONFLICT', cause: { code: 'EOWNERRECOVERY' } });
    expect(failure.token).toBeUndefined();
    expect(failure.committed).not.toBe(true);
    expect(await fs.readFile(stage, 'utf8')).toBe('partial content');
    const after = await fs.stat(stage, { bigint: true });
    for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'] as const) expect(after[field]).toBe(before[field]);
    expect(await fs.readdir(path.dirname(f.head))).toEqual(names);
    await expect(fs.stat(path.join(f.tenantRoot, '.memory-owners'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('closes the actual exclusively opened stage without writing after authority loss', async () => {
    const f = await fixture();
    const revoked = new Error('controlled authority loss');
    const internals = FileMemoryOwnedCreate.prototype as unknown as {
      closed: (handle: fs.FileHandle, body: () => Promise<unknown>) => Promise<unknown>;
    };
    const original = internals.closed;
    let opened: fs.FileHandle | undefined;
    jest.spyOn(internals, 'closed').mockImplementation(async function(this: typeof internals, handle, body) {
      const stat = await handle.stat();
      if (!opened && stat.isFile() && stat.size === 0) {
        opened = handle;
        jest.spyOn(f.coordinator, 'requireActiveOperationScope').mockImplementation(() => { throw revoked; });
      }
      return original.call(this, handle, body);
    });
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY', cause: revoked });
    expect(opened).toBeDefined();
    await expect(opened!.stat()).rejects.toMatchObject({ code: 'EBADF' });
    const names = await fs.readdir(path.dirname(f.head));
    const stage = names.find(name => name.endsWith('.head.tmp'))!;
    expect(stage).toBeDefined();
    expect(await fs.readFile(path.join(path.dirname(f.head), stage), 'utf8')).toBe('');
    await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reports actual link EEXIST as conflict and preserves the foreign inode and own stage', async () => {
    const f = await fixture();
    const internals = FileMemoryOwnedCreate.prototype as unknown as { barrier: (phase: CreatePublication) => Promise<void> };
    const original = internals.barrier;
    let foreign: Awaited<ReturnType<typeof fs.stat>> | undefined;
    jest.spyOn(internals, 'barrier').mockImplementation(async function(this: typeof internals, phase) {
      await original.call(this, phase);
      if (phase === 'before-link') {
        await fs.writeFile(f.head, 'foreign', { flag: 'wx', mode: 0o600 });
        foreign = await fs.stat(f.head);
      }
    });
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT', cause: { code: 'EEXIST' }, residual: true });
    expect((await fs.stat(f.head)).ino).toBe(foreign!.ino);
    expect(await fs.readFile(f.head, 'utf8')).toBe('foreign');
    const names = await fs.readdir(path.dirname(f.head));
    expect(names.some(name => name.endsWith('.head.tmp'))).toBe(true);
    expect(names.some(name => name.endsWith('.memory-write.json'))).toBe(true);
  });
  it('does not attribute a hook-forged EEXIST to the private link syscall', async () => {
    const f = await fixture();
    const cause = Object.assign(new Error('forged conflict'), { code: 'EEXIST' });
    await expect(f.store(phase => { if (phase === 'before-link') throw cause; }).createOwned(f.request))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY', cause });
    await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['linked-before-intent', 'unlinked-stage-before-intent'] as const)('preserves the unrecorded %s transition for manual recovery', async stop => {
    const f = await fixture();
    const cause = new Error('unrecorded identity');
    await expect(f.store(phase => { if (phase === stop) throw cause; }).createOwned(f.request))
      .rejects.toMatchObject({ code: 'EHEADCOMMITUNKNOWN', cause });
    const names = (await fs.readdir(path.dirname(f.head))).sort();
    const before = await Promise.all(names.map(async name => {
      const file = path.join(path.dirname(f.head), name), stat = await fs.stat(file);
      return { name, raw: await fs.readFile(file, 'utf8'), inode: stat.ino, links: stat.nlink };
    }));
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect((await fs.readdir(path.dirname(f.head))).sort()).toEqual(names);
    for (const entry of before) {
      const file = path.join(path.dirname(f.head), entry.name), stat = await fs.stat(file);
      expect({ raw: await fs.readFile(file, 'utf8'), inode: stat.ino, links: stat.nlink })
        .toEqual({ raw: entry.raw, inode: entry.inode, links: entry.links });
    }
  });
  it('preserves long Unicode unrelated names without growing compact phase records', async () => {
    const f = await fixture();
    for (let index = 0; index < 20; index++) await fs.writeFile(path.join(path.dirname(f.head), `${index}-${'界'.repeat(70)}`), 'preserved');
    const token = await f.store().createOwned(f.request);
    expect((await f.store().readHeadSnapshot(f.request.locator)).token).toEqual(token);
    expect((await fs.readdir(path.dirname(f.head))).filter(name => name.endsWith('.memory-write.json'))).toEqual([]);
    expect((await fs.readdir(path.dirname(f.head))).filter(name => name.endsWith('.head.tmp'))).toEqual([]);
    for (let index = 0; index < 20; index++) expect(await fs.readFile(path.join(path.dirname(f.head), `${index}-${'界'.repeat(70)}`), 'utf8')).toBe('preserved');
  });
  it('refuses an over-cap real census before creating ownership directories or artifacts', async () => {
    const f = await fixture();
    for (let index = 0; index < 4096; index++) await fs.writeFile(path.join(path.dirname(f.head), `unrelated-${index}`), 'preserved');
    const names = (await fs.readdir(path.dirname(f.head))).sort();
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT', residual: false });
    expect((await fs.readdir(path.dirname(f.head))).sort()).toEqual(names);
    await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(f.tenantRoot, '.memory-owners'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects unrelated same-byte file ABA during its own permitted directory transition', async () => {
    const f = await fixture(), unrelated = path.join(path.dirname(f.head), 'unrelated');
    await fs.writeFile(unrelated, 'unchanged');
    const initial = await fs.stat(unrelated);
    const internals = FileMemoryOwnedCreate.prototype as unknown as {
      transition: (target: string, add: string[], remove?: string[], changed?: string[]) => Promise<void>;
    };
    const original = internals.transition;
    let replaced = false;
    jest.spyOn(internals, 'transition').mockImplementation(async function(this: typeof internals, target, add, remove, changed) {
      if (!replaced && add.some(name => name.endsWith('.head.tmp'))) {
        replaced = true;
        await fs.rename(unrelated, `${unrelated}.old`);
        await fs.writeFile(unrelated, 'unchanged');
        await fs.unlink(`${unrelated}.old`);
      }
      return original.call(this, target, add, remove, changed);
    });
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(replaced).toBe(true);
    expect((await fs.stat(unrelated)).ino).not.toBe(initial.ino);
    expect(await fs.readFile(unrelated, 'utf8')).toBe('unchanged');
    await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('cannot reuse a genuine prior CREATE receipt before the current commit', async () => {
    const first = await fixture(), second = await fixture();
    const cause = new Error('after genuine commit');
    let prior: unknown;
    try { await first.store(phase => { if (phase === 'committed') throw cause; }).createOwned(first.request); }
    catch (error) { prior = error; }
    expect(prior).toMatchObject({ code: 'EHEADCOMMITTED', cause, committed: true });
    try {
      await second.store(phase => { if (phase === 'before-link') throw prior; }).createOwned(second.request);
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toMatchObject({ code: 'EOWNERRECOVERY', cause: prior });
      expect(error).not.toHaveProperty('token');
      expect(error).not.toHaveProperty('committed');
    }
    await expect(fs.stat(second.head)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['sync', 'close'] as const)('does not claim commit when the final directory %s fails', async operation => {
    const f = await fixture(), cause = new Error(`controlled directory ${operation}`);
    const internals = FileMemoryOwnedCreate.prototype as unknown as {
      phase: string;
      closed: (handle: fs.FileHandle, body: () => Promise<unknown>) => Promise<unknown>;
    };
    const original = internals.closed;
    let injected = false, descriptor: fs.FileHandle | undefined;
    jest.spyOn(internals, 'closed').mockImplementation(async function(this: typeof internals, handle, body) {
      if (this.phase === 'durability-unconfirmed' && (await handle.stat()).isDirectory()) {
        injected = true; descriptor = handle;
        const actualClose = handle.close.bind(handle);
        if (operation === 'sync') jest.spyOn(handle, 'sync').mockRejectedValue(cause);
        else jest.spyOn(handle, 'close').mockImplementation(async () => { await actualClose(); throw cause; });
      }
      return original.call(this, handle, body);
    });
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCOMMITUNKNOWN', cause, phase: 'durability-unconfirmed' });
    expect(injected).toBe(true);
    await expect(descriptor!.stat()).rejects.toMatchObject({ code: 'EBADF' });
    expect(await fs.readFile(f.head, 'utf8')).toBe(f.request.content);
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
  });
  it.each([null, undefined])('preserves primitive primary %s and the actual secondary close failure', async primary => {
    const f = await fixture(), closeCause = new Error('controlled close');
    const internals = FileMemoryOwnedCreate.prototype as unknown as {
      closed: (handle: fs.FileHandle, body: () => Promise<unknown>) => Promise<unknown>;
    };
    const original = internals.closed;
    let injected = false;
    jest.spyOn(internals, 'closed').mockImplementation(async function(this: typeof internals, handle, body) {
      if (!injected && (await handle.stat()).isFile() && (await handle.stat()).size === 0) {
        injected = true;
        const actualClose = handle.close.bind(handle);
        jest.spyOn(handle, 'close').mockImplementation(async () => { await actualClose(); throw closeCause; });
        return original.call(this, handle, async () => { throw primary; });
      }
      return original.call(this, handle, body);
    });
    try { await f.store().createOwned(f.request); throw new Error('expected refusal'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'EOWNERRECOVERY', closeCause });
      expect((error as { cause: unknown }).cause).toBe(primary);
    }
    expect(injected).toBe(true);
    await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['code', 'committed', 'token', 'hostile-getter'] as const)('sanitizes pre-scope %s markers without current commit evidence', async marker => {
    const f = await fixture();
    const cause = marker === 'code' ? { code: 'EHEADCOMMITTED' } : marker === 'committed' ? { committed: true } :
      marker === 'token' ? { token: 'forged' } : Object.defineProperty({}, 'code', { get() { throw new Error('hostile marker'); } });
    const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: f.tenantRoot,
      getCurrentUserId: () => { throw cause; }, fence: new FileMemoryFence() });
    try { await new FileMemoryOwnerSnapshots({ coordinator }).createOwned(f.request); throw new Error('expected refusal'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'EOWNERRECOVERY' });
      expect((error as { cause: unknown }).cause).toBe(cause);
      expect(error).not.toHaveProperty('token'); expect(error).not.toHaveProperty('committed');
    }
    await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['standalone', 'transaction'] as const)('sanitizes an input getter’s forged receipt on the %s entry point', async mode => {
    const f = await fixture(), cause = { code: 'EHEADCOMMITTED', token: 'forged', committed: true };
    const request = Object.defineProperty({ ...f.request }, 'content', { get() { throw cause; } });
    let refusal: unknown;
    if (mode === 'standalone') {
      try { await f.store().createOwned(request); } catch (error) { refusal = error; }
    } else {
      await f.coordinator.withTenantTransaction(async context => {
        try { await f.store().createOwnedInTransaction(context, request); } catch (error) { refusal = error; }
      });
    }
    expect(refusal).toMatchObject({ code: 'EOWNERRECOVERY', cause });
    expect((refusal as { cause: unknown }).cause).toBe(cause);
    expect(refusal).not.toHaveProperty('token'); expect(refusal).not.toHaveProperty('committed');
    await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('binds a partial named read to the original exclusive descriptor before continuing the write', async () => {
    const f = await fixture();
    const internals = FileMemoryOwnedCreate.prototype as unknown as {
      read: (target: string, maximum: number, links?: '1' | '2') => Promise<unknown>;
    };
    const original = internals.read;
    let replacement: { path: string; inode: bigint; raw: string } | undefined;
    jest.spyOn(internals, 'read').mockImplementation(async function(this: typeof internals, target, maximum, links) {
      if (!replacement && target.endsWith('.head.tmp')) {
        const raw = await fs.readFile(target, 'utf8');
        await fs.rename(target, `${target}.saved`);
        await fs.writeFile(target, raw, { mode: 0o600 });
        await fs.unlink(`${target}.saved`);
        replacement = { path: target, inode: (await fs.stat(target, { bigint: true })).ino, raw };
      }
      return original.call(this, target, maximum, links);
    });
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect(replacement).toBeDefined();
    expect(replacement!.raw).toBe(f.request.content.slice(0, Math.floor(f.request.content.length / 2)));
    expect(await fs.readFile(replacement!.path, 'utf8')).toBe(replacement!.raw);
    expect((await fs.stat(replacement!.path, { bigint: true })).ino).toBe(replacement!.inode);
    await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['capture', 'close'] as const)('preserves the freshly created private directory when descriptor %s fails', async fault => {
    const f = await fixture(), cause = new Error(`controlled directory ${fault}`);
    const internals = FileMemoryOwnedCreate.prototype as unknown as {
      closed: (handle: fs.FileHandle, body: () => Promise<unknown>) => Promise<unknown>;
    };
    const original = internals.closed;
    let descriptor: fs.FileHandle | undefined;
    jest.spyOn(internals, 'closed').mockImplementation(async function(this: typeof internals, handle, body) {
      const stat = await handle.stat();
      if (!descriptor && stat.isDirectory() && (stat.mode & 0o777) === 0o700) {
        descriptor = handle;
        if (fault === 'capture') jest.spyOn(handle, 'stat').mockRejectedValueOnce(cause);
        else {
          const close = handle.close.bind(handle);
          jest.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw cause; });
        }
      }
      return original.call(this, handle, body);
    });
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY', cause });
    expect(descriptor).toBeDefined();
    await expect(descriptor!.stat()).rejects.toMatchObject({ code: 'EBADF' });
    expect((await fs.stat(path.join(f.tenantRoot, '.memory-owners'))).isDirectory()).toBe(true);
    expect(await fs.readdir(path.join(f.tenantRoot, '.memory-owners'))).toEqual([]);
    expect(await fs.readdir(path.dirname(f.head))).toEqual([]);
    jest.restoreAllMocks();
    const syncs: string[] = [], canonicalRoot = await fs.realpath(f.tenantRoot);
    const durability = FileMemoryOwnedCreate.prototype as unknown as { syncDirectory: (target: string, final?: boolean) => Promise<void> };
    const sync = durability.syncDirectory;
    jest.spyOn(durability, 'syncDirectory').mockImplementation(async function(this: typeof durability, target, final) {
      await sync.call(this, target, final);
      syncs.push(target); // Only successful sync AND close count as acknowledgement.
    });
    const token = await f.store(phase => {
      if (phase === 'before-content') expect(syncs).toContain(canonicalRoot);
    }).createOwned(f.request);
    expect((await f.store().readHeadSnapshot(f.request.locator)).token).toEqual(token);
  });
  it.each(['sync', 'close'] as const)('refuses retry until an existing ownership parent directory %s is acknowledged', async fault => {
    const f = await fixture(), first = new Error('first directory capture failed');
    const internals = FileMemoryOwnedCreate.prototype as unknown as {
      captureCreatedDirectory: (locator: string) => Promise<unknown>;
      closed: (handle: fs.FileHandle, body: () => Promise<unknown>) => Promise<unknown>;
    };
    jest.spyOn(internals, 'captureCreatedDirectory').mockRejectedValueOnce(first);
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ cause: first });
    jest.restoreAllMocks();
    const rootIdentity = await fs.stat(f.tenantRoot, { bigint: true });
    const secondary = new Error(`retry parent ${fault} failed`), closed = internals.closed;
    let injected = false, descriptor: fs.FileHandle | undefined;
    jest.spyOn(internals, 'closed').mockImplementation(async function(this: typeof internals, handle, body) {
      const stat = await handle.stat({ bigint: true });
      if (!injected && stat.dev === rootIdentity.dev && stat.ino === rootIdentity.ino) {
        injected = true; descriptor = handle;
        if (fault === 'sync') jest.spyOn(handle, 'sync').mockRejectedValueOnce(secondary);
        else {
          const close = handle.close.bind(handle);
          jest.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw secondary; });
        }
      }
      return closed.call(this, handle, body);
    });
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ cause: secondary });
    expect(injected).toBe(true);
    await expect(descriptor!.stat()).rejects.toMatchObject({ code: 'EBADF' });
    await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(path.dirname(f.head))).toEqual([]);
    jest.restoreAllMocks();
    const token = await f.store().createOwned(f.request);
    expect((await f.store().readHeadSnapshot(f.request.locator)).token).toEqual(token);
  });
  it.each(['.memory-owner.json.tmp', '.MEMORY-OWNER.JSON'])('refuses existing per-head %s residue before staging', async suffix => {
    const f = await fixture(), hash = createHash('sha256').update(path.basename(f.head)).digest('hex');
    const residue = path.join(path.dirname(f.head), `.${hash}${suffix}`);
    await fs.writeFile(residue, 'foreign residue', { mode: 0o600 });
    const inode = (await fs.stat(residue)).ino;
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect((await fs.stat(residue)).ino).toBe(inode);
    expect(await fs.readFile(residue, 'utf8')).toBe('foreign residue');
    expect(await fs.readdir(path.dirname(f.head))).toEqual([path.basename(residue)]);
  });
  it('does not apply ownership-directory privacy requirements to an ordinary similarly prefixed ancestor', async () => {
    const f = await fixture('.memory-owners-history/Created.yaml');
    await fs.chmod(path.dirname(f.head), 0o755);
    const token = await f.store().createOwned(f.request);
    expect((await f.store().readHeadSnapshot(f.request.locator)).token).toEqual(token);
    expect((await fs.stat(path.dirname(f.head))).mode & 0o777).toBe(0o755);
  });
  it('checks authority synchronously after the pre-open proof and allocates no content stage', async () => {
    const f = await fixture(), cause = new Error('revoked after proof');
    const internals = FileMemoryOwnedCreate.prototype as unknown as {
      proof: () => Promise<void>; write: (target: string, raw: string, partial?: CreatePublication) => Promise<unknown>;
    };
    const prove = internals.proof, write = internals.write;
    let insideContent = false, triggered = false;
    jest.spyOn(internals, 'write').mockImplementation(function(this: typeof internals, target, raw, partial) {
      insideContent = target.endsWith('.head.tmp');
      return write.call(this, target, raw, partial);
    });
    jest.spyOn(internals, 'proof').mockImplementation(async function(this: typeof internals) {
      await prove.call(this);
      if (insideContent && !triggered) {
        triggered = true;
        jest.spyOn(f.coordinator, 'requireActiveOperationScope').mockImplementation(() => { throw cause; });
      }
    });
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY', cause });
    expect(triggered).toBe(true);
    expect(await fs.readdir(path.dirname(f.head))).toEqual([]);
  });
  it('checks authority immediately after the final pre-link barrier without publishing a head', async () => {
    const f = await fixture(), cause = new Error('revoked before link');
    const internals = FileMemoryOwnedCreate.prototype as unknown as { barrier: (phase: CreatePublication) => Promise<void> };
    const original = internals.barrier;
    let triggered = false;
    jest.spyOn(internals, 'barrier').mockImplementation(async function(this: typeof internals, phase) {
      await original.call(this, phase);
      if (phase === 'before-link') {
        triggered = true;
        jest.spyOn(f.coordinator, 'requireActiveOperationScope').mockImplementation(() => { throw cause; });
      }
    });
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY', cause });
    expect(triggered).toBe(true);
    await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
    const stage = (await fs.readdir(path.dirname(f.head))).find(name => name.endsWith('.head.tmp'))!;
    expect((await fs.stat(path.join(path.dirname(f.head), stage))).nlink).toBe(1);
    expect(await fs.readFile(path.join(path.dirname(f.head), stage), 'utf8')).toBe(f.request.content);
  });
  it.each(['short', 'zero'] as const)('handles actual descriptor %s writes without a false successful publication', async kind => {
    const f = await fixture();
    const internals = FileMemoryOwnedCreate.prototype as unknown as {
      closed: (handle: fs.FileHandle, body: () => Promise<unknown>) => Promise<unknown>;
    };
    const original = internals.closed;
    let calls = 0, injected = false;
    jest.spyOn(internals, 'closed').mockImplementation(async function(this: typeof internals, handle, body) {
      const stat = await handle.stat();
      if (!injected && stat.isFile() && stat.size === 0) {
        injected = true;
        type Write = (buffer: Buffer, offset: number, length: number) => Promise<{ bytesWritten: number; buffer: Buffer }>;
        const writable = handle as unknown as { write: Write };
        const write = writable.write.bind(handle);
        jest.spyOn(writable, 'write').mockImplementation(async (buffer, offset, length) => {
          calls++;
          return kind === 'zero' ? { bytesWritten: 0, buffer } : write(buffer, offset, Math.min(length, 2));
        });
      }
      return original.call(this, handle, body);
    });
    if (kind === 'zero') {
      await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
      expect(calls).toBe(1);
      const stage = (await fs.readdir(path.dirname(f.head))).find(name => name.endsWith('.head.tmp'))!;
      expect(await fs.readFile(path.join(path.dirname(f.head), stage), 'utf8')).toBe('');
      await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      const token = await f.store().createOwned(f.request);
      expect(calls).toBeGreaterThan(2);
      expect(await fs.readFile(f.head, 'utf8')).toBe(f.request.content);
      expect((await f.store().readHeadSnapshot(f.request.locator)).token).toEqual(token);
    }
    expect(injected).toBe(true);
  });
  it('composes its committed token with ordinary conditional UPDATE and rejects the stale creation token', async () => {
    const f = await fixture(), store = f.store();
    const created = await store.createOwned(f.request);
    const fresh = await store.readHeadSnapshot(f.request.locator);
    expect(fresh.token).toEqual(created);
    const content = 'name: Created\ncontent: changed\n';
    const updated = await store.updateOwnedHead(created, content);
    expect(updated.ownerId).toBe(created.ownerId);
    expect(updated.revision).toBe('2');
    expect((await store.readHeadSnapshot(f.request.locator)).token).toEqual(updated);
    expect(await fs.readFile(f.head, 'utf8')).toBe(content);
    await expect(store.updateOwnedHead(created, 'name: Created\ncontent: stale\n'))
      .rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect(await fs.readFile(f.head, 'utf8')).toBe(content);
  });
  it.each(['prepared', 'linked', 'published', 'active-sidecar'] as const)('ordinary reads refuse pending CREATE at %s', async stop => {
    const f = await fixture(), cause = new Error('pending creation');
    await expect(f.store(phase => { if (phase === stop) throw cause; }).createOwned(f.request))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY', cause });
    const names = (await fs.readdir(path.dirname(f.head))).sort();
    await expect(f.store().readHeadSnapshot(f.request.locator)).rejects.toMatchObject({
      code: stop === 'prepared' ? 'ENOENT' : stop === 'linked' ? 'EHEADCONFLICT' : 'EOWNERRECOVERY',
    });
    expect((await fs.readdir(path.dirname(f.head))).sort()).toEqual(names);
  });
  it.each(['.json.tmp', '.JSON'])('preserves derived owner-registry %s residue on a published retry', async suffix => {
    const f = await fixture();
    await expect(f.store(phase => { if (phase === 'published') throw new Error('stop'); }).createOwned(f.request))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    const journal = (await fs.readdir(path.dirname(f.head))).find(name => name.endsWith('.memory-write.json'))!;
    const { ownerId } = JSON.parse(await fs.readFile(path.join(path.dirname(f.head), journal), 'utf8')) as { ownerId: string };
    const residue = path.join(f.tenantRoot, '.memory-owners', 'owners', `${ownerId}${suffix}`);
    await fs.writeFile(residue, 'foreign registry residue', { mode: 0o600 });
    const before = await fs.stat(residue, { bigint: true });
    const head = await fs.stat(f.head, { bigint: true });
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect((await fs.stat(residue, { bigint: true })).ino).toBe(before.ino);
    expect(await fs.readFile(residue, 'utf8')).toBe('foreign registry residue');
    expect((await fs.stat(f.head, { bigint: true })).ino).toBe(head.ino);
    expect(await fs.readdir(path.dirname(residue))).toEqual([path.basename(residue)]);
  });
  it.each(['adoption', 'update'] as const)('existing conditional %s refuses a pending replacement CREATE without mutation', async operation => {
    const f = await fixture(), store = f.store();
    let action: () => Promise<unknown>;
    if (operation === 'adoption') {
      await fs.writeFile(f.head, f.request.content);
      const legacy = await store.readHeadSnapshot(f.request.locator);
      if (legacy.token.ownership !== 'unowned') throw new Error('expected actual legacy snapshot');
      const token = legacy.token;
      action = () => store.adoptUnowned(token);
      await fs.unlink(f.head);
    } else {
      const original = await store.createOwned(f.request);
      action = () => store.updateOwnedHead(original, 'name: Created\ncontent: stale update\n');
      const hash = createHash('sha256').update(path.basename(f.head)).digest('hex');
      // Explicit test-owned removal simulates a new generation; no production cleanup API is used.
      await fs.unlink(f.head);
      await fs.unlink(path.join(path.dirname(f.head), `.${hash}.memory-owner.json`));
      await fs.unlink(path.join(f.tenantRoot, '.memory-owners', 'owners', `${original.ownerId}.json`));
    }
    const request = { ...f.request, operationId: randomUUID() };
    await expect(f.store(phase => { if (phase === 'published') throw new Error('pending replacement'); }).createOwned(request))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    const names = (await fs.readdir(path.dirname(f.head))).sort();
    const before = await Promise.all(names.map(async name => {
      const file = path.join(path.dirname(f.head), name), stat = await fs.stat(file, { bigint: true });
      return { name, raw: await fs.readFile(file, 'utf8'), inode: stat.ino };
    }));
    await expect(action()).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect((await fs.readdir(path.dirname(f.head))).sort()).toEqual(names);
    for (const record of before) {
      const file = path.join(path.dirname(f.head), record.name);
      expect(await fs.readFile(file, 'utf8')).toBe(record.raw);
      expect((await fs.stat(file, { bigint: true })).ino).toBe(record.inode);
    }
  });
  it('refuses sidecar-only publication evidence without recreating the missing registry', async () => {
    const f = await fixture();
    await expect(f.store(phase => { if (phase === 'active-sidecar') throw new Error('interrupted metadata'); }).createOwned(f.request))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    const names = (await fs.readdir(path.dirname(f.head))).sort();
    const journal = names.find(name => name.endsWith('.memory-write.json'))!;
    const { ownerId } = JSON.parse(await fs.readFile(path.join(path.dirname(f.head), journal), 'utf8')) as { ownerId: string };
    const registry = path.join(f.tenantRoot, '.memory-owners', 'owners', `${ownerId}.json`);
    await fs.unlink(registry);
    const before = await Promise.all(names.map(async name => {
      const file = path.join(path.dirname(f.head), name), stat = await fs.stat(file, { bigint: true });
      return { name, raw: await fs.readFile(file, 'utf8'), identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs } };
    }));
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    await expect(fs.stat(registry)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(path.dirname(f.head))).sort()).toEqual(names);
    for (const record of before) {
      const file = path.join(path.dirname(f.head), record.name), stat = await fs.stat(file, { bigint: true });
      expect(await fs.readFile(file, 'utf8')).toBe(record.raw);
      expect({ dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs }).toEqual(record.identity);
    }
  });
  async function seedOwners(f: Awaited<ReturnType<typeof fixture>>, count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      const locator = path.posix.join(path.posix.dirname(f.request.locator), `Existing${index}.yaml`);
      await fs.writeFile(path.join(f.tenantRoot, locator), 'name: Existing\ncontent: prior\n', { mode: 0o600 });
      const snapshot = await f.store().readHeadSnapshot(locator);
      if (snapshot.token.ownership !== 'unowned') throw new Error('Fixture must begin unowned');
      await f.store().adoptUnowned(snapshot.token);
    }
  }
  // Exact persisted ACTIVE schema1 fixtures qualify CREATE, not public adoption throughput.
  async function seedPersistedOwners(f: Awaited<ReturnType<typeof fixture>>, count: number): Promise<void> {
    const owners = path.join(f.tenantRoot, '.memory-owners', 'owners');
    await fs.mkdir(path.dirname(owners), { mode: 0o700 });
    await fs.mkdir(owners, { mode: 0o700 });
    for (let index = 0; index < count; index++) {
      const locator = path.posix.join(path.posix.dirname(f.request.locator), `Existing${index}.yaml`);
      const target = path.join(f.tenantRoot, locator), raw = 'name: Existing\ncontent: prior\n';
      await fs.writeFile(target, raw, { mode: 0o600 });
      const stat = await fs.stat(target, { bigint: true }), ownerId = randomUUID();
      const record = JSON.stringify({ schema: 1, state: 'ACTIVE', userId: USER, ownerId, locator, revision: '1',
        contentHash: createHash('sha256').update(raw).digest('hex'), fileIdentity: {
          device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
        } });
      const basename = createHash('sha256').update(path.posix.basename(locator)).digest('hex');
      await fs.writeFile(path.join(path.dirname(target), `.${basename}.memory-owner.json`), record, { mode: 0o600 });
      await fs.writeFile(path.join(owners, `${ownerId}.json`), record, { mode: 0o600 });
    }
    expect((await f.store().readHeadSnapshot(path.posix.join(path.posix.dirname(f.request.locator), 'Existing0.yaml'))).token.ownership).toBe('owned');
  }
  it('commits exact ordinal child identities and refuses malformed canonical baselines', () => {
    const child = { name: 'a', directory: false, identity: { device: '1', inode: '2', size: '3', mtimeNs: '4', ctimeNs: '5' }, mode: '384', uid: '1', links: '1' };
    const baseline = { locator: '.', device: '1', inode: '9', mode: '448', uid: '1', names: ['a'], children: [child] };
    const committed = commitCreateDirectory(baseline);
    expect(committed.baselineChildCount).toBe(1);
    expect(committed.sha256).toBe(createHash('sha256').update(JSON.stringify([
      'dollhouse-create-namespace-directory-v1', '.', '1', '9', '448', '1',
      [['a', false, '1', '2', '3', '4', '5', '384', '1', '1']],
    ])).digest('hex'));
    for (const field of ['locator', 'device', 'inode', 'mode', 'uid'] as const) {
      expect(commitCreateDirectory({ ...baseline, [field]: field === 'locator' ? 'Other' : '10' }).sha256).not.toBe(committed.sha256);
    }
    for (const field of ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs'] as const) {
      expect(commitCreateDirectory({ ...baseline, children: [{ ...child, identity: { ...child.identity, [field]: '10' } }] }).sha256).not.toBe(committed.sha256);
    }
    for (const field of ['mode', 'uid', 'links'] as const) {
      expect(commitCreateDirectory({ ...baseline, children: [{ ...child, [field]: '10' }] }).sha256).not.toBe(committed.sha256);
    }
    expect(commitCreateDirectory({ ...baseline, names: ['b'], children: [{ ...child, name: 'b' }] }).sha256).not.toBe(committed.sha256);
    const directoryChild = { ...child, directory: true, links: '0', identity: { ...child.identity, size: '0', mtimeNs: '0', ctimeNs: '0' } };
    const directoryCommitment = commitCreateDirectory({ ...baseline, children: [directoryChild] });
    expect(directoryCommitment.sha256).not.toBe(committed.sha256);
    expect(directoryCommitment.sha256).toBe(createHash('sha256').update(JSON.stringify([
      'dollhouse-create-namespace-directory-v1', '.', '1', '9', '448', '1',
      [['a', true, '1', '2', '0', '0', '0', '384', '1', '0']],
    ])).digest('hex'));
    expect(() => commitCreateDirectory({ ...baseline, children: [{ ...directoryChild, links: '1' }] })).toThrow();
    expect(() => commitCreateDirectory({ ...baseline, names: ['a', 'a'], children: [child, child] })).toThrow();
  });
  it('indexes each fresh child observation without silently collapsing duplicate names', () => {
    type Child = Parameters<typeof commitCreateDirectory>[0]['children'][number];
    const index = FileMemoryOwnedCreate.prototype as unknown as { childIndex: (children: Child[]) => Map<string, Child> };
    const a: Child = { name: 'a', directory: false, identity: { device: '1', inode: '2', size: '3', mtimeNs: '4', ctimeNs: '5' }, mode: '384', uid: '1', links: '1' };
    const b = { ...a, name: 'b' };
    const observed = index.childIndex([b, a]);
    expect([...observed.keys()]).toEqual(['b', 'a']);
    expect(observed.get('a')).toBe(a);
    expect(observed.get('missing')).toBeUndefined();
    expect(() => index.childIndex([a, a])).toThrow(expect.objectContaining({ code: 'EOWNERRECOVERY' }));
    expect(() => index.childIndex([a, { ...a, identity: { ...a.identity, inode: '99' } }])).toThrow(expect.objectContaining({ code: 'EOWNERRECOVERY' }));
    expect(index.childIndex([{ ...a, identity: { ...a.identity, inode: '99' } }]).get('a')?.identity.inode).toBe('99');
    expect(observed.get('a')?.identity.inode).toBe('2');
  });
  it('preserves strict schema3 forward recovery instead of reinterpreting legacy evidence', async () => {
    const f = await fixture();
    await expect(f.store(phase => { if (phase === 'prepared') throw new Error('stop'); }).createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    const names = await fs.readdir(path.dirname(f.head)), journal = names.find(name => name.endsWith('.memory-write.json'))!;
    const target = path.join(path.dirname(f.head), journal), value = JSON.parse(await fs.readFile(target, 'utf8'));
    const legacy = [];
    for (const slot of value.namespace) {
      const directory = path.join(f.tenantRoot, slot.locator);
      const retained = (await fs.readdir(directory)).filter(name => name !== journal && name !== value.stageName).sort();
      const children = [];
      for (const name of retained) {
        const stat = await fs.lstat(path.join(directory, name), { bigint: true }), isDirectory = stat.isDirectory();
        children.push({ name, directory: isDirectory, identity: { device: String(stat.dev), inode: String(stat.ino),
          size: isDirectory ? '0' : String(stat.size), mtimeNs: isDirectory ? '0' : String(stat.mtimeNs), ctimeNs: isDirectory ? '0' : String(stat.ctimeNs) },
          mode: String(stat.mode), uid: String(stat.uid), links: isDirectory ? '0' : String(stat.nlink) });
      }
      const { locator, device, inode, mode, uid } = slot;
      legacy.push({ locator, device, inode, mode, uid, names: retained, children });
    }
    value.schema = 3; value.namespace = legacy;
    await fs.writeFile(target, JSON.stringify(value));
    const seen: number[] = [];
    const token = await f.store(async phase => {
      if (phase === 'linked' || phase === 'published') seen.push(JSON.parse(await fs.readFile(target, 'utf8')).schema);
    }).createOwned(f.request);
    expect(seen).toEqual([3, 3]);
    expect((await f.store().readHeadSnapshot(f.request.locator)).token).toEqual(token);
  });
  it.each(['count', 'digest', 'same-byte-ABA'] as const)('refuses compact recovery with changed %s without accepting a fresh baseline', async change => {
    const f = await fixture(), unrelated = path.join(path.dirname(f.head), 'unrelated');
    await fs.writeFile(unrelated, 'same bytes');
    await expect(f.store(phase => { if (phase === 'prepared') throw new Error('stop'); }).createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    const names = (await fs.readdir(path.dirname(f.head))).sort(), journal = names.find(name => name.endsWith('.memory-write.json'))!;
    const target = path.join(path.dirname(f.head), journal);
    if (change === 'same-byte-ABA') {
      await fs.rename(unrelated, `${unrelated}.old`);
      await fs.writeFile(unrelated, 'same bytes');
      await fs.unlink(`${unrelated}.old`);
    } else {
      const value = JSON.parse(await fs.readFile(target, 'utf8'));
      if (change === 'count') value.namespace[0].baselineChildCount++;
      else value.namespace[0].sha256 = '0'.repeat(64);
      await fs.writeFile(target, JSON.stringify(value));
    }
    const before = await Promise.all(names.map(async name => ({ name, raw: await fs.readFile(path.join(path.dirname(f.head), name), 'utf8'),
      inode: (await fs.stat(path.join(path.dirname(f.head), name))).ino })));
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    for (const entry of before) expect({ raw: await fs.readFile(path.join(path.dirname(f.head), entry.name), 'utf8'),
      inode: (await fs.stat(path.join(path.dirname(f.head), entry.name))).ino }).toEqual({ raw: entry.raw, inode: entry.inode });
    await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    ['Created.yaml', 100], ['Created.yaml', 250], ['Created.yaml', 1000],
    ['Notes/Created.yaml', 100], ['Notes/Created.yaml', 250], ['Notes/Created.yaml', 1000],
  ] as const)('fits compact phase evidence and completes %s with %s existing memories', async (locator, count) => {
      const f = await fixture(locator);
      await seedPersistedOwners(f, count);
      const observed = observeAccounting(), sizes: Record<string, number> = {};
      const start = performance.now();
      const token = await f.store(async phase => {
        if (['prepared', 'linked', 'published'].includes(phase)) {
          const name = (await fs.readdir(path.dirname(f.head))).find(value => value.endsWith('.memory-write.json'))!;
          const raw = await fs.readFile(path.join(path.dirname(f.head), name), 'utf8');
          sizes[phase] = Buffer.byteLength(raw);
          expect(JSON.parse(raw).schema).toBe(5);
          expect(sizes[phase]).toBeLessThanOrEqual(8192);
        }
      }).createOwned(f.request);
      expect((await f.store().readHeadSnapshot(locator)).token).toEqual(token);
      expect(observed.budget().consumed).toBeLessThanOrEqual(observed.budget().limit);
      expect(observed.budget().limit).toBeLessThanOrEqual(454656);
      process.stderr.write(`CREATE capacity ${JSON.stringify({ locator, count, sizes, consumed: observed.budget().consumed, reserved: observed.budget().limit, ms: performance.now() - start, measured: observed.measured })}\n`);
  });
  function observeAccounting() {
    const records: { before: number; limit: number; phase?: string; budget: FileMemoryCreateScanBudget }[] = [];
    const measured = { completedCensuses: 0, childLstatsInCompletedCensuses: 0, directoryLstatsInCompletedCensuses: 0,
      canonicalDescriptorBytesAcrossCompletedCensuses: 0, peakSnapshotBytes: 0, peakRss: process.memoryUsage().rss };
    const internals = FileMemoryOwnedCreate.prototype as unknown as {
      directory: (locator: string) => Promise<Parameters<typeof commitCreateDirectory>[0]>;
    };
    const directory = internals.directory;
    jest.spyOn(internals, 'directory').mockImplementation(async function(this: typeof internals, locator) {
      const result = await directory.call(this, locator);
      // A successfully returned real directory() has performed exactly one lstat
      // per child plus its two directory observations; failures are not counted.
      measured.completedCensuses++;
      measured.childLstatsInCompletedCensuses += result.children.length;
      measured.directoryLstatsInCompletedCensuses += 2;
      const tuples = result.children.map(child => [child.name, child.directory, child.identity.device, child.identity.inode,
        child.directory ? '0' : child.identity.size, child.directory ? '0' : child.identity.mtimeNs,
        child.directory ? '0' : child.identity.ctimeNs, child.mode, child.uid, child.directory ? '0' : child.links]);
      measured.canonicalDescriptorBytesAcrossCompletedCensuses += Buffer.byteLength(JSON.stringify(['dollhouse-create-namespace-directory-v1', result.locator,
        result.device, result.inode, result.mode, result.uid, tuples]));
      measured.peakSnapshotBytes = Math.max(measured.peakSnapshotBytes, Buffer.byteLength(JSON.stringify(result)));
      measured.peakRss = Math.max(measured.peakRss, process.memoryUsage().rss);
      return result;
    });
    const reserve = FileMemoryCreateScanBudget.prototype.reserve;
    jest.spyOn(FileMemoryCreateScanBudget.prototype, 'reserve').mockImplementation(function(this: FileMemoryCreateScanBudget, slots, headParent, phase) {
      const before = this.consumed;
      reserve.call(this, slots, headParent, phase);
      records.push({ before, limit: this.limit, phase, budget: this });
      expect(this.consumed).toBe(before);
    });
    return { records, measured, budget: () => records.at(-1)!.budget };
  }
  it.each([
    ['Created.yaml', 'prepared'], ['Created.yaml', 'linked'], ['Created.yaml', 'published'],
    ['Notes/Created.yaml', 'prepared'], ['Notes/Created.yaml', 'linked'], ['Notes/Created.yaml', 'published'],
  ] as const)('recovers %s at %s with 1000 persisted owners and exact compact evidence', async (locator, stop) => {
    const f = await fixture(locator);
    await seedPersistedOwners(f, 1000);
    const cause = new Error('target-scale controlled interruption');
    await expect(f.store(phase => { if (phase === stop) throw cause; }).createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY', cause });
    const observed = observeAccounting(), start = performance.now();
    const token = await f.store().createOwned(f.request);
    expect((await f.store().readHeadSnapshot(locator)).token).toEqual(token);
    expect(observed.records).toHaveLength(1);
    expect(observed.budget().consumed).toBeLessThanOrEqual(observed.budget().limit);
    process.stderr.write(`CREATE target recovery ${JSON.stringify({ locator, stop, before: observed.records[0].before,
      consumed: observed.budget().consumed, reserved: observed.budget().limit, ms: performance.now() - start, measured: observed.measured })}\n`);
  });
  it.each([
    ['Created.yaml', 1], ['Created.yaml', 5], ['Notes/Created.yaml', 1], ['Notes/Created.yaml', 5],
  ] as const)('completes real %s CREATE with %s existing owners inside its reserved protocol', async (locator, count) => {
    const f = await fixture(locator);
    await seedOwners(f, count);
    const observed = observeAccounting(), progress: number[] = [];
    const final = FileMemoryOwnedCreate.prototype as unknown as { syncDirectory: (target: string, commit?: boolean) => Promise<void> };
    const sync = final.syncDirectory; let commitClosed = false;
    jest.spyOn(final, 'syncDirectory').mockImplementation(async function(this: typeof final, target, commit) {
      await sync.call(this, target, commit);
      if (commit) commitClosed = true;
    });
    const token = await f.store(() => { progress.push(observed.budget().consumed); }).createOwned(f.request);
    expect(commitClosed).toBe(true);
    expect(observed.records).toHaveLength(1);
    expect(observed.records[0].before).toBeGreaterThan(0);
    expect(observed.budget().consumed).toBeLessThanOrEqual(observed.budget().limit);
    expect(observed.budget().limit).toBeLessThanOrEqual(454656);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect((await f.store().readHeadSnapshot(locator)).token).toEqual(token);
    expect((await fs.readdir(path.dirname(f.head))).some(name => name.includes('memory-write'))).toBe(false);
    process.stderr.write(`CREATE accounting ${JSON.stringify({ locator, count, consumed: observed.budget().consumed, reserved: observed.budget().limit })}\n`);
  });
  it.each(['prepared', 'linked', 'published'] as const)('retains discovery consumption while reserving only the remaining %s recovery', async stop => {
    const f = await fixture();
    await seedOwners(f, 5);
    const cause = new Error('controlled persisted interruption');
    await expect(f.store(phase => { if (phase === stop) throw cause; }).createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY', cause });
    const initialCost = (await Promise.all(['.', 'Notes', '.memory-owners', '.memory-owners/owners'].map(async locator =>
      (await fs.readdir(path.join(f.tenantRoot, locator))).length + 1))).reduce((sum, value) => sum + value, 0);
    const observed = observeAccounting();
    const token = await f.store().createOwned(f.request);
    expect(observed.records).toHaveLength(1);
    expect(observed.records[0].phase).toBe({ prepared: 'PREPARED_CREATE', linked: 'LINKED_CREATE', published: 'PUBLISHED_CREATE' }[stop]);
    // Discovery and the pre-reservation recovery proof each census every current slot once.
    expect(observed.records[0].before).toBe(2 * initialCost);
    expect(observed.budget().consumed).toBeLessThanOrEqual(observed.budget().limit);
    expect((await f.store().readHeadSnapshot(f.request.locator)).token).toEqual(token);
    process.stderr.write(`CREATE recovery accounting ${JSON.stringify({ stop, before: observed.records[0].before, consumed: observed.budget().consumed, reserved: observed.budget().limit })}\n`);
  });
  it('cannot rebase a missing ownership slot created after discovery', async () => {
    const f = await fixture();
    const internals = FileMemoryOwnedCreate.prototype as unknown as { preflight: () => Promise<void> };
    const preflight = internals.preflight;
    let foreign: bigint | undefined;
    jest.spyOn(internals, 'preflight').mockImplementation(async function(this: typeof internals) {
      await preflight.call(this);
      const parent = path.join(f.tenantRoot, '.memory-owners');
      await fs.mkdir(parent, { mode: 0o700 });
      await fs.writeFile(path.join(parent, 'foreign'), 'preserved');
      foreign = (await fs.stat(parent, { bigint: true })).ino;
    });
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect((await fs.stat(path.join(f.tenantRoot, '.memory-owners'), { bigint: true })).ino).toBe(foreign);
    expect(await fs.readFile(path.join(f.tenantRoot, '.memory-owners', 'foreign'), 'utf8')).toBe('preserved');
    await expect(fs.stat(path.join(f.tenantRoot, '.memory-owners', 'owners'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects unsupported persisted numeric widths before recovery mutations', async () => {
    const f = await fixture();
    await expect(f.store(phase => { if (phase === 'prepared') throw new Error('stop'); }).createOwned(f.request)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    const names = await fs.readdir(path.dirname(f.head)), journal = names.find(name => name.endsWith('.memory-write.json'))!;
    const target = path.join(path.dirname(f.head), journal), value = JSON.parse(await fs.readFile(target, 'utf8'));
    value.initialStageIdentity.mtimeNs = '9'.repeat(33); value.currentStageIdentity.mtimeNs = '9'.repeat(33);
    await fs.writeFile(target, JSON.stringify(value));
    const before = await Promise.all(names.map(async name => ({ name, raw: await fs.readFile(path.join(path.dirname(f.head), name), 'utf8'), ino: (await fs.stat(path.join(path.dirname(f.head), name))).ino })));
    await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT', cause: { code: 'EOWNERRECOVERY' } });
    for (const entry of before) expect({ raw: await fs.readFile(path.join(path.dirname(f.head), entry.name), 'utf8'), ino: (await fs.stat(path.join(path.dirname(f.head), entry.name))).ino }).toEqual({ raw: entry.raw, ino: entry.ino });
    await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves one real EOF counter and refuses quota reset or excess projected cardinality', async () => {
    const f = await fixture(), budget = new FileMemoryCreateScanBudget();
    await budget.scan(path.dirname(f.head), () => { throw new Error('not empty'); });
    expect(budget.consumed).toBe(1);
    const slots = [{ locator: '.', names: ['Notes', '.memory-owners'], missing: false },
      { locator: 'Notes', names: [], missing: false }, { locator: '.memory-owners', names: ['owners'], missing: true },
      { locator: '.memory-owners/owners', names: [], missing: true }];
    budget.reserve(slots, 'Notes'); const reserved = budget.limit;
    expect(budget.consumed).toBe(1);
    await budget.scan(path.dirname(f.head), () => { throw new Error('not empty'); });
    expect(budget.consumed).toBe(2);
    expect(() => budget.reserve(slots, 'Notes')).toThrow('budget exhausted');
    expect(budget.limit).toBe(reserved); expect(budget.consumed).toBe(2);
    const excessive = new FileMemoryCreateScanBudget();
    expect(() => excessive.reserve([{ ...slots[0], names: Array.from({ length: 4096 }, (_, index) => String(index)) }, ...slots.slice(1)], 'Notes')).toThrow('budget exhausted');
    expect(excessive.consumed).toBe(0);
    await expect(fs.stat(path.join(f.tenantRoot, '.memory-owners'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  const crashChild = `
    const [ownersUrl,coordinatorUrl,fenceUrl,root,user,request,stop]=process.argv.slice(1);
    const {FileMemoryOwnerSnapshots}=await import(ownersUrl);
    const {FileMemoryTransactionCoordinator}=await import(coordinatorUrl);
    const {FileMemoryFence}=await import(fenceUrl);
    const coordinator=new FileMemoryTransactionCoordinator({tenantRoot:root,getCurrentUserId:()=>user,fence:new FileMemoryFence()});
    const store=new FileMemoryOwnerSnapshots({coordinator,afterCreatePublication:phase=>{
      if(phase===stop){ process.stdout.write('CREATE_BARRIER\\n'); process.stdin.resume(); return new Promise(()=>{}); }
    }});
    await store.createOwned(JSON.parse(request));
  `;
  it.each(['partial-content', 'prepared', 'linked-before-intent', 'linked', 'unlinked-stage-before-intent',
    'published', 'active-registry', 'active-sidecar', 'intent-unlinked'] as const)(
    'preserves actual SIGKILL residue at %s and qualifies only supported fresh retry', async stop => {
      const f = await fixture();
      const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
      const modules = ['FileMemoryOwnerSnapshots', 'FileMemoryTransactionCoordinator', 'FileMemoryFence']
        .map(name => new URL(`../../../src/storage/${name}.${extension}`, import.meta.url).href);
      const loader = extension === 'ts' ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [];
      const child = spawn(process.execPath, [...loader, '--input-type=module', '-e', crashChild,
        ...modules, f.tenantRoot, USER, JSON.stringify(f.request), stop], { cwd: f.tenantRoot, stdio: ['pipe', 'pipe', 'pipe'] });
      let didClose = false, output = '';
      const closed = new Promise<void>(resolve => child.once('close', () => { didClose = true; resolve(); }));
      const ready = new Promise<void>((resolve, reject) => {
        child.once('error', () => reject(new Error('CREATE crash child failed')));
        child.once('close', () => reject(new Error('CREATE crash child closed before barrier')));
        child.stdout.on('data', chunk => {
          output += String(chunk);
          if (output.length > 256) reject(new Error('CREATE crash child exceeded output cap'));
          else if (output === 'CREATE_BARRIER\n') resolve();
        });
        child.stderr.on('data', () => reject(new Error('CREATE crash child reported unexpected diagnostics')));
      });
      void ready.catch(() => undefined);
      const timer = setTimeout(() => { if (!didClose) child.kill('SIGKILL'); }, 5000);
      const index = roots.indexOf(f.tenantRoot); if (index >= 0) roots.splice(index, 1);
      try {
        await ready;
        child.kill('SIGKILL'); await closed;
        // Confirmed isolated process death permits explicit test-only orphan handling.
        await fs.rm(path.join(f.tenantRoot, '.memory-fences', 'tenant.lock'), { recursive: true });
        const headBefore = await fs.stat(f.head, { bigint: true }).catch(() => undefined);
        const manual = ['partial-content', 'linked-before-intent', 'unlinked-stage-before-intent', 'intent-unlinked'].includes(stop);
        const names = (await fs.readdir(path.dirname(f.head))).sort();
        const artifacts = await Promise.all(names.map(async name => {
          const file = path.join(path.dirname(f.head), name), stat = await fs.stat(file, { bigint: true });
          return { name, raw: await fs.readFile(file, 'utf8'), inode: stat.ino, links: stat.nlink };
        }));
        if (manual) {
          await expect(f.store().createOwned(f.request)).rejects.toMatchObject({ code: stop === 'intent-unlinked' || stop === 'partial-content' ? 'EHEADCONFLICT' : 'EOWNERRECOVERY' });
          expect((await fs.readdir(path.dirname(f.head))).sort()).toEqual(names);
          for (const artifact of artifacts) {
            const file = path.join(path.dirname(f.head), artifact.name), stat = await fs.stat(file, { bigint: true });
            expect({ raw: await fs.readFile(file, 'utf8'), inode: stat.ino, links: stat.nlink })
              .toEqual({ raw: artifact.raw, inode: artifact.inode, links: artifact.links });
          }
        } else {
          const token = await f.store().createOwned(f.request);
          expect((await f.store().readHeadSnapshot(f.request.locator)).token).toEqual(token);
        }
        if (headBefore) expect((await fs.stat(f.head, { bigint: true })).ino).toBe(headBefore.ino);
        if (stop === 'partial-content') {
          const stage = artifacts.find(artifact => artifact.name.endsWith('.head.tmp'))!;
          expect(stage.raw).toBe(f.request.content.slice(0, Math.floor(f.request.content.length / 2)));
          await expect(fs.stat(f.head)).rejects.toMatchObject({ code: 'ENOENT' });
        } else expect(await fs.readFile(f.head, 'utf8')).toBe(f.request.content);
      } finally {
        clearTimeout(timer);
        if (!didClose) child.kill('SIGKILL');
        await closed;
        await fs.rm(f.tenantRoot, { recursive: true, force: true });
      }
    });
});
