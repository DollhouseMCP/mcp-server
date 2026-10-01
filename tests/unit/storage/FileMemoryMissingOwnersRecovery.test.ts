import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type AdoptionRecoveryPublication, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryAdoptionRecoveryScanBudget } from '../../../src/storage/FileMemoryAdoptionRecoveryScanBudget.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';

const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
async function fixture(locator = 'Notes/ÜberNote.yaml') {
  const tenantRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'missing-owners-'));
  roots.push(tenantRoot);
  const headPath = path.join(tenantRoot, locator);
  if (path.dirname(headPath) !== tenantRoot) await fs.mkdir(path.dirname(headPath));
  await fs.writeFile(headPath, 'name: Original\nentries: []\n');
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
  const store = new FileMemoryOwnerSnapshots({ coordinator });
  const legacy = await store.readHeadSnapshot(locator);
  const interrupted = new FileMemoryOwnerSnapshots({ coordinator, afterPublication: phase => {
    if (phase === 'reserved-registry') throw new Error('fixture interruption');
  } });
  await expect(interrupted.adoptUnowned(legacy.token as UnownedFileMemoryToken)).rejects.toThrow('fixture interruption');
  const hash = createHash('sha256').update(path.basename(headPath)).digest('hex');
  const sidecarPath = path.join(path.dirname(headPath), `.${hash}.memory-owner.json`);
  const record = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  const request = { locator, ownerId: record.ownerId as string };
  const parent = path.join(tenantRoot, '.memory-owners');
  const directory = path.join(parent, 'owners');
  const registryPath = path.join(directory, `${request.ownerId}.json`);
  await fs.unlink(registryPath); await fs.rmdir(directory);
  const archivePath = path.join(tenantRoot, 'archive-evidence');
  await fs.writeFile(archivePath, 'untouched archive');
  return { tenantRoot, coordinator, store, request, headPath, sidecarPath, parent, directory, registryPath, archivePath };
}
type Setup = Awaited<ReturnType<typeof fixture>>;
async function directoryIdentity(file: string) {
  const stat = await fs.lstat(file, { bigint: true });
  return { dev: stat.dev, inode: stat.ino, size: stat.size, mtime: stat.mtimeNs,
    ctime: stat.ctimeNs, mode: stat.mode, uid: stat.uid, links: stat.nlink };
}
async function proof(files: string[]) {
  return Promise.all(files.map(async file => {
    const stat = await fs.lstat(file, { bigint: true });
    return { dev: stat.dev, inode: stat.ino, mode: stat.mode, links: stat.nlink, size: stat.size,
      mtime: stat.mtimeNs, ctime: stat.ctimeNs, bytes: await fs.readFile(file) };
  }));
}
function at(setup: Setup, stop: AdoptionRecoveryPublication, hook: () => void | Promise<void>) {
  return new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator, afterAdoptionRecoveryPublication: phase => {
    if (phase === stop) return hook();
  } });
}
async function failure(action: Promise<unknown>) {
  try { await action; } catch (cause) { return cause as { code: string; phase?: string; cause: unknown; closeCause?: unknown }; }
  throw new Error('expected failure');
}
afterEach(async () => {
  jest.restoreAllMocks(); SecurityMonitor.clearAllEventsForTesting();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
describe('existing private parent with missing owners child recovery', () => {
  if (process.platform === 'win32') {
    it('retains POSIX restrictions', () => {
      const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: 'C:\\', getCurrentUserId: () => USER, fence: new FileMemoryFence() });
      expect(() => new FileMemoryOwnerSnapshots({ coordinator })).toThrow('requires POSIX');
    });
    return;
  }
  it('creates the private child and completes only one tracked operation', async () => {
    const setup = await fixture();
    const original = await proof([setup.headPath, setup.archivePath]);
    const perform = jest.spyOn(setup.coordinator, 'perform');
    expect((await setup.store.recoverReservedAdoption(setup.request)).status).toBe('known-adopted');
    expect(perform).toHaveBeenCalledTimes(1);
    expect(Number((await fs.lstat(setup.directory)).mode) & 0o777).toBe(0o700);
    expect(await proof([setup.headPath, setup.archivePath])).toEqual(original);
    expect(await setup.store.recoverReservedAdoption(setup.request)).toEqual({ status: 'already-clean-no-attribution' });
  });
  it.each(['parent-mode', 'parent-alias', 'child-residue'] as const)('preserves unsupported %s', async kind => {
    const setup = await fixture();
    if (kind === 'parent-mode') await fs.chmod(setup.parent, 0o755);
    if (kind === 'parent-alias') await fs.rename(setup.parent, path.join(setup.tenantRoot, '.MEMORY-OWNERS'));
    if (kind === 'child-residue') await fs.writeFile(path.join(setup.parent, 'owners.partial'), 'foreign');
    const before = await proof([setup.headPath, setup.sidecarPath, setup.archivePath]);
    await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect(await proof([setup.headPath, setup.sidecarPath, setup.archivePath])).toEqual(before);
    await expect(fs.lstat(setup.registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['before-owners-directory-create', 'after-owners-directory-create', 'before-registry-create'] as const)('refuses revoked authority at %s', async stop => {
    const setup = await fixture();
    const result = await failure(at(setup, stop, () => {
      jest.spyOn(setup.coordinator, 'requireActiveOperationScope').mockImplementation(() => { throw new Error('revoked'); });
    }).recoverReservedAdoption(setup.request));
    expect(result.code).toBe('EADOPTIONPENDING');
    expect(result).not.toHaveProperty('token');
    await expect(fs.lstat(setup.registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    if (stop !== 'before-owners-directory-create') expect(await fs.readdir(setup.directory)).toEqual([]);
  });
  it.each(['after-owners-directory-create', 'before-registry-create', 'after-registry-create'] as const)('retains original tenant census through %s', async stop => {
    const setup = await fixture();
    const result = await failure(at(setup, stop, async () => {
      await fs.writeFile(path.join(setup.tenantRoot, 'late-evidence'), 'foreign');
    }).recoverReservedAdoption(setup.request));
    expect(result.code).toBe('EADOPTIONPENDING');
    expect(result).not.toHaveProperty('token');
    expect(await fs.readFile(path.join(setup.tenantRoot, 'late-evidence'), 'utf8')).toBe('foreign');
    expect(JSON.parse(await fs.readFile(setup.sidecarPath, 'utf8')).state).toBe('RESERVED');
    if (stop !== 'after-registry-create') await expect(fs.lstat(setup.registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['headPath', 'sidecarPath'] as const)('rejects original %s inode replacement', async field => {
    const setup = await fixture();
    await expect(at(setup, 'after-owners-directory-create', async () => {
      const bytes = await fs.readFile(setup[field]);
      await fs.rename(setup[field], `${setup[field]}.saved`);
      await fs.writeFile(setup[field], bytes, { mode: 0o600 });
      await fs.unlink(`${setup[field]}.saved`);
    }).recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING', phase: 'owners-directory-created' });
    await expect(fs.lstat(setup.registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses an unexpected registry appearing after child capture', async () => {
    const setup = await fixture();
    const result = await failure(at(setup, 'after-owners-directory-create', () => fs.writeFile(setup.registryPath, 'foreign', { mode: 0o600 })).recoverReservedAdoption(setup.request));
    expect(result.phase).toBe('owners-directory-created');
    expect(await fs.readFile(setup.registryPath, 'utf8')).toBe('foreign');
  });
  it('rejects a root case alias introduced at the registry hook before opening the registry', async () => {
    const setup = await fixture();
    const result = await failure(at(setup, 'before-registry-create', async () => {
      await fs.rename(setup.parent, path.join(setup.tenantRoot, '.MEMORY-OWNERS'));
    }).recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'owners-directory-created' });
    expect(await fs.readdir(path.join(setup.tenantRoot, '.MEMORY-OWNERS', 'owners'))).toEqual([]);
    expect(JSON.parse(await fs.readFile(setup.sidecarPath, 'utf8')).state).toBe('RESERVED');
  });
  it('rejects replacement of the private parent without publishing any registry', async () => {
    const setup = await fixture();
    const result = await failure(at(setup, 'after-owners-directory-create', async () => {
      await fs.rename(setup.parent, `${setup.parent}.saved`);
      await fs.mkdir(setup.parent, { mode: 0o700 });
      await fs.mkdir(setup.directory, { mode: 0o700 });
    }).recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'owners-directory-created' });
    expect(await fs.readdir(path.join(`${setup.parent}.saved`, 'owners'))).toEqual([]);
    await expect(fs.lstat(setup.registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('uses one monotonic scan budget through all phases', async () => {
    const setup = await fixture();
    const original = FileMemoryAdoptionRecoveryScanBudget.prototype.read;
    const instances = new Set<FileMemoryAdoptionRecoveryScanBudget>();
    const counts: number[] = [];
    jest.spyOn(FileMemoryAdoptionRecoveryScanBudget.prototype, 'read').mockImplementation(function(this: FileMemoryAdoptionRecoveryScanBudget, directory, attempts, bound) {
      instances.add(this); counts.push(this.consumed); return original.call(this, directory, attempts, bound);
    });
    await setup.store.recoverReservedAdoption(setup.request);
    expect(instances.size).toBe(1);
    expect(counts).toEqual(counts.map((_, index) => index));
  });
  it.each([null, undefined, new Error('capture failed')])('preserves direct capture cause %s and secondary close failure', async primary => {
    const setup = await fixture();
    const probe = await fs.open(setup.parent, 'r');
    const methods = Object.getPrototypeOf(probe) as { stat(...args: unknown[]): Promise<unknown> };
    await probe.close();
    const secondary = new Error('capture close failed');
    const internals = setup.store as unknown as { captureOwnersDirectory: (...args: unknown[]) => Promise<unknown> };
    const capture = internals.captureOwnersDirectory;
    jest.spyOn(internals, 'captureOwnersDirectory').mockImplementation(function(...args) {
      const spy = jest.spyOn(methods, 'stat').mockImplementation(async function(this: { close(): Promise<void> }) {
        spy.mockRestore();
        const close = this.close;
        this.close = async () => { await close.call(this); throw secondary; };
        throw primary;
      });
      return capture.apply(this, args);
    });
    const result = await failure(setup.store.recoverReservedAdoption(setup.request));
    expect(result.phase).toBe('owners-directory-creation-unknown');
    expect(result.cause).toBe(primary); expect(result.closeCause).toBe(secondary);
    expect(result).not.toHaveProperty('token');
    expect(await fs.readdir(setup.directory)).toEqual([]);
    jest.restoreAllMocks();
    expect((await setup.store.recoverReservedAdoption(setup.request)).status).toBe('known-adopted');
  });
  it('retains close-only uncertainty after successful descriptor capture', async () => {
    const setup = await fixture();
    const probe = await fs.open(setup.parent, 'r');
    const methods = Object.getPrototypeOf(probe) as { stat(...args: unknown[]): Promise<unknown> };
    await probe.close();
    const stat = methods.stat;
    const cause = new Error('close only');
    const internals = setup.store as unknown as { captureOwnersDirectory: (...args: unknown[]) => Promise<unknown> };
    const capture = internals.captureOwnersDirectory;
    jest.spyOn(internals, 'captureOwnersDirectory').mockImplementation(function(...args) {
      const spy = jest.spyOn(methods, 'stat').mockImplementation(async function(this: { close(): Promise<void> }, ...statArgs) {
        spy.mockRestore();
        const close = this.close;
        this.close = async () => { await close.call(this); throw cause; };
        return stat.apply(this, statArgs);
      });
      return capture.apply(this, args);
    });
    const result = await failure(setup.store.recoverReservedAdoption(setup.request));
    expect(result.phase).toBe('owners-directory-creation-unknown'); expect(result.cause).toBe(cause);
    expect(result).not.toHaveProperty('closeCause');
    await expect(fs.lstat(setup.registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects directory ABA between descriptor stat and named capture', async () => {
    const setup = await fixture();
    const internals = setup.store as unknown as { requireAdoptionNamedFiles: (...args: unknown[]) => Promise<void> };
    const named = internals.requireAdoptionNamedFiles;
    let replaced = false;
    jest.spyOn(internals, 'requireAdoptionNamedFiles').mockImplementation(async function(...args) {
      const files = args[0] as [string, unknown][];
      if (files.length === 1 && path.basename(files[0][0]) === 'owners') {
        replaced = true;
        await fs.rename(setup.directory, `${setup.directory}.saved`);
        await fs.mkdir(setup.directory, { mode: 0o700 });
      }
      return named.apply(this, args);
    });
    const result = await failure(setup.store.recoverReservedAdoption(setup.request));
    expect(replaced).toBe(true); expect(result.phase).toBe('owners-directory-creation-unknown');
    expect(await fs.readdir(`${setup.directory}.saved`)).toEqual([]);
    await expect(fs.lstat(setup.registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves a real exclusive mkdir EEXIST at the first mutation boundary', async () => {
    const setup = await fixture();
    const internals = setup.store as unknown as { missingOwnersProof: (...args: unknown[]) => Promise<unknown> };
    const proofMethod = internals.missingOwnersProof;
    let calls = 0;
    let inserted: Awaited<ReturnType<typeof directoryIdentity>> | undefined;
    jest.spyOn(internals, 'missingOwnersProof').mockImplementation(async function(...args) {
      const result = await proofMethod.apply(this, args);
      if (++calls === 2) {
        await fs.mkdir(setup.directory, { mode: 0o700 });
        await fs.writeFile(path.join(setup.directory, 'foreign'), 'sentinel');
        inserted = await directoryIdentity(setup.directory);
      }
      return result;
    });
    const result = await failure(setup.store.recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ phase: 'owners-directory-creation-unknown', cause: { code: 'EEXIST' } });
    expect(await directoryIdentity(setup.directory)).toEqual(inserted);
    expect(await fs.readFile(path.join(setup.directory, 'foreign'), 'utf8')).toBe('sentinel');
  });
  it('retains an actual capture-open failure without close attribution', async () => {
    const setup = await fixture();
    const internals = setup.store as unknown as { captureOwnersDirectory: (...args: unknown[]) => Promise<unknown> };
    const capture = internals.captureOwnersDirectory;
    jest.spyOn(internals, 'captureOwnersDirectory').mockImplementation(async function(...args) {
      await fs.rename(setup.directory, `${setup.directory}.saved`);
      return capture.apply(this, args);
    });
    const result = await failure(setup.store.recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ phase: 'owners-directory-creation-unknown', cause: { code: 'ENOENT' } });
    expect(result).not.toHaveProperty('closeCause');
    expect(await fs.readdir(`${setup.directory}.saved`)).toEqual([]);
    await expect(fs.lstat(setup.registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves captured child when a subsequent census exhausts the same budget', async () => {
    const setup = await fixture();
    let identity: Awaited<ReturnType<typeof directoryIdentity>> | undefined;
    const result = await failure(at(setup, 'after-owners-directory-create', async () => {
      identity = await directoryIdentity(setup.directory);
      const original = FileMemoryAdoptionRecoveryScanBudget.prototype.read;
      jest.spyOn(FileMemoryAdoptionRecoveryScanBudget.prototype, 'read').mockImplementation(async function(this: FileMemoryAdoptionRecoveryScanBudget, directory, attempts, bound) {
        while (this.consumed < this.limit) await original.call(this, directory, attempts, bound);
        return original.call(this, directory, attempts, bound);
      });
    }).recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ phase: 'owners-directory-created', cause: { code: 'EHEADRESOURCE' } });
    expect(await directoryIdentity(setup.directory)).toEqual(identity);
    await expect(fs.lstat(setup.registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('cannot create when the shared complete census budget is exhausted', async () => {
    const setup = await fixture();
    await Promise.all(Array.from({ length: 4096 }, (_, index) => fs.writeFile(path.join(setup.parent, `noise-${index}`), 'x')));
    const result = await failure(setup.store.recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ code: 'EADOPTIONPENDING', cause: { code: 'EHEADRESOURCE' } });
    expect(result).not.toHaveProperty('phase');
    await expect(fs.lstat(setup.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  const latePhases = ['before-registry-stage', 'partial-registry-stage', 'verified-registry-stage', 'before-registry-rename',
    'after-registry-rename', 'before-stage', 'partial-stage', 'verified-stage', 'before-rename', 'after-rename', 'after-read'] as const;
  it.each(latePhases.flatMap(stop => ['parent-residue', 'root-case-alias'].map(kind => ({ stop, kind }))))(
    'retains full topology for $kind at $stop', async ({ stop, kind }) => {
      const setup = await fixture();
      const original = await proof([setup.headPath, setup.archivePath]);
      const result = await failure(at(setup, stop, async () => {
        if (kind === 'parent-residue') await fs.writeFile(path.join(setup.parent, 'owners.partial'), 'foreign');
        else await fs.rename(setup.parent, path.join(setup.tenantRoot, '.MEMORY-OWNERS'));
      }).recoverReservedAdoption(setup.request));
      const committed = stop === 'after-rename' || stop === 'after-read';
      expect(result.code).toBe(committed ? 'EHEADADOPTED' : 'EADOPTIONPENDING');
      if (committed) expect(result).toMatchObject({ token: { ownerId: setup.request.ownerId, revision: '1', ownership: 'owned' } });
      else expect(result).not.toHaveProperty('token');
      if (kind === 'parent-residue') expect(await fs.readFile(path.join(setup.parent, 'owners.partial'), 'utf8')).toBe('foreign');
      else expect(await fs.readdir(setup.tenantRoot)).toContain('.MEMORY-OWNERS');
      expect(await proof([setup.headPath, setup.archivePath])).toEqual(original);
    });
  it('allows only its descriptor-bound sidecar stage transition when the head is at tenant root', async () => {
    const setup = await fixture('ÜberNote.yaml');
    expect((await setup.store.recoverReservedAdoption(setup.request)).status).toBe('known-adopted');
  });
  it('rejects a later root metadata ABA after capturing its own partial stage transition', async () => {
    const setup = await fixture('ÜberNote.yaml');
    const result = await failure(at(setup, 'partial-stage', async () => {
      const transient = path.join(setup.tenantRoot, 'unbound');
      await fs.writeFile(transient, 'foreign'); await fs.unlink(transient);
    }).recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'registry-published' });
    const bytes = Buffer.from(await fs.readFile(setup.registryPath, 'utf8'));
    const stage = `${setup.sidecarPath}.adopt-${setup.request.ownerId}.tmp`;
    expect(await fs.readFile(stage)).toEqual(bytes.subarray(0, Math.floor(bytes.length / 2)));
    expect(JSON.parse(await fs.readFile(setup.sidecarPath, 'utf8')).state).toBe('RESERVED');
  });
  it.each([null, undefined])('attempts known-adopted audit after postrename proof failure %s without replacing its cause', async primary => {
    const setup = await fixture('ÜberNote.yaml');
    type Topology = (...args: unknown[]) => Promise<void>;
    const internals = setup.store as unknown as { createdOwnersPublicationProof: (...args: unknown[]) => Topology };
    const factory = internals.createdOwnersPublicationProof;
    let failed = false;
    jest.spyOn(internals, 'createdOwnersPublicationProof').mockImplementation(function(...args) {
      const original = factory.apply(this, args);
      return async (...proofArgs) => {
        await original(...proofArgs);
        if (proofArgs[1] && proofArgs[2] === 'sidecar-rename') { failed = true; throw primary; }
      };
    });
    let audited = false;
    const detach = SecurityMonitor.addLogListener(event => {
      if (event.source === 'FileMemoryOwnerSnapshots.adoption-recovery' && event.additionalData?.outcome === 'known-adopted') {
        audited = true; throw new Error('secondary audit failure');
      }
    });
    try {
      const result = await failure(setup.store.recoverReservedAdoption(setup.request));
      expect(failed).toBe(true); expect(audited).toBe(true);
      expect(result).toMatchObject({ code: 'EHEADADOPTED', token: { ownerId: setup.request.ownerId } });
      expect(result.cause).toBe(primary);
      expect(SecurityMonitor.getRecentEvents().some(event => event.additionalData?.outcome === 'known-adopted')).toBe(true);
    } finally { detach(); }
  });
  it('does not rebaseline a nonthrowing committed audit listener root mutation', async () => {
    const setup = await fixture('ÜberNote.yaml');
    let injected = false;
    const detach = SecurityMonitor.addLogListener(event => {
      if (event.source !== 'FileMemoryOwnerSnapshots.adoption-recovery' || event.additionalData?.outcome !== 'known-adopted') return;
      injected = true;
      const transient = path.join(setup.tenantRoot, 'foreign');
      syncFs.writeFileSync(transient, 'foreign'); syncFs.unlinkSync(transient);
    });
    try {
      await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({
        code: 'EHEADADOPTED', token: { ownerId: setup.request.ownerId },
      });
      expect(injected).toBe(true);
    } finally { detach(); }
  });
  it.each(['partial-registry-create', 'after-registry-create', ...latePhases].flatMap(stop =>
    ['foreign-file', 'metadata-aba'].map(kind => ({ stop, kind }))))(
    'retains complete child census and identity for $kind at $stop', async ({ stop, kind }) => {
      const setup = await fixture();
      const original = await proof([setup.headPath, setup.archivePath]);
      const reservedRaw = await fs.readFile(setup.sidecarPath, 'utf8');
      const target = path.join(setup.directory, 'foreign.json');
      let foreign: Awaited<ReturnType<typeof proof>> | undefined;
      let writes = 0, fileWrites = 0, syncs = 0;
      const probe = await fs.open(setup.parent, 'r');
      const methods = Object.getPrototypeOf(probe) as { write(...args: unknown[]): Promise<unknown>;
        writeFile(...args: unknown[]): Promise<void>; sync(): Promise<void> };
      await probe.close();
      const write = methods.write, writeFile = methods.writeFile, sync = methods.sync;
      const result = await failure(at(setup, stop as AdoptionRecoveryPublication, async () => {
        await fs.writeFile(target, 'foreign', { mode: 0o600 });
        if (kind === 'metadata-aba') await fs.unlink(target);
        else foreign = await proof([target]);
        if (stop.startsWith('partial-')) {
          jest.spyOn(methods, 'write').mockImplementation(function(...args) { writes++; return write.apply(this, args); });
          jest.spyOn(methods, 'writeFile').mockImplementation(function(...args) { fileWrites++; return writeFile.apply(this, args); });
          jest.spyOn(methods, 'sync').mockImplementation(function() { syncs++; return sync.call(this); });
        }
      }).recoverReservedAdoption(setup.request));
      const committed = stop === 'after-rename' || stop === 'after-read';
      expect(result.code).toBe(committed ? 'EHEADADOPTED' : 'EADOPTIONPENDING');
      if (committed) expect(result).toMatchObject({ token: { ownerId: setup.request.ownerId, ownership: 'owned' } });
      else expect(result).not.toHaveProperty('token');
      if (foreign) expect(await proof([target])).toEqual(foreign);
      else await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      if (stop.startsWith('partial-')) {
        expect(writes).toBe(0); expect(fileWrites).toBe(0); expect(syncs).toBe(0);
        const creation = stop === 'partial-registry-create';
        const targetPath = creation ? setup.registryPath :
          `${stop === 'partial-registry-stage' ? setup.registryPath : setup.sidecarPath}.adopt-${setup.request.ownerId}.tmp`;
        const bytes = Buffer.from(creation ? reservedRaw : JSON.stringify({ ...JSON.parse(reservedRaw), state: 'ACTIVE' }));
        expect(await fs.readFile(targetPath)).toEqual(bytes.subarray(0, Math.floor(bytes.length / 2)));
      }
      expect(await proof([setup.headPath, setup.archivePath])).toEqual(original);
    });
  const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
  const moduleRoot = new URL('../../../src/storage/', import.meta.url);
  const childScript = `
    const [ownersUrl,coordinatorUrl,fenceUrl,root,user,request,stop] = process.argv.slice(1);
    const {FileMemoryOwnerSnapshots} = await import(ownersUrl);
    const {FileMemoryTransactionCoordinator} = await import(coordinatorUrl);
    const {FileMemoryFence} = await import(fenceUrl);
    const coordinator = new FileMemoryTransactionCoordinator({tenantRoot:root,getCurrentUserId:()=>user,fence:new FileMemoryFence()});
    const store = new FileMemoryOwnerSnapshots({coordinator,afterAdoptionRecoveryPublication:phase=>{
      if(phase===stop){process.stdout.write('STOPPED\\n');process.stdin.resume();return new Promise(()=>{});}
    }});
    await store.recoverReservedAdoption(JSON.parse(request));
  `;
  it.each([
    { stop: 'after-owners-directory-create', rootHead: false }, { stop: 'after-registry-create', rootHead: false },
    { stop: 'after-registry-rename', rootHead: false }, { stop: 'after-rename', rootHead: false },
    { stop: 'verified-stage', rootHead: true }, { stop: 'after-rename', rootHead: true },
  ] as const)('recovers real SIGKILL at $stop (root head: $rootHead)', async ({ stop, rootHead }) => {
    const setup = await fixture(rootHead ? 'ÜberNote.yaml' : undefined);
    const original = await proof([setup.headPath, setup.archivePath]);
    const child = spawn(process.execPath, [...(extension === 'ts' ? ['--import', 'tsx'] : []), '--input-type=module', '-e', childScript,
      new URL(`FileMemoryOwnerSnapshots.${extension}`, moduleRoot).href,
      new URL(`FileMemoryTransactionCoordinator.${extension}`, moduleRoot).href,
      new URL(`FileMemoryFence.${extension}`, moduleRoot).href,
      setup.tenantRoot, USER, JSON.stringify(setup.request), stop], { stdio: ['pipe', 'pipe', 'pipe'] });
    let childError: Error | undefined;
    child.once('error', cause => { childError = cause; });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        let output = ''; let errors = '';
        const timer = setTimeout(() => reject(new Error(`Child missed ${stop}: ${errors}`)), 8000);
        child.stdout.on('data', (bytes: Buffer) => { output += bytes.toString(); if (output.includes('STOPPED\n')) { clearTimeout(timer); resolve(); } });
        child.stderr.on('data', (bytes: Buffer) => { errors += bytes.toString(); });
        child.once('error', cause => { clearTimeout(timer); reject(cause); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exited ${code}: ${errors}`)); });
      });
      child.kill('SIGKILL'); await closed;
      expect((await setup.store.inspectInterruptedOwnedHead(setup.request.locator)).kind).toBe('blocked-by-fence');
      // Only the isolated child has exited; explicitly test-only orphan handling.
      await fs.rm(path.join(setup.tenantRoot, '.memory-fences', 'tenant.lock'), { recursive: true });
      if (stop === 'after-owners-directory-create') {
        expect(await fs.readdir(setup.directory)).toEqual([]);
        expect(Number((await fs.lstat(setup.directory)).mode) & 0o777).toBe(0o700);
        expect(JSON.parse(await fs.readFile(setup.sidecarPath, 'utf8')).state).toBe('RESERVED');
      }
      expect((await setup.store.recoverReservedAdoption(setup.request)).status).toBe(stop === 'after-rename' ? 'already-clean-no-attribution' : 'known-adopted');
      expect(await proof([setup.headPath, setup.archivePath])).toEqual(original);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
    if (childError) throw childError;
  });
});
