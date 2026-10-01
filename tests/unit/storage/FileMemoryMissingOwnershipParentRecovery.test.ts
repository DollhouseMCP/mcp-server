import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type AdoptionRecoveryPublication, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryDirectoryScanBudget } from '../../../src/storage/FileMemoryDirectoryScanBudget.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';

const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
async function fixture(rootHead = false) {
  const tenantRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-parent-recovery-')); roots.push(tenantRoot);
  await fs.chmod(tenantRoot, 0o755);
  const locator = rootHead ? 'ÜberNote.yaml' : 'memories/ÜberNote.yaml';
  const headPath = path.join(tenantRoot, locator);
  await fs.mkdir(path.dirname(headPath), { recursive: true }); await fs.writeFile(headPath, 'content: original\n');
  const preserved = path.join(tenantRoot, '.memory-owners.history'); await fs.writeFile(preserved, 'uninterpreted evidence');
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
  const store = new FileMemoryOwnerSnapshots({ coordinator });
  const legacy = await store.readHeadSnapshot(locator);
  const interrupted = new FileMemoryOwnerSnapshots({ coordinator, afterPublication: phase => {
    if (phase === 'reserved-sidecar') throw new Error('fixture interruption');
  } });
  await expect(interrupted.adoptUnowned(legacy.token as UnownedFileMemoryToken)).rejects.toThrow('fixture interruption');
  const hash = createHash('sha256').update(path.basename(headPath)).digest('hex');
  const sidecarPath = path.join(path.dirname(headPath), `.${hash}.memory-owner.json`);
  const record = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  const request = { locator, ownerId: record.ownerId as string };
  const parent = path.join(tenantRoot, '.memory-owners'), directory = path.join(parent, 'owners');
  await expect(fs.lstat(parent)).rejects.toMatchObject({ code: 'ENOENT' });
  return { tenantRoot, coordinator, store, request, headPath, sidecarPath, preserved, parent, directory };
}
type Setup = Awaited<ReturnType<typeof fixture>>;
async function identity(file: string) {
  const stat = await fs.lstat(file, { bigint: true });
  return { dev: stat.dev, inode: stat.ino, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs,
    mode: stat.mode, uid: stat.uid, links: stat.nlink };
}
async function proof(files: string[]) {
  return Promise.all(files.map(async file => ({ identity: await identity(file), bytes: await fs.readFile(file) })));
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
describe('missing ownership parent recovery', () => {
  if (process.platform === 'win32') {
    it('retains POSIX restrictions', () => {
      const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: 'C:\\', getCurrentUserId: () => USER, fence: new FileMemoryFence() });
      expect(() => new FileMemoryOwnerSnapshots({ coordinator })).toThrow('requires POSIX');
    }); return;
  }
  it.each([false, true])('resumes actual RESERVED interruption (root head: %s)', async rootHead => {
    const setup = await fixture(rootHead), original = await proof([setup.headPath, setup.preserved]);
    const perform = jest.spyOn(setup.coordinator, 'perform');
    expect((await setup.store.recoverReservedAdoption(setup.request)).status).toBe('known-adopted');
    expect(perform).toHaveBeenCalledTimes(1);
    expect(await proof([setup.headPath, setup.preserved])).toEqual(original);
    expect(Number((await fs.lstat(setup.tenantRoot)).mode) & 0o777).toBe(0o755);
    expect(Number((await fs.lstat(setup.parent)).mode) & 0o777).toBe(0o700);
    expect(await setup.store.recoverReservedAdoption(setup.request)).toEqual({ status: 'already-clean-no-attribution' });
  });
  it('preserves a real mkdir EEXIST foreign object', async () => {
    const setup = await fixture(); let captured: Awaited<ReturnType<typeof identity>> | undefined;
    const recovery = at(setup, 'before-ownership-parent-create', async () => {
      // Insert only after the second proof, at the actual exclusive mkdir boundary.
      const original = setup.coordinator.requireActiveOperationScope.bind(setup.coordinator);
      const internals = recovery as unknown as { missingOwnershipParentProof: (...args: unknown[]) => Promise<unknown> };
      const prove = internals.missingOwnershipParentProof;
      jest.spyOn(internals, 'missingOwnershipParentProof').mockImplementation(async function(...args) {
        const value = await prove.apply(this, args);
        await fs.mkdir(setup.parent, { mode: 0o700 }); await fs.writeFile(path.join(setup.parent, 'sentinel'), 'foreign');
        captured = await identity(setup.parent); original(args[0] as Parameters<typeof original>[0]); return value;
      });
    });
    const result = await failure(recovery.recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ phase: 'ownership-parent-creation-unknown', cause: { code: 'EEXIST' } });
    expect(await identity(setup.parent)).toEqual(captured);
    expect(await fs.readFile(path.join(setup.parent, 'sentinel'), 'utf8')).toBe('foreign');
  });
  it.each(['before-ownership-parent-create', 'after-ownership-parent-create', 'before-owners-directory-create'] as const)(
    'refuses revoked authority at %s', async stop => {
      const setup = await fixture();
      const result = await failure(at(setup, stop, () => {
        jest.spyOn(setup.coordinator, 'requireActiveOperationScope').mockImplementation(() => { throw new Error('revoked'); });
      }).recoverReservedAdoption(setup.request));
      expect(result.code).toBe('EADOPTIONPENDING'); expect(result.cause).toEqual(new Error('revoked'));
      expect(result).not.toHaveProperty('token'); await expect(fs.lstat(setup.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  it.each([null, undefined])('retains parent-created before fallible root transition: %s', async cause => {
    const setup = await fixture();
    const internals = setup.store as unknown as { missingOwnersProof: (...args: unknown[]) => Promise<unknown> };
    jest.spyOn(internals, 'missingOwnersProof').mockRejectedValue(cause);
    const result = await failure(setup.store.recoverReservedAdoption(setup.request));
    expect(result.phase).toBe('ownership-parent-created'); expect(result.cause).toBe(cause);
    expect(await fs.readdir(setup.parent)).toEqual([]);
    await expect(fs.lstat(setup.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['root-aba', 'head-aba', 'sidecar-aba', 'parent-aba', 'root-foreign', 'case-alias'] as const)(
    'retains original evidence after parent hook: %s', async kind => {
      const setup = await fixture(true); let foreign: Awaited<ReturnType<typeof proof>> | undefined;
      const result = await failure(at(setup, 'after-ownership-parent-create', async () => {
        if (kind === 'root-aba' || kind === 'root-foreign') {
          const file = path.join(setup.tenantRoot, 'foreign'); await fs.writeFile(file, 'retained');
          if (kind === 'root-aba') await fs.unlink(file); else foreign = await proof([file]);
        } else if (kind === 'parent-aba' || kind === 'case-alias') {
          await fs.rename(setup.parent, path.join(setup.tenantRoot, kind === 'case-alias' ? '.MEMORY-OWNERS' : 'saved-parent'));
          if (kind === 'parent-aba') await fs.mkdir(setup.parent, { mode: 0o700 });
        } else {
          const file = kind === 'head-aba' ? setup.headPath : setup.sidecarPath, bytes = await fs.readFile(file);
          await fs.rename(file, `${file}.saved`); await fs.writeFile(file, bytes, { mode: 0o600 }); await fs.unlink(`${file}.saved`);
        }
      }).recoverReservedAdoption(setup.request));
      expect(result).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'ownership-parent-created' });
      expect(result).not.toHaveProperty('token'); await expect(fs.lstat(setup.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      if (foreign) expect(await proof([path.join(setup.tenantRoot, 'foreign')])).toEqual(foreign);
    });
  it.each(['before-owners-directory-create', 'before-registry-stage', 'after-rename'] as const)(
    'carries the captured root through %s', async stop => {
      const setup = await fixture(true), original = await proof([setup.headPath, setup.preserved]);
      const result = await failure(at(setup, stop, async () => {
        const file = path.join(setup.tenantRoot, 'transient'); await fs.writeFile(file, 'x'); await fs.unlink(file);
      }).recoverReservedAdoption(setup.request));
      expect(result.code).toBe(stop === 'after-rename' ? 'EHEADADOPTED' : 'EADOPTIONPENDING');
      if (stop === 'after-rename') expect(result).toMatchObject({ token: { ownerId: setup.request.ownerId, ownership: 'owned' } });
      else expect(result).not.toHaveProperty('token');
      expect(await proof([setup.headPath, setup.preserved])).toEqual(original);
    });
  it.each([null, undefined, new Error('stat failed')])('preserves primary %s and actual secondary close failure', async primary => {
    const setup = await fixture(), probe = await fs.open(setup.tenantRoot, 'r');
    const methods = Object.getPrototypeOf(probe) as { stat(...args: unknown[]): Promise<unknown> }; await probe.close();
    const secondary = new Error('close failed');
    const internals = setup.store as unknown as { captureOwnersDirectory: (...args: unknown[]) => Promise<unknown> };
    const capture = internals.captureOwnersDirectory;
    jest.spyOn(internals, 'captureOwnersDirectory').mockImplementation(function(...args) {
      const spy = jest.spyOn(methods, 'stat').mockImplementation(async function(this: { close(): Promise<void> }) {
        spy.mockRestore(); const close = this.close; this.close = async () => { await close.call(this); throw secondary; }; throw primary;
      }); return capture.apply(this, args);
    });
    const result = await failure(setup.store.recoverReservedAdoption(setup.request));
    expect(result.phase).toBe('ownership-parent-creation-unknown'); expect(result.cause).toBe(primary); expect(result.closeCause).toBe(secondary);
    expect(await fs.readdir(setup.parent)).toEqual([]); expect(result).not.toHaveProperty('token');
  });
  it('retains an injected capture-open ENOENT and the physical empty parent', async () => {
    const setup = await fixture();
    const internals = setup.store as unknown as { captureOwnersDirectory: (...args: unknown[]) => Promise<unknown> };
    jest.spyOn(internals, 'captureOwnersDirectory').mockImplementation(async () => { await fs.open(path.join(setup.parent, 'missing'), 'r'); });
    const result = await failure(setup.store.recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ phase: 'ownership-parent-creation-unknown', cause: { code: 'ENOENT' } });
    expect(result).not.toHaveProperty('closeCause'); expect(await fs.readdir(setup.parent)).toEqual([]);
  });
  it('retains close-only failure after actual descriptor capture', async () => {
    const setup = await fixture(), probe = await fs.open(setup.tenantRoot, 'r');
    const methods = Object.getPrototypeOf(probe) as { stat(...args: unknown[]): Promise<unknown> }; await probe.close();
    const stat = methods.stat, cause = new Error('close only');
    const internals = setup.store as unknown as { captureOwnersDirectory: (...args: unknown[]) => Promise<unknown> }, capture = internals.captureOwnersDirectory;
    jest.spyOn(internals, 'captureOwnersDirectory').mockImplementation(function(...args) {
      const spy = jest.spyOn(methods, 'stat').mockImplementation(async function(this: { close(): Promise<void> }, ...values) {
        spy.mockRestore(); const close = this.close; this.close = async () => { await close.call(this); throw cause; }; return stat.apply(this, values);
      }); return capture.apply(this, args);
    });
    const result = await failure(setup.store.recoverReservedAdoption(setup.request));
    expect(result.phase).toBe('ownership-parent-creation-unknown'); expect(result.cause).toBe(cause); expect(result).not.toHaveProperty('closeCause');
    expect(await fs.readdir(setup.parent)).toEqual([]);
  });
  it('rejects descriptor/named parent ABA during mandatory capture', async () => {
    const setup = await fixture();
    const internals = setup.store as unknown as { requireAdoptionNamedFiles: (...args: unknown[]) => Promise<void> }, check = internals.requireAdoptionNamedFiles;
    let replaced = false;
    jest.spyOn(internals, 'requireAdoptionNamedFiles').mockImplementation(async function(...args) {
      const names = args[0] as [string, unknown][];
      if (!replaced && names.length === 1 && path.basename(names[0][0]) === '.memory-owners') {
        replaced = true; await fs.rename(setup.parent, `${setup.parent}.saved`); await fs.mkdir(setup.parent, { mode: 0o700 });
      } await check.apply(this, args);
    });
    const result = await failure(setup.store.recoverReservedAdoption(setup.request));
    expect(replaced).toBe(true); expect(result.phase).toBe('ownership-parent-creation-unknown');
    expect(await fs.readdir(`${setup.parent}.saved`)).toEqual([]); await expect(fs.lstat(setup.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('uses one monotonic hard scan budget for both mkdirs and all publication proofs', async () => {
    const setup = await fixture(), original = FileMemoryDirectoryScanBudget.prototype.read;
    const instances = new Set<FileMemoryDirectoryScanBudget>(), counts: number[] = [];
    jest.spyOn(FileMemoryDirectoryScanBudget.prototype, 'read').mockImplementation(function(this: FileMemoryDirectoryScanBudget, directory) {
      instances.add(this); counts.push(this.consumed); return original.call(this, directory);
    });
    await setup.store.recoverReservedAdoption(setup.request);
    expect(instances.size).toBe(1); expect(counts).toEqual(counts.map((_, index) => index)); expect(counts.length).toBeLessThanOrEqual(1000);
  });
  it.each(['before-ownership-parent-create', 'after-ownership-parent-create'] as const)('preserves state after actual budget exhaustion at %s', async stop => {
    const setup = await fixture(); let captured: Awaited<ReturnType<typeof identity>> | undefined;
    const result = await failure(at(setup, stop, async () => {
      if (stop === 'after-ownership-parent-create') captured = await identity(setup.parent);
      const original = FileMemoryDirectoryScanBudget.prototype.read;
      jest.spyOn(FileMemoryDirectoryScanBudget.prototype, 'read').mockImplementation(async function(this: FileMemoryDirectoryScanBudget, directory) {
        while (this.consumed < 1000) await original.call(this, directory); return original.call(this, directory);
      });
    }).recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ code: 'EADOPTIONPENDING', cause: { code: 'EHEADRESOURCE' } });
    if (captured) { expect(result.phase).toBe('ownership-parent-created'); expect(await identity(setup.parent)).toEqual(captured); }
    else { expect(result).not.toHaveProperty('phase'); await expect(fs.lstat(setup.parent)).rejects.toMatchObject({ code: 'ENOENT' }); }
    await expect(fs.lstat(setup.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts', moduleRoot = new URL('../../../src/storage/', import.meta.url);
  const childScript = `
    const [ownersUrl,coordinatorUrl,fenceUrl,root,user,request,stop]=process.argv.slice(1);
    const {FileMemoryOwnerSnapshots}=await import(ownersUrl);
    const {FileMemoryTransactionCoordinator}=await import(coordinatorUrl);
    const {FileMemoryFence}=await import(fenceUrl);
    const coordinator=new FileMemoryTransactionCoordinator({tenantRoot:root,getCurrentUserId:()=>user,fence:new FileMemoryFence()});
    const store=new FileMemoryOwnerSnapshots({coordinator,afterAdoptionRecoveryPublication:phase=>{
      if(phase===stop){process.stdout.write('STOPPED\\n');process.stdin.resume();return new Promise(()=>{});}
    }});
    await store.recoverReservedAdoption(JSON.parse(request));
  `;
  it.each(['after-ownership-parent-create', 'verified-stage', 'after-rename'] as const)('resumes real SIGKILL at %s', async stop => {
    const setup = await fixture(true), original = await proof([setup.headPath, setup.preserved]);
    const child = spawn(process.execPath, [...(extension === 'ts' ? ['--import', 'tsx'] : []), '--input-type=module', '-e', childScript,
      new URL(`FileMemoryOwnerSnapshots.${extension}`, moduleRoot).href, new URL(`FileMemoryTransactionCoordinator.${extension}`, moduleRoot).href,
      new URL(`FileMemoryFence.${extension}`, moduleRoot).href, setup.tenantRoot, USER, JSON.stringify(setup.request), stop], { stdio: ['pipe', 'pipe', 'pipe'] });
    let childError: Error | undefined; child.once('error', cause => { childError = cause; });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '', errors = ''; const timer = setTimeout(() => reject(new Error(`Child missed ${stop}: ${errors}`)), 8000);
        child.stdout.on('data', (bytes: Buffer) => { output += bytes.toString(); if (output.includes('STOPPED\n')) { clearTimeout(timer); resolve(); } });
        child.stderr.on('data', (bytes: Buffer) => { errors += bytes.toString(); });
        child.once('error', cause => { clearTimeout(timer); reject(cause); }); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exited ${code}: ${errors}`)); });
      });
      child.kill('SIGKILL'); await closed;
      expect((await setup.store.inspectInterruptedOwnedHead(setup.request.locator)).kind).toBe('blocked-by-fence');
      // Confirmed isolated child exit only; explicit test-only orphan handling.
      await fs.rm(path.join(setup.tenantRoot, '.memory-fences', 'tenant.lock'), { recursive: true });
      const retainedParent = await identity(setup.parent);
      if (stop === 'after-ownership-parent-create') { expect(await fs.readdir(setup.parent)).toEqual([]); expect(JSON.parse(await fs.readFile(setup.sidecarPath, 'utf8')).state).toBe('RESERVED'); }
      expect((await setup.store.recoverReservedAdoption(setup.request)).status).toBe(stop === 'after-rename' ? 'already-clean-no-attribution' : 'known-adopted');
      expect(await identity(setup.parent)).toMatchObject({ dev: retainedParent.dev, inode: retainedParent.inode });
      expect(await proof([setup.headPath, setup.preserved])).toEqual(original);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
    if (childError) throw childError;
  });
});
