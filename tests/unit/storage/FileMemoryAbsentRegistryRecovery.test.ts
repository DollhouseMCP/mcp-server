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
async function fixture() {
  const tenantRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'absent-registry-'));
  roots.push(tenantRoot);
  const locator = 'Notes/ÜberNote.yaml';
  const headPath = path.join(tenantRoot, locator);
  await fs.mkdir(path.dirname(headPath));
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
  const registryPath = path.join(tenantRoot, '.memory-owners', 'owners', `${request.ownerId}.json`);
  await fs.unlink(registryPath);
  const archivePath = path.join(tenantRoot, 'archive-evidence');
  await fs.writeFile(archivePath, 'untouched archive');
  return { tenantRoot, coordinator, store, legacy, request, headPath, sidecarPath, registryPath, record, archivePath };
}
type Setup = Awaited<ReturnType<typeof fixture>>;
async function proof(files: string[]) {
  return Promise.all(files.map(async file => {
    const stat = await fs.lstat(file, { bigint: true });
    return { inode: stat.ino, dev: stat.dev, size: stat.size, mode: stat.mode, links: stat.nlink,
      ctime: stat.ctimeNs, mtime: stat.mtimeNs, bytes: await fs.readFile(file) };
  }));
}
async function replaceSame(file: string) {
  const bytes = await fs.readFile(file);
  await fs.rename(file, `${file}.saved`);
  await fs.writeFile(file, bytes, { mode: 0o600 });
  await fs.unlink(`${file}.saved`);
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
  jest.restoreAllMocks();
  SecurityMonitor.clearAllEventsForTesting();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('exact missing-registry adoption recovery', () => {
  if (process.platform === 'win32') {
    it('retains POSIX restrictions', () => {
      const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: 'C:\\', getCurrentUserId: () => USER, fence: new FileMemoryFence() });
      expect(() => new FileMemoryOwnerSnapshots({ coordinator })).toThrow('requires POSIX');
    });
    return;
  }
  it('creates RESERVED then completes one operation without touching head/archive', async () => {
    const setup = await fixture();
    const before = await proof([setup.headPath, setup.archivePath]);
    const perform = jest.spyOn(setup.coordinator, 'perform');
    const result = await setup.store.recoverReservedAdoption(setup.request);
    expect(result).toMatchObject({ status: 'known-adopted', token: { ownership: 'owned', ownerId: setup.request.ownerId } });
    expect(perform).toHaveBeenCalledTimes(1);
    expect(await proof([setup.headPath, setup.archivePath])).toEqual(before);
    expect(await setup.store.recoverReservedAdoption(setup.request)).toEqual({ status: 'already-clean-no-attribution' });
  });
  it.each(['headPath', 'sidecarPath'] as const)('rejects %s ABA before creation without a registry', async field => {
    const setup = await fixture();
    const result = await failure(at(setup, 'before-registry-create', () => replaceSame(setup[field])).recoverReservedAdoption(setup.request));
    expect(result.code).toBe('EADOPTIONPENDING');
    expect(result).not.toHaveProperty('phase');
    await expect(fs.lstat(setup.registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['headPath', 'sidecarPath', 'registryPath'] as const)('retains created progress after %s ABA', async field => {
    const setup = await fixture();
    const result = await failure(at(setup, 'after-registry-create', () => replaceSame(setup[field])).recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'registry-created' });
    expect(result).not.toHaveProperty('token');
    expect(JSON.parse(await fs.readFile(setup.registryPath, 'utf8')).state).toBe('RESERVED');
  });
  it.each(['before-registry-create', 'partial-registry-create', 'after-registry-create'] as const)('rechecks authority at %s', async stop => {
    const setup = await fixture();
    const store = at(setup, stop, () => {
      jest.spyOn(setup.coordinator, 'requireActiveOperationScope').mockImplementation(() => { throw new Error('revoked'); });
    });
    const result = await failure(store.recoverReservedAdoption(setup.request));
    expect(result.code).toBe('EADOPTIONPENDING');
    expect(result).not.toHaveProperty('token');
    if (stop === 'partial-registry-create') {
      const bytes = Buffer.from(JSON.stringify(setup.record));
      expect(await fs.readFile(setup.registryPath)).toEqual(bytes.subarray(0, Math.floor(bytes.length / 2)));
    }
  });
  it.each([null, undefined, new Error('creation callback')])('retains exact primary cause %s after partial creation', async cause => {
    const setup = await fixture();
    const result = await failure(at(setup, 'partial-registry-create', () => { throw cause; }).recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'registry-creation-unknown' });
    expect(result.cause).toBe(cause);
    const before = await proof([setup.registryPath]);
    await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect(await proof([setup.registryPath])).toEqual(before);
  });
  it('retains known creation progress through later activation failure and resumes', async () => {
    const setup = await fixture();
    const cause = { phase: 'sidecar-publication-unknown', adopted: true, token: {} };
    const result = await failure(at(setup, 'before-registry-stage', () => { throw cause; }).recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'registry-created' });
    expect(result.cause).toBe(cause);
    expect(result).not.toHaveProperty('token');
    expect((await setup.store.recoverReservedAdoption(setup.request)).status).toBe('known-adopted');
  });
  it.each(['missing-directory', 'alias', 'random-stage', 'journal', 'invalid-sidecar'] as const)('preserves invalid %s', async kind => {
    const setup = await fixture();
    if (kind === 'missing-directory') {
      await fs.rmdir(path.dirname(setup.registryPath));
      await fs.rmdir(path.dirname(path.dirname(setup.registryPath)));
    }
    if (kind === 'alias') await fs.writeFile(path.join(path.dirname(setup.registryPath), `${setup.request.ownerId.toUpperCase()}.JSON`), 'foreign');
    if (kind === 'random-stage') await fs.writeFile(`${setup.registryPath}.random.tmp`, 'foreign');
    if (kind === 'journal') await fs.writeFile(setup.sidecarPath.replace('memory-owner', 'memory-write'), 'foreign');
    if (kind === 'invalid-sidecar') await fs.writeFile(setup.sidecarPath, JSON.stringify({ ...setup.record, state: 'ACTIVE' }));
    const before = await proof([setup.headPath, setup.sidecarPath, setup.archivePath]);
    await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect(await proof([setup.headPath, setup.sidecarPath, setup.archivePath])).toEqual(before);
  });
  it('shares a monotonic budget including absent, pair and final proofs', async () => {
    const setup = await fixture();
    const original = FileMemoryDirectoryScanBudget.prototype.read;
    const instances = new Set<FileMemoryDirectoryScanBudget>();
    const consumed: number[] = [];
    jest.spyOn(FileMemoryDirectoryScanBudget.prototype, 'read').mockImplementation(function(this: FileMemoryDirectoryScanBudget, directory) {
      instances.add(this); consumed.push(this.consumed); return original.call(this, directory);
    });
    await setup.store.recoverReservedAdoption(setup.request);
    expect(instances.size).toBe(1);
    expect(consumed).toEqual(consumed.map((_, index) => index));
  });
  it('retains sole final commit receipt after callback failure', async () => {
    const setup = await fixture();
    const cause = new Error('final callback');
    const result = await failure(at(setup, 'after-rename', () => { throw cause; }).recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ code: 'EHEADADOPTED', token: { ownership: 'owned', ownerId: setup.request.ownerId } });
    expect(result.cause).toBe(cause);
  });
  it('retains foreign EEXIST target inserted at the actual exclusive-open boundary', async () => {
    const setup = await fixture();
    const internals = setup.store as unknown as { writeAbsentRegistry: (...args: unknown[]) => Promise<unknown> };
    const original = internals.writeAbsentRegistry;
    const bytes = 'foreign record';
    jest.spyOn(internals, 'writeAbsentRegistry').mockImplementation(async function(...args) {
      await fs.writeFile(setup.registryPath, bytes, { mode: 0o600 });
      return original.apply(this, args);
    });
    const result = await failure(setup.store.recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'registry-creation-unknown', cause: { code: 'EEXIST' } });
    expect(await fs.readFile(setup.registryPath, 'utf8')).toBe(bytes);
    expect(result).not.toHaveProperty('token');
  });
  it.each(['alias', 'journal'] as const)('rejects late %s introduced during final absence observation', async variant => {
    const setup = await fixture();
    const internals = setup.store as unknown as { requireAdoptionNamedFiles: (...args: unknown[]) => Promise<void> };
    const original = internals.requireAdoptionNamedFiles;
    let calls = 0;
    let injected = false;
    jest.spyOn(internals, 'requireAdoptionNamedFiles').mockImplementation(async function(...args) {
      await original.apply(this, args);
      if (args[1] === undefined && ++calls === 2) {
        injected = true;
        const target = variant === 'alias' ? `${setup.registryPath}.foreign.tmp` : setup.sidecarPath.replace('memory-owner', 'memory-write');
        await fs.writeFile(target, 'foreign', { mode: 0o600 });
      }
    });
    await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect(injected).toBe(true);
    await expect(fs.lstat(setup.registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  type HandleMethods = { write(buffer: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }>;
    sync(): Promise<void>; close(): Promise<void> };
  async function handleMethods(setup: Setup): Promise<HandleMethods> {
    const probe = path.join(setup.tenantRoot, 'handle-probe');
    const handle = await fs.open(probe, 'wx');
    const methods = Object.getPrototypeOf(handle) as HandleMethods;
    await handle.close(); await fs.unlink(probe);
    return methods;
  }
  it('finishes genuine short writes with complete descriptor-bound bytes', async () => {
    const setup = await fixture();
    const methods = await handleMethods(setup);
    const original = methods.write;
    let calls = 0;
    jest.spyOn(methods, 'write').mockImplementation(function(buffer, offset, length) {
      calls++; return original.call(this, buffer, offset, Math.min(length, 7));
    });
    expect((await setup.store.recoverReservedAdoption(setup.request)).status).toBe('known-adopted');
    expect(calls).toBeGreaterThan(2);
  });
  it('rejects zero-progress write without claiming complete creation', async () => {
    const setup = await fixture();
    const methods = await handleMethods(setup);
    jest.spyOn(methods, 'write').mockResolvedValue({ bytesWritten: 0 });
    const result = await failure(setup.store.recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'registry-creation-unknown' });
    expect((await fs.stat(setup.registryPath)).size).toBe(0);
    expect(result).not.toHaveProperty('token');
  });
  it.each(['write', 'sync', 'close'] as const)('retains direct %s failure and creation uncertainty', async method => {
    const setup = await fixture();
    const methods = await handleMethods(setup);
    const cause = new Error(`${method} failed`);
    if (method === 'write') jest.spyOn(methods, 'write').mockRejectedValue(cause);
    if (method === 'sync') {
      const store = at(setup, 'partial-registry-create', () => {
        const spy = jest.spyOn(methods, 'sync').mockImplementation(async () => { spy.mockRestore(); throw cause; });
      });
      const result = await failure(store.recoverReservedAdoption(setup.request));
      expect(result).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'registry-creation-unknown' });
      expect(result.cause).toBe(cause);
      return;
    }
    if (method === 'close') {
      const write = methods.write;
      const spy = jest.spyOn(methods, 'write').mockImplementation(async function(buffer, offset, length) {
        spy.mockRestore();
        const original = this.close;
        this.close = async () => { await original.call(this); throw cause; };
        return write.call(this, buffer, offset, length);
      });
      const result = await failure(setup.store.recoverReservedAdoption(setup.request));
      expect(result).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'registry-creation-unknown' });
      expect(result.cause).toBe(cause);
      expect(result).not.toHaveProperty('closeCause');
      return;
    }
    const result = await failure(setup.store.recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'registry-creation-unknown' });
    expect(result.cause).toBe(cause);
    expect(result).not.toHaveProperty('closeCause');
    expect(result).not.toHaveProperty('token');
  });
  it.each([null, undefined])('retains primary %s and separate secondary close cause', async primary => {
    const setup = await fixture();
    const methods = await handleMethods(setup);
    const secondary = new Error('secondary close failure');
    const write = methods.write;
    const spy = jest.spyOn(methods, 'write').mockImplementation(async function(buffer, offset, length) {
      spy.mockRestore();
      const original = this.close;
      this.close = async () => { await original.call(this); throw secondary; };
      return write.call(this, buffer, offset, length);
    });
    const store = at(setup, 'partial-registry-create', () => {
      throw primary;
    });
    const result = await failure(store.recoverReservedAdoption(setup.request));
    expect(result.cause).toBe(primary);
    expect(result.closeCause).toBe(secondary);
    expect(result.phase).toBe('registry-creation-unknown');
  });
  it('rejects replacement of the private owners directory after creation', async () => {
    const setup = await fixture();
    const directory = path.dirname(setup.registryPath);
    const result = await failure(at(setup, 'after-registry-create', async () => {
      await fs.rename(directory, `${directory}.saved`);
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.copyFile(path.join(`${directory}.saved`, path.basename(setup.registryPath)), setup.registryPath);
      await fs.chmod(setup.registryPath, 0o600);
    }).recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'registry-created' });
    expect(result).not.toHaveProperty('token');
    expect(JSON.parse(await fs.readFile(setup.sidecarPath, 'utf8')).state).toBe('RESERVED');
  });
  it('does not perform another write or sync after partial-hook revocation', async () => {
    const setup = await fixture();
    const methods = await handleMethods(setup);
    const write = methods.write;
    const sync = methods.sync;
    let writes = 0, syncs = 0;
    const store = at(setup, 'partial-registry-create', () => {
      jest.spyOn(methods, 'write').mockImplementation(function(buffer, offset, length) {
        writes++; return write.call(this, buffer, offset, length);
      });
      jest.spyOn(methods, 'sync').mockImplementation(function() { syncs++; return sync.call(this); });
      jest.spyOn(setup.coordinator, 'requireActiveOperationScope').mockImplementation(() => { throw new Error('revoked'); });
    });
    expect((await failure(store.recoverReservedAdoption(setup.request))).phase).toBe('registry-creation-unknown');
    expect(writes).toBe(0); expect(syncs).toBe(0);
    const bytes = Buffer.from(JSON.stringify(setup.record));
    expect(await fs.readFile(setup.registryPath)).toEqual(bytes.subarray(0, Math.floor(bytes.length / 2)));
  });
  it('never treats exhausted absence proof as authority to create', async () => {
    const setup = await fixture();
    await Promise.all(Array.from({ length: 1100 }, (_, index) => fs.writeFile(path.join(path.dirname(setup.registryPath), `noise-${index}`), 'x')));
    const result = await failure(setup.store.recoverReservedAdoption(setup.request));
    expect(result).toMatchObject({ code: 'EADOPTIONPENDING', cause: { code: 'EHEADRESOURCE' } });
    expect(result).not.toHaveProperty('phase');
    await expect(fs.lstat(setup.registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
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
  it.each(['partial-registry-create', 'after-registry-create', 'after-registry-rename', 'after-rename'] as const)('qualifies real SIGKILL at %s', async stop => {
    const setup = await fixture();
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
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL'); await exited;
      expect((await setup.store.inspectInterruptedOwnedHead(setup.request.locator)).kind).toBe('blocked-by-fence');
      // Sole child has exited; this is explicitly isolated test-only orphan handling.
      await fs.rm(path.join(setup.tenantRoot, '.memory-fences', 'tenant.lock'), { recursive: true });
      if (stop === 'partial-registry-create') {
        const bytes = Buffer.from(JSON.stringify(setup.record));
        expect(await fs.readFile(setup.registryPath)).toEqual(bytes.subarray(0, Math.floor(bytes.length / 2)));
        expect(JSON.parse(await fs.readFile(setup.sidecarPath, 'utf8')).state).toBe('RESERVED');
        const before = await proof([setup.registryPath]);
        await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
        expect(await proof([setup.registryPath])).toEqual(before);
      } else {
        expect((await setup.store.recoverReservedAdoption(setup.request)).status).toBe(stop === 'after-rename' ? 'already-clean-no-attribution' : 'known-adopted');
      }
      expect(await proof([setup.headPath, setup.archivePath])).toEqual(original);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
    if (childError) throw childError;
  });
});
