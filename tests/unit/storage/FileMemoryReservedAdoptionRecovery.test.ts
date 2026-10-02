import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type AdoptionRecoveryPublication, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { FileMemoryAdoptionRecoveryScanBudget } from '../../../src/storage/FileMemoryAdoptionRecoveryScanBudget.js';

const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
async function fixture(stop = 'active-registry', existing?: { tenantRoot: string; coordinator: FileMemoryTransactionCoordinator }) {
  const tenantRoot = existing?.tenantRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'adoption-final-'));
  if (!existing) roots.push(tenantRoot);
  const locator = existing ? 'Notes/Second.yaml' : 'Notes/ÜberNote.yaml';
  const headPath = path.join(tenantRoot, locator);
  await fs.mkdir(path.dirname(headPath), { recursive: true });
  await fs.writeFile(headPath, 'name: Original\nentries: []\n');
  const coordinator = existing?.coordinator ?? new FileMemoryTransactionCoordinator({ tenantRoot, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
  const store = new FileMemoryOwnerSnapshots({ coordinator });
  const legacy = await store.readHeadSnapshot(locator);
  const adopter = new FileMemoryOwnerSnapshots({ coordinator, afterPublication: phase => {
    if (phase === stop) throw new Error('interrupted adoption');
  } });
  await expect(adopter.adoptUnowned(legacy.token as UnownedFileMemoryToken)).rejects.toBeDefined();
  const hash = createHash('sha256').update(path.basename(headPath)).digest('hex');
  const sidecarPath = path.join(path.dirname(headPath), `.${hash}.memory-owner.json`);
  const reserved = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  const request = { locator, ownerId: reserved.ownerId as string };
  const registryPath = path.join(tenantRoot, '.memory-owners', 'owners', `${request.ownerId}.json`);
  const stagePath = `${sidecarPath}.adopt-${request.ownerId}.tmp`;
  const archivePath = path.join(tenantRoot, 'archive-evidence');
  await fs.writeFile(archivePath, 'unrelated durable archive evidence', { mode: 0o600 });
  return { tenantRoot, locator, headPath, coordinator, store, legacy, request, sidecarPath, registryPath, stagePath, archivePath };
}
type Setup = Awaited<ReturnType<typeof fixture>>;
async function proof(files: string[]) {
  return Promise.all(files.map(async file => {
    const stat = await fs.lstat(file, { bigint: true });
    return { file, dev: stat.dev, inode: stat.ino, size: stat.size, mode: stat.mode, links: stat.nlink,
      ctime: stat.ctimeNs, mtime: stat.mtimeNs, bytes: stat.isFile() ? await fs.readFile(file) : null };
  }));
}
async function residual(setup: Setup) {
  const files = [setup.archivePath];
  for (const directory of [path.dirname(setup.headPath), path.dirname(setup.registryPath)]) {
    try { for (const name of (await fs.readdir(directory)).sort()) files.push(path.join(directory, name)); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
  }
  return proof(files);
}
async function replaceSameBytes(file: string) {
  const raw = await fs.readFile(file);
  await fs.rename(file, `${file}.saved`);
  await fs.writeFile(file, raw, { mode: 0o600 });
  await fs.unlink(`${file}.saved`);
}
function at(setup: Setup, stop: AdoptionRecoveryPublication, callback: () => void | Promise<void>) {
  return new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator, afterAdoptionRecoveryPublication: phase => {
    if (phase === stop) return callback();
  } });
}
async function failureOf(action: Promise<unknown>): Promise<{ code: string; cause: unknown; token?: unknown }> {
  try { await action; } catch (cause) { return cause as { code: string; cause: unknown; token?: unknown }; }
  throw new Error('expected failure');
}
afterEach(async () => {
  jest.restoreAllMocks();
  SecurityMonitor.clearAllEventsForTesting();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('dormant final RESERVED adoption recovery', () => {
  if (process.platform === 'win32') {
    it('retains the local POSIX restriction', () => {
      const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: 'C:\\', getCurrentUserId: () => USER, fence: new FileMemoryFence() });
      expect(() => new FileMemoryOwnerSnapshots({ coordinator })).toThrow('requires POSIX');
    });
    return;
  }
  it('publishes only the final sidecar and retries without attribution under one tracked operation', async () => {
    const setup = await fixture();
    const before = await proof([setup.headPath, setup.registryPath, setup.archivePath]);
    await expect(setup.store.readHeadSnapshot(setup.locator)).rejects.toBeDefined();
    const perform = jest.spyOn(setup.coordinator, 'perform');
    const result = await setup.store.recoverReservedAdoption(setup.request);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'known-adopted', token: { ...setup.legacy.token,
      ownership: 'owned', ownerId: setup.request.ownerId, revision: '1' } });
    if (result.status !== 'known-adopted') throw new Error('expected known adoption');
    expect(Object.isFrozen(result.token.fileIdentity)).toBe(true);
    expect(await proof([setup.headPath, setup.registryPath, setup.archivePath])).toEqual(before);
    expect(await setup.store.readHeadSnapshot(setup.locator)).toMatchObject({ token: result.token });
    expect(await setup.store.recoverReservedAdoption(setup.request)).toEqual({ status: 'already-clean-no-attribution' });
  });
  it('recovers the earlier reserved-sidecar phase through exact directory preparation', async () => {
    const setup = await fixture('reserved-sidecar');
    const before = await proof([setup.headPath, setup.archivePath]);
    const result = await setup.store.recoverReservedAdoption(setup.request);
    expect(result).toMatchObject({ status: 'known-adopted', token: { ...setup.legacy.token,
      ownership: 'owned', ownerId: setup.request.ownerId, revision: '1' } });
    expect(await proof([setup.headPath, setup.archivePath])).toEqual(before);
    expect(await setup.store.recoverReservedAdoption(setup.request)).toEqual({ status: 'already-clean-no-attribution' });
  });
  it.each(['ownerId', 'locator'])('preserves evidence for wrong request %s', async field => {
    const setup = await fixture();
    const before = await residual(setup);
    await expect(setup.store.recoverReservedAdoption({ ...setup.request,
      [field]: field === 'ownerId' ? randomUUID() : 'Other.yaml' })).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect(await residual(setup)).toEqual(before);
  });
  it.each(['userId', 'revision', 'locator', 'ownerId'] as const)('rejects registry mismatch %s', async field => {
    const setup = await fixture();
    const record = JSON.parse(await fs.readFile(setup.registryPath, 'utf8'));
    record[field] = field === 'revision' ? '2' : field === 'locator' ? 'Other.yaml' : randomUUID();
    await fs.writeFile(setup.registryPath, JSON.stringify(record));
    const before = await residual(setup);
    await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect(await residual(setup)).toEqual(before);
  });
  it('captures primitive request values before the first awaited lease', async () => {
    const setup = await fixture();
    const request = { ...setup.request };
    const result = setup.store.recoverReservedAdoption(request);
    request.locator = 'Other.yaml'; request.ownerId = randomUUID();
    expect((await result).status).toBe('known-adopted');
  });
  it.each([null, { locator: ['note.yaml'], ownerId: USER }, { locator: 'note.yaml', ownerId: [USER] },
    { locator: 'note.yaml', ownerId: USER, operationId: USER }])('rejects malformed request before any operation: %p', async request => {
    const setup = await fixture();
    const perform = jest.spyOn(setup.coordinator, 'perform');
    await expect(setup.store.recoverReservedAdoption(request as never)).rejects.toBeDefined();
    expect(perform).not.toHaveBeenCalled();
  });
  it('freshly verifies and reuses an exact complete deterministic stage', async () => {
    const setup = await fixture();
    await fs.writeFile(setup.stagePath, await fs.readFile(setup.registryPath), { mode: 0o600 });
    const staged = await fs.lstat(setup.stagePath, { bigint: true });
    expect((await setup.store.recoverReservedAdoption(setup.request)).status).toBe('known-adopted');
    expect((await fs.lstat(setup.sidecarPath, { bigint: true })).ino).toBe(staged.ino);
  });
  it.each(['partial', 'legacy-random', 'alias', 'registry-stage', 'journal'])('preserves unbound artifact %s', async kind => {
    const setup = await fixture();
    let file = setup.stagePath;
    if (kind === 'legacy-random') file = `${setup.sidecarPath}.${randomUUID()}.tmp`;
    if (kind === 'alias') file = `${setup.sidecarPath}.ADOPT-${setup.request.ownerId}.tmp`;
    if (kind === 'registry-stage') file = `${setup.registryPath}.tmp`;
    if (kind === 'journal') file = setup.sidecarPath.replace('.memory-owner.json', '.memory-write.json');
    await fs.writeFile(file, kind === 'partial' ? '{' : await fs.readFile(setup.registryPath), { mode: 0o600 });
    const before = await residual(setup);
    await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect(await residual(setup)).toEqual(before);
  });
  it.each(['headPath', 'sidecarPath', 'registryPath', 'stagePath'] as const)('rejects pre-rename same-byte replacement of %s', async target => {
    const setup = await fixture();
    const store = at(setup, 'before-rename', () => replaceSameBytes(setup[target]));
    await expect(store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect(JSON.parse(await fs.readFile(setup.sidecarPath, 'utf8')).state).toBe('RESERVED');
  });
  it.each(['after-rename', 'after-read'] as const)('retains a genuine token across nonthrowing substitutions at %s', async stop => {
    for (const target of ['headPath', 'registryPath', 'sidecarPath'] as const) {
      const setup = await fixture();
      await expect(at(setup, stop, () => replaceSameBytes(setup[target])).recoverReservedAdoption(setup.request))
        .rejects.toMatchObject({ code: 'EHEADADOPTED', adopted: true, token: { ownerId: setup.request.ownerId,
          contentHash: setup.legacy.token.contentHash, fileIdentity: setup.legacy.token.fileIdentity } });
    }
  });
  it.each(['before-stage', 'partial-stage', 'verified-stage', 'before-rename', 'after-rename', 'after-read'] as const)('rechecks active operation authority at %s', async stop => {
    const setup = await fixture();
    let revoked = false;
    const original = setup.coordinator.requireActiveOperationScope.bind(setup.coordinator);
    jest.spyOn(setup.coordinator, 'requireActiveOperationScope').mockImplementation(operation => {
      if (revoked) throw new Error('revoked');
      return original(operation);
    });
    await expect(at(setup, stop, () => { revoked = true; }).recoverReservedAdoption(setup.request)).rejects.toMatchObject({
      code: stop.startsWith('after-') ? 'EHEADADOPTED' : 'EADOPTIONPENDING',
    });
    if (stop === 'partial-stage') {
      const expected = await fs.readFile(setup.registryPath);
      expect(await fs.readFile(setup.stagePath)).toEqual(expected.subarray(0, Math.floor(expected.length / 2)));
      expect(JSON.parse(await fs.readFile(setup.sidecarPath, 'utf8')).state).toBe('RESERVED');
    }
  });
  it.each([null, undefined, new Error('fault')])('preserves non-Error fault cause %p', async cause => {
    const setup = await fixture();
    await expect(at(setup, 'before-stage', () => { throw cause; }).recoverReservedAdoption(setup.request))
      .rejects.toMatchObject({ code: 'EADOPTIONPENDING', cause, residual: true });
  });
  it('does not trust a forged adopted error thrown before commit', async () => {
    const setup = await fixture();
    const forged = { adopted: true, token: { ...setup.legacy.token, ownership: 'owned' } };
    await expect(at(setup, 'before-stage', () => { throw forged; }).recoverReservedAdoption(setup.request))
      .rejects.toMatchObject({ code: 'EADOPTIONPENDING', cause: forged });
    expect(JSON.parse(await fs.readFile(setup.sidecarPath, 'utf8')).state).toBe('RESERVED');
  });
  it('does not trust an adopted flag thrown by a requested audit listener', async () => {
    const setup = await fixture();
    const forged = { adopted: true, token: setup.legacy.token };
    const detach = SecurityMonitor.addLogListener(event => {
      if (event.source === 'FileMemoryOwnerSnapshots.adoption-recovery' && event.additionalData?.outcome === 'requested') throw forged;
    });
    try {
      await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING', cause: forged });
      expect(JSON.parse(await fs.readFile(setup.sidecarPath, 'utf8')).state).toBe('RESERVED');
    } finally { detach(); }
  });
  it.each(['after-rename', 'after-read'] as const)('retains original token and committed audit despite throwing %s hook', async stop => {
    const setup = await fixture();
    const failure = await failureOf(at(setup, stop, () => { throw null; }).recoverReservedAdoption(setup.request));
    expect(failure).toMatchObject({
      code: 'EHEADADOPTED', adopted: true, token: { ...setup.legacy.token, ownership: 'owned', ownerId: setup.request.ownerId, revision: '1' },
    });
    expect(failure.cause).toBeNull();
    expect(SecurityMonitor.getRecentEvents().some(event => event.source === 'FileMemoryOwnerSnapshots.adoption-recovery' &&
      event.additionalData?.outcome === 'known-adopted')).toBe(true);
    expect(await setup.store.recoverReservedAdoption(setup.request)).toEqual({ status: 'already-clean-no-attribution' });
  });
  it('retains genuine commit token across outer fence release failure', async () => {
    const setup = await fixture();
    const original = setup.coordinator.withTenantTransaction.bind(setup.coordinator);
    const releaseError = new Error('outer release fault');
    jest.spyOn(setup.coordinator, 'withTenantTransaction').mockImplementation(async callback => {
      await original(callback);
      throw releaseError;
    });
    const failure = await failureOf(setup.store.recoverReservedAdoption(setup.request));
    expect(failure).toMatchObject({ code: 'EHEADADOPTED',
      token: { ownerId: setup.request.ownerId, fileIdentity: setup.legacy.token.fileIdentity }, cause: { message: 'outer release fault' } });
    expect(failure.cause).toBe(releaseError);
  });
  it('preserves the original synchronous committed-audit listener error as direct cause', async () => {
    const setup = await fixture();
    const auditError = new Error('audit listener failure');
    const detach = SecurityMonitor.addLogListener(event => {
      if (event.source === 'FileMemoryOwnerSnapshots.adoption-recovery' && event.additionalData?.outcome === 'known-adopted') throw auditError;
    });
    try {
      const failure = await failureOf(setup.store.recoverReservedAdoption(setup.request));
      expect(failure.code).toBe('EHEADADOPTED');
      expect(failure.cause).toBe(auditError);
    } finally { detach(); }
  });
  it('preserves the native readback error as direct cause after genuine publication', async () => {
    const setup = await fixture();
    const failure = await failureOf(at(setup, 'after-rename', () => fs.unlink(setup.headPath)).recoverReservedAdoption(setup.request));
    expect(failure).toMatchObject({ code: 'EHEADADOPTED', cause: { code: 'ENOENT' },
      token: { ownerId: setup.request.ownerId, fileIdentity: setup.legacy.token.fileIdentity } });
  });
  it.each(['before-stage', 'after-rename'] as const)('does not borrow a prior invocation token at %s', async stop => {
    const first = await fixture();
    const second = await fixture('active-registry', first);
    let failurePhase: AdoptionRecoveryPublication = 'after-rename';
    let thrown: unknown = new Error('first committed failure');
    const store = new FileMemoryOwnerSnapshots({ coordinator: first.coordinator,
      afterAdoptionRecoveryPublication: phase => { if (phase === failurePhase) throw thrown; } });
    const prior = await failureOf(store.recoverReservedAdoption(first.request));
    expect(prior.code).toBe('EHEADADOPTED');
    failurePhase = stop;
    thrown = prior;
    const failure = await failureOf(store.recoverReservedAdoption(second.request));
    expect(failure.code).toBe(stop === 'before-stage' ? 'EADOPTIONPENDING' : 'EHEADADOPTED');
    expect(failure.cause).toBe(prior);
    if (stop === 'before-stage') expect(failure.token).toBeUndefined();
    else expect(failure.token).toMatchObject({ ownerId: second.request.ownerId, fileIdentity: second.legacy.token.fileIdentity });
  });
  it.each(['before-stage', 'verified-stage'] as const)('refuses earlier same-byte sidecar replacement at %s', async stop => {
    const setup = await fixture();
    await expect(at(setup, stop, () => replaceSameBytes(setup.sidecarPath)).recoverReservedAdoption(setup.request))
      .rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect(JSON.parse(await fs.readFile(setup.sidecarPath, 'utf8')).state).toBe('RESERVED');
  });
  it.each(['mode', 'hardlink', 'symlink', 'wrong-owner'])('preserves an unsafe exact stage: %s', async kind => {
    const setup = await fixture();
    const raw = await fs.readFile(setup.registryPath);
    if (kind === 'symlink') await fs.symlink(setup.registryPath, setup.stagePath);
    else {
      await fs.writeFile(setup.stagePath, raw, { mode: kind === 'mode' ? 0o644 : 0o600 });
      if (kind === 'hardlink') await fs.link(setup.stagePath, `${setup.stagePath}.other`);
      if (kind === 'wrong-owner') {
        const record = JSON.parse(raw.toString()); record.ownerId = randomUUID();
        await fs.writeFile(setup.stagePath, JSON.stringify(record));
      }
    }
    const inode = (await fs.lstat(setup.stagePath)).ino;
    await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect((await fs.lstat(setup.stagePath)).ino).toBe(inode);
  });
  it('refuses unavailable private owner ancestor proof', async () => {
    const setup = await fixture();
    const directory = path.dirname(setup.registryPath);
    await fs.chmod(directory, 0o755);
    const before = await residual(setup);
    await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect(await residual(setup)).toEqual(before);
  });
  it('keeps two real audit invocations and their distinct outcomes in the same dedup window', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    for (let index = 0; index < 2; index++) {
      const setup = await fixture();
      await setup.store.recoverReservedAdoption(setup.request);
    }
    const events = SecurityMonitor.getRecentEvents().filter(event => event.source === 'FileMemoryOwnerSnapshots.adoption-recovery');
    expect(events.map(event => event.additionalData?.outcome)).toEqual(['requested', 'known-adopted', 'requested', 'known-adopted']);
    expect(events.every(event => !event.details.includes(USER))).toBe(true);
  });
  it.each(['known-adopted', 'already-clean-no-attribution'] as const)('reproves after real nonthrowing %s audit listener', async outcome => {
    const setup = await fixture();
    if (outcome === 'already-clean-no-attribution') await setup.store.recoverReservedAdoption(setup.request);
    let injected = false;
    const detach = SecurityMonitor.addLogListener(event => {
      if (event.source !== 'FileMemoryOwnerSnapshots.adoption-recovery' || event.additionalData?.outcome !== outcome) return;
      injected = true;
      const raw = syncFs.readFileSync(setup.registryPath);
      syncFs.renameSync(setup.registryPath, `${setup.registryPath}.saved`);
      syncFs.writeFileSync(setup.registryPath, raw, { mode: 0o600 });
      syncFs.unlinkSync(`${setup.registryPath}.saved`);
    });
    try {
      await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({
        code: outcome === 'known-adopted' ? 'EHEADADOPTED' : 'EADOPTIONPENDING',
      });
      expect(injected).toBe(true);
    } finally { detach(); }
  });
  it('rejects a nonregular exact-named FIFO stage without hanging', async () => {
    const setup = await fixture();
    execFileSync('mkfifo', ['-m', '600', setup.stagePath]);
    await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
    expect((await fs.lstat(setup.stagePath)).isFIFO()).toBe(true);
  });
  describe('whole-invocation budget exhaustion with 4096 unrelated entries', () => {
    let setup: Setup, before: Awaited<ReturnType<typeof residual>>, started: number, lifecycleStarted: number | undefined;
    const diagnostic = (phase: string, accounting: object = {}) => {
      process.stderr.write(`ADOPTION capacity ${JSON.stringify({ phase, elapsedMs: performance.now() - started,
        ...(lifecycleStarted === undefined ? {} : { lifecycleElapsedMs: performance.now() - lifecycleStarted }),
        node: process.version, pid: process.pid, noiseFiles: 4096, ...accounting })}\n`);
    };
    beforeEach(async () => {
      started = performance.now();
      try {
        setup = await fixture();
        await Promise.all(Array.from({ length: 4096 }, (_, index) => fs.writeFile(path.join(path.dirname(setup.headPath), `noise-${index}`), 'x')));
        before = await residual(setup);
      } finally { diagnostic('setup-end'); }
    }, 10000);
    it('charges unrelated entries against one whole invocation budget, preserving exhaustion evidence', async () => {
      lifecycleStarted = performance.now(); diagnostic('lifecycle-start');
      const read = FileMemoryAdoptionRecoveryScanBudget.prototype.read;
      let budgetReadCalls = 0;
      let budgetAccounting: (() => { chargedReads: number; scanLimit: number }) | undefined;
      // Direct delegation keeps the original read promise and distinguishes calls
      // (including a refused admission) from the budget's actual charged attempts.
      jest.spyOn(FileMemoryAdoptionRecoveryScanBudget.prototype, 'read').mockImplementation(function(this: FileMemoryAdoptionRecoveryScanBudget, directory, attempts, bound) {
        budgetAccounting = () => ({ chargedReads: this.consumed, scanLimit: this.limit });
        budgetReadCalls++; return read.call(this, directory, attempts, bound);
      });
      const accounting = () => ({ budgetReadCalls, ...budgetAccounting?.() });
      try {
        await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING', cause: { code: 'EHEADRESOURCE' } });
      } finally { diagnostic('recovery-end', accounting()); }
      expect(await residual(setup)).toEqual(before);
      await expect(fs.lstat(setup.stagePath)).rejects.toMatchObject({ code: 'ENOENT' });
      diagnostic('assertions-complete', accounting());
    }, 10000);
  });
  it('retains a known token when the same private budget exhausts only after publication', async () => {
    const setup = await fixture();
    const store = new FileMemoryOwnerSnapshots({ coordinator: setup.coordinator, afterAdoptionRecoveryPublication: phase => {
      if (phase !== 'after-rename') return;
      const read = FileMemoryAdoptionRecoveryScanBudget.prototype.read;
      jest.spyOn(FileMemoryAdoptionRecoveryScanBudget.prototype, 'read').mockImplementation(async function(this: FileMemoryAdoptionRecoveryScanBudget, directory, attempts, bound) {
        while (this.consumed < this.limit) await read.call(this, directory, attempts, bound);
        return read.call(this, directory, attempts, bound);
      });
    } });
    await expect(store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EHEADADOPTED', adopted: true,
      cause: { code: 'EHEADRESOURCE' },
      token: { ownerId: setup.request.ownerId, fileIdentity: setup.legacy.token.fileIdentity } });
    expect(JSON.parse(await fs.readFile(setup.sidecarPath, 'utf8')).state).toBe('ACTIVE');
  });
  const permissionTest = process.getuid?.() === 0 ? it.skip : it;
  permissionTest.each(['before-stage', 'before-rename'] as const)('types real %s permission failure without discarding evidence', async stop => {
    const setup = await fixture();
    const directory = path.dirname(setup.headPath);
    try {
      await expect(at(setup, stop, () => fs.chmod(directory, 0o500)).recoverReservedAdoption(setup.request))
        .rejects.toMatchObject({ code: stop === 'before-rename' ? 'EADOPTIONCOMMITUNKNOWN' : 'EADOPTIONPENDING',
          cause: { code: 'EACCES' }, residual: true });
    } finally { await fs.chmod(directory, 0o700); }
    expect((await setup.store.recoverReservedAdoption(setup.request)).status).toBe('known-adopted');
  });

  const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
  const moduleRoot = new URL('../../../src/storage/', import.meta.url);
  const childScript = `
    const [ownersUrl,coordinatorUrl,fenceUrl,tenantRoot,userId,requestJson,stop] = process.argv.slice(1);
    const { FileMemoryOwnerSnapshots } = await import(ownersUrl);
    const { FileMemoryTransactionCoordinator } = await import(coordinatorUrl);
    const { FileMemoryFence } = await import(fenceUrl);
    const coordinator = new FileMemoryTransactionCoordinator({tenantRoot,getCurrentUserId:()=>userId,fence:new FileMemoryFence()});
    const store = new FileMemoryOwnerSnapshots({coordinator,afterAdoptionRecoveryPublication:phase=>{
      if(phase===stop){process.stdout.write('STOPPED\\n');process.stdin.resume();return new Promise(()=>{});}
    }});
    await store.recoverReservedAdoption(JSON.parse(requestJson));
  `;
  it.each(['partial-stage', 'verified-stage', 'before-rename', 'after-rename', 'after-read'] as const)('qualifies real SIGKILL and fresh orphan-handled retry at %s', async stop => {
    const setup = await fixture();
    const original = await proof([setup.headPath, setup.registryPath, setup.archivePath]);
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
      expect((await setup.store.inspectInterruptedOwnedHead(setup.locator)).kind).toBe('blocked-by-fence');
      // Isolated test-only cleanup after the sole child writer's confirmed exit; never a production policy.
      await fs.rm(path.join(setup.tenantRoot, '.memory-fences', 'tenant.lock'), { recursive: true });
      if (stop === 'partial-stage') {
        const before = await residual(setup);
        await expect(setup.store.recoverReservedAdoption(setup.request)).rejects.toMatchObject({ code: 'EADOPTIONPENDING' });
        expect(await residual(setup)).toEqual(before);
      } else {
        expect((await setup.store.recoverReservedAdoption(setup.request)).status).toBe(stop.startsWith('after-')
          ? 'already-clean-no-attribution' : 'known-adopted');
      }
      expect(await proof([setup.headPath, setup.registryPath, setup.archivePath])).toEqual(original);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
});
