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
import { MemorySearchIndex } from '../../../src/elements/memories/MemorySearchIndex.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { MEMORY_SECURITY_EVENTS } from '../../../src/elements/memories/constants.js';
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
import { MemorySaveHandler } from '../../../src/handlers/mcp-aql/MemorySaveHandler.js';
import type { HandlerRegistry } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import type { ExecutionContext } from '../../../src/security/encryption/ContextTracker.js';
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
async function fixture(seedMetadata: Partial<MemoryMetadata> = {}) {
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
    tags: ['original'], autoLoad: true, priority: 3, ...seedMetadata }, metadataService);
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
  it('publishes a normal runtime copy that indexes and audits subsequent cached appends', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const memory = await manager.load('head.yaml');
      await manager.save(memory);
      const cached = manager.cached('head.yaml')!;
      expect(cached).not.toBe(memory);
      expect(cached.serialize()).toBe(memory.serialize());
      const before = await f.owners.readHeadSnapshot('head.yaml');
      const index = jest.spyOn(MemorySearchIndex.prototype, 'addEntry');
      const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
      try {
        const entry = await cached.addEntry('Cached normal runtime append', ['runtime']);
        expect(index).toHaveBeenCalledWith(entry);
        expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: MEMORY_SECURITY_EVENTS.MEMORY_ADDED, source: 'Memory.addEntry' }));
        expect(await cached.search({ query: 'Cached normal runtime append' })).toContainEqual(entry);
        expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(before);
        expect(memory.getEntries().size).toBe(1);
      } finally { index.mockRestore(); audit.mockRestore(); }
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
async function externalOwnedUpdate(tenantRoot: string): Promise<void> {
  const worker = new URL('../../fixtures/memory-head-update-worker.ts', import.meta.url);
  const child = spawn(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, worker.pathname, tenantRoot, USER], { stdio: ['ignore', 'pipe', 'pipe'] });
  let code: number | null = null, output = '', error = '', spawnFailure: Error | undefined;
  child.once('error', cause => { spawnFailure = cause; });
  child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(0, 1024); });
  child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(0, 4096); });
  const closed = new Promise<void>(resolve => child.once('close', value => { code = value; resolve(); }));
  const guard = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await closed; expect(spawnFailure).toBeUndefined(); expect({ code, output, error }).toEqual({ code: 0, output: 'CHILD_COMMITTED\n', error: '' }); }
  finally { clearTimeout(guard); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
}

function guardedHandler(manager: MemoryManager) {
  let context: ExecutionContext = { type: 'test', timestamp: Date.now(), session: {
    userId: USER, sessionId: 'guarded-session', tenantId: null, transport: 'http', createdAt: Date.now(),
  } };
  const handler = new MemorySaveHandler({ memoryManager: manager } as unknown as HandlerRegistry,
    name => `legacy:${name}`, { getContext: () => context });
  const dispatch = (method: string, params: Record<string, unknown> = {}) => handler.dispatch(method, { element_name: 'Owned memory', ...params });
  return { handler, dispatch, setContext: (value: ExecutionContext) => { context = value; } };
}

