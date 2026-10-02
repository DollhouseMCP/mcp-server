import { afterEach, describe, expect, it as jestIt, jest } from '@jest/globals';
import * as realFs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// Instrument actual filesystem calls before loading the production graph. Every
// mutation delegates to the real method; only explicitly disclosed lstat evidence
// is substituted. Native ESM namespace exports cannot be spied on in place.
type Lstat = (...args: Parameters<typeof realFs.lstat>) => ReturnType<typeof realFs.lstat>;
const lstat = jest.fn<Lstat>(realFs.lstat), mkdir = jest.fn(realFs.mkdir), open = jest.fn(realFs.open);
const writeFile = jest.fn(realFs.writeFile), unlink = jest.fn(realFs.unlink), rmdir = jest.fn(realFs.rmdir);
jest.unstable_mockModule('node:fs/promises', () => ({ ...realFs, lstat, mkdir, open, writeFile, unlink, rmdir }));
const { FileMemoryFence, FileMemoryFenceTimeoutError } = await import('../../../src/storage/FileMemoryFence.js');
const { FileMemoryTransactionCoordinator } = await import('../../../src/storage/FileMemoryTransactionCoordinator.js');
const { FileMemoryOwnerSnapshots } = await import('../../../src/storage/FileMemoryOwnerSnapshots.js');
const { FileMemoryVolumeStore } = await import('../../../src/storage/FileMemoryVolumeStore.js');
const { FileMemoryOwnedDelete } = await import('../../../src/storage/FileMemoryOwnedDelete.js');
const it = process.platform === 'win32' || !process.getuid ? jestIt.skip : jestIt;
const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [], aliases: string[] = [];
const mutations = [mkdir, open, writeFile, unlink, rmdir];
function clearMutations() { for (const spy of mutations) spy.mockClear(); }
function noMutations() { for (const spy of mutations) expect(spy).not.toHaveBeenCalled(); }
function noWriteMutations() {
  for (const spy of [mkdir, writeFile, unlink, rmdir]) expect(spy).not.toHaveBeenCalled();
  const writeFlags = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND;
  expect(open.mock.calls.filter(([, flags]) => typeof flags === 'number' ? (flags & writeFlags) !== 0 : typeof flags !== 'string' || !['r', 'rs', 'sr'].includes(flags))).toEqual([]);
}
async function tree(root: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (const name of (await realFs.readdir(root)).sort()) {
    const target = path.join(root, name), stat = await realFs.lstat(target, { bigint: true });
    entries.push({ name, identity: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.nlink],
      bytes: stat.isFile() ? await realFs.readFile(target) : undefined,
      children: stat.isDirectory() ? await tree(target) : undefined });
  }
  return entries;
}
async function root() {
  const target = await realFs.realpath(await realFs.mkdtemp(path.join(os.tmpdir(), 'canonical-fence-'))); roots.push(target); return target;
}
async function fixture() {
  const tenantRoot = await root();
  await realFs.writeFile(path.join(tenantRoot, 'memory.yaml'), 'entries: []\n');
  const fence = new FileMemoryFence();
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot, getCurrentUserId: () => USER, fence });
  const owners = new FileMemoryOwnerSnapshots({ coordinator });
  const snapshot = await owners.readHeadSnapshot('memory.yaml');
  if (snapshot.token.ownership !== 'unowned') throw new Error('Fixture must begin unowned');
  const token = await owners.adoptUnowned(snapshot.token);
  const archives = new FileMemoryVolumeStore({ coordinator, owners });
  await archives.createExclusive(token, { minimumVolume: 1, rawContent: 'entries: []\n', entryCount: 0, sealedAt: new Date('2026-10-01') });
  const fenceRoot = path.join(tenantRoot, '.memory-fences');
  await realFs.mkdir(path.join(fenceRoot, 'foreign.lock'), { mode: 0o700 });
  await realFs.writeFile(path.join(fenceRoot, 'foreign.lock', 'owner'), 'preserved foreign evidence', { mode: 0o600 });
  return { tenantRoot, fenceRoot, fence, coordinator, owners, token, request: { operationId: randomUUID(), expectedToken: token } };
}
function substituteIdentity(target: string, identity: BigIntStats, enabled: () => boolean = () => true) {
  let substitutions = 0;
  lstat.mockImplementation(async (...args: Parameters<typeof realFs.lstat>) => {
    const actual = await realFs.lstat(...args);
    if (String(args[0]) !== target || !enabled()) return actual;
    substitutions++;
    const clone = Object.create(Object.getPrototypeOf(actual)) as typeof actual;
    const bigint = typeof actual.dev === 'bigint';
    return Object.assign(clone, actual, { dev: bigint ? identity.dev : Number(identity.dev), ino: bigint ? identity.ino : Number(identity.ino) });
  });
  return () => substitutions;
}
afterEach(async () => {
  lstat.mockImplementation(realFs.lstat); clearMutations();
  for (const alias of aliases.splice(0)) await realFs.unlink(alias);
  for (const target of roots.splice(0)) await realFs.rm(target, { recursive: true, force: true });
});
describe('canonical archive/fence separation before lease mutation', () => {
  it.each(['tenant', 'generic', 'root-alias', 'coordinator', 'delete'] as const)(
    'refuses a disclosed actual-stat volume/fence alias through %s before any lease attempt', async entry => {
      const f = await fixture(), before = await tree(f.tenantRoot);
      const fenceIdentity = await realFs.lstat(f.fenceRoot, { bigint: true });
      const observed = substituteIdentity(path.join(f.tenantRoot, 'volumes'), fenceIdentity);
      let callback = false, result: unknown;
      const operation = () => { callback = true; return 'unexpected'; };
      let suppliedRoot = f.tenantRoot;
      if (entry === 'root-alias') {
        suppliedRoot = `${f.tenantRoot}-alias`; aliases.push(suppliedRoot); await realFs.symlink(f.tenantRoot, suppliedRoot);
      }
      clearMutations();
      const pending = entry === 'generic' ? f.fence.withFence({ tenantRoot: suppliedRoot, memoryLocator: 'memory.yaml' }, operation) :
        entry === 'coordinator' ? f.coordinator.withTenantTransaction(operation) :
          entry === 'delete' ? f.owners.deleteOwned(f.request) : f.fence.withTenantFence(suppliedRoot, operation);
      await expect(pending.then(value => { result = value; })).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect(observed()).toBeGreaterThan(0); expect(callback).toBe(false); expect(result).toBeUndefined(); noMutations();
      lstat.mockImplementation(realFs.lstat);
      expect(await tree(f.tenantRoot)).toEqual(before);
      expect((await f.owners.readHeadSnapshot(f.token.locator)).token).toEqual(f.token);
    });

  it('refuses standalone archive publication at the unsafe canonical-volume prelease boundary with zero lease attempts', async () => {
    const tenantRoot = await root(), target = await root();
    await realFs.writeFile(path.join(tenantRoot, 'memory.yaml'), 'entries: []\n');
    const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
    const owners = new FileMemoryOwnerSnapshots({ coordinator }), snapshot = await owners.readHeadSnapshot('memory.yaml');
    if (snapshot.token.ownership !== 'unowned') throw new Error('Fixture must begin unowned');
    const token = await owners.adoptUnowned(snapshot.token), archives = new FileMemoryVolumeStore({ coordinator, owners });
    await realFs.symlink(target, path.join(tenantRoot, 'volumes'));
    const before = await tree(tenantRoot), outside = await tree(target);
    const perform = jest.spyOn(coordinator, 'perform'); let result: unknown;
    clearMutations();
    try {
      await expect(archives.createExclusive(token, { minimumVolume: 1, rawContent: 'entries: []\n', entryCount: 0,
        sealedAt: new Date('2026-10-01') }).then(value => { result = value; })).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect(result).toBeUndefined(); expect(perform).not.toHaveBeenCalled(); noMutations();
    } finally { perform.mockRestore(); }
    expect(await tree(tenantRoot)).toEqual(before); expect(await tree(target)).toEqual(outside);
    expect((await owners.readHeadSnapshot(token.locator)).token).toEqual(token);
  });

  it.each(['volume-root', 'fence-root'] as const)('refuses canonical %s physical alias before parent mkdir', async role => {
    const tenantRoot = await root();
    await realFs.mkdir(path.join(tenantRoot, 'volumes'), { mode: 0o700 });
    if (role === 'fence-root') await realFs.mkdir(path.join(tenantRoot, '.memory-fences'), { mode: 0o700 });
    const before = await tree(tenantRoot), identity = await realFs.lstat(tenantRoot, { bigint: true });
    const observed = substituteIdentity(path.join(tenantRoot, role === 'volume-root' ? 'volumes' : '.memory-fences'), identity);
    clearMutations();
    await expect(new FileMemoryFence().withTenantFence(tenantRoot, () => 'unexpected')).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect(observed()).toBeGreaterThan(0); noMutations(); lstat.mockImplementation(realFs.lstat);
    expect(await tree(tenantRoot)).toEqual(before);
  });

  it.each(['file', 'symlink'] as const)('refuses unsafe canonical volumes %s without lease attempts', async kind => {
    const tenantRoot = await root();
    if (kind === 'file') await realFs.writeFile(path.join(tenantRoot, 'volumes'), 'preserved');
    else await realFs.symlink(tenantRoot, path.join(tenantRoot, 'volumes'));
    const before = await tree(tenantRoot); clearMutations();
    await expect(new FileMemoryFence().withTenantFence(tenantRoot, () => 'unexpected')).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    noMutations(); expect(await tree(tenantRoot)).toEqual(before);
  });

  it.each([false, true])('permits ordinary acquisition with absent fence and separate volumes present=%s', async present => {
    const tenantRoot = await root();
    if (present) { await realFs.mkdir(path.join(tenantRoot, 'volumes')); await realFs.writeFile(path.join(tenantRoot, 'volumes', 'retained'), 'archive'); }
    const before = present ? await tree(path.join(tenantRoot, 'volumes')) : undefined;
    await expect(new FileMemoryFence().withTenantFence(tenantRoot, () => 'done')).resolves.toBe('done');
    expect(await realFs.readdir(path.join(tenantRoot, '.memory-fences'))).toEqual([]);
    if (present) expect(await tree(path.join(tenantRoot, 'volumes'))).toEqual(before);
    else await expect(realFs.lstat(path.join(tenantRoot, 'volumes'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['volumes', '.memory-fences'])('permits actual cooperating creation of optional %s during admission', async child => {
    const tenantRoot = await root(), target = path.join(tenantRoot, child); let created = false;
    lstat.mockImplementation(async (...args: Parameters<typeof realFs.lstat>) => {
      try { return await realFs.lstat(...args); }
      catch (cause) {
        if (!created && String(args[0]) === target && (cause as NodeJS.ErrnoException).code === 'ENOENT') {
          created = true; await realFs.mkdir(target, { mode: 0o700 });
          if (child === 'volumes') await realFs.writeFile(path.join(target, 'retained'), 'cooperating archive');
        }
        throw cause;
      }
    });
    clearMutations();
    await expect(new FileMemoryFence().withTenantFence(tenantRoot, () => 'done')).resolves.toBe('done');
    expect(created).toBe(true);
    expect(mkdir.mock.calls.some(args => String(args[0]) === path.join(tenantRoot, 'volumes'))).toBe(false);
    expect(await realFs.readdir(path.join(tenantRoot, '.memory-fences'))).toEqual([]);
    if (child === 'volumes') expect(await realFs.readFile(path.join(target, 'retained'), 'utf8')).toBe('cooperating archive');
  });

  it('preserves an exact canonical observation failure through standalone DELETE without outcome markers', async () => {
    const f = await fixture(), before = await tree(f.tenantRoot), cause = Object.assign(new Error('canonical lstat denied'), { code: 'EACCES' });
    lstat.mockImplementation(async (...args: Parameters<typeof realFs.lstat>) => {
      const actual = await realFs.lstat(...args); if (String(args[0]) === path.join(f.tenantRoot, 'volumes')) throw cause;
      return actual;
    });
    clearMutations(); await expect(f.owners.deleteOwned(f.request)).rejects.toBe(cause); noMutations();
    expect(cause).not.toHaveProperty('result'); expect(cause).not.toHaveProperty('headDeleted');
    lstat.mockImplementation(realFs.lstat); expect(await tree(f.tenantRoot)).toEqual(before);
  });

  it('refuses a volume/fence alias introduced inside an already legitimate transaction before DELETE artifacts', async () => {
    const f = await fixture(); let reached = false;
    await expect(f.coordinator.withTenantTransaction(async context => {
      reached = true; const before = await tree(f.tenantRoot);
      const identity = await realFs.lstat(f.fenceRoot, { bigint: true });
      const observed = substituteIdentity(path.join(f.tenantRoot, 'volumes'), identity);
      const internals = FileMemoryOwnedDelete.prototype as unknown as { canonicalVolume(): Promise<BigIntStats | undefined> };
      const original = internals.canonicalVolume;
      const canonical = jest.spyOn(internals, 'canonicalVolume').mockImplementation(function(this: typeof internals) {
        return original.call(this);
      });
      clearMutations(); lstat.mockClear();
      try {
        await expect(f.owners.deleteOwnedInTransaction(context, f.request)).rejects.toMatchObject({ code: 'EHEADCONFLICT', cause: { code: 'EHEADCONFLICT' } });
        // Two canonical observations plus the genuine full root child census.
        expect(observed()).toBe(3); expect(canonical).toHaveBeenCalledTimes(2);
        // Existing-transaction admission retains genuine read-only proof descriptors.
        noWriteMutations(); expect(await tree(f.tenantRoot)).toEqual(before);
      } finally { lstat.mockImplementation(realFs.lstat); canonical.mockRestore(); }
    })).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect(reached).toBe(true);
    expect(await realFs.readdir(f.fenceRoot)).toEqual(['foreign.lock']);
    expect((await f.owners.readHeadSnapshot(f.token.locator)).token).toEqual(f.token);
  });

  it('rejects a late canonical alias between admission observations without any lease attempt', async () => {
    const f = await fixture(), before = await tree(f.tenantRoot); let volumeReads = 0;
    const identity = await realFs.lstat(f.fenceRoot, { bigint: true });
    const observed = substituteIdentity(path.join(f.tenantRoot, 'volumes'), identity, () => ++volumeReads === 2);
    clearMutations(); await expect(f.fence.withTenantFence(f.tenantRoot, () => 'unexpected')).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect(observed()).toBe(1); noMutations(); lstat.mockImplementation(realFs.lstat);
    expect(await tree(f.tenantRoot)).toEqual(before);
  });

  it('rejects a nonalias canonical directory replacement between admission observations before lease attempts', async () => {
    const f = await fixture(), other = path.join(f.tenantRoot, 'other-volume');
    await realFs.mkdir(other, { mode: 0o700 });
    const before = await tree(f.tenantRoot), identity = await realFs.lstat(other, { bigint: true });
    const rootIdentity = await realFs.lstat(f.tenantRoot, { bigint: true }), fenceIdentity = await realFs.lstat(f.fenceRoot, { bigint: true });
    expect([String(rootIdentity.ino), String(fenceIdentity.ino)]).not.toContain(String(identity.ino));
    let volumeReads = 0;
    const observed = substituteIdentity(path.join(f.tenantRoot, 'volumes'), identity, () => ++volumeReads === 2);
    clearMutations(); await expect(f.fence.withTenantFence(f.tenantRoot, () => 'unexpected')).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect(observed()).toBe(1); noMutations(); lstat.mockImplementation(realFs.lstat);
    expect(await tree(f.tenantRoot)).toEqual(before);
  });

  it('rechecks changed admission after waiting on a real foreign lease before another lease mkdir', async () => {
    const f = await fixture(), lock = path.join(f.fenceRoot, 'tenant.lock');
    await realFs.mkdir(lock, { mode: 0o700 }); await realFs.writeFile(path.join(lock, 'owner'), 'foreign owner', { mode: 0o600 });
    const before = await tree(f.tenantRoot), identity = await realFs.lstat(f.fenceRoot, { bigint: true });
    // First admission/parent mkdir/acquisition observe the genuine directories.
    // After the first real EEXIST lease attempt, the retry sees a disclosed alias.
    const observed = substituteIdentity(path.join(f.tenantRoot, 'volumes'), identity,
      () => mkdir.mock.calls.some(args => String(args[0]) === lock));
    clearMutations();
    await expect(f.fence.withTenantFence(f.tenantRoot, () => 'unexpected', { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect(observed()).toBeGreaterThan(0);
    expect(mkdir.mock.calls.filter(args => String(args[0]) === lock)).toHaveLength(1);
    expect(open).not.toHaveBeenCalled(); expect(writeFile).not.toHaveBeenCalled(); expect(unlink).not.toHaveBeenCalled(); expect(rmdir).not.toHaveBeenCalled();
    lstat.mockImplementation(realFs.lstat); expect(await tree(f.tenantRoot)).toEqual(before);
  });

  it('retains deadline refusal after slow read-only retry admission, before another lease mkdir', async () => {
    const f = await fixture(), lock = path.join(f.fenceRoot, 'tenant.lock');
    await realFs.mkdir(lock, { mode: 0o700 }); await realFs.writeFile(path.join(lock, 'owner'), 'foreign owner', { mode: 0o600 });
    const before = await tree(f.tenantRoot); let delayed = false;
    lstat.mockImplementation(async (...args: Parameters<typeof realFs.lstat>) => {
      const actual = await realFs.lstat(...args);
      if (!delayed && String(args[0]) === path.join(f.tenantRoot, 'volumes') && mkdir.mock.calls.some(args => String(args[0]) === lock)) {
        delayed = true; await new Promise(resolve => setTimeout(resolve, 300));
      }
      return actual;
    });
    clearMutations();
    await expect(f.fence.withTenantFence(f.tenantRoot, () => 'unexpected', { timeoutMs: 250 })).rejects.toBeInstanceOf(FileMemoryFenceTimeoutError);
    expect(delayed).toBe(true); expect(mkdir.mock.calls.filter(args => String(args[0]) === lock)).toHaveLength(1);
    expect(open).not.toHaveBeenCalled(); expect(writeFile).not.toHaveBeenCalled(); expect(unlink).not.toHaveBeenCalled(); expect(rmdir).not.toHaveBeenCalled();
    lstat.mockImplementation(realFs.lstat); expect(await tree(f.tenantRoot)).toEqual(before);
  });
});
