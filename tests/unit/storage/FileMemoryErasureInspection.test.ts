import { afterEach, describe, expect, it as jestIt, jest } from '@jest/globals';
import * as realFs from 'node:fs/promises';
import { type BigIntStats, type Dir } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const open = jest.fn(realFs.open), lstat = jest.fn(realFs.lstat), opendir = jest.fn(realFs.opendir);
jest.unstable_mockModule('node:fs/promises', () => ({ ...realFs, open, lstat, opendir }));
const { ErasureAccounting, ErasureInspection } = await import('../../../src/storage/FileMemoryErasureInspection.js');
const it = process.platform === 'win32' || !process.getuid ? jestIt.skip : jestIt;
const roots: string[] = [];
const OWNER = '11111111-1111-4111-8111-111111111111';
async function fixture() {
  const root = await realFs.realpath(await realFs.mkdtemp(path.join(os.tmpdir(), 'erasure-inspection-'))); roots.push(root);
  await realFs.chmod(root, 0o700);
  const stat = await realFs.lstat(root, { bigint: true }), accounting = new ErasureAccounting();
  const active = jest.fn();
  return { root, accounting, active, inspect: new ErasureInspection(root, String(stat.dev), accounting, active) };
}
afterEach(async () => {
  open.mockReset(); open.mockImplementation(realFs.open); lstat.mockReset(); lstat.mockImplementation(realFs.lstat);
  opendir.mockReset(); opendir.mockImplementation(realFs.opendir);
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) await realFs.rm(root, { recursive: true, force: true });
});

