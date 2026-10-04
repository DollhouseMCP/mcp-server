import { ManagerBackedPortfolioElementStore, type ManagerBackedPortfolioManagers } from '../../../src/web-console/stores/ManagerBackedPortfolioElementStore.js';
import { PortfolioElementVersionConflictError } from '../../../src/web-console/stores/IPortfolioElementStore.js';
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
import { ContextTracker, type ExecutionContext } from '../../../src/security/encryption/ContextTracker.js';
import { createUserIdResolver } from '../../../src/database/UserContext.js';
import { SessionActivationRegistry } from '../../../src/state/SessionActivationState.js';
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
async function fixture(seedMetadata: Partial<MemoryMetadata> = {}, tenantResolver?: () => string, expired = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-central-owned-'));
  const metadataService = new MetadataService();
  const lock = new FileLockManager();
  const files = new FileOperationsService(lock);
  let tenant = USER;
  const currentTenant = () => tenantResolver ? tenantResolver() : tenant;
  const deps: ElementManagerDeps = { portfolioManager: new PortfolioManager(files, { baseDir: root }),
    fileLockManager: lock, fileOperationsService: files, serializationService: new SerializationService(),
    metadataService, validationRegistry: new ValidationRegistry(new ValidationService(), new TriggerValidationService(), metadataService),
    eventDispatcher: new ElementEventDispatcher(), storageLayerFactory: createTestStorageFactory(), getCurrentUserId: currentTenant };
  const managers: MemoryManager[] = [];
  const ordinary = new MemoryManager(deps); managers.push(ordinary);
  const memory = new Memory({ name: 'Owned memory', description: 'Original description', retentionDays: 36500,
    tags: ['original'], autoLoad: true, priority: 3, ...seedMetadata }, metadataService);
  memory.instructions = 'Original instructions';
  memory.extensions = { nested: { value: 'original' } };
  const seededEntry = await memory.addEntry('Original entry', ['original'], { nested: { value: 'original' } });
  if (expired) seededEntry.expiresAt = new Date('2000-01-01T00:00:00Z');
  try {
    await ordinary.save(memory, 'head.yaml');
    const tenantRoot = await fs.realpath(path.join(root, 'memories'));
    const fence = new FileMemoryFence();
    const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot, getCurrentUserId: currentTenant, fence });
    const owners = new FileMemoryOwnerSnapshots({ coordinator });
    const unowned = await owners.readHeadSnapshot('head.yaml');
    if (unowned.token.ownership !== 'unowned') throw new Error('Expected genuine unowned fixture');
    await owners.adoptUnowned(unowned.token);
    const makeManager = (store = owners) => {
      const adapter = new MemoryHeadUpdateAdapter({ backend: 'file', store }, currentTenant);
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
  it('pins real stdio effective identity separately from the raw session and retains switched-owner evidence', async () => {
    const tracker = new ContextTracker();
    const registry = new SessionActivationRegistry('stdio-guarded');
    const session: ExecutionContext = { type: 'test', timestamp: Date.now(), session: {
      userId: 'local-user', sessionId: 'stdio-guarded', tenantId: null, transport: 'stdio', createdAt: Date.now(),
    } };
    const state = registry.getOrCreate('stdio-guarded'); state.dbUserId = USER;
    const resolver = createUserIdResolver(tracker, registry);
    await tracker.runAsync(session, async () => {
      const f = await fixture({}, resolver);
      try {
        const { manager } = f.makeManager();
        const handler = new MemorySaveHandler({ memoryManager: manager } as unknown as HandlerRegistry,
          name => `legacy:${name}`, tracker);
        const dispatch = (method: string, content?: string) => handler.dispatch(method, { element_name: 'Owned memory', content });
        expect(tracker.getSessionContext()?.userId).toBe('local-user'); expect(resolver()).toBe(USER);
        await dispatch('addEntry', 'Effective owner append'); await dispatch('clear');
        const committed = (await f.owners.readHeadSnapshot('head.yaml')).content;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const original = manager.save.bind(manager);
        const barrier = jest.spyOn(manager, 'save').mockImplementation((...args) => {
          manager.serializeGate = gate;
          const saving = original(...args);
          state.dbUserId = '22222222-2222-4222-8222-222222222222'; release();
          return saving;
        });
        try { await expect(dispatch('addEntry', 'Retained original owner')).rejects.toMatchObject({ code: 'EHEADCONFLICT' }); }
        finally { barrier.mockRestore(); manager.serializeGate = undefined; }
        expect(handler.getPendingGuardedMutation('Owned memory')).toBeUndefined();
        state.dbUserId = USER;
        const retained = handler.getPendingGuardedMutation('Owned memory');
        expect(retained?.status).toBe('refused');
        expect([...retained!.candidate!.getEntries().values()].map(entry => entry.content)).toContain('Retained original owner');
        await expect(dispatch('clear')).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
        await handler.flushPendingSaves();
        expect((await f.owners.readHeadSnapshot('head.yaml')).content).toBe(committed);
        expect(handler.getPendingGuardedMutation('Owned memory')).toBe(retained);
      } finally { state.dbUserId = USER; await f.cleanup(); }
    });
  });

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
        expect(timer.mock.calls).toHaveLength(count);
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
  it.each(['addEntry', 'clear'])('mutates the exact discovered root locator for %s despite a system basename shadow', async method => {
    const f = await fixture();
    try {
      const original = await f.owners.readHeadSnapshot('head.yaml');
      const shadowPath = path.join(f.tenantRoot, 'system', 'head.yaml');
      await fs.mkdir(path.dirname(shadowPath), { recursive: true });
      await fs.writeFile(shadowPath, original.content.replace('Owned memory', 'System shadow'));
      const unowned = await f.owners.readHeadSnapshot('system/head.yaml');
      if (unowned.token.ownership !== 'unowned') throw new Error('Expected genuine unowned shadow');
      await f.owners.adoptUnowned(unowned.token);
      const shadowBefore = await f.owners.readHeadSnapshot('system/head.yaml');
      const { manager } = f.makeManager();
      // Public basename loading deliberately retains the existing system-first precedence.
      expect((await manager.load('head.yaml')).metadata.name).toBe('System shadow');
      const { dispatch } = guardedHandler(manager);
      await dispatch(method, { content: 'Exact root append' });
      const rootAfter = await f.owners.readHeadSnapshot('head.yaml');
      expect(rootAfter.token).toMatchObject({ revision: '2', locator: 'head.yaml' });
      if (method === 'addEntry') {
        expect(rootAfter.content).toContain('Exact root append');
        expect(rootAfter.content).toContain('Original entry');
      } else {
        expect(rootAfter.content).not.toContain('Original entry');
      }
      const shadowAfter = await f.owners.readHeadSnapshot('system/head.yaml');
      expect(shadowAfter.content).toBe(shadowBefore.content);
      expect(shadowAfter.token).toEqual(shadowBefore.token);
    } finally { await f.cleanup(); }
  });
  it('preserves public guarded on-load behavior while named mutation hydration stays quiet', async () => {
    const f = await fixture({}, undefined, true);
    try {
      const { manager } = f.makeManager();
      manager.setRetentionPolicyService({ shouldEnforceOnLoad: () => true, isEnabled: () => true });
      const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
      try {
        const loaded = await manager.load('head.yaml');
        expect(loaded.getEntries().size).toBe(0);
        expect(audit.mock.calls.filter(([event]) => event.type === MEMORY_SECURITY_EVENTS.RETENTION_POLICY_ENFORCED)).toHaveLength(1);
        audit.mockClear();
        const mutationSource = await manager.loadGuardedMemoryByName('Owned memory', USER);
        expect(mutationSource.getEntries().size).toBe(1);
        expect(mutationSource.getPolicyRemovedCount()).toBe(0);
        expect(audit.mock.calls.filter(([event]) => event.type === MEMORY_SECURITY_EVENTS.RETENTION_POLICY_ENFORCED)).toHaveLength(0);
        expect((await f.owners.readHeadSnapshot('head.yaml')).content).toContain('Original entry');
      } finally { audit.mockRestore(); }
    } finally { await f.cleanup(); }
  });
  it('commits below-capacity append when optional load-policy probe throws without fabricated removals', async () => {
    const f = await fixture({}, undefined, true);
    try {
      const { manager } = f.makeManager();
      const failure = new Error('Disposed optional retention service');
      manager.setRetentionPolicyService({ shouldEnforceOnLoad: () => { throw failure; }, isEnabled: () => true });
      const { dispatch } = guardedHandler(manager);
      const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
      try {
        const response = await dispatch('addEntry', { content: 'Safe fallback append' });
        expect(response).not.toHaveProperty('warning');
        const snapshot = await f.owners.readHeadSnapshot('head.yaml');
        expect(snapshot.content).toContain('Original entry');
        expect(snapshot.content).toContain('Safe fallback append');
        expect(snapshot.token).toMatchObject({ revision: '2' });
        expect(audit.mock.calls.filter(([event]) => event.type === MEMORY_SECURITY_EVENTS.RETENTION_POLICY_ENFORCED)).toHaveLength(0);
      } finally { audit.mockRestore(); }
    } finally { await f.cleanup(); }
  });
  it.each(['success', 'conflict', 'clear'])('keeps on-load retention quiet until guarded %s commits', async outcome => {
    const f = await fixture({}, undefined, true);
    try {
      const { manager } = f.makeManager();
      manager.setRetentionPolicyService({ shouldEnforceOnLoad: () => true, isEnabled: () => true });
      const { handler, dispatch } = guardedHandler(manager);
      let source: Memory | undefined;
      const derive = manager.deriveGuardedMutation.bind(manager);
      jest.spyOn(manager, 'deriveGuardedMutation').mockImplementation(memory => { source = memory; return derive(memory); });
      const before = await f.owners.readHeadSnapshot('head.yaml');
      const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
      const validate = manager.assertPersistable.bind(manager);
      jest.spyOn(manager, 'assertPersistable').mockImplementation(async candidate => {
        expect(source!.getEntries().size).toBe(1);
        expect(source!.getPolicyRemovedCount()).toBe(0);
        expect(audit.mock.calls.filter(([event]) => event.type === MEMORY_SECURITY_EVENTS.RETENTION_POLICY_ENFORCED)).toHaveLength(0);
        expect((await f.owners.readHeadSnapshot('head.yaml')).content).toBe(before.content);
        if (outcome === 'conflict') await externalOwnedUpdate(f.tenantRoot);
        return validate(candidate);
      });
      try {
        if (outcome === 'conflict') {
          await expect(dispatch('addEntry', { content: 'Quiet candidate append' })).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
          expect(handler.getPendingGuardedMutation('Owned memory')?.candidate?.getEntries().size).toBe(1);
          const current = await f.owners.readHeadSnapshot('head.yaml');
          expect(current.content).toContain('Original entry');
          expect(current.content).not.toContain('Quiet candidate append');
          expect(audit.mock.calls.filter(([event]) => event.type === MEMORY_SECURITY_EVENTS.RETENTION_POLICY_ENFORCED)).toHaveLength(0);
        } else {
          const response = await dispatch(outcome === 'clear' ? 'clear' : 'addEntry', { content: 'Quiet candidate append' });
          const current = await f.owners.readHeadSnapshot('head.yaml');
          expect(current.content).not.toContain('Original entry');
          expect(source!.getEntries().size).toBe(1);
          if (outcome === 'success') {
            expect(response).toMatchObject({ warning: expect.stringContaining('1 existing entry was removed') });
            expect(current.content).toContain('Quiet candidate append');
            expect(audit.mock.calls.filter(([event]) => event.type === MEMORY_SECURITY_EVENTS.RETENTION_POLICY_ENFORCED)).toHaveLength(1);
          } else {
            expect(audit.mock.calls.filter(([event]) => event.type === MEMORY_SECURITY_EVENTS.RETENTION_POLICY_ENFORCED)).toHaveLength(0);
            expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: MEMORY_SECURITY_EVENTS.MEMORY_CLEARED, details: 'Durably cleared all 1 memory entries' }));
          }
        }
      } finally { audit.mockRestore(); }
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
      await expect(dispatch('unsupported', {})).rejects.toThrow('Unknown Memory method: unsupported');
      expect(handler.getPendingGuardedMutation('Owned memory')).toBeUndefined();
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
      expect(write.mock.calls).toHaveLength(calls);
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
      f.setTenant('other-user');
      scoped.setContext({ type: 'test', timestamp: 1, session: { userId: 'other-user', sessionId: 'guarded-session', tenantId: null, transport: 'http', createdAt: 1 } });
      expect(scoped.handler.getPendingGuardedMutation('Owned memory')).toBeUndefined();
      await expect(scoped.dispatch('clear')).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
      f.setTenant(USER);
      scoped.setContext({ type: 'test', timestamp: 1, session: { userId: USER, sessionId: 'guarded-session', tenantId: null, transport: 'http', createdAt: 1 } });
      expect(scoped.handler.getPendingGuardedMutation('Owned memory')?.cause).toBe(cause);
    } finally { await f.cleanup(); }
  });
});

