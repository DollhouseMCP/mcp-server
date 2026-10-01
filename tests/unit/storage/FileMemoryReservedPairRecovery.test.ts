import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
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
async function fixture() {
  const tenantRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reserved-pair-'));
  roots.push(tenantRoot);
  const locator = 'Notes/ÜberNote.yaml';
  const headPath = path.join(tenantRoot, locator);
  await fs.mkdir(path.dirname(headPath), { recursive: true });
  await fs.writeFile(headPath, 'name: Original\nentries: []\n');
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
  const store = new FileMemoryOwnerSnapshots({ coordinator });
  const legacy = await store.readHeadSnapshot(locator);
  const adopter = new FileMemoryOwnerSnapshots({ coordinator, afterPublication: phase => {
    if (phase === 'reserved-registry') throw new Error('initial interruption');
  } });
  await expect(adopter.adoptUnowned(legacy.token as UnownedFileMemoryToken)).rejects.toThrow('initial interruption');
  const hash = createHash('sha256').update(path.basename(headPath)).digest('hex');
  const sidecarPath = path.join(path.dirname(headPath), `.${hash}.memory-owner.json`);
  const record = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  const request = { locator, ownerId: record.ownerId as string };
  const registryPath = path.join(tenantRoot, '.memory-owners', 'owners', `${request.ownerId}.json`);
  const registryStage = `${registryPath}.adopt-${request.ownerId}.tmp`;
  const sidecarStage = `${sidecarPath}.adopt-${request.ownerId}.tmp`;
  const archivePath = path.join(tenantRoot, 'archive-evidence');
  await fs.writeFile(archivePath, 'untouched durable archive evidence');
  return { tenantRoot, coordinator, store, legacy, request, headPath, sidecarPath, registryPath, registryStage, sidecarStage, archivePath, record };
}
type Setup = Awaited<ReturnType<typeof fixture>>;
async function proof(files: string[]) {
  return Promise.all(files.map(async file => {
    const stat = await fs.lstat(file, { bigint: true });
    return { file, inode: stat.ino, dev: stat.dev, size: stat.size, mode: stat.mode, links: stat.nlink,
      ctime: stat.ctimeNs, mtime: stat.mtimeNs, raw: stat.isFile() ? await fs.readFile(file) : null };
  }));
}
async function residual(setup: Setup) {
  const files = [setup.headPath, setup.archivePath];
  for (const dir of [path.dirname(setup.sidecarPath), path.dirname(setup.registryPath)]) {
    for (const name of (await fs.readdir(dir)).sort()) if (path.join(dir, name) !== setup.headPath) files.push(path.join(dir, name));
  }
  return proof(files);
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
async function failureOf(action: Promise<unknown>) {
  try { await action; } catch (cause) { return cause as { code: string; cause: unknown; phase?: string; token?: unknown }; }
  throw new Error('expected failure');
}
afterEach(async () => {
  jest.restoreAllMocks();
  SecurityMonitor.clearAllEventsForTesting();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('exact existing RESERVED pair recovery', () => {
  if (process.platform === 'win32') {
    it('retains POSIX restriction', () => {
      const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: 'C:\\', getCurrentUserId: () => USER, fence: new FileMemoryFence() });
      expect(() => new FileMemoryOwnerSnapshots({ coordinator })).toThrow('requires POSIX');
    });
    return;
  }
  it('completes the pair under one tracked operation without changing head or archives', async () => {
    const setup = await fixture();
    const before = await proof([setup.headPath, setup.archivePath]);
    const perform = jest.spyOn(setup.coordinator, 'perform');
    expect((await setup.store.inspectInterruptedOwnedHead(setup.request.locator)).kind).not.toBe('clean');
    await expect(setup.store.readHeadSnapshot(setup.request.locator)).rejects.toBeDefined();
    const result = await setup.store.recoverReservedAdoption(setup.request);
    expect(result).toMatchObject({ status: 'known-adopted', token: { ...setup.legacy.token, ownership: 'owned', ownerId: setup.request.ownerId, revision: '1' } });
    expect(perform).toHaveBeenCalledTimes(1);
    expect(await proof([setup.headPath, setup.archivePath])).toEqual(before);
    expect(await setup.store.recoverReservedAdoption(setup.request)).toEqual({ status: 'already-clean-no-attribution' });
    expect(JSON.parse(await fs.readFile(setup.registryPath, 'utf8')).state).toBe('ACTIVE');
    expect(JSON.parse(await fs.readFile(setup.sidecarPath, 'utf8')).state).toBe('ACTIVE');
  });
  it('freshly verifies and reuses only the complete exact registry stage', async () => {
    const setup = await fixture();
    await fs.writeFile(setup.registryStage, JSON.stringify({ ...setup.record, state: 'ACTIVE' }), { mode: 0o600 });
    const original = await fs.lstat(setup.registryStage);
    await setup.store.recoverReservedAdoption(setup.request);
    expect((await fs.lstat(setup.registryPath)).ino).toBe(original.ino);
    await expect(fs.lstat(setup.registryStage)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['ACTIVE', 'mismatch', 'revision', 'owner', 'tenant', 'locator'] as const)('preserves invalid pair %s', async variant => {
    const setup = await fixture();
    const sidecar = { ...setup.record };
    if (variant === 'ACTIVE') sidecar.state = 'ACTIVE';
    if (variant === 'mismatch') sidecar.contentHash = 'a'.repeat(64);
    if (variant === 'revision') sidecar.revision = '2';
    if (variant === 'owner') sidecar.ownerId = '22222222-2222-4222-8222-222222222222';
    if (variant === 'tenant') sidecar.userId = 'other';
    if (variant === 'locator') sidecar.locator = 'Notes/Other.yaml';
    await fs.writeFile(setup.sidecarPath, JSON.stringify(sidecar), { mode: 0o600 });
    const before = await residual(setup);
    await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect(await residual(setup)).toEqual(before);
  });
  it.each(['partial', 'random', 'wrong-order', 'alias', 'duplicate'] as const)('preserves unbound stage %s', async variant => {
    const setup = await fixture();
    const active = JSON.stringify({ ...setup.record, state: 'ACTIVE' });
    const file = variant === 'wrong-order' ? setup.sidecarStage : variant === 'random' ? `${setup.registryPath}.random.tmp` :
      variant === 'alias' ? setup.registryStage.toUpperCase().replace(path.dirname(setup.registryStage).toUpperCase(), path.dirname(setup.registryStage)) : setup.registryStage;
    await fs.writeFile(file, variant === 'partial' ? active.slice(0, 15) : active, { mode: 0o600 });
    if (variant === 'duplicate') await fs.writeFile(`${setup.registryPath}.other.tmp`, active, { mode: 0o600 });
    const before = await residual(setup);
    await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect(await residual(setup)).toEqual(before);
  });
  it.each(['headPath', 'sidecarPath', 'registryPath', 'registryStage'] as const)('refuses same-byte inode substitution of %s before registry rename', async field => {
    const setup = await fixture();
    let captured: Awaited<ReturnType<typeof residual>> | undefined;
    const store = at(setup, 'before-registry-rename', async () => { await replaceSame(setup[field]); captured = await residual(setup); });
    await expect(store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect(captured).toBeDefined();
    expect(await residual(setup)).toEqual(captured);
  });
  it('refuses replaced owners-directory identity after registry publication', async () => {
    const setup = await fixture();
    const directory = path.dirname(setup.registryPath);
    const store = at(setup, 'after-registry-rename', async () => {
      await fs.rename(directory, `${directory}.old`);
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.copyFile(path.join(`${directory}.old`, path.basename(setup.registryPath)), setup.registryPath);
      await fs.chmod(setup.registryPath, 0o600);
    });
    const failure = await failureOf(store.recoverReservedAdoption(setup.request));
    expect(failure).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'registry-published' });
    expect(failure).not.toHaveProperty('token');
  });
  it.each(['headPath', 'sidecarPath', 'registryPath'] as const)('does not rebase after same-byte %s replacement at registry publication', async field => {
    const setup = await fixture();
    const failure = await failureOf(at(setup, 'after-registry-rename', () => replaceSame(setup[field])).recoverReservedAdoption(setup.request));
    expect(failure).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'registry-published' });
    expect(failure).not.toHaveProperty('token');
    expect(JSON.parse(await fs.readFile(setup.sidecarPath, 'utf8')).state).toBe('RESERVED');
  });
  it.each(['before-registry-stage', 'partial-registry-stage', 'verified-registry-stage', 'before-registry-rename', 'after-registry-rename'] as const)('rechecks authority at %s', async stop => {
    const setup = await fixture();
    const check = setup.coordinator.requireActiveOperationScope.bind(setup.coordinator);
    const store = at(setup, stop, () => {
      jest.spyOn(setup.coordinator, 'requireActiveOperationScope').mockImplementation(() => { throw new Error('revoked'); });
    });
    const failure = await failureOf(store.recoverReservedAdoption(setup.request));
    expect(failure.code).toBe('EADOPTIONPENDING');
    expect(failure).not.toHaveProperty('token');
    if (stop === 'partial-registry-stage') {
      const bytes = Buffer.from(JSON.stringify({ ...setup.record, state: 'ACTIVE' }));
      expect(await fs.readFile(setup.registryStage)).toEqual(bytes.subarray(0, Math.floor(bytes.length / 2)));
    }
    jest.spyOn(setup.coordinator, 'requireActiveOperationScope').mockImplementation(check);
  });
  it.each([new Error('post-registry'), null])('retains direct intermediate cause %s and resumes without false attribution', async cause => {
    const setup = await fixture();
    const failure = await failureOf(at(setup, 'after-registry-rename', () => { throw cause; }).recoverReservedAdoption(setup.request));
    expect(failure).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'registry-published' });
    expect(failure.cause).toBe(cause);
    expect(failure).not.toHaveProperty('token');
    expect(failure).not.toHaveProperty('adopted');
    expect((await setup.store.recoverReservedAdoption(setup.request)).status).toBe('known-adopted');
  });
  it('does not infer progress from forged phase and adopted markers before rename', async () => {
    const setup = await fixture();
    const forged = { code: 'EADOPTIONCOMMITUNKNOWN', phase: 'registry-published', adopted: true, token: setup.legacy.token };
    const failure = await failureOf(at(setup, 'before-registry-stage', () => { throw forged; }).recoverReservedAdoption(setup.request));
    expect(failure.code).toBe('EADOPTIONPENDING');
    expect(failure.cause).toBe(forged);
    expect(failure).not.toHaveProperty('phase');
    expect(failure).not.toHaveProperty('token');
    expect(failure).not.toHaveProperty('adopted');
  });
  it('carries registry-published phase through final-sidecar staging failure', async () => {
    const setup = await fixture();
    const cause = new Error('sidecar stage');
    const failure = await failureOf(at(setup, 'before-stage', () => { throw cause; }).recoverReservedAdoption(setup.request));
    expect(failure).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'registry-published' });
    expect(failure.cause).toBe(cause);
    expect(failure).not.toHaveProperty('token');
  });
  it('uses a single budget instance across both publications without reset', async () => {
    const setup = await fixture();
    const instances = new Set<FileMemoryAdoptionRecoveryScanBudget>();
    const consumed: number[] = [];
    const read = FileMemoryAdoptionRecoveryScanBudget.prototype.read;
    jest.spyOn(FileMemoryAdoptionRecoveryScanBudget.prototype, 'read').mockImplementation(function (this: FileMemoryAdoptionRecoveryScanBudget, directory, attempts, bound) {
      instances.add(this); consumed.push(this.consumed); return read.call(this, directory, attempts, bound);
    });
    await setup.store.recoverReservedAdoption(setup.request);
    expect(instances.size).toBe(1);
    expect(consumed).toEqual(consumed.map((_, index) => index));
  });
  it('keeps genuine final receipt and direct cause after progressing both records', async () => {
    const setup = await fixture();
    const cause = new Error('committed hook');
    const failure = await failureOf(at(setup, 'after-rename', () => { throw cause; }).recoverReservedAdoption(setup.request));
    expect(failure).toMatchObject({ code: 'EHEADADOPTED', token: { ...setup.legacy.token, ownership: 'owned' } });
    expect(failure.cause).toBe(cause);
    expect(failure).not.toHaveProperty('phase');
  });
  it('reports actual registry rename refusal as pending unknown without nested cause', async () => {
    if (process.getuid?.() === 0) return; // Root can rename despite owner write permissions.
    const setup = await fixture();
    const directory = path.dirname(setup.registryPath);
    const check = setup.coordinator.requireActiveOperationScope.bind(setup.coordinator);
    let checks = 0;
    const store = at(setup, 'before-registry-rename', () => {
      jest.spyOn(setup.coordinator, 'requireActiveOperationScope').mockImplementation(operation => {
        const scope = check(operation);
        if (++checks === 2) syncFs.chmodSync(directory, 0o500);
        return scope;
      });
    });
    try {
      const failure = await failureOf(store.recoverReservedAdoption(setup.request));
      expect(failure).toMatchObject({ code: 'EADOPTIONPENDING', phase: 'registry-publication-unknown', cause: { code: 'EACCES' } });
      expect(failure).not.toHaveProperty('token');
      expect(failure).not.toHaveProperty('adopted');
      expect(JSON.parse(await fs.readFile(setup.registryPath, 'utf8')).state).toBe('RESERVED');
    } finally { await fs.chmod(directory, 0o700); }
    jest.restoreAllMocks();
    expect((await setup.store.recoverReservedAdoption(setup.request)).status).toBe('known-adopted');
  });
  it('rejects exact named FIFO stage without blocking', async () => {
    const setup = await fixture();
    execFileSync('mkfifo', ['-m', '600', setup.registryStage]);
    const before = await residual(setup);
    await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect(await residual(setup)).toEqual(before);
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
  it.each(['partial-registry-stage', 'verified-registry-stage', 'before-registry-rename', 'after-registry-rename', 'verified-stage', 'after-rename'] as const)('qualifies real SIGKILL at %s and exact residual retry', async stop => {
    const setup = await fixture();
    const original = await proof([setup.headPath, setup.archivePath]);
    const child = spawn(process.execPath, [...(extension === 'ts' ? ['--import', 'tsx'] : []), '--input-type=module', '-e', childScript,
      new URL(`FileMemoryOwnerSnapshots.${extension}`, moduleRoot).href,
      new URL(`FileMemoryTransactionCoordinator.${extension}`, moduleRoot).href,
      new URL(`FileMemoryFence.${extension}`, moduleRoot).href,
      setup.tenantRoot, USER, JSON.stringify(setup.request), stop], { stdio: ['pipe', 'pipe', 'pipe'] });
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
      // Isolated test-only orphan handling after confirmed sole writer exit, never production cleanup.
      await fs.rm(path.join(setup.tenantRoot, '.memory-fences', 'tenant.lock'), { recursive: true });
      if (stop === 'partial-registry-stage') {
        const before = await residual(setup);
        await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
        expect(await residual(setup)).toEqual(before);
      } else {
        expect((await setup.store.recoverReservedAdoption(setup.request)).status).toBe(stop === 'after-rename' ? 'already-clean-no-attribution' : 'known-adopted');
      }
      expect(await proof([setup.headPath, setup.archivePath])).toEqual(original);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
});