describe('content-free erasure inspection', () => {
  it('inventories a real private tree in postorder without payload reads', async () => {
    const f = await fixture(), owner = path.join(f.root, 'volumes', 'by-id', OWNER);
    await realFs.mkdir(path.join(owner, 'unknown'), { recursive: true, mode: 0o700 });
    await realFs.writeFile(path.join(owner, 'payload.yaml'), 'invalid: [secret payload', { mode: 0o600 });
    await realFs.writeFile(path.join(owner, 'unknown', 'partial'), '{broken bytes', { mode: 0o600 });
    const reads: string[] = [];
    open.mockImplementation(async (...args) => {
      const handle = await realFs.open(...args), original = handle.read.bind(handle);
      jest.spyOn(handle, 'read').mockImplementation((...readArgs: Parameters<typeof handle.read>) => { reads.push(String(args[0])); return original(...readArgs); });
      return handle;
    });
    const nodes = await f.inspect.inventory(OWNER);
    expect(reads).toEqual([]); expect(f.accounting.actual.recordReadBytes).toBe(0);
    expect(nodes.map(node => node.name)).toEqual(['payload.yaml', 'partial', 'unknown', OWNER]);
    expect(nodes.map(node => node.parent)).toEqual([3, 2, 3, null]);
    // N=4 and d=2: every edge costs one entry, every directory costs EOF.
    expect(f.accounting.discoveryConsumed).toBe(4 - 1 + 2);
    expect(f.accounting.actual.directoryReads).toBe(5);
    expect(f.accounting.actual.closes).toBe(6); // two Dir and four descriptors
  });
  it('captures shared names without inspecting unrelated children, while selected/full observations retain actual identities', async () => {
    const f = await fixture();
    await realFs.writeFile(path.join(f.root, 'selected'), 'selected bytes', { mode: 0o600 });
    await realFs.symlink('/unresolved-foreign-target', path.join(f.root, 'foreign'));
    const shared = await f.inspect.sharedDirectory('.');
    expect(shared).toMatchObject({ kind: 'names', names: ['foreign', 'selected'] });
    expect(shared).not.toHaveProperty('children');
    expect(opendir.mock.calls.at(-1)).toEqual([f.root, { bufferSize: 4096 }]);
    expect(lstat.mock.calls.map(call => String(call[0]))).toEqual([f.root, f.root]);
    expect(f.accounting.actual.directoryReads).toBe(3); // two names plus EOF
    expect(f.accounting.actual.closes).toBe(2);
    expect(open.mock.calls.every(call => String(call[0]) === f.root)).toBe(true);
    const selected = await f.inspect.file('selected');
    expect(selected.identity.inode).toBe(String((await realFs.lstat(path.join(f.root, 'selected'), { bigint: true })).ino));
    const full = await f.inspect.directory('.');
    expect(full.children.map(child => child.name)).toEqual(['foreign', 'selected']);
    expect(opendir.mock.calls.at(-1)).toEqual([f.root, undefined]);
    expect(lstat.mock.calls.some(call => String(call[0]) === path.join(f.root, 'foreign'))).toBe(true);
    expect(await realFs.readlink(path.join(f.root, 'foreign'))).toBe('/unresolved-foreign-target');
    await realFs.chmod(path.join(f.root, 'selected'), 0o644);
    await expect(f.inspect.file('selected')).rejects.toMatchObject({ code: 'EERASURERESIDUAL' });
  }, 10_000);
  it('refuses a shared containing-directory interval change and still closes its real descriptor', async () => {
    const f = await fixture(); let observations = 0;
    lstat.mockImplementation((async (...args: Parameters<typeof realFs.lstat>) => {
      const stat = await realFs.lstat(...args);
      if (String(args[0]) === f.root && ++observations === 2) {
        const value = stat as BigIntStats;
        return Object.assign(value, { ctimeNs: value.ctimeNs + 1n });
      }
      return stat;
    }) as typeof realFs.lstat);
    await expect(f.inspect.sharedDirectory('.')).rejects.toMatchObject({ code: 'EERASURERESIDUAL' });
    expect(f.accounting.actual.directoryReads).toBe(1); expect(f.accounting.actual.closes).toBe(2);
    expect(f.accounting.actual.recordReadBytes).toBe(0);
  }, 10_000);
  it.each([4095, 4096])('keeps logical shared entry/EOF bounds and actual close with buffered named entries=%i', async entries => {
    const f = await fixture();
    for (let first = 0; first < entries; first += 32) await Promise.all(
      Array.from({ length: Math.min(32, entries - first) }, (_, offset) =>
        realFs.writeFile(path.join(f.root, `f${String(first + offset).padStart(4, '0')}`), '', { mode: 0o600 })));
    const before = (await realFs.readdir(f.root)).sort();
    let directory: Dir | undefined; const reads: (string | null)[] = [];
    opendir.mockImplementation(async (...args: Parameters<typeof realFs.opendir>) => {
      directory = await realFs.opendir(...args); const original = directory.read.bind(directory);
      jest.spyOn(directory, 'read').mockImplementation(async () => {
        const entry = await original(); reads.push(entry?.name ?? null); return entry;
      });
      return directory;
    });
    if (entries === 4095) {
      const capture = await f.inspect.sharedDirectory('.');
      expect(capture.names).toEqual(before); expect(reads.at(-1)).toBeNull();
    } else {
      await expect(f.inspect.sharedDirectory('.')).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
      expect(reads.at(-1)).not.toBeNull(); // the 4096th actual entry cannot masquerade as EOF
    }
    expect(reads).toHaveLength(4096); expect(f.accounting.actual.directoryReads).toBe(4096);
    expect(f.accounting.actual.closes).toBe(2); expect(f.accounting.discoveryConsumed).toBe(0);
    expect(opendir.mock.calls).toEqual([[f.root, { bufferSize: 4096 }]]);
    expect(lstat.mock.calls.every(call => String(call[0]) === f.root)).toBe(true);
    await expect(directory!.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
    expect((await realFs.readdir(f.root)).sort()).toEqual(before);
    expect(f.accounting.actual.recordReadBytes).toBe(0);
  }, 10_000);
  it.each([16, 17])('admits depth 16 and refuses depth 17 on a real private chain (depth=%i)', async depth => {
    const f = await fixture(), owner = path.join(f.root, 'volumes', 'by-id', OWNER);
    await realFs.mkdir(owner, { recursive: true, mode: 0o700 });
    let leaf = owner;
    for (let level = 1; level <= depth; level++) { leaf = path.join(leaf, `d${level}`); await realFs.mkdir(leaf, { mode: 0o700 }); }
    const before = await realFs.lstat(leaf, { bigint: true });
    if (depth === 16) {
      const nodes = await f.inspect.inventory(OWNER);
      expect(nodes).toHaveLength(17); expect(f.accounting.discoveryConsumed).toBe(33);
    } else await expect(f.inspect.inventory(OWNER)).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(await realFs.lstat(leaf, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, mode: before.mode });
    expect(await realFs.readdir(leaf)).toEqual([]);
  }, 10_000);
  it.each([false, true])('qualifies the conditional object/discovery boundary on actual named files (nested=%s)', async nested => {
    const f = await fixture(), owner = path.join(f.root, 'volumes', 'by-id', OWNER);
    await realFs.mkdir(owner, { recursive: true, mode: 0o700 });
    const count = nested ? 4093 : 4095;
    for (let first = 0; first < count; first += 32) await Promise.all(
      Array.from({ length: Math.min(32, count - first) }, (_, offset) =>
        realFs.writeFile(path.join(owner, `f${String(first + offset).padStart(4, '0')}`), 'retained', { mode: 0o600 })));
    if (nested) { await realFs.mkdir(path.join(owner, 'nested'), { mode: 0o700 });
      await realFs.writeFile(path.join(owner, 'nested', 'leaf'), 'retained nested', { mode: 0o600 }); }
    const before = await realFs.lstat(owner, { bigint: true });
    if (!nested) {
      const nodes = await f.inspect.inventory(OWNER);
      expect(nodes).toHaveLength(4096); expect(f.accounting.discoveryConsumed).toBe(4096);
    } else {
      // Same N=4096, but d=2 requires N-1+d=4097 attempts; admission must refuse.
      await expect(f.inspect.inventory(OWNER)).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
      expect(f.accounting.discoveryConsumed).toBe(4096);
      expect(await realFs.readFile(path.join(owner, 'nested', 'leaf'), 'utf8')).toBe('retained nested');
    }
    expect(await realFs.readdir(owner)).toHaveLength(nested ? 4094 : 4095);
    for (let first = 0; first < count; first += 32) {
      const contents = await Promise.all(Array.from({ length: Math.min(32, count - first) }, (_, offset) =>
        realFs.readFile(path.join(owner, `f${String(first + offset).padStart(4, '0')}`), 'utf8')));
      expect(contents.every(content => content === 'retained')).toBe(true);
    }
    expect(await realFs.readFile(path.join(owner, `f${String(count - 1).padStart(4, '0')}`), 'utf8')).toBe('retained');
    expect(await realFs.lstat(owner, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, mode: before.mode });
    expect(f.accounting.actual.recordReadBytes).toBe(0);
  }, 10_000);
  it.each(['symlink', 'hardlink', 'public-file', 'public-directory'] as const)('refuses unsafe %s without reading its bytes', async kind => {
    const f = await fixture(), target = path.join(f.root, 'selected');
    await realFs.writeFile(path.join(f.root, 'retained'), 'untouched', { mode: 0o600 });
    if (kind === 'symlink') await realFs.symlink(path.join(f.root, 'retained'), target);
    if (kind === 'hardlink') await realFs.link(path.join(f.root, 'retained'), target);
    if (kind === 'public-file') await realFs.writeFile(target, 'private data', { mode: 0o644 });
    if (kind === 'public-directory') await realFs.mkdir(target, { mode: 0o755 });
    await expect(kind === 'public-directory' ? f.inspect.directory('selected') : f.inspect.file('selected')).rejects.toMatchObject({ code: 'EERASURERESIDUAL' });
    expect(open).not.toHaveBeenCalled(); expect(await realFs.readFile(path.join(f.root, 'retained'), 'utf8')).toBe('untouched');
  });
  it.each(['wrong-device', 'wrong-uid', 'fifo'] as const)('rejects actual-stat evidence classified as %s before open', async kind => {
    const f = await fixture(); await realFs.writeFile(path.join(f.root, 'selected'), 'retained', { mode: 0o600 });
    lstat.mockImplementation((async (...args: Parameters<typeof realFs.lstat>) => {
      const stat = await realFs.lstat(...args);
      if (String(args[0]).endsWith('/selected')) {
        const value = stat as BigIntStats;
        if (kind === 'wrong-device') return Object.assign(value, { dev: value.dev + 1n }) as never;
        if (kind === 'wrong-uid') return Object.assign(value, { uid: value.uid + 1n }) as never;
        return Object.assign(value, { isFile: () => false, isFIFO: () => true }) as never;
      }
      return stat;
    }) as typeof realFs.lstat);
    await expect(f.inspect.file('selected')).rejects.toMatchObject({ code: 'EERASURERESIDUAL' });
    expect(open).not.toHaveBeenCalled();
  });
  it('ignores atime-only observation changes while retaining identity and close proofs', async () => {
    const f = await fixture(); await realFs.writeFile(path.join(f.root, 'selected'), 'retained', { mode: 0o600 });
    let tick = 0n;
    open.mockImplementation(async (...args) => {
      const handle = await realFs.open(...args), original = handle.stat.bind(handle);
      jest.spyOn(handle, 'stat').mockImplementation(async (...statArgs: Parameters<typeof handle.stat>) => {
        const stat = await original(...statArgs); Object.assign(stat, { atimeNs: ++tick, atimeMs: tick }); return stat;
      });
      return handle;
    });
    const observed = await f.inspect.file('selected');
    expect(observed.identity.size).toBe('8'); expect(tick).toBe(2n); expect(f.accounting.actual.closes).toBe(1);
  });
});

describe('actual erasure work accounting', () => {
  it('charges successful entries and EOF in a real directory census', async () => {
    const f = await fixture(); await realFs.writeFile(path.join(f.root, 'one'), '', { mode: 0o600 });
    expect(await f.inspect.names('.', true)).toEqual(['one']);
    expect(f.accounting.actual.directoryReads).toBe(2); expect(f.accounting.discoveryConsumed).toBe(2);
    expect(f.accounting.actual.censuses).toBe(1); expect(f.accounting.actual.closes).toBe(1);
  });
  it('charges a thrown read before failure and retains discovery when reserving a suffix', async () => {
    const accounting = new ErasureAccounting(), cause = Object.assign(new Error('read failed'), { code: 'EIO' });
    const directory = { read: jest.fn(async () => { throw cause; }) } as unknown as Dir;
    await expect(accounting.read(directory, true)).rejects.toBe(cause);
    expect(accounting.actual.directoryReads).toBe(1); expect(accounting.discoveryConsumed).toBe(1);
    accounting.reserve([2, 3]); expect(accounting.reservedDirectoryReads).toBe(6);
    expect(() => accounting.reserve([1])).toThrow(expect.objectContaining({ code: 'EHEADRESOURCE' }));
  });
  it('admits 4,096 discovery attempts, then refuses before another read syscall', async () => {
    const accounting = new ErasureAccounting(), read = jest.fn(async () => null), directory = { read } as unknown as Dir;
    // A 4,095-edge tree with one directory consumes N-1+d=4,096.
    for (let index = 0; index < 4096; index++) await accounting.read(directory, true);
    expect(accounting.discoveryConsumed).toBe(4096);
    // Adding another directory EOF exceeds discovery even if N itself fits.
    expect(() => accounting.read(directory, true)).toThrow(expect.objectContaining({ code: 'EHEADRESOURCE' }));
    expect(read).toHaveBeenCalledTimes(4096);
  });
  it('refuses invalid reservations and arithmetic overflow without refunding work', () => {
    for (const weight of [0, -1, 4097, 1.5, Number.MAX_SAFE_INTEGER]) expect(() => new ErasureAccounting().reserve([weight])).toThrow();
    const accounting = new ErasureAccounting(); accounting.charge('closes', Number.MAX_SAFE_INTEGER);
    expect(() => accounting.charge('closes')).toThrow(expect.objectContaining({ code: 'EHEADRESOURCE' }));
    expect(accounting.actual.closes).toBe(Number.MAX_SAFE_INTEGER);
    const limited = new ErasureAccounting(); limited.reserve([1]); limited.charge('directoryReads');
    expect(() => limited.charge('directoryReads')).toThrow(); expect(limited.actual.directoryReads).toBe(1);
  });
});

describe('mandatory close after reservation refusal', () => {
  it('actually closes an opened descriptor when no close allowance remains', async () => {
    const f = await fixture(); await realFs.writeFile(path.join(f.root, 'record'), 'xxx', { mode: 0o600 });
    const allowances = { ...f.accounting.actual };
    for (const kind of Object.keys(allowances) as (keyof typeof allowances)[]) allowances[kind] = 100;
    allowances.closes = 0; f.accounting.reserveOperations(allowances);
    let checkClosed: (() => Promise<unknown>) | undefined;
    const closeAttempts = jest.fn();
    open.mockImplementation(async (...args) => {
      const handle = await realFs.open(...args), actualClose = handle.close.bind(handle), actualStat = handle.stat.bind(handle);
      checkClosed = () => actualStat();
      jest.spyOn(handle, 'close').mockImplementation(async () => { closeAttempts(); await actualClose(); });
      return handle;
    });
    await expect(f.inspect.record('record')).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    expect(closeAttempts).toHaveBeenCalledTimes(1);
    await expect(checkClosed!()).rejects.toMatchObject({ code: 'EBADF' });
    expect(f.accounting.actual.closes).toBe(1);
  });
  it('retains body failure, close admission refusal and real close failure while closing the descriptor', async () => {
    const f = await fixture(); await realFs.writeFile(path.join(f.root, 'record'), 'xxx', { mode: 0o600 });
    const allowances = { ...f.accounting.actual };
    for (const kind of Object.keys(allowances) as (keyof typeof allowances)[]) allowances[kind] = 100;
    allowances.closes = 0; f.accounting.reserveOperations(allowances);
    const body = Object.assign(new Error('body failed'), { code: 'EIO' }), close = new Error('actual close failed');
    let checkClosed: (() => Promise<unknown>) | undefined;
    const closeAttempts = jest.fn();
    open.mockImplementation(async (...args) => {
      const handle = await realFs.open(...args), actualClose = handle.close.bind(handle), actualStat = handle.stat.bind(handle);
      checkClosed = () => actualStat();
      jest.spyOn(handle, 'stat').mockRejectedValue(body);
      jest.spyOn(handle, 'close').mockImplementation(async () => { closeAttempts(); await actualClose(); throw close; });
      return handle;
    });
    let observed: unknown;
    try { await f.inspect.record('record'); } catch (cause) { observed = cause; }
    expect(observed).toMatchObject({ code: 'EIO', errors: [
      { code: 'EIO', cause: body, errors: [body, { code: 'EHEADRESOURCE' }] }, close,
    ] });
    expect(closeAttempts).toHaveBeenCalledTimes(1);
    await expect(checkClosed!()).rejects.toMatchObject({ code: 'EBADF' });
    expect(f.accounting.actual.closes).toBe(1);
  });
});

describe('bounded descriptor record qualification', () => {
  it('writes and reads back actual UTF-8 bytes after writer close', async () => {
    const f = await fixture(), raw = '界'.repeat(2730) + 'xx'; // exactly 8,192 bytes
    const result = await f.inspect.writeRecord('record', raw, async () => {});
    expect(result.identity.size).toBe('8192'); expect(f.accounting.actual.recordWriteBytes).toBe(8192);
    expect(f.accounting.actual.recordReadBytes).toBe(8192); expect(f.accounting.actual.recordReads).toBeGreaterThanOrEqual(2);
    expect(f.accounting.actual.closes).toBe(2);
    expect((await f.inspect.record('record')).raw).toBe(raw);
    await expect(f.inspect.writeRecord('overflow', `${raw}x`, async () => {})).rejects.toMatchObject({ code: 'EHEADRESOURCE' });
    await expect(realFs.lstat(path.join(f.root, 'overflow'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses invalid UTF-8 and oversized existing records before unbounded materialization', async () => {
    const f = await fixture(); await realFs.writeFile(path.join(f.root, 'invalid'), Buffer.from([0xff]), { mode: 0o600 });
    await expect(f.inspect.record('invalid')).rejects.toMatchObject({ code: 'EERASURERESIDUAL' });
    await realFs.writeFile(path.join(f.root, 'large'), Buffer.alloc(8193), { mode: 0o600 }); open.mockClear();
    await expect(f.inspect.record('large')).rejects.toMatchObject({ code: 'EHEADRESOURCE' }); expect(open).not.toHaveBeenCalled();
  });
  it('detects altered readback bytes even when read length and identity still match', async () => {
    const f = await fixture();
    open.mockImplementation(async (...args) => {
      const handle = await realFs.open(...args), original = handle.read.bind(handle);
      if (String(args[0]).endsWith('/record')) jest.spyOn(handle, 'read').mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await original(...readArgs);
        if (result.bytesRead && Buffer.isBuffer(readArgs[0])) readArgs[0][0] = 0x79;
        return result;
      });
      return handle;
    });
    await expect(f.inspect.writeRecord('record', 'xxx', async () => {})).rejects.toMatchObject({ code: 'EERASURERESIDUAL' });
    expect(await realFs.readFile(path.join(f.root, 'record'), 'utf8')).toBe('xxx');
  });
  it('preserves primary descriptor failure and the actual close failure', async () => {
    const f = await fixture(); await realFs.writeFile(path.join(f.root, 'record'), 'xxx', { mode: 0o600 });
    const primary = Object.assign(new Error('descriptor failed'), { code: 'EIO' }), close = new Error('close failed');
    open.mockImplementation(async (...args) => {
      const handle = await realFs.open(...args), actualClose = handle.close.bind(handle);
      jest.spyOn(handle, 'stat').mockRejectedValue(primary);
      jest.spyOn(handle, 'close').mockImplementation(async () => { await actualClose(); throw close; });
      return handle;
    });
    await expect(f.inspect.record('record')).rejects.toMatchObject({ code: 'EIO', cause: primary, errors: [primary, close] });
    expect(f.accounting.actual.closes).toBe(1);
  });
});