describe('pure working candidate snapshot', () => {
  it.each([true, false])('preserves legacy load policy and quiet candidate policy when on_load=%s', async onLoad => {
    const metadata = new MetadataService();
    const policy = { shouldEnforceOnLoad: () => onLoad, isEnabled: () => true };
    const original = new Memory({ name: 'Policy' }, metadata);
    const entry = await original.addEntry('Expired'); entry.expiresAt = new Date('2000-01-01T00:00:00Z');
    const quiet = new Memory({ name: 'Policy' }, metadata, undefined, policy);
    quiet.deserialize(original.serialize(), { suppressLoadPolicy: true });
    expect(quiet.getEntries().size).toBe(1);
    const candidate = quiet.createPersistenceCandidate();
    await candidate.enforceCandidateLoadRetention();
    expect(candidate.getEntries().size).toBe(onLoad ? 0 : 1);
    expect(quiet.getEntries().size).toBe(1);
    const legacy = new Memory({ name: 'Policy' }, metadata, undefined, policy);
    legacy.deserialize(original.serialize());
    expect(legacy.getEntries().size).toBe(onLoad ? 0 : 1);
  });
  it('does not swallow candidate guard or actual enforcement failures', async () => {
    const metadata = new MetadataService();
    const memory = new Memory({ name: 'Policy' }, metadata, undefined,
      { shouldEnforceOnLoad: () => true, isEnabled: () => true });
    await expect(memory.enforceCandidateLoadRetention()).rejects.toThrow('requires a persistence candidate');
    const candidate = memory.createPersistenceCandidate();
    const failure = new Error('Actual retention mutation failed');
    jest.spyOn(candidate, 'enforceRetentionPolicy').mockRejectedValue(failure);
    await expect(candidate.enforceCandidateLoadRetention()).rejects.toBe(failure);
  });
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

function consoleStore(manager: MemoryManager, currentUser = () => USER): ManagerBackedPortfolioElementStore {
  return new ManagerBackedPortfolioElementStore({getCurrentUserId: currentUser,
    managers: {memories: manager} as unknown as ManagerBackedPortfolioManagers});
}

posix('guarded console existing-owner UPDATE', () => {
  it('updates through same-read ETag and preserves complete state with coherent runtime config', async () => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const before = await store.findByName(USER, 'memories', 'owned-memory');
      const originalEntryMetadata = [...(await manager.load('head.yaml')).getEntries().values()][0].metadata;
      const imported = jest.spyOn(manager, 'importElement');
      const result = await store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory',
        expectedVersion: 1, expectedContentHash: before!.contentHash, now: new Date(),
        metadata: {description: 'Console change', maxEntries: 7, retentionDays: 9, priority: 8, onFull: 'error'}, tags: []});
      expect(imported).not.toHaveBeenCalled();
      expect(result!.metadata.description).toBe('Console change');
      expect(result!.tags).toEqual([]);
      expect(result!.content).toContain('Original instructions');
      const loaded = await manager.load('head.yaml');
      expect(loaded.extensions).toEqual({nested: {value: 'original'}});
      expect(loaded.instructions).toBe('Original instructions');
      expect((loaded.metadata as MemoryMetadata).retentionDays).toBe(9);
      for (let i = loaded.getEntries().size; i < 7; i++) await loaded.addEntry(`Capacity entry ${i}`);
      await expect(loaded.addEntry('Eighth entry')).rejects.toThrow('full');
      expect([...loaded.getEntries().values()].find(entry => entry.content === 'Original entry')!.metadata).toEqual(originalEntryMetadata);
      expect(result!.metadata.unique_id).toBe(before!.metadata.unique_id);
      expect((await store.findByName(USER, 'memories', 'owned-memory'))!.contentHash).toBe(result!.contentHash);
    } finally {await f.cleanup();}
  });

  it('makes no write for missing targets and failed ETags, then permits a corrected request', async () => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const write = jest.spyOn(f.owners, 'updateOwnedHead');
      const input = {userId: USER, type: 'memories' as const, canonicalName: 'missing', expectedVersion: 1, now: new Date()};
      expect(await store.update(input)).toBeNull();
      await expect(store.update({...input, canonicalName: 'owned-memory', expectedContentHash: 'wrong'})).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
      expect(write).not.toHaveBeenCalled();
      expect(store.getPendingGuardedUpdate(USER, 'owned-memory')).toBeUndefined();
      const before = await store.findByName(USER, 'memories', 'owned-memory');
      await expect(store.update({...input, canonicalName: 'owned-memory', expectedContentHash: before!.contentHash,
        metadata: {description: 'Accepted'}})).resolves.not.toBeNull();
    } finally {await f.cleanup();}
  });

  it('retains a real competing-process conflict and blocks replay through another spelling', async () => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const before = await store.findByName(USER, 'memories', 'owned-memory');
      const save = manager.save.bind(manager);
      const saving = jest.spyOn(manager, 'save').mockImplementation(async (memory, locator, options) => {
        await externalOwnedUpdate(f.tenantRoot);
        await save(memory, locator, options);
      });
      await expect(store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1,
        expectedContentHash: before!.contentHash, now: new Date(), metadata: {description: 'Attempted console'}})).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
      const pending = store.getPendingGuardedUpdate(USER, 'owned-memory')!;
      expect(pending.status).toBe('refused'); expect(pending.manager).toBe(manager);
      expect(manager.getPendingHeadUpdate(pending.candidate!)?.candidate?.content).toContain('Attempted console');
      const winner = await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8');
      await expect(store.update({userId: USER, type: 'memories', canonicalName: 'Owned memory', expectedVersion: 1,
        now: new Date(), metadata: {description: 'Replay'}})).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
      expect(saving).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8')).toBe(winner);
    } finally {await f.cleanup();}
  });

  it('retains known commit publication failures and refuses lifecycle mutations before legacy methods', async () => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const failure = new Error('Publication failed'); manager.publicationFailure = {cause: failure};
      await expect(store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1,
        now: new Date(), metadata: {description: 'Durable console'}})).rejects.toBe(failure);
      const pending = store.getPendingGuardedUpdate(USER, 'owned-memory')!;
      expect(pending.status).toBe('committed-publication-failed'); expect(pending.cause).toBe(failure);
      expect((await f.owners.readHeadSnapshot('head.yaml')).content).toContain('Durable console');
      const imported = jest.spyOn(manager, 'importElement'); const removed = jest.spyOn(manager, 'delete');
      await expect(store.create({userId: USER, type: 'memories', name: 'New', displayName: null, content: '',
        metadata: {}, tags: [], now: new Date()})).rejects.toThrow('CREATE');
      await expect(store.delete({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1, now: new Date()})).rejects.toThrow('DELETE');
      expect(imported).not.toHaveBeenCalled(); expect(removed).not.toHaveBeenCalled();
    } finally {await f.cleanup();}
  });
  it('freshly refuses canonical duplicate names without any write', async () => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const raw = await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8');
      await fs.writeFile(path.join(f.tenantRoot, 'duplicate.yaml'), raw.replace('name: Owned memory', 'name: owned-memory'));
      const save = jest.spyOn(manager, 'save');
      await expect(store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1, now: new Date()})).rejects.toMatchObject({code: 'EHEADCONFLICT'});
      expect(save).not.toHaveBeenCalled(); expect(store.getPendingGuardedUpdate(USER, 'owned-memory')).toBeUndefined();
    } finally {await f.cleanup();}
  });

  it('releases invalid preparation but retains an unknown attempt without automatic replay', async () => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const input = {userId: USER, type: 'memories' as const, canonicalName: 'owned-memory', expectedVersion: 1, now: new Date()};
      await expect(store.update({...input, content: 'Not a complete memory document'})).rejects.toThrow('YAML content must parse to an object');
      expect(store.getPendingGuardedUpdate(USER, 'owned-memory')).toBeUndefined();
      const cause = new Error('Unknown transport outcome');
      const write = jest.spyOn(f.owners, 'updateOwnedHead').mockRejectedValue(cause);
      await expect(store.update({...input, metadata: {description: 'Unknown attempt'}})).rejects.toBe(cause);
      const pending = store.getPendingGuardedUpdate(USER, 'owned-memory')!;
      expect(pending.status).toBe('unknown'); expect(pending.cause).toBe(cause);
      expect(manager.getPendingHeadUpdate(pending.candidate!)?.candidate?.content).toContain('Unknown attempt');
      await expect(store.update(input)).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {await f.cleanup();}
  });

  it('refuses captured tenant drift before dispatch and does not return old-tenant GET data', async () => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const actual = manager.validate.bind(manager);
      const validation = jest.spyOn(manager, 'validate').mockImplementation(memory => {
        f.setTenant('22222222-2222-4222-8222-222222222222'); return actual(memory);
      });
      const write = jest.spyOn(f.owners, 'updateOwnedHead');
      await expect(store.findByName(USER, 'memories', 'owned-memory')).rejects.toMatchObject({code: 'EHEADCONFLICT'});
      f.setTenant(USER);
      await expect(store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1,
        now: new Date(), metadata: {description: 'Not dispatched'}})).rejects.toMatchObject({code: 'EHEADCONFLICT'});
      expect(write).not.toHaveBeenCalled(); validation.mockRestore(); f.setTenant(USER);
      expect(store.getPendingGuardedUpdate(USER, 'owned-memory')).toBeUndefined();
    } finally {await f.cleanup();}
  });

  it('returns its own committed response instead of rereading a subsequent writer', async () => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const save = manager.save.bind(manager);
      jest.spyOn(manager, 'save').mockImplementation(async (memory, locator, options) => {
        await save(memory, locator, options); await externalOwnedUpdate(f.tenantRoot);
      });
      const response = await store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1,
        now: new Date(), metadata: {description: 'Original description'}});
      expect(response!.metadata.description).toBe('Original description');
      const current = await store.findByName(USER, 'memories', 'owned-memory');
      expect(current!.metadata.description).toBe('External description');
      expect(current!.contentHash).not.toBe(response!.contentHash);
    } finally {await f.cleanup();}
  });

  it('edits structured content and then explicitly empties entries without losing omitted auxiliary state', async () => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const input = {userId: USER, type: 'memories' as const, canonicalName: 'owned-memory', expectedVersion: 1, now: new Date()};
      await store.update({...input, content: 'entries:\n  - id: edited\n    content: Edited entry\n    timestamp: "2026-01-01T00:00:00.000Z"\n    metadata:\n      nested:\n        value: preserved\n'});
      const loaded = await manager.load('head.yaml');
      expect([...loaded.getEntries().values()][0].metadata).toEqual({nested: {value: 'preserved'}});
      expect(loaded.instructions).toBe('Original instructions');
      expect(loaded.extensions).toEqual({nested: {value: 'original'}});
      await store.update({...input, content: 'entries: []'});
      const empty = await manager.load('head.yaml');
      expect(empty.getEntries().size).toBe(0); expect(empty.instructions).toBe('Original instructions');
      expect(empty.extensions).toEqual({nested: {value: 'original'}});
    } finally {await f.cleanup();}
  });

  it('uses the discovered exact root locator despite a different logical name at system/head.yaml', async () => {
    const f = await fixture();
    try {
      const raw = await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8');
      const shadow = raw.replace('name: Owned memory', 'name: Different system memory');
      await fs.mkdir(path.join(f.tenantRoot, 'system')); await fs.writeFile(path.join(f.tenantRoot, 'system', 'head.yaml'), shadow);
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      await store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1,
        now: new Date(), content: 'entries: []'});
      expect((await f.owners.readHeadSnapshot('head.yaml')).content).toContain('entries: []');
      expect(await fs.readFile(path.join(f.tenantRoot, 'system', 'head.yaml'), 'utf8')).toBe(shadow);
    } finally {await f.cleanup();}
  });

});
