import { describe, it, expect, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { MemoryHeadUpdateAdapter } from '../../../src/storage/MemoryHeadUpdateAdapter.js';
import { FileMemoryOwnerSnapshots } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { Memory, type MemoryMetadata } from '../../../src/elements/memories/Memory.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { MetadataService } from '../../../src/services/MetadataService.js';
import { createTestStorageFactory } from '../../helpers/createTestStorageFactory.js';
import type { ElementManagerDeps } from '../../../src/elements/base/BaseElementManager.js';
const USER = '11111111-1111-4111-8111-111111111111';
class ObservedManager extends MemoryManager {
  serializeGate?: Promise<void>;
  rejectValidation = false;
  backendValidationCandidate?: string;
  publicationFailure?: { cause: unknown };
  cached(locator: string): Memory | undefined { return this.getCachedByAbsolutePath(path.join(this.elementDir, locator)); }
  protected override async serializeElement(memory: Memory): Promise<string> {
    if (this.serializeGate) await this.serializeGate;
    return this.backendValidationCandidate ?? super.serializeElement(memory);
  }
  protected override validateSerializedContent(content: string): void {
    if (this.rejectValidation) throw new Error('controlled candidate validation');
    if (this.backendValidationCandidate === undefined) super.validateSerializedContent(content);
  }
  protected override afterSave(memory: Memory, locator: string): Promise<void> {
    if (this.publicationFailure) return Promise.reject(this.publicationFailure.cause);
    return super.afterSave(memory, locator);
  }
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-central-owned-'));
  const metadataService = new MetadataService();
  const lock = new FileLockManager();
  const files = new FileOperationsService(lock);
  let tenant = USER;
  const deps: ElementManagerDeps = { portfolioManager: new PortfolioManager(files, { baseDir: root }),
    fileLockManager: lock, fileOperationsService: files, serializationService: new SerializationService(),
    metadataService, validationRegistry: new ValidationRegistry(new ValidationService(), new TriggerValidationService(), metadataService),
    eventDispatcher: new ElementEventDispatcher(), storageLayerFactory: createTestStorageFactory(), getCurrentUserId: () => tenant };
  const managers: MemoryManager[] = [];
  const ordinary = new MemoryManager(deps); managers.push(ordinary);
  const memory = new Memory({ name: 'Owned memory', description: 'Original description', retentionDays: 36500,
    tags: ['original'], autoLoad: true, priority: 3 }, metadataService);
  memory.instructions = 'Original instructions';
  memory.extensions = { nested: { value: 'original' } };
  await memory.addEntry('Original entry', ['original'], { nested: { value: 'original' } });
  try {
    await ordinary.save(memory, 'head.yaml');
    const tenantRoot = await fs.realpath(path.join(root, 'memories'));
    const fence = new FileMemoryFence();
    const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot, getCurrentUserId: () => tenant, fence });
    const owners = new FileMemoryOwnerSnapshots({ coordinator });
    const unowned = await owners.readHeadSnapshot('head.yaml');
    if (unowned.token.ownership !== 'unowned') throw new Error('Expected genuine unowned fixture');
    await owners.adoptUnowned(unowned.token);
    const makeManager = (store = owners) => {
      const adapter = new MemoryHeadUpdateAdapter({ backend: 'file', store }, () => tenant);
      const manager = new ObservedManager(deps, adapter); managers.push(manager);
      return { manager, adapter };
    };
    const cleanup = async () => { for (const manager of managers) manager.dispose(); await fs.rm(root, { recursive: true, force: true }); };
    return { root, tenantRoot, owners, fence, makeManager, setTenant: (value: string) => { tenant = value; }, cleanup };
  } catch (cause) {
    for (const manager of managers) manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
    throw cause;
  }
}
const posix = process.platform === 'win32' ? describe.skip : describe;
posix('dormant central owned memory UPDATE', () => {
  it('hydrates exact snapshot entries/instructions/extensions and self-saves without a legacy writer', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager();
      const read = jest.spyOn(f.owners, 'readHeadSnapshot');
      const memory = await manager.load('head.yaml');
      expect(read).toHaveBeenCalledTimes(1);
      expect(memory.instructions).toBe('Original instructions');
      expect([...memory.getEntries().values()].map(entry => entry.content)).toEqual(['Original entry']);
      expect(memory.extensions).toEqual({ nested: { value: 'original' } });
      expect(manager.cached('head.yaml')).toBeUndefined();
      const legacy = jest.spyOn(FileOperationsService.prototype, 'writeFile');
      try {
        await memory.addEntry('Second entry');
        await memory.save();
        expect(legacy).not.toHaveBeenCalled();
        expect((await f.owners.readHeadSnapshot('head.yaml')).content).toContain('Second entry');
        expect(manager.cached('head.yaml')).not.toBe(memory);
      } finally { legacy.mockRestore(); }
    } finally { await f.cleanup(); }
  });
  it('retains a stale working candidate and never reads a fresh token at save time', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager();
      const first = await manager.load('head.yaml'), stale = await manager.load('head.yaml');
      await first.addEntry('Committed first'); await manager.save(first);
      const current = await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8');
      await stale.addEntry('Pending second');
      const read = jest.spyOn(f.owners, 'readHeadSnapshot');
      await expect(manager.save(stale)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect(read).not.toHaveBeenCalled();
      expect(manager.getPendingHeadUpdate(stale)).toMatchObject({ status: 'refused', candidate: { name: 'Owned memory' } });
      expect(manager.getPendingHeadUpdate(stale)?.candidate?.content).toContain('Pending second');
      expect(await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8')).toBe(current);
    } finally { await f.cleanup(); }
  });
  it('isolates nested candidate mutations while serialization awaits and refuses overlapping saves', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const memory = await manager.load('head.yaml');
      [...memory.getEntries().values()][0].metadata = { nested: { value: 'original' } };
      let release!: () => void; manager.serializeGate = new Promise<void>(resolve => { release = resolve; });
      const saving = manager.save(memory);
      (memory.extensions!.nested as { value: string }).value = 'unsaved';
      const entry = [...memory.getEntries().values()][0]; (entry.metadata!.nested as { value: string }).value = 'unsaved';
      await expect(manager.save(memory)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      release(); await saving;
      expect((await f.owners.readHeadSnapshot('head.yaml')).content).not.toContain('unsaved');
      expect(manager.cached('head.yaml')?.extensions).toEqual({ nested: { value: 'original' } });
      expect(memory.extensions).toEqual({ nested: { value: 'unsaved' } });
    } finally { await f.cleanup(); }
  });
  it('releases busy state and replaces an earlier rejected candidate after validation failure', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const memory = await manager.load('head.yaml');
      manager.rejectValidation = true;
      await memory.addEntry('First failed candidate'); await expect(manager.save(memory)).rejects.toThrow('controlled');
      expect(manager.getPendingHeadUpdate(memory)?.candidate?.content).toContain('First failed candidate');
      await memory.addEntry('Second failed candidate'); await expect(manager.save(memory)).rejects.toThrow('controlled');
      expect(manager.getPendingHeadUpdate(memory)?.candidate?.content).toContain('Second failed candidate');
      manager.rejectValidation = false; await manager.save(memory);
      expect(manager.getPendingHeadUpdate(memory)).toBeUndefined();
    } finally { await f.cleanup(); }
  });
  it('refuses a tenant switch before dispatch without updating the head', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const memory = await manager.load('head.yaml');
      const before = await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8');
      const write = jest.spyOn(f.owners, 'updateOwnedHead');
      let release!: () => void; manager.serializeGate = new Promise<void>(resolve => { release = resolve; });
      const saving = manager.save(memory); f.setTenant('different-user'); release();
      await expect(saving).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect(write).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8')).toBe(before);
    } finally { await f.cleanup(); }
  });
  it('retains a genuine committed cleanup receipt even when its rejection cause is falsy', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const memory = await manager.load('head.yaml');
      const releaseTarget = f.fence as unknown as { release: (lease: unknown) => Promise<void> };
      const release = releaseTarget.release.bind(releaseTarget);
      const spy = jest.spyOn(releaseTarget, 'release').mockImplementation(async token => { await release(token); throw undefined; });
      try {
        await memory.addEntry('Actually committed');
        await expect(manager.save(memory)).rejects.toMatchObject({ committed: true });
        expect(manager.getPendingHeadUpdate(memory)).toMatchObject({ status: 'committed-publication-failed', committedToken: { revision: '2' } });
        expect(manager.cached('head.yaml')).toBeUndefined();
      } finally { spy.mockRestore(); }
      expect((await f.owners.readHeadSnapshot('head.yaml')).content).toContain('Actually committed');
    } finally { await f.cleanup(); }
  });
  it('keeps known commit authority when a publication callback fails and does not retry the old revision', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const memory = await manager.load('head.yaml');
      const cause = new Error('publication failure'); manager.publicationFailure = { cause };
      await expect(manager.save(memory)).rejects.toBe(cause);
      expect(manager.getPendingHeadUpdate(memory)).toMatchObject({ status: 'committed-publication-failed', committedToken: { revision: '2' }, cause });
      manager.publicationFailure = undefined; await manager.save(memory);
      expect((await f.owners.readHeadSnapshot('head.yaml')).token).toMatchObject({ revision: '3' });
    } finally { await f.cleanup(); }
  });
  it('refuses unbound creation, name repair and delete before legacy effects', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const memory = await manager.load('head.yaml');
      await expect(manager.create({ name: 'New' })).rejects.toThrow('UPDATE only');
      await expect(manager.delete('head.yaml')).rejects.toThrow('UPDATE only');
      memory.metadata.name = 'Owned memory.backup-2026-10-03-12-00-00-000';
      await expect(manager.save(memory)).rejects.toThrow('unchanged-name');
      const unbound = memory.createPersistenceCandidate(); unbound.metadata.name = 'Owned memory';
      await expect(manager.save(unbound, 'head.yaml')).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect((await f.owners.readHeadSnapshot('head.yaml')).token).toMatchObject({ revision: '1' });
    } finally { await f.cleanup(); }
  });
  it('refuses caller preconditions and a changed portfolio context without dispatch', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const memory = await manager.load('head.yaml');
      const write = jest.spyOn(f.owners, 'updateOwnedHead');
      for (const options of [{ expectedIdentity: 'caller' }, { expectedStorageRevision: '1' }, { expectedFileSnapshot: {} }]) {
        await expect(manager.save(memory, undefined, options as Parameters<MemoryManager['save']>[2])).rejects.toThrow('Caller preconditions');
      }
      Object.defineProperty(manager, 'memoriesDir', { configurable: true, get: () => path.join(f.root, 'different-root') });
      await expect(manager.save(memory)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect(write).not.toHaveBeenCalled();
      expect((await f.owners.readHeadSnapshot('head.yaml')).token).toMatchObject({ revision: '1' });
    } finally { await f.cleanup(); }
  });
  it('retains a genuine invalid-head refusal and permits corrected same-instance save', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const memory = await manager.load('head.yaml');
      const before = await f.owners.readHeadSnapshot('head.yaml');
      // Defer this candidate's validation to the actual file backend, not a mocked error.
      manager.backendValidationCandidate = 'metadata: [invalid YAML';
      let rejected: unknown;
      try { await manager.save(memory); } catch (cause) { rejected = cause; }
      expect(rejected).toMatchObject({ code: 'EINVALIDHEAD', message: 'Memory update YAML is invalid' });
      const pending = manager.getPendingHeadUpdate(memory);
      expect(pending?.status).toBe('refused');
      expect(pending?.cause).toBe(rejected);
      expect(pending?.candidate?.content).toBe(manager.backendValidationCandidate);
      expect(pending?.originalToken).toEqual(before.token);
      expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(before);
      manager.backendValidationCandidate = undefined;
      await memory.addEntry('Corrected candidate');
      await manager.save(memory);
      expect(manager.getPendingHeadUpdate(memory)).toBeUndefined();
      const committed = await f.owners.readHeadSnapshot('head.yaml');
      expect(committed.token).toMatchObject({ revision: '2' });
      expect(committed.content).toContain('Corrected candidate');
    } finally { await f.cleanup(); }
  });
  it('blocks an unknown write on the same instance without dispatching again', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const memory = await manager.load('head.yaml');
      const cause = new Error('unclassified backend outcome');
      const write = jest.spyOn(f.owners, 'updateOwnedHead').mockRejectedValue(cause);
      await expect(manager.save(memory)).rejects.toBe(cause);
      expect(manager.getPendingHeadUpdate(memory)?.status).toBe('unknown');
      await expect(manager.save(memory)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect(write).toHaveBeenCalledTimes(1);
    } finally { await f.cleanup(); }
  });
  it('retains committed authority when same-user root changes before publication', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const memory = await manager.load('head.yaml');
      const write = f.owners.updateOwnedHead.bind(f.owners);
      jest.spyOn(f.owners, 'updateOwnedHead').mockImplementation(async (token, content) => {
        const receipt = await write(token, content);
        Object.defineProperty(manager, 'memoriesDir', { configurable: true, get: () => path.join(f.root, 'different-root') });
        return receipt;
      });
      await expect(manager.save(memory)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect(manager.getPendingHeadUpdate(memory)).toMatchObject({ status: 'committed-publication-failed', committedToken: { revision: '2' } });
      expect(manager.cached('head.yaml')).toBeUndefined();
    } finally { await f.cleanup(); }
  });
  it('publishes committed entries without replaying a newly enabled on-load policy', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); let enabled = false;
      manager.setRetentionPolicyService({ shouldEnforceOnLoad: () => enabled, isEnabled: () => enabled });
      const memory = await manager.load('head.yaml');
      (memory.metadata as MemoryMetadata).retentionDays = 1;
      [...memory.getEntries().values()][0].timestamp = new Date('2000-01-01T00:00:00Z');
      let release!: () => void; manager.serializeGate = new Promise<void>(resolve => { release = resolve; });
      const saving = manager.save(memory); enabled = true; release(); await saving;
      expect((await f.owners.readHeadSnapshot('head.yaml')).content).toContain('Original entry');
      expect([...manager.cached('head.yaml')!.getEntries().values()].map(entry => entry.content)).toEqual(['Original entry']);
    } finally { await f.cleanup(); }
  });
  it('rejects a separate process UPDATE using the working instance original token', async () => {
    const f = await fixture();
    let child: ReturnType<typeof spawn> | undefined; let closed: Promise<void> | undefined;
    try {
      const { manager } = f.makeManager(); const memory = await manager.load('head.yaml');
      const worker = new URL('../../fixtures/memory-head-update-worker.ts', import.meta.url);
      child = spawn(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, worker.pathname, f.tenantRoot, USER], { stdio: ['ignore', 'pipe', 'pipe'] });
      let spawnFailure: Error | undefined;
      child.once('error', error => { spawnFailure = error; });
      let code: number | null = null, output = '', error = '';
      child.stdout!.on('data', chunk => { output = (output + String(chunk)).slice(0, 1024); });
      child.stderr!.on('data', chunk => { error = (error + String(chunk)).slice(0, 4096); });
      closed = new Promise<void>(resolve => child!.once('close', value => { code = value; resolve(); }));
      const guard = setTimeout(() => child!.kill('SIGKILL'), 5000);
      try { await closed; } finally { clearTimeout(guard); }
      expect(spawnFailure).toBeUndefined();
      expect({ code, output, error }).toEqual({ code: 0, output: 'CHILD_COMMITTED\n', error: '' });
      await memory.addEntry('Rejected stale append');
      await expect(manager.save(memory)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      const current = await f.owners.readHeadSnapshot('head.yaml');
      expect(current.content).toContain('External description'); expect(current.content).not.toContain('Rejected stale append');
      expect(manager.getPendingHeadUpdate(memory)?.candidate?.content).toContain('Rejected stale append');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (closed) await closed;
      await f.cleanup();
    }
  });
});
describe('pure working candidate snapshot', () => {
  it('does not replay opted-in load retention and isolates nested state', async () => {
    const metadata = new MetadataService(); let enabled = false;
    const memory = new Memory({ name: 'Retained', retentionDays: 1 }, metadata, undefined,
      { shouldEnforceOnLoad: () => enabled, isEnabled: () => enabled });
    const entry = await memory.addEntry('Old entry', [], { nested: { value: 'original' } });
    entry.metadata = { nested: { value: 'original' } };
    entry.timestamp = new Date('2000-01-01T00:00:00Z'); enabled = true;
    const clone = memory.createPersistenceCandidate();
    expect(clone.serialize()).toBe(memory.serialize());
    (entry.metadata!.nested as { value: string }).value = 'changed';
    expect(clone.serialize()).not.toContain('changed');
    expect(clone.getEntries().size).toBe(1);
  });
});