posix('immediate guarded MCP-AQL mutations', () => {
  it('awaits real append and clear commits without legacy writers or debounce', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const { handler, dispatch } = guardedHandler(manager);
      const legacy = jest.spyOn(FileOperationsService.prototype, 'writeFile');
      const timer = jest.spyOn(globalThis, 'setTimeout');
      try {
        const result = await dispatch('addEntry', { content: 'Durable handler append', tags: ['handler'] });
        expect(result).toMatchObject({ id: expect.any(String), timestamp: expect.any(String), trustLevel: 'untrusted' });
        let snapshot = await f.owners.readHeadSnapshot('head.yaml');
        expect(snapshot.content).toContain('Durable handler append');
        expect(snapshot.content).toContain('Original instructions');
        expect(snapshot.content).toContain('Original description');
        expect(snapshot.content).toContain('nested:');
        expect(snapshot.token).toMatchObject({ revision: '2' });
        expect(handler.getPendingGuardedMutation('Owned memory')).toBeUndefined();
        await dispatch('clear');
        snapshot = await f.owners.readHeadSnapshot('head.yaml');
        expect(snapshot.content).not.toContain('Durable handler append');
        expect(snapshot.content).not.toContain('Original entry');
        expect(snapshot.content).toContain('Original instructions');
        expect(snapshot.token).toMatchObject({ revision: '3' });
        expect(legacy.mock.calls.every(([destination]) => destination.endsWith('_index.json'))).toBe(true);
        // Discovery/index publication may write _index.json; no legacy head write is allowed.
        // Backend fencing can schedule timers; guarded handler has no pending debounce.
        expect((handler as unknown as { pendingSaves: Map<string, unknown> }).pendingSaves.size).toBe(0);
        const count = timer.mock.calls.length;
        await handler.flushPendingSaves();
        expect(timer.mock.calls.length).toBe(count);
      } finally { legacy.mockRestore(); timer.mockRestore(); }
    } finally { await f.cleanup(); }
  });
  it.each(['addEntry', 'clear'])('emits no %s mutation audit before durable qualification', async method => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const { dispatch } = guardedHandler(manager);
      let reached!: () => void, release!: () => void;
      const atBarrier = new Promise<void>(resolve => { reached = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const original = manager.assertPersistable.bind(manager);
      const validation = jest.spyOn(manager, 'assertPersistable').mockImplementation(async memory => { reached(); await gate; return original(memory); });
      const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
      const pending = dispatch(method, { content: 'Held mutation' });
      try {
        await atBarrier;
        expect(audit.mock.calls.some(([event]) => event.type === MEMORY_SECURITY_EVENTS.MEMORY_ADDED || event.type === MEMORY_SECURITY_EVENTS.MEMORY_CLEARED)).toBe(false);
        expect((await f.owners.readHeadSnapshot('head.yaml')).token).toMatchObject({ revision: '1' });
      } finally { release(); await pending; validation.mockRestore(); audit.mockRestore(); }
      expect((await f.owners.readHeadSnapshot('head.yaml')).token).toMatchObject({ revision: '2' });
    } finally { await f.cleanup(); }
  });
  it('publishes policy-removal audit only with a genuine durable eviction', async () => {
    const f = await fixture({ maxEntries: 1, onFull: 'evict_oldest' });
    try {
      const { manager } = f.makeManager(); const { dispatch } = guardedHandler(manager);
      const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
      try {
        const response = await dispatch('addEntry', { content: 'Durable evicting append' });
        expect(response).toMatchObject({ warning: expect.any(String) });
        expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: MEMORY_SECURITY_EVENTS.RETENTION_POLICY_ENFORCED,
          source: 'MemorySaveHandler.guardedMutation', details: 'Durably removed 1 entries by retention or onFull policy' }));
        const snapshot = await f.owners.readHeadSnapshot('head.yaml');
        expect(snapshot.content).toContain('Durable evicting append'); expect(snapshot.content).not.toContain('Original entry');
      } finally { audit.mockRestore(); }
    } finally { await f.cleanup(); }
  });
  it.each(['addEntry', 'clear'])('refuses stale %s after actual separate-process interference and retains evidence', async method => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const { handler, dispatch } = guardedHandler(manager);
      let reached!: () => void, release!: () => void;
      const atBarrier = new Promise<void>(resolve => { reached = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const original = manager.assertPersistable.bind(manager);
      const validation = jest.spyOn(manager, 'assertPersistable').mockImplementation(async candidate => { reached(); await gate; return original(candidate); });
      const saving = dispatch(method, { content: 'Stale handler append' });
      const rejected = expect(saving).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      try { await atBarrier; await externalOwnedUpdate(f.tenantRoot); }
      finally { release(); await rejected; validation.mockRestore(); }
      const operation = handler.getPendingGuardedMutation('Owned memory');
      expect(operation?.status).toBe('refused');
      expect(operation?.candidate).toBeDefined();
      expect(manager.getPendingHeadUpdate(operation!.candidate!)?.candidate?.content).toBeDefined();
      const snapshot = await f.owners.readHeadSnapshot('head.yaml');
      expect(snapshot.content).toContain('External description'); expect(snapshot.content).toContain('Original entry');
      expect(snapshot.content).not.toContain('Stale handler append');
      const write = jest.spyOn(f.owners, 'updateOwnedHead');
      await handler.flushPendingSaves(); handler.cleanupSession('guarded-session');
      await expect(dispatch('clear')).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect(write).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
  it('refuses a same-mtime rename-to-duplicate rather than trusting indexed metadata', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager();
      const content = (await f.owners.readHeadSnapshot('head.yaml')).content;
      const duplicate = path.join(f.tenantRoot, 'same-mtime.yaml');
      const fixed = new Date('2020-01-01T00:00:00Z');
      await fs.writeFile(duplicate, content.replace('Owned memory', 'Other memory'));
      await fs.utimes(duplicate, fixed, fixed);
      await manager.loadGuardedMemoryByName('Owned memory', USER);
      const before = await fs.stat(duplicate);
      await fs.writeFile(duplicate, content); await fs.utimes(duplicate, fixed, fixed);
      expect((await fs.stat(duplicate)).mtimeMs).toBe(before.mtimeMs);
      await expect(manager.loadGuardedMemoryByName('Owned memory', USER)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect((await f.owners.readHeadSnapshot('head.yaml')).token).toMatchObject({ revision: '1' });
    } finally { await f.cleanup(); }
  });
  it('rejects actual duplicate-name inventory and never retokenizes cached content', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const loaded = await manager.load('head.yaml');
      await manager.save(loaded); const cached = manager.cached('head.yaml');
      await externalOwnedUpdate(f.tenantRoot);
      const fresh = await manager.loadGuardedMemoryByName('Owned memory', USER);
      expect(fresh).not.toBe(cached); expect(fresh.metadata.description).toBe('External description');
      expect(cached?.metadata.description).toBe('Original description');
      await fs.copyFile(path.join(f.tenantRoot, 'head.yaml'), path.join(f.tenantRoot, 'duplicate.yaml'));
      await expect(manager.loadGuardedMemoryByName('Owned memory', USER)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    } finally { await f.cleanup(); }
  });
  it('claims the case-collision slot before lookup and releases preparation failures', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const { handler, dispatch } = guardedHandler(manager);
      let reached!: () => void, release!: () => void;
      const atBarrier = new Promise<void>(resolve => { reached = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const original = manager.loadGuardedMemoryByName.bind(manager);
      const lookup = jest.spyOn(manager, 'loadGuardedMemoryByName').mockImplementation(async (...args) => { reached(); await gate; return original(...args); });
      const first = dispatch('addEntry', { content: 'First claimed request' });
      try {
        await atBarrier;
        await expect(handler.dispatch('clear', { element_name: 'owned MEMORY' })).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
        expect(lookup).toHaveBeenCalledTimes(1);
      } finally { release(); await first; lookup.mockRestore(); }
      await expect(handler.dispatch('addEntry', { element_name: 'Missing', content: 'No target' })).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect(handler.getPendingGuardedMutation('Missing')).toBeUndefined();
      await expect(dispatch('addEntry', { content: '' })).rejects.toThrow();
      expect(handler.getPendingGuardedMutation('Owned memory')).toBeUndefined();
      await dispatch('addEntry', { content: 'Next accepted request' });
    } finally { await f.cleanup(); }
  });
  it('keeps candidate and source authority independent under both CAS orders', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const source = await manager.load('head.yaml');
      const candidate = manager.deriveGuardedMutation(source);
      await candidate.addEntry('Candidate winner'); await manager.save(candidate);
      expect(source.getEntries().size).toBe(1);
      await source.addEntry('Stale source edit');
      await expect(manager.save(source)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      const fresh = await manager.load('head.yaml');
      const stale = manager.deriveGuardedMutation(fresh);
      await stale.addEntry('Losing candidate');
      await fresh.addEntry('Source winner'); await manager.save(fresh);
      await expect(manager.save(stale)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      const actual = await f.owners.readHeadSnapshot('head.yaml');
      expect(actual.content).toContain('Candidate winner'); expect(actual.content).toContain('Source winner');
      expect(actual.content).not.toContain('Stale source edit'); expect(actual.content).not.toContain('Losing candidate');
    } finally { await f.cleanup(); }
  });
  it('blocks source and prederived siblings after unknown without clearing lineage on late success', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const source = await manager.load('head.yaml');
      const unknown = manager.deriveGuardedMutation(source), late = manager.deriveGuardedMutation(source), blocked = manager.deriveGuardedMutation(source);
      const original = f.owners.updateOwnedHead.bind(f.owners);
      let reached!: () => void, release!: () => void;
      const atBarrier = new Promise<void>(resolve => { reached = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      let call = 0;
      const cause = new Error('Unknown backend transport');
      const write = jest.spyOn(f.owners, 'updateOwnedHead').mockImplementation(async (...args) => {
        if (++call === 1) { reached(); await gate; return original(...args); }
        throw cause;
      });
      const settling = manager.save(late);
      try {
        await atBarrier;
        await expect(manager.save(unknown)).rejects.toBe(cause);
        expect(() => manager.deriveGuardedMutation(source)).toThrow('Cannot derive');
        await expect(manager.save(blocked)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      } finally { release(); await settling; }
      await expect(manager.save(late)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      await expect(manager.save(source)).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect(write).toHaveBeenCalledTimes(2); write.mockRestore();
      await manager.save(await manager.load('head.yaml'));
    } finally { await f.cleanup(); }
  });
  it('retains unknown and known-committed audit outcomes without shutdown replay', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const { handler, dispatch } = guardedHandler(manager);
      const failure = new Error('Audit after real commit');
      const originalAudit = SecurityMonitor.logSecurityEvent;
      const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(event => {
        if (event.source === 'MemorySaveHandler.guardedMutation') throw failure;
        return originalAudit.call(SecurityMonitor, event);
      });
      try { await expect(dispatch('addEntry', { content: 'Committed despite audit' })).rejects.toBe(failure); }
      finally { audit.mockRestore(); }
      expect(handler.getPendingGuardedMutation('Owned memory')).toMatchObject({ status: 'known-committed', cause: failure });
      const before = await f.owners.readHeadSnapshot('head.yaml');
      expect(before.content).toContain('Committed despite audit');
      const write = jest.spyOn(f.owners, 'updateOwnedHead');
      await handler.flushPendingSaves(); await handler.dispose();
      await expect(dispatch('clear')).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect(write).not.toHaveBeenCalled(); expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(before);
      const other = guardedHandler(manager); const unknown = new Error('Unknown transport');
      write.mockRejectedValueOnce(unknown);
      await expect(other.dispatch('clear')).rejects.toBe(unknown);
      expect(other.handler.getPendingGuardedMutation('Owned memory')).toMatchObject({ status: 'unknown', cause: unknown });
      const calls = write.mock.calls.length; await other.handler.flushPendingSaves();
      await expect(other.dispatch('addEntry', { content: 'Do not replay' })).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      expect(write.mock.calls.length).toBe(calls);
    } finally { await f.cleanup(); }
  });
  it('refuses missing or changed session context without mixing retained tenant evidence', async () => {
    const f = await fixture();
    try {
      const { manager } = f.makeManager(); const noContext = new MemorySaveHandler({ memoryManager: manager } as unknown as HandlerRegistry, name => name);
      await expect(noContext.dispatch('clear', { element_name: 'Owned memory' })).rejects.toThrow('authenticated session');
      const scoped = guardedHandler(manager);
      const cause = new Error('Unknown original tenant');
      jest.spyOn(f.owners, 'updateOwnedHead').mockRejectedValueOnce(cause);
      await expect(scoped.dispatch('clear')).rejects.toBe(cause);
      scoped.setContext({ type: 'test', timestamp: 1, session: { userId: 'other-user', sessionId: 'guarded-session', tenantId: null, transport: 'http', createdAt: 1 } });
      expect(scoped.handler.getPendingGuardedMutation('Owned memory')).toBeUndefined();
      await expect(scoped.dispatch('clear')).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
      scoped.setContext({ type: 'test', timestamp: 1, session: { userId: USER, sessionId: 'guarded-session', tenantId: null, transport: 'http', createdAt: 1 } });
      expect(scoped.handler.getPendingGuardedMutation('Owned memory')?.cause).toBe(cause);
    } finally { await f.cleanup(); }
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
