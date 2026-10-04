import { createHash, randomUUID } from 'node:crypto';
import { PortfolioService } from '../../../src/web-console/modules/portfolio/PortfolioService.js';
import type { ConsoleRequest } from '../../../src/web-console/platform/ConsolePlatformTypes.js';
import { InMemoryUserIntegrationStore } from '../../../src/web-console/stores/InMemoryUserIntegrationStore.js';
import { InMemoryPortfolioSyncJobStore } from '../../../src/web-console/stores/InMemoryPortfolioSyncJobStore.js';
import { ManagerBackedPortfolioElementStore, type ManagerBackedPortfolioManagers } from '../../../src/web-console/stores/ManagerBackedPortfolioElementStore.js';
import { problemForConsoleError } from '../../../src/web-console/platform/ProblemResponses.js';
import { ConsoleStoreValidationError } from '../../../src/web-console/stores/ConsoleStoreValidation.js';
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
import { MEMORY_CONSTANTS, MEMORY_SECURITY_EVENTS } from '../../../src/elements/memories/constants.js';
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
import yaml from 'js-yaml';
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
async function fixture(seedMetadata: Partial<MemoryMetadata> = {}, tenantResolver?: () => string, expired = false,
  transformSeed?: (raw: string) => string) {
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
    if (transformSeed) {
      const seedPath = path.join(tenantRoot, 'head.yaml');
      await fs.writeFile(seedPath, transformSeed(await fs.readFile(seedPath, 'utf8')));
    }
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
    return { root, tenantRoot, owners, fence, ordinary, makeManager, setTenant: (value: string) => { tenant = value; }, cleanup };
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

async function tagBoundaryFixture(rawTags: unknown = ['original'], absent = false) {
  const f = await fixture({version: '3.4.5'}, undefined, false, raw => {
    const definition = yaml.load(raw, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>};
    if (absent) delete definition.metadata.tags;
    else definition.metadata.tags = rawTags;
    return yaml.dump(definition, {lineWidth: -1, noRefs: true});
  });
  const {manager} = f.makeManager(); const store = consoleStore(manager);
  const service = new PortfolioService(store, new InMemoryUserIntegrationStore(), new InMemoryPortfolioSyncJobStore());
  const request = (body?: unknown, etag?: string): ConsoleRequest => ({body, query: {},
    headers: etag ? {'if-match': etag} : {}, consoleAuthentication: {userId: USER}} as unknown as ConsoleRequest);
  const get = await service.getElement(request(), 'memories', 'owned-memory');
  const before = await f.owners.readHeadSnapshot('head.yaml');
  const definition = yaml.load(before.content, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>; entries: unknown[]};
  const tree = async () => {
    const files: Record<string, string> = {};
    for (const entry of (await fs.readdir(f.tenantRoot, {recursive: true})).sort()) {
      const fullPath = path.join(f.tenantRoot, entry);
      if ((await fs.lstat(fullPath)).isFile()) files[entry] = (await fs.readFile(fullPath)).toString('base64');
    }
    return files;
  };
  const originalTree = await tree();
  let source: Memory | undefined; let sourceState: string | undefined;
  const find = manager.findGuardedMemoryForUpdate.bind(manager);
  jest.spyOn(manager, 'findGuardedMemoryForUpdate').mockImplementation(async (...args) => {
    const target = await find(...args); source = target?.memory; sourceState = source?.serialize(); return target;
  });
  const save = jest.spyOn(manager, 'save'); const write = jest.spyOn(f.owners, 'updateOwnedHead');
  const prepare = jest.spyOn(manager, 'prepareGuardedMemoryReplacement');
  const update = (body: unknown) => service.updateElement(request(body, get.headers!.ETag), 'memories', 'owned-memory');
  const sourceUnchanged = () => { expect(source).toBeDefined(); expect(source!.serialize()).toBe(sourceState); };
  const refused = async (preparationAllowed = false) => {
    sourceUnchanged(); if (!preparationAllowed) expect(prepare).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect(await tree()).toEqual(originalTree); expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(before);
    expect(store.getPendingGuardedUpdate(USER, 'owned-memory')).toBeUndefined();
  };
  const coherent = async (response: Awaited<ReturnType<typeof update>>, expected: unknown, omitted = false) => {
    expect(response.status).toBe(200); sourceUnchanged();
    const raw = yaml.load((await f.owners.readHeadSnapshot('head.yaml')).content, {schema: yaml.JSON_SCHEMA}) as typeof definition;
    const publication = manager.cached('head.yaml')!;
    if (omitted) expect(raw.metadata).not.toHaveProperty('tags');
    else expect(raw.metadata.tags).toEqual(expected);
    expect(publication.metadata.tags).toEqual(expected);
    expect((response.body as {tags: unknown; metadata: Record<string, unknown>}).tags).toEqual(expected ?? []);
    expect((response.body as {metadata: Record<string, unknown>}).metadata.tags).toEqual(expected);
    expect(raw.entries).toEqual(definition.entries);
    expect(raw.metadata.name).toBe(definition.metadata.name); expect(raw.metadata.unique_id).toBe(definition.metadata.unique_id);
    expect(raw.metadata.version).toBe('3.4.5'); expect(raw.metadata.created).toBe(definition.metadata.created);
    expect(publication.instructions).toBe('Original instructions'); expect(publication.extensions).toEqual({nested: {value: 'original'}});
    const next = await service.getElement(request(), 'memories', 'owned-memory');
    expect(next.body).toEqual(response.body); expect(next.headers!.ETag).toBe(response.headers!.ETag);
  };
  return {...f, definition, update, refused, coherent, save, write};
}

posix('guarded console tag boundary', () => {
  it.each([false, true].flatMap(content => [null, 'invalid', ['alternate']].map(tags => ({content, tags}))))(
    'ignores request metadata tags $tags with content=$content', async ({content, tags}) => {
      const f = await tagBoundaryFixture();
      try {
        const response = await f.update({metadata: {tags, description: 'Tag metadata edit'},
          ...(content ? {content: yaml.dump(f.definition)} : {})});
        await f.coherent(response, ['original']);
        expect((response.body as {metadata: Record<string, unknown>}).metadata.description).toBe('Tag metadata edit');
      } finally {await f.cleanup();}
    });
  it.each([
    {label: 'scalar', tags: 'invalid'}, {label: 'null', tags: null}, {label: 'mixed', tags: ['good', 9]},
    {label: 'empty', tags: ['']}, {label: 'control', tags: ['bad\u0000tag']},
    {label: 'long', tags: ['x'.repeat(81)]}, {label: 'count', tags: Array.from({length: 51}, (_, i) => `tag-${i}`)},
  ])('refuses effective structured-content tags $label before preparation', async ({tags}) => {
    const f = await tagBoundaryFixture();
    try {
      const error = await f.update({content: yaml.dump({...f.definition, metadata: {...f.definition.metadata, tags}})}).catch(cause => cause);
      expect(error).toBeInstanceOf(ConsoleStoreValidationError);
      expect(problemForConsoleError(error)).toMatchObject({status: 400, code: 'invalid_request'});
      await f.refused();
    } finally {await f.cleanup();}
  });
  it.each([{flat: false, tags: ['content']}, {flat: true, tags: ['flat']}, {flat: false, tags: []}])(
    'preserves supported content tags $tags flat=$flat', async ({flat, tags}) => {
      const f = await tagBoundaryFixture();
      try {
        const content = flat ? {...f.definition.metadata, entries: f.definition.entries, tags}
          : {...f.definition, metadata: {...f.definition.metadata, tags}};
        await f.coherent(await f.update({content: yaml.dump(content)}), tags);
      } finally {await f.cleanup();}
    });
  it.each([{tags: ['dedicated']}, {tags: []}])('gives dedicated tags $tags precedence over malformed lower-priority tags', async ({tags}) => {
    const f = await tagBoundaryFixture();
    try {
      await f.coherent(await f.update({tags, metadata: {tags: 'invalid'},
        content: yaml.dump({...f.definition, metadata: {...f.definition.metadata, tags: null}})}), tags);
    } finally {await f.cleanup();}
  });
  it.each([false, true])('refuses malformed original tags unless explicitly repaired=%s', async repair => {
    const f = await tagBoundaryFixture('original malformed');
    try {
      if (repair) await f.coherent(await f.update({tags: ['repaired']}), ['repaired']);
      else {
        const error = await f.update({metadata: {description: 'Must refuse'}}).catch(cause => cause);
        expect(error).toBeInstanceOf(ConsoleStoreValidationError);
        expect(problemForConsoleError(error)).toMatchObject({status: 400, code: 'invalid_request'});
        await f.refused();
      }
    } finally {await f.cleanup();}
  });
  it('keeps an absent original tags field absent', async () => {
    const f = await tagBoundaryFixture(undefined, true);
    try {await f.coherent(await f.update({metadata: {description: 'Absent tags edit'}}), undefined, true);}
    finally {await f.cleanup();}
  });
  it.each([{tags: 'invalid'}, {tags: ['']}, {tags: Array.from({length: 51}, (_, i) => `tag-${i}`)}])('retains direct dedicated tags $tags service422', async ({tags}) => {
    const f = await tagBoundaryFixture();
    try {
      expect((await f.update({tags})).status).toBe(422); await f.refused();
    } finally {await f.cleanup();}
  });
});

posix('guarded console canonical runtime configuration', () => {
  const profiles = [
    {label: 'constructor defaults and clamp', supplied: {maxEntries: 20000, privacyLevel: 'unsupported',
      retentionDays: 0, storageBackend: null, searchable: null}, expected: {
      maxEntries: MEMORY_CONSTANTS.MAX_ENTRIES_DEFAULT, privacyLevel: MEMORY_CONSTANTS.DEFAULT_PRIVACY_LEVEL,
      retentionDays: MEMORY_CONSTANTS.DEFAULT_RETENTION_DAYS, storageBackend: MEMORY_CONSTANTS.DEFAULT_STORAGE_BACKEND, searchable: true}},
    {label: 'canonical supported false', supplied: {maxEntries: 7, privacyLevel: 'sensitive', retentionDays: 9,
      storageBackend: 'file', searchable: false}, expected: {maxEntries: 7, privacyLevel: 'sensitive', retentionDays: 9,
      storageBackend: 'file', searchable: false}},
    {label: 'aliases win and normalize', supplied: {maxEntries: 20000, privacyLevel: 'public', privacy_level: 'unsupported',
      storageBackend: 'memory', storage_backend: 'file', retentionDays: 20, retention_policy: {default: '7 days', custom: 'retained'},
      searchable: null}, expected: {maxEntries: MEMORY_CONSTANTS.MAX_ENTRIES_DEFAULT, privacyLevel: MEMORY_CONSTANTS.DEFAULT_PRIVACY_LEVEL,
      storageBackend: 'file', retentionDays: 7, searchable: true}},
  ];
  it.each([false, true].flatMap(content => profiles.map(profile => ({...profile, content}))))(
    'persists normalized $label for actual service content=$content', async ({supplied, expected, content}) => {
      const f = await fixture({version: '3.4.5'}, undefined, false, raw => {
        const definition = yaml.load(raw, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>};
        delete definition.metadata.tags; definition.metadata.custom = {value: 'retained'};
        return yaml.dump(definition, {lineWidth: -1, noRefs: true});
      });
      try {
        const {manager} = f.makeManager(); const store = consoleStore(manager);
        const now = new Date('2026-10-04T20:00:00.000Z');
        const service = new PortfolioService(store, new InMemoryUserIntegrationStore(), new InMemoryPortfolioSyncJobStore(), () => now);
        const request = (body?: unknown, etag?: string): ConsoleRequest => ({body, query: {}, headers: etag ? {'if-match': etag} : {},
          consoleAuthentication: {userId: USER}} as unknown as ConsoleRequest);
        const before = await service.getElement(request(), 'memories', 'owned-memory');
        const original = yaml.load((await f.owners.readHeadSnapshot('head.yaml')).content, {schema: yaml.JSON_SCHEMA}) as {
          metadata: Record<string, unknown>; entries: unknown[]; instructions: string; extensions: unknown};
        let source: Memory | undefined; let sourceState: string | undefined;
        const find = manager.findGuardedMemoryForUpdate.bind(manager);
        jest.spyOn(manager, 'findGuardedMemoryForUpdate').mockImplementation(async (...args) => {
          const target = await find(...args); source = target?.memory; sourceState = source?.serialize(); return target;
        });
        const patch = content ? {content: yaml.dump({...original, metadata: {...original.metadata, ...supplied}})} : {metadata: supplied};
        const response = await service.updateElement(request(patch, before.headers!.ETag), 'memories', 'owned-memory');
        expect(response.status).toBe(200);
        expect(source).toBeDefined(); expect(source!.serialize()).toBe(sourceState);
        const persisted = yaml.load((await f.owners.readHeadSnapshot('head.yaml')).content, {schema: yaml.JSON_SCHEMA}) as typeof original;
        const publication = manager.cached('head.yaml')!;
        const runtime = JSON.parse(publication.captureAppendState().fingerprint) as Record<string, unknown>;
        const returned = response.body as {metadata: Record<string, unknown>; content: string};
        const submitted = yaml.load(returned.content, {schema: yaml.JSON_SCHEMA}) as Record<string, unknown>;
        for (const [key, value] of Object.entries(expected)) {
          expect(persisted.metadata[key]).toEqual(value); expect((publication.metadata as unknown as Record<string, unknown>)[key]).toEqual(value);
          expect(runtime[key]).toEqual(value); expect(returned.metadata[key]).toEqual(value); expect(submitted[key]).toEqual(value);
        }
        for (const key of ['privacy_level', 'storage_backend', 'retention_policy']) {
          if (Object.hasOwn(supplied, key)) expect(persisted.metadata[key]).toEqual((supplied as Record<string, unknown>)[key]);
        }
        expect(persisted.metadata).not.toHaveProperty('tags'); expect(publication.metadata).not.toHaveProperty('tags');
        expect(persisted.metadata.custom).toEqual(original.metadata.custom); expect(publication.metadata.custom).toEqual(original.metadata.custom);
        expect(persisted.metadata.name).toBe(original.metadata.name); expect(persisted.metadata.unique_id).toBe(original.metadata.unique_id);
        expect(persisted.metadata.created).toBe(original.metadata.created); expect(persisted.metadata.modified).toBe(now.toISOString());
        expect(persisted.metadata.version).toBe('3.4.5'); expect(publication.version).toBe('3.4.5');
        expect(persisted.entries).toEqual(original.entries); expect(persisted.instructions).toBe(original.instructions);
        expect(persisted.extensions).toEqual(original.extensions);
        const fresh = f.makeManager().manager; const reloaded = await fresh.load('head.yaml');
        const reloadRuntime = JSON.parse(reloaded.captureAppendState().fingerprint) as Record<string, unknown>;
        for (const [key, value] of Object.entries(expected)) {
          expect((reloaded.metadata as unknown as Record<string, unknown>)[key]).toEqual(value); expect(reloadRuntime[key]).toEqual(value);
        }
        expect(reloaded.getEntries().size).toBe(original.entries.length); expect(reloaded.validate().valid).toBe(true);
        const nextService = new PortfolioService(consoleStore(fresh), new InMemoryUserIntegrationStore(), new InMemoryPortfolioSyncJobStore());
        const next = await nextService.getElement(request(), 'memories', 'owned-memory');
        expect(next.body).toEqual(response.body); expect(next.headers!.ETag).toBe(response.headers!.ETag);
      } finally {await f.cleanup();}
    });
});

posix('guarded console computed metadata handoff', () => {
  const fields = ['description', 'tags', 'triggers', 'gatekeeper'];
  const profiles: Array<{label: string; supplied: Record<string, unknown>; expected: Record<string, unknown>; absent?: boolean}> = [
    {label: 'validated values', supplied: {description: '  Edited description  ', tags: ['a;b'],
      triggers: [' recall ', 'bad!trigger', ' ', 'x'.repeat(60)],
      gatekeeper: {allow: ['verify_challenge', 'read_element'], confirm: ['confirm_operation'],
        deny: ['abort_execution', 'delete_element', 'confirm_operation']}},
    expected: {description: 'Edited description', tags: ['ab'], triggers: ['recall', 'x'.repeat(50)],
      gatekeeper: {allow: ['read_element'], confirm: ['confirm_operation'], deny: ['delete_element', 'confirm_operation']}}},
    {label: 'trigger count limit', supplied: {triggers: Array.from({length: 23}, (_, i) => `recall-${i}`)},
      expected: {triggers: Array.from({length: 20}, (_, i) => `recall-${i}`)}},
    {label: 'explicit clears', supplied: {description: null, tags: [], triggers: null, gatekeeper: null},
      expected: {description: '', tags: [], triggers: [], gatekeeper: undefined}},
    {label: 'absent fields', supplied: {}, expected: {}, absent: true},
  ];
  it.each(['metadata', 'nested', 'flat'].flatMap(mode => profiles.map(profile => ({...profile, mode}))))(
    'keeps $label coherent for actual service mode=$mode', async ({supplied, expected, absent, mode}) => {
      const f = await fixture({version: '3.4.5'}, undefined, false, raw => {
        const definition = yaml.load(raw, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>};
        definition.metadata.custom = {value: 'retained'};
        if (absent) for (const field of fields) delete definition.metadata[field];
        return yaml.dump(definition, {lineWidth: -1, noRefs: true});
      });
      try {
        const {manager} = f.makeManager(); const store = consoleStore(manager);
        const now = new Date('2026-10-04T20:00:00.000Z');
        const service = new PortfolioService(store, new InMemoryUserIntegrationStore(), new InMemoryPortfolioSyncJobStore(), () => now);
        const request = (body?: unknown, etag?: string): ConsoleRequest => ({body, query: {}, headers: etag ? {'if-match': etag} : {},
          consoleAuthentication: {userId: USER}} as unknown as ConsoleRequest);
        const before = await service.getElement(request(), 'memories', 'owned-memory');
        const original = yaml.load((await f.owners.readHeadSnapshot('head.yaml')).content, {schema: yaml.JSON_SCHEMA}) as {
          metadata: Record<string, unknown>; entries: unknown[]; instructions: string; extensions: unknown};
        const metadata = {...original.metadata, ...supplied};
        const content = mode === 'flat' ? {...metadata, entries: original.entries, instructions: original.instructions, extensions: original.extensions}
          : {...original, metadata};
        const patch = mode === 'metadata' ? {metadata: supplied, ...('tags' in supplied ? {tags: supplied.tags} : {})}
          : {content: yaml.dump(content)};
        let source: Memory | undefined; let sourceState: string | undefined;
        const find = manager.findGuardedMemoryForUpdate.bind(manager);
        jest.spyOn(manager, 'findGuardedMemoryForUpdate').mockImplementation(async (...args) => {
          const target = await find(...args); source = target?.memory; sourceState = source?.serialize(); return target;
        });
        const write = jest.spyOn(f.owners, 'updateOwnedHead');
        const response = await service.updateElement(request(patch, before.headers!.ETag), 'memories', 'owned-memory');
        expect(response.status).toBe(200); expect(source).toBeDefined(); expect(source!.serialize()).toBe(sourceState);
        const snapshot = await f.owners.readHeadSnapshot('head.yaml');
        const persisted = yaml.load(snapshot.content, {schema: yaml.JSON_SCHEMA}) as typeof original;
        const publication = manager.cached('head.yaml')!;
        const fresh = f.makeManager().manager; const reloaded = await fresh.load('head.yaml');
        const returned = response.body as {metadata: Record<string, unknown>; content: string; tags: unknown};
        // Compare actual persisted, committed and reloaded fields before hash-shape assertions.
        const pick = (metadata: Record<string, unknown>) => Object.fromEntries(Object.keys(expected).map(field => [field, metadata[field]]));
        expect({persisted: pick(persisted.metadata), runtime: pick(publication.metadata as unknown as Record<string, unknown>),
          response: pick(returned.metadata), reloaded: pick(reloaded.metadata as unknown as Record<string, unknown>)})
          .toEqual({persisted: expected, runtime: expected, response: expected, reloaded: expected});
        if (absent) for (const field of fields) {
          expect(persisted.metadata).not.toHaveProperty(field); expect(publication.metadata).not.toHaveProperty(field);
          expect(returned.metadata).not.toHaveProperty(field);
        }
        expect(persisted.entries).toEqual(original.entries); expect(persisted.instructions).toBe(original.instructions);
        expect(persisted.extensions).toEqual(original.extensions); expect(persisted.metadata.custom).toEqual(original.metadata.custom);
        for (const field of ['name', 'unique_id', 'version', 'created', 'maxEntries', 'retentionDays', 'privacyLevel', 'storageBackend', 'searchable']) {
          expect(persisted.metadata[field]).toEqual(original.metadata[field]);
        }
        expect(persisted.metadata.modified).toBe(now.toISOString()); expect(publication.version).toBe('3.4.5');
        expect(reloaded.getEntries().size).toBe(original.entries.length); expect(reloaded.validate().valid).toBe(true);
        expect(write).toHaveBeenCalledTimes(1); expect(write.mock.calls[0][1]).toBe(snapshot.content);
        expect(response.headers!.ETag).toBe(`"sha256:${createHash('sha256').update(snapshot.content, 'utf8').digest('hex')}"`);
        const freshService = new PortfolioService(consoleStore(fresh), new InMemoryUserIntegrationStore(), new InMemoryPortfolioSyncJobStore());
        const next = await freshService.getElement(request(), 'memories', 'owned-memory');
        expect(next.body).toEqual(response.body); expect(next.headers!.ETag).toBe(response.headers!.ETag);
      } finally {await f.cleanup();}
    });
  it.each(['metadata', 'nested', 'flat'].flatMap(mode => [
    {label: 'malformed authored gatekeeper', supplied: {gatekeeper: {allow: 'not an array'}}},
    {label: 'sanitizer-empty tag', supplied: {tags: [';;']}},
  ].map(profile => ({...profile, mode}))))('refuses $label before owned dispatch mode=$mode', async ({supplied, mode, label}) => {
    const f = await tagBoundaryFixture();
    try {
      const metadata = {...f.definition.metadata, ...supplied};
      const content = mode === 'flat' ? {...metadata, entries: f.definition.entries} : {...f.definition, metadata};
      const patch = mode === 'metadata' ? {metadata: supplied, ...('tags' in supplied ? {tags: supplied.tags} : {})}
        : {content: yaml.dump(content)};
      const error = await f.update(patch).catch(cause => cause);
      if (label === 'sanitizer-empty tag') {
        expect(error).toBeInstanceOf(ConsoleStoreValidationError);
        expect(problemForConsoleError(error)).toMatchObject({status: 400, code: 'invalid_request'});
      } else expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(label === 'sanitizer-empty tag' ? 'printable non-empty' : 'Invalid gatekeeper policy');
      // Normalization reaches preparation, but source/tree/owner and reservation proofs remain strict.
      await f.refused(true);
    } finally {await f.cleanup();}
  });
});

posix('guarded console canonical tag precedence', () => {
  it.each([false, true].flatMap(flat => [['a;b'], []].map(tags => ({flat, tags}))))(
    'canonicalizes dedicated tags $tags after precedence flat=$flat', async ({flat, tags}) => {
      const f = await tagBoundaryFixture();
      try {
        const metadata = {...f.definition.metadata, tags: ['lower;priority']};
        const content = flat ? {...metadata, entries: f.definition.entries} : {...f.definition, metadata};
        const response = await f.update({content: yaml.dump(content), metadata: {tags: ['ignored;metadata']}, tags});
        const expected = tags.length ? ['ab'] : [];
        await f.coherent(response, expected);
        expect((await f.makeManager().manager.load('head.yaml')).metadata.tags).toEqual(expected);
      } finally {await f.cleanup();}
    });
});

posix('guarded console complete snapshot ETag', () => {
  it.each([{label: 'nested value', extensions: {nested: {value: 'First extension edit'}}},
    {label: 'nested modified only', extensions: {nested: {value: 'original', modified: '2026-10-04T21:00:00.000Z'}}}])(
    'refuses stale extension overwrite at equal captured time for $label', async ({extensions}) => {
      const now = new Date('2026-10-04T20:00:00.000Z');
      const f = await fixture({version: '3.4.5'}, undefined, false, raw => {
        const definition = yaml.load(raw, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>};
        definition.metadata.modified = now.toISOString(); return yaml.dump(definition, {lineWidth: -1, noRefs: true});
      });
      try {
        const {manager} = f.makeManager(); const store = consoleStore(manager);
        const service = new PortfolioService(store, new InMemoryUserIntegrationStore(), new InMemoryPortfolioSyncJobStore(), () => now);
        const request = (body?: unknown, etag?: string): ConsoleRequest => ({body, query: {}, headers: etag ? {'if-match': etag} : {},
          consoleAuthentication: {userId: USER}} as unknown as ConsoleRequest);
        const before = await service.getElement(request(), 'memories', 'owned-memory');
        const initial = await f.owners.readHeadSnapshot('head.yaml');
        const definition = yaml.load(initial.content, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>; entries: unknown[]; extensions: unknown};
        const save = jest.spyOn(manager, 'save'); const write = jest.spyOn(f.owners, 'updateOwnedHead');
        let source: Memory | undefined; let sourceState: string | undefined;
        const find = manager.findGuardedMemoryForUpdate.bind(manager);
        jest.spyOn(manager, 'findGuardedMemoryForUpdate').mockImplementation(async (...args) => {
          const target = await find(...args); source = target?.memory; sourceState = source?.serialize(); return target;
        });
        const first = await service.updateElement(request({content: yaml.dump({...definition, extensions})}, before.headers!.ETag),
          'memories', 'owned-memory');
        expect(first.status).toBe(200); expect(source).toBeDefined(); expect(source!.serialize()).toBe(sourceState);
        const accepted = await f.owners.readHeadSnapshot('head.yaml');
        const parsed = yaml.load(accepted.content, {schema: yaml.JSON_SCHEMA}) as typeof definition;
        expect(parsed.extensions).toEqual(extensions); expect(parsed.metadata.modified).toBe(now.toISOString());
        expect(parsed.entries).toEqual(definition.entries); expect(parsed.metadata.unique_id).toBe(definition.metadata.unique_id);
        const tree = async () => {
          const files: Record<string, string> = {};
          for (const entry of (await fs.readdir(f.tenantRoot, {recursive: true})).sort()) {
            const file = path.join(f.tenantRoot, entry);
            if ((await fs.lstat(file)).isFile()) files[entry] = (await fs.readFile(file)).toString('base64');
          }
          return files;
        };
        const acceptedTree = await tree(); save.mockClear(); write.mockClear();
        const stale = await service.updateElement(request({content: yaml.dump(definition)}, before.headers!.ETag), 'memories', 'owned-memory');
        const afterStale = yaml.load((await f.owners.readHeadSnapshot('head.yaml')).content, {schema: yaml.JSON_SCHEMA}) as typeof definition;
        expect({status: stale.status, dispatched: write.mock.calls.length, persistedExtensions: afterStale.extensions,
          priorTokenStillMatches: first.headers!.ETag === before.headers!.ETag})
          .toEqual({status: 412, dispatched: 0, persistedExtensions: extensions, priorTokenStillMatches: false});
        expect(source).toBeDefined(); expect(source!.serialize()).toBe(sourceState);
        expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
        expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(accepted); expect(await tree()).toEqual(acceptedTree);
        expect(store.getPendingGuardedUpdate(USER, 'owned-memory')).toBeUndefined();
        expect(first.headers!.ETag).not.toBe(before.headers!.ETag);
        const after = await service.getElement(request(), 'memories', 'owned-memory');
        expect(after.body).toEqual(first.body); expect(after.headers!.ETag).toBe(first.headers!.ETag);
        const second = await service.updateElement(request({content: yaml.dump({...definition, extensions: {nested: {value: 'Second extension edit'}}})},
          first.headers!.ETag), 'memories', 'owned-memory');
        expect(second.status).toBe(200); expect(source!.serialize()).toBe(sourceState);
        expect(write).toHaveBeenCalledTimes(1);
        const submitted = write.mock.calls[0][1]; const persisted = await f.owners.readHeadSnapshot('head.yaml');
        expect(persisted.content).toBe(submitted);
        expect(second.headers!.ETag).toBe(`"sha256:${createHash('sha256').update(submitted, 'utf8').digest('hex')}"`);
        expect((yaml.load(persisted.content, {schema: yaml.JSON_SCHEMA}) as typeof definition).extensions).toEqual({nested: {value: 'Second extension edit'}});
        expect(second.headers!.ETag).not.toBe(first.headers!.ETag);
        expect((await service.getElement(request(), 'memories', 'owned-memory')).headers!.ETag).toBe(second.headers!.ETag);
      } finally {await f.cleanup();}
    });
  it('distinguishes raw extensions absence null and empty while retaining legacy and list projections', async () => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const original = yaml.load((await f.owners.readHeadSnapshot('head.yaml')).content, {schema: yaml.JSON_SCHEMA}) as Record<string, unknown>;
      const hashes: string[] = [];
      for (const value of [undefined, null, {}]) {
        const definition = {...original};
        if (value === undefined) delete definition.extensions; else definition.extensions = value;
        const before = await f.owners.readHeadSnapshot('head.yaml');
        if (before.token.ownership !== 'owned') throw new Error('Expected real owned projection fixture');
        const content = yaml.dump(definition, {lineWidth: -1, noRefs: true});
        await f.owners.updateOwnedHead(before.token, content);
        const record = await store.findByName(USER, 'memories', 'owned-memory');
        expect(record!.contentHash).toBe(createHash('sha256').update(content, 'utf8').digest('hex')); hashes.push(record!.contentHash!);
      }
      expect(new Set(hashes).size).toBe(3);
      const stable = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(stable);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'modified').sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, stable(value)]));
      };
      const legacy = consoleStore(f.ordinary); const record = await legacy.findByName(USER, 'memories', 'owned-memory');
      const expected = createHash('sha256').update(JSON.stringify({type: 'memories', metadata: stable(record!.metadata), content: record!.content})).digest('hex');
      expect(record!.contentHash).toBe(expected);
      const runtime = await manager.load('head.yaml');
      const summary = await (store as unknown as {toRecord: (user: string, type: string, memory: Memory) => Promise<{contentHash: string; metadata: unknown; content: string}>})
        .toRecord(USER, 'memories', runtime);
      expect(summary.contentHash).toBe(createHash('sha256').update(JSON.stringify({type: 'memories', metadata: stable(summary.metadata), content: summary.content})).digest('hex'));
    } finally {await f.cleanup();}
  });
});

posix('guarded console legacy raw-name identity', () => {
  const request = (body?: unknown, etag?: string): ConsoleRequest => ({body, query: {type: 'memories'},
    headers: etag ? {'if-match': etag} : {}, consoleAuthentication: {userId: USER}} as unknown as ConsoleRequest);
  const serviceFor = (manager: MemoryManager) => new PortfolioService(consoleStore(manager),
    new InMemoryUserIntegrationStore(), new InMemoryPortfolioSyncJobStore());
  const seed = (name: string, missingId = false) => fixture({}, undefined, false, raw => {
    const data = yaml.load(raw, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>};
    data.metadata.name = name; if (missingId) delete data.metadata.unique_id;
    return yaml.dump(data, {noRefs: true});
  });
  it.each(['R&D', 'L'.repeat(105)].flatMap(rawName => [false, true].flatMap(missingId =>
    [false, true].map(content => ({rawName, missingId, content})))))('edits actual LIST identity without renaming raw=$rawName missingId=$missingId content=$content', async ({rawName, missingId, content}) => {
    const f = await seed(rawName, missingId);
    try {
      const {manager} = f.makeManager(); const service = serviceFor(manager);
      const listed = await service.listElements(request());
      const records = (listed.body as {elements: Array<{name: string}>}).elements;
      expect(records).toHaveLength(1); const logical = rawName === 'R&D' ? 'RD' : 'L'.repeat(100);
      expect(records[0].name).toBe(logical);
      const get = await service.getElement(request(), 'memories', records[0].name);
      expect(get.status).toBe(200);
      const detail = get.body as {display_name: string; content: string}; expect(detail.display_name).toBe(rawName);
      const before = await f.owners.readHeadSnapshot('head.yaml');
      expect(get.headers!.ETag).toContain(createHash('sha256').update(before.content).digest('hex'));
      const parsed = yaml.load(detail.content, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>; entries: Array<{content: string}>};
      if (content) parsed.entries[0].content = 'Edited legacy entry';
      const response = await service.updateElement(request({display_name: detail.display_name,
        metadata: {description: 'Legacy identity edit'}, ...(content ? {content: yaml.dump(parsed)} : {})}, get.headers!.ETag), 'memories', logical);
      expect(response.status).toBe(200);
      const first = await f.owners.readHeadSnapshot('head.yaml');
      const durable = yaml.load(first.content, {schema: yaml.JSON_SCHEMA}) as typeof parsed;
      expect(durable.metadata.name).toBe(rawName); expect(durable.metadata.unique_id).toEqual(expect.any(String));
      expect(durable.entries[0].content).toBe(content ? 'Edited legacy entry' : 'Original entry');
      const publication = manager.cached('head.yaml')!; expect(publication.metadata.name).toBe(rawName === 'R&D' ? 'RD' : 'L'.repeat(100));
      expect(publication.instructions).toBe('Original instructions'); expect(publication.extensions).toEqual({nested: {value: 'original'}});
      const next = await service.getElement(request(), 'memories', logical);
      expect(next.body).toEqual(response.body); expect(next.headers!.ETag).toBe(response.headers!.ETag);
      const second = await service.updateElement(request({metadata: {description: 'Second legacy edit'}}, next.headers!.ETag), 'memories', logical);
      expect(second.status).toBe(200);
      const secondRaw = yaml.load((await f.owners.readHeadSnapshot('head.yaml')).content, {schema: yaml.JSON_SCHEMA}) as typeof parsed;
      expect(secondRaw.metadata.name).toBe(rawName); expect(secondRaw.metadata.unique_id).toBe(durable.metadata.unique_id);
    } finally {await f.cleanup();}
  });
  it('isolates raw-name evidence from public source, generic derivation, publication and ordinary serialization', async () => {
    const f = await seed('R&D');
    try {
      const {manager} = f.makeManager();
      const target = (await manager.findGuardedMemoryForUpdate('rd', USER))!;
      const serialize = (memory: Memory) => (manager as unknown as {serializeElement(memory: Memory): Promise<string>}).serializeElement(memory);
      const name = async (memory: Memory) => (yaml.load(await serialize(memory)) as {metadata: {name: string}}).metadata.name;
      expect(await name(target.memory)).toBe('RD'); expect(await name(manager.deriveGuardedMutation(target.memory))).toBe('RD');
      expect(await name(await manager.load('head.yaml'))).toBe('RD'); f.ordinary.clearCache(); expect(await name(await f.ordinary.load('head.yaml'))).toBe('RD');
      const baseline = structuredClone(target.replacementBaseline); (baseline.metadata as Record<string, unknown>).description = 'Console only';
      const candidate = await manager.prepareGuardedMemoryReplacement(target.memory, yaml.dump(baseline));
      expect(await name(candidate)).toBe('R&D'); expect(await name(manager.deriveGuardedMutation(candidate))).toBe('RD');
      await manager.save(candidate); expect((yaml.load((await f.owners.readHeadSnapshot('head.yaml')).content) as {metadata: {name: string}}).metadata.name).toBe('R&D');
      expect(await name(manager.cached('head.yaml')!)).toBe('RD');
      // A separately loaded public writer keeps its existing serialization behavior.
      const publicMemory = await manager.load('head.yaml'); await manager.save(publicMemory);
      expect((yaml.load((await f.owners.readHeadSnapshot('head.yaml')).content) as {metadata: {name: string}}).metadata.name).toBe('RD');
    } finally {await f.cleanup();}
  });
  it.each(['display', 'metadata', 'content'] as const)('refuses explicit legacy identity change from %s without dispatch', async mode => {
    const f = await seed('R&D');
    try {
      const {manager} = f.makeManager(); const service = serviceFor(manager); const get = await service.getElement(request(), 'memories', 'rd'); expect(get.status).toBe(200);
      const before = await f.owners.readHeadSnapshot('head.yaml'); const save = jest.spyOn(manager, 'save'); const write = jest.spyOn(f.owners, 'updateOwnedHead');
      const edit = yaml.load((get.body as {content: string}).content) as Record<string, unknown>; edit.name = 'RD';
      const body = mode === 'display' ? {display_name: 'RD'} : mode === 'metadata' ? {metadata: {name: 'RD'}} : {content: yaml.dump(edit)};
      await expect(service.updateElement(request(body, get.headers!.ETag), 'memories', 'rd')).rejects.toThrow('rename');
      expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(before);
      const target = (await manager.findGuardedMemoryForUpdate('rd', USER))!; const state = target.memory.serialize();
      const direct = structuredClone(target.replacementBaseline); (direct.metadata as Record<string, unknown>).name = 'RD';
      await expect(manager.prepareGuardedMemoryReplacement(target.memory, yaml.dump(direct))).rejects.toThrow('identity'); expect(target.memory.serialize()).toBe(state);
    } finally {await f.cleanup();}
  });
  it.each(['R;D', 'RD', 'R-D'])('refuses all raw/normalized/stem candidate collisions with %s', async otherName => {
    const f = await seed('R&D');
    try {
      const other = new Memory({name: otherName}, new MetadataService()); await f.ordinary.save(other, 'other.yaml');
      const snapshot = await f.owners.readHeadSnapshot('other.yaml'); if (snapshot.token.ownership !== 'unowned') throw new Error('Expected unowned second file'); await f.owners.adoptUnowned(snapshot.token);
      const {manager} = f.makeManager(); const write = jest.spyOn(f.owners, 'updateOwnedHead');
      // R-D shares the raw filename stem r-d; other cases share normalized RD.
      await expect(manager.findGuardedMemoryForUpdate(otherName === 'R-D' ? 'r-d' : 'rd', USER)).rejects.toMatchObject({code: 'EHEADCONFLICT'}); expect(write).not.toHaveBeenCalled();
    } finally {await f.cleanup();}
  });
  it('refuses raw summary drift even when both names normalize to RD', async () => {
    const f = await seed('R&D');
    try {
      const {manager} = f.makeManager(); const storage = (manager as unknown as {storageLayer: {listSummaries: (...args: unknown[]) => Promise<Array<{name: string}>>}}).storageLayer;
      const list = storage.listSummaries.bind(storage); jest.spyOn(storage, 'listSummaries').mockImplementation(async (...args) => (await list(...args)).map(item => ({...item, name: 'R;D'})));
      const before = await f.owners.readHeadSnapshot('head.yaml'); const save = jest.spyOn(manager, 'save'); const write = jest.spyOn(f.owners, 'updateOwnedHead');
      await expect(manager.findGuardedMemoryForUpdate('rd', USER)).rejects.toMatchObject({code: 'EHEADCONFLICT'});
      expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(before);
    } finally {await f.cleanup();}
  });
});

posix('guarded console existing-owner UPDATE', () => {
  it.each(['delete', 'rename'].flatMap(transition => ['GET', 'initial PATCH', 'store PATCH'].map(operation => ({transition, operation}))))('returns service404 when $transition wins discovery/read race during $operation', async ({transition, operation}) => {
      const f = await fixture();
      try {
        const {manager} = f.makeManager(); const store = consoleStore(manager);
        const service = new PortfolioService(store, new InMemoryUserIntegrationStore(), new InMemoryPortfolioSyncJobStore());
        const request = (body: unknown = undefined, etag?: string): ConsoleRequest => ({body, query: {},
          headers: etag ? {'if-match': etag} : {}, consoleAuthentication: {userId: USER}} as unknown as ConsoleRequest);
        const before = await service.getElement(request(), 'memories', 'owned-memory');
        const snapshot = await f.owners.readHeadSnapshot('head.yaml');
        if (snapshot.token.ownership !== 'owned') throw new Error('Expected real owned transition fixture');
        const token = snapshot.token;
        const tree = async () => {
          const entries = await fs.readdir(f.tenantRoot, {recursive: true});
          const files: Record<string, string> = {};
          for (const entry of entries.sort()) {
            const fullPath = path.join(f.tenantRoot, entry);
            if ((await fs.lstat(fullPath)).isFile()) files[entry] = (await fs.readFile(fullPath)).toString('base64');
          }
          return files;
        };
        const read = f.owners.readHeadSnapshot.bind(f.owners);
        let reads = 0; let transitioned: Record<string, string> | undefined;
        const raceRead = operation === 'store PATCH' ? 2 : 1;
        const lookup = jest.spyOn(f.owners, 'readHeadSnapshot').mockImplementation(async locator => {
          if (++reads === raceRead) {
            if (transition === 'delete') await f.owners.deleteOwned({operationId: randomUUID(), expectedToken: token});
            else await f.owners.renameOwned({operationId: randomUUID(), expectedToken: token, destinationLocator: 'moved.yaml'});
            transitioned = await tree();
          }
          return read(locator);
        });
        const save = jest.spyOn(manager, 'save'); const write = jest.spyOn(f.owners, 'updateOwnedHead');
        const result = operation === 'GET' ? await service.getElement(request(), 'memories', 'owned-memory')
          : await service.updateElement(request({metadata: {description: 'Must be absent'}}, before.headers!.ETag), 'memories', 'owned-memory');
        expect(result.status).toBe(404); expect(lookup).toHaveBeenCalledTimes(raceRead);
        expect(transitioned).toBeDefined(); expect(await tree()).toEqual(transitioned);
        expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
        expect(store.getPendingGuardedUpdate(USER, 'owned-memory')).toBeUndefined();
        if (transition === 'rename') expect(await fs.readFile(path.join(f.tenantRoot, 'moved.yaml'), 'utf8')).toBe(snapshot.content);
      } finally {await f.cleanup();}
    });

  it.each(['EACCES', 'EHEADCONFLICT', 'EOWNERRECOVERY', 'EERASURERESIDUAL', undefined])('preserves initial lookup failure identity outside ENOENT: %s', async code => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const service = new PortfolioService(store, new InMemoryUserIntegrationStore(), new InMemoryPortfolioSyncJobStore());
      const request = {query: {}, headers: {}, consoleAuthentication: {userId: USER}} as unknown as ConsoleRequest;
      const snapshot = await f.owners.readHeadSnapshot('head.yaml');
      const cause = Object.assign(new Error('Controlled lookup failure'), {code});
      jest.spyOn(f.owners, 'readHeadSnapshot').mockRejectedValueOnce(cause);
      const save = jest.spyOn(manager, 'save'); const write = jest.spyOn(f.owners, 'updateOwnedHead');
      await expect(service.getElement(request, 'memories', 'owned-memory')).rejects.toBe(cause);
      expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
      expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(snapshot);
    } finally {await f.cleanup();}
  });

  it.each(['tenant', 'root'])('preserves original %s context refusal over lookup ENOENT', async drift => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const service = new PortfolioService(store, new InMemoryUserIntegrationStore(), new InMemoryPortfolioSyncJobStore());
      const request = {query: {}, headers: {}, consoleAuthentication: {userId: USER}} as unknown as ConsoleRequest;
      const bytes = await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8');
      jest.spyOn(f.owners, 'readHeadSnapshot').mockImplementationOnce(async () => {
        if (drift === 'tenant') f.setTenant('22222222-2222-4222-8222-222222222222');
        else Object.defineProperty(manager, 'memoriesDir', {configurable: true, get: () => path.join(f.root, 'different-root')});
        throw Object.assign(new Error('Missing during changed context'), {code: 'ENOENT'});
      });
      const save = jest.spyOn(manager, 'save'); const write = jest.spyOn(f.owners, 'updateOwnedHead');
      await expect(service.getElement(request, 'memories', 'owned-memory')).rejects.toMatchObject({code: 'EHEADCONFLICT'});
      expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8')).toBe(bytes);
    } finally {await f.cleanup();}
  });

  it.each(['public load', 'hydration'])('preserves ENOENT outside the lookup snapshot stage: %s', async stage => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const snapshot = await f.owners.readHeadSnapshot('head.yaml');
      const cause = Object.assign(new Error('Missing outside lookup read'), {code: 'ENOENT'});
      if (stage === 'public load') jest.spyOn(f.owners, 'readHeadSnapshot').mockRejectedValueOnce(cause);
      else jest.spyOn(manager as unknown as {hydrateDefinitionFromContent: () => Promise<Memory>}, 'hydrateDefinitionFromContent').mockRejectedValueOnce(cause);
      const save = jest.spyOn(manager, 'save'); const write = jest.spyOn(f.owners, 'updateOwnedHead');
      await expect(stage === 'public load' ? manager.load('head.yaml') : store.findByName(USER, 'memories', 'owned-memory')).rejects.toBe(cause);
      expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
      expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(snapshot);
    } finally {await f.cleanup();}
  });

  it('retains a postcommit publication ENOENT instead of converting it to notfound', async () => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const service = new PortfolioService(store, new InMemoryUserIntegrationStore(), new InMemoryPortfolioSyncJobStore());
      const request = (body: unknown = undefined, etag?: string): ConsoleRequest => ({body, query: {},
        headers: etag ? {'if-match': etag} : {}, consoleAuthentication: {userId: USER}} as unknown as ConsoleRequest);
      const before = await service.getElement(request(), 'memories', 'owned-memory');
      const cause = Object.assign(new Error('Publication missing after commit'), {code: 'ENOENT'});
      manager.publicationFailure = {cause};
      await expect(service.updateElement(request({metadata: {description: 'Known durable update'}}, before.headers!.ETag),
        'memories', 'owned-memory')).rejects.toBe(cause);
      expect(store.getPendingGuardedUpdate(USER, 'owned-memory')).toMatchObject({status: 'committed-publication-failed', cause});
      expect((await f.owners.readHeadSnapshot('head.yaml')).content).toContain('Known durable update');
    } finally {await f.cleanup();}
  });

  it.each([false, true].flatMap(body => [false, true].flatMap(missingId => [false, true].map(echo => ({body, missingId, echo})))))('edits frontmatter through the console service body=$body missingId=$missingId echoedContent=$echo', async ({body, missingId, echo}) => {
      const markdown = body ? '# Route memory\n\nPreserved Markdown body.' : '';
      let rawDefinition: Record<string, unknown> = {};
      const f = await fixture({version: '3.4.5'}, undefined, false, raw => {
        const definition = yaml.load(raw, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>};
        definition.metadata.custom = {value: 'route retained'};
        if (missingId) delete definition.metadata.unique_id;
        rawDefinition = definition;
        return `---\n${yaml.dump(definition, {lineWidth: -1, noRefs: true})}---\n\n${markdown}\n`;
      });
      try {
        const {manager} = f.makeManager(); const store = consoleStore(manager);
        const now = new Date('2026-10-07T12:00:00.000Z');
        const service = new PortfolioService(store, new InMemoryUserIntegrationStore(), new InMemoryPortfolioSyncJobStore(), () => now);
        const request = (payload: unknown = undefined, etag?: string): ConsoleRequest => ({body: payload, query: {},
          headers: etag ? {'if-match': etag} : {}, consoleAuthentication: {userId: USER}} as unknown as ConsoleRequest);
        const get = await service.getElement(request(), 'memories', 'owned-memory');
        expect(get.status).toBe(200);
        const original = get.body as {content: string; metadata: Record<string, unknown>};
        const rawSnapshot = await f.owners.readHeadSnapshot('head.yaml');
        const rawHash = createHash('sha256').update(rawSnapshot.content, 'utf8').digest('hex');
        expect(get.headers?.ETag).toBe(`"sha256:${rawHash}"`);
        const initialSnapshot = await f.owners.readHeadSnapshot('head.yaml');
        const save = jest.spyOn(manager, 'save'); const write = jest.spyOn(f.owners, 'updateOwnedHead');
        const stale = await service.updateElement(request({metadata: {description: 'Stale route'}}, '"sha256:stale"'), 'memories', 'owned-memory');
        expect(stale.status).toBe(412); expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
        expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(initialSnapshot);
        const first = await service.updateElement(request({display_name: null, metadata: {description: 'First route edit'}, tags: ['route'],
          ...(echo ? {content: original.content} : {})}, get.headers!.ETag), 'memories', 'owned-memory');
        expect(first.status).toBe(200);
        const initialContent = yaml.load(original.content, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>; entries: unknown[]};
        expect(Array.isArray(initialContent.entries)).toBe(true);
        if (missingId) expect(initialContent.metadata).not.toHaveProperty('unique_id');
        const firstRaw = yaml.load((await f.owners.readHeadSnapshot('head.yaml')).content, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>; entries: Array<{id: string; content: string}>};
        const persistedId = firstRaw.metadata.unique_id;
        expect(typeof persistedId).toBe('string');
        if (!missingId) expect(persistedId).toBe((rawDefinition.metadata as Record<string, unknown>).unique_id);
        expect(firstRaw.entries).toHaveLength(body ? 2 : 1);
        expect(firstRaw.entries.filter(entry => entry.content === markdown)).toHaveLength(body ? 1 : 0);
        expect(firstRaw.metadata.name).toBe('Owned memory'); expect(firstRaw.metadata.version).toBe('3.4.5');
        expect(firstRaw.metadata.custom).toEqual({value: 'route retained'}); expect(firstRaw.metadata.modified).toBe(now.toISOString());
        const next = await service.getElement(request(), 'memories', 'owned-memory');
        expect(next.headers?.ETag).toBe(first.headers?.ETag); expect(next.body).toEqual(first.body);
        const returned = next.body as {content: string};
        const edit = yaml.load(returned.content, {schema: yaml.JSON_SCHEMA}) as {entries: Array<{id: string; content: string}>};
        edit.entries.find(entry => entry.content === 'Original entry')!.content = 'Edited echoed entry';
        const second = await service.updateElement(request({content: yaml.dump(edit, {lineWidth: -1, noRefs: true}),
          metadata: {description: 'Second route edit'}}, next.headers!.ETag), 'memories', 'owned-memory');
        expect(second.status).toBe(200);
        const secondSnapshot = await f.owners.readHeadSnapshot('head.yaml');
        const secondRaw = yaml.load(secondSnapshot.content, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>; entries: Array<{id: string; content: string}>};
        expect(secondRaw.metadata.unique_id).toBe(persistedId); expect(secondRaw.metadata.created).toBe(firstRaw.metadata.created);
        expect(secondRaw.entries.find(entry => entry.content === 'Edited echoed entry')?.id).toBe(firstRaw.entries.find(entry => entry.content === 'Original entry')?.id);
        expect(secondRaw.entries.filter(entry => entry.content === markdown)).toHaveLength(body ? 1 : 0);
        const publication = manager.cached('head.yaml')!;
        expect(publication.instructions).toBe('Original instructions'); expect(publication.extensions).toEqual({nested: {value: 'original'}});
        expect(publication.version).toBe('3.4.5'); expect(publication.metadata.name).toBe('Owned memory');
        const finalGet = await service.getElement(request(), 'memories', 'owned-memory');
        expect(finalGet.headers?.ETag).toBe(second.headers?.ETag); expect(finalGet.body).toEqual(second.body);
        save.mockClear(); write.mockClear();
        await expect(service.updateElement(request({metadata: {unique_id: 'wrong-id'}}, finalGet.headers!.ETag), 'memories', 'owned-memory')).rejects.toThrow('identity');
        expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
        expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(secondSnapshot);
      } finally {await f.cleanup();}
    });

  it.each([{entries: null}, {entries: [{content: 'Malformed raw entry'}]}])('retains malformed frontmatter entries through service editing projection: $entries', async ({entries}) => {
    const f = await fixture({}, undefined, false, raw => {
      const definition = yaml.load(raw, {schema: yaml.JSON_SCHEMA}) as Record<string, unknown>;
      return `---\n${yaml.dump({...definition, entries})}---\n`;
    });
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const service = new PortfolioService(store, new InMemoryUserIntegrationStore(), new InMemoryPortfolioSyncJobStore());
      const request = (body: unknown = undefined, etag?: string): ConsoleRequest => ({body, query: {},
        headers: etag ? {'if-match': etag} : {}, consoleAuthentication: {userId: USER}} as unknown as ConsoleRequest);
      const get = await service.getElement(request(), 'memories', 'owned-memory');
      expect(get.status).toBe(200);
      const content = (get.body as {content: string}).content;
      expect((yaml.load(content, {schema: yaml.JSON_SCHEMA}) as {entries: unknown}).entries).toEqual(entries);
      const snapshot = await f.owners.readHeadSnapshot('head.yaml');
      const save = jest.spyOn(manager, 'save'); const write = jest.spyOn(f.owners, 'updateOwnedHead');
      await expect(service.updateElement(request({content, metadata: {description: 'Must refuse'}}, get.headers!.ETag),
        'memories', 'owned-memory')).rejects.toThrow();
      expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
      expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(snapshot);
    } finally {await f.cleanup();}
  });

  it.each(['lookup', 'update'] as const)('does not resolve unrelated Unicode names through empty filename stems during %s', async operation => {
    const f = await fixture({name: '記憶'});
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const before = await store.findByName(USER, 'memories', '記憶');
      expect(before).not.toBeNull();
      const snapshot = await f.owners.readHeadSnapshot('head.yaml');
      const save = jest.spyOn(manager, 'save'); const write = jest.spyOn(f.owners, 'updateOwnedHead');
      if (operation === 'lookup') expect(await store.findByName(USER, 'memories', '不存在')).toBeNull();
      else expect(await store.update({userId: USER, type: 'memories', canonicalName: '不存在', expectedVersion: 1,
        expectedContentHash: before!.contentHash, now: new Date(), metadata: {description: 'Wrong target'}})).toBeNull();
      expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
      expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(snapshot);
      expect(store.getPendingGuardedUpdate(USER, '不存在')).toBeUndefined();
    } finally {await f.cleanup();}
  });

  it('preserves exact Unicode canonical-name lookup and conditional update', async () => {
    const f = await fixture({name: '記憶'});
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const before = await store.findByName(USER, 'memories', '記憶');
      expect(before!.displayName).toBe('記憶');
      const response = await store.update({userId: USER, type: 'memories', canonicalName: '記憶', expectedVersion: 1,
        expectedContentHash: before!.contentHash, now: new Date(), metadata: {description: 'Exact Unicode edit'}});
      const raw = yaml.load((await f.owners.readHeadSnapshot('head.yaml')).content, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>};
      expect(raw.metadata.name).toBe('記憶'); expect(raw.metadata.unique_id).toBe(before!.metadata.unique_id);
      expect(raw.metadata.description).toBe('Exact Unicode edit'); expect(response!.displayName).toBe('記憶');
      expect((await store.findByName(USER, 'memories', '記憶'))!.contentHash).toBe(response!.contentHash);
    } finally {await f.cleanup();}
  });

  it('refuses duplicate exact Unicode names without dispatch', async () => {
    const f = await fixture({name: '記憶'});
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const snapshot = await f.owners.readHeadSnapshot('head.yaml');
      await fs.writeFile(path.join(f.tenantRoot, 'duplicate.yaml'), snapshot.content);
      const save = jest.spyOn(manager, 'save'); const write = jest.spyOn(f.owners, 'updateOwnedHead');
      await expect(store.findByName(USER, 'memories', '記憶')).rejects.toMatchObject({code: 'EHEADCONFLICT'});
      await expect(store.update({userId: USER, type: 'memories', canonicalName: '記憶', expectedVersion: 1,
        now: new Date(), metadata: {description: 'Ambiguous edit'}})).rejects.toMatchObject({code: 'EHEADCONFLICT'});
      expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
      expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(snapshot);
      expect(await fs.readFile(path.join(f.tenantRoot, 'duplicate.yaml'), 'utf8')).toBe(snapshot.content);
    } finally {await f.cleanup();}
  });

  it.each([false, true])('falls back to the unchanged memory name for null displayName and full replacement=%s', async fullReplacement => {
    const f = await fixture({version: '3.4.5'}, undefined, false, raw => {
      const definition = yaml.load(raw, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>};
      definition.metadata.custom = {value: 'retained'};
      return yaml.dump(definition, {lineWidth: -1, noRefs: true});
    });
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const before = await store.findByName(USER, 'memories', 'owned-memory');
      const original = yaml.load((await f.owners.readHeadSnapshot('head.yaml')).content, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>; entries: unknown[]};
      let source: Memory | undefined; let sourceState: string | undefined;
      const find = manager.findGuardedMemoryForUpdate.bind(manager);
      jest.spyOn(manager, 'findGuardedMemoryForUpdate').mockImplementation(async (...args) => {
        const target = await find(...args); source = target?.memory; sourceState = source?.serialize(); return target;
      });
      const metadata = {description: 'Nullable display-name edit'};
      const response = await store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1,
        expectedContentHash: before!.contentHash, displayName: null, now: new Date(), metadata,
        content: fullReplacement ? yaml.dump({metadata, entries: original.entries}) : undefined});
      expect(source).toBeDefined(); expect(source!.serialize()).toBe(sourceState);
      const publication = manager.cached('head.yaml')!;
      const raw = yaml.load((await f.owners.readHeadSnapshot('head.yaml')).content, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>; entries: unknown[]};
      expect(raw.metadata.name).toBe('Owned memory'); expect(raw.metadata.unique_id).toBe(original.metadata.unique_id);
      expect(raw.metadata.created).toBe(original.metadata.created); expect(raw.metadata.version).toBe('3.4.5');
      expect(raw.metadata.custom).toEqual({value: 'retained'}); expect(raw.entries).toEqual(original.entries);
      expect(publication.instructions).toBe('Original instructions'); expect(publication.extensions).toEqual({nested: {value: 'original'}});
      expect(response!.displayName).toBe('Owned memory'); expect(response!.metadata.description).toBe('Nullable display-name edit');
      expect((await store.findByName(USER, 'memories', 'owned-memory'))!.contentHash).toBe(response!.contentHash);
    } finally {await f.cleanup();}
  });

  it('still refuses explicit nonnull displayName renames before dispatch', async () => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const before = await store.findByName(USER, 'memories', 'owned-memory');
      const snapshot = await f.owners.readHeadSnapshot('head.yaml');
      const save = jest.spyOn(manager, 'save'); const write = jest.spyOn(f.owners, 'updateOwnedHead');
      await expect(store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1,
        expectedContentHash: before!.contentHash, displayName: 'Other name', now: new Date()})).rejects.toThrow('rename');
      expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
      expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(snapshot);
    } finally {await f.cleanup();}
  });

  it.each([
    {fullReplacement: false, version: 'invalid'},
    {fullReplacement: true, version: 'invalid'},
    {fullReplacement: false, version: '1.0.0-!'},
    {fullReplacement: true, version: '1.0.0-!'},
    {fullReplacement: false, version: null},
    {fullReplacement: true, version: null},
    {fullReplacement: false, version: false},
    {fullReplacement: true, version: false},
    {fullReplacement: false, version: 0},
    {fullReplacement: true, version: 0},
    {fullReplacement: false, version: ''},
    {fullReplacement: true, version: ''},
  ])('refuses invalid persisted version $version before dispatch for full replacement=$fullReplacement', async ({fullReplacement, version}) => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const before = await store.findByName(USER, 'memories', 'owned-memory');
      const snapshot = await f.owners.readHeadSnapshot('head.yaml');
      const definition = yaml.load(snapshot.content) as {entries: unknown[]};
      let source: Memory | undefined; let sourceState: string | undefined;
      const find = manager.findGuardedMemoryForUpdate.bind(manager);
      const lookup = jest.spyOn(manager, 'findGuardedMemoryForUpdate').mockImplementation(async (...args) => {
        const target = await find(...args);
        source = target?.memory; sourceState = source?.serialize();
        return target;
      });
      const save = jest.spyOn(manager, 'save'); const write = jest.spyOn(f.owners, 'updateOwnedHead');
      const content = fullReplacement ? yaml.dump({metadata: {version}, entries: definition.entries}) : undefined;
      await expect(store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1,
        expectedContentHash: before!.contentHash, now: new Date(), content,
        metadata: fullReplacement ? {description: 'Invalid full replacement'} : {version}})).rejects.toThrow('Version');
      expect(save).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
      expect(await f.owners.readHeadSnapshot('head.yaml')).toEqual(snapshot);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(source).toBeDefined(); expect(source!.serialize()).toBe(sourceState);
      expect(source!.version).toBe('1.0.0'); expect(source!.validate().valid).toBe(true);
      expect((await store.findByName(USER, 'memories', 'owned-memory'))!.contentHash).toBe(before!.contentHash);
    } finally {await f.cleanup();}
  });

  it.each([
    {fullReplacement: false, version: '02.3', expected: '2.3.0'},
    {fullReplacement: true, version: '02.3', expected: '2.3.0'},
    {fullReplacement: false, version: '0', expected: '0.0.0'},
    {fullReplacement: true, version: '0', expected: '0.0.0'},
    {fullReplacement: false, version: undefined, expected: '3.4.5'},
    {fullReplacement: true, version: undefined, expected: '3.4.5'},
  ])('keeps persisted version $version coherent for full replacement=$fullReplacement', async ({fullReplacement, version, expected}) => {
    const f = await fixture(version === undefined ? {version: '3.4.5'} : {});
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const before = await store.findByName(USER, 'memories', 'owned-memory');
      const snapshot = await f.owners.readHeadSnapshot('head.yaml');
      const definition = yaml.load(snapshot.content) as {entries: unknown[]};
      const metadata = version === undefined ? {description: 'Omitted version edit'} : {version};
      const content = fullReplacement ? yaml.dump({metadata, entries: definition.entries}) : undefined;
      const response = await store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1,
        expectedContentHash: before!.contentHash, now: new Date(), content, metadata: fullReplacement ? undefined : metadata});
      const publication = manager.cached('head.yaml')!;
      const persisted = await f.owners.readHeadSnapshot('head.yaml');
      const raw = yaml.load(persisted.content) as {metadata: Record<string, unknown>; entries: unknown[]};
      expect(publication.version).toBe(expected); expect(publication.metadata.version).toBe(expected);
      expect(JSON.parse(publication.serialize()).version).toBe(expected);
      expect(raw.metadata.version).toBe(expected); expect(response!.metadata.version).toBe(expected);
      expect((await store.findByName(USER, 'memories', 'owned-memory'))!.contentHash).toBe(response!.contentHash);
      expect(raw.entries).toEqual(definition.entries);
      expect(raw.metadata.unique_id).toBe(before!.metadata.unique_id);
      expect(publication.instructions).toBe('Original instructions');
      expect(publication.extensions).toEqual({nested: {value: 'original'}});
      const reloaded = await f.makeManager().manager.load('head.yaml');
      expect(reloaded.version).toBe(expected); expect(reloaded.metadata.version).toBe(expected);
      expect(reloaded.validate().valid).toBe(true);
    } finally {await f.cleanup();}
  });

  it.each([false, true])('advances captured modification time for full replacement=%s', async fullReplacement => {
    const f = await fixture({version: '3.4.5'}, undefined, false, raw => {
      const definition = yaml.load(raw, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>};
      definition.metadata.modified = '2025-01-01T00:00:00.000Z';
      definition.metadata.custom = {value: 'preserved'};
      return yaml.dump(definition, {lineWidth: -1, noRefs: true});
    });
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      let before = await store.findByName(USER, 'memories', 'owned-memory');
      const snapshot = await f.owners.readHeadSnapshot('head.yaml');
      const definition = yaml.load(snapshot.content, {schema: yaml.JSON_SCHEMA}) as {entries: unknown[]};
      let source: Memory | undefined; let sourceState: string | undefined;
      const find = manager.findGuardedMemoryForUpdate.bind(manager);
      jest.spyOn(manager, 'findGuardedMemoryForUpdate').mockImplementation(async (...args) => {
        const target = await find(...args);
        source = target?.memory; sourceState = source?.serialize();
        return target;
      });
      for (const now of [new Date('2026-10-05T12:00:00.000Z'), new Date('2026-10-06T13:00:00.000Z')]) {
        const metadata = {description: 'Timestamp edit', modified: '1999-01-01T00:00:00.000Z'};
        const content = fullReplacement ? yaml.dump({metadata, entries: definition.entries}) : undefined;
        const response = await store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1,
          expectedContentHash: before!.contentHash, now, content, metadata});
        expect(source).toBeDefined(); expect(source!.serialize()).toBe(sourceState);
        const publication = manager.cached('head.yaml')!;
        const persisted = await f.owners.readHeadSnapshot('head.yaml');
        const raw = yaml.load(persisted.content, {schema: yaml.JSON_SCHEMA}) as {metadata: Record<string, unknown>; entries: unknown[]};
        expect(publication.metadata.modified).toBe(now.toISOString());
        expect(raw.metadata.modified).toBe(now.toISOString());
        expect(response!.metadata.modified).toBe(now.toISOString());
        expect(response!.updatedAt).toEqual(now);
        expect(raw.metadata.created).toBe(before!.metadata.created);
        expect(raw.metadata.unique_id).toBe(before!.metadata.unique_id);
        expect(raw.metadata.version).toBe('3.4.5'); expect(raw.metadata.custom).toEqual({value: 'preserved'});
        expect(raw.entries).toEqual(definition.entries);
        expect(publication.instructions).toBe('Original instructions');
        expect(publication.extensions).toEqual({nested: {value: 'original'}});
        const next = await store.findByName(USER, 'memories', 'owned-memory');
        expect(next!.updatedAt).toEqual(now); expect(next!.metadata.modified).toBe(now.toISOString());
        expect(next!.contentHash).toBe(response!.contentHash);
        expect(response!.contentHash).not.toBe(before!.contentHash);
        before = next;
      }
    } finally {await f.cleanup();}
  });

  it.each([false, true])('keeps legacy config precedence in the committed publication for full replacement=%s', async fullReplacement => {
    let originalEntries: unknown[] = [];
    const f = await fixture({maxEntries: 3, onFull: 'error'}, undefined, false, raw => {
      const definition = yaml.load(raw) as Record<string, unknown> & {metadata: Record<string, unknown>; entries: unknown[]};
      Object.assign(definition.metadata, {storage_backend: 'file', privacy_level: 'sensitive',
        retention_policy: {default: '7 days', custom: 'retained'}, storageBackend: 'memory', privacyLevel: 'public',
        retentionDays: 99, custom: {nested: {value: 'unknown metadata retained'}}});
      originalEntries = definition.entries;
      return yaml.dump(definition, {lineWidth: -1, noRefs: true});
    });
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const source = await manager.load('head.yaml');
      expect(source.metadata).toMatchObject({storageBackend: 'file', privacyLevel: 'sensitive', retentionDays: 7});
      const before = await store.findByName(USER, 'memories', 'owned-memory');
      const content = fullReplacement ? yaml.dump({metadata: {description: 'Structured legacy edit'}, entries: originalEntries}) : undefined;
      const response = await store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1,
        expectedContentHash: before!.contentHash, now: new Date(), content, metadata: {description: 'Legacy edit',
          storageBackend: 'memory', privacyLevel: 'public', retentionDays: 99}});
      const publication = manager.cached('head.yaml')!;
      expect(publication).toBeDefined();
      expect(publication.metadata).toMatchObject({storageBackend: 'file', privacyLevel: 'sensitive', retentionDays: 7,
        storage_backend: 'file', privacy_level: 'sensitive', retention_policy: {default: '7 days', custom: 'retained'},
        custom: {nested: {value: 'unknown metadata retained'}}, maxEntries: 3, onFull: 'error'});
      expect(publication.instructions).toBe('Original instructions');
      expect(publication.extensions).toEqual({nested: {value: 'original'}});
      expect([...publication.getEntries().values()]).toEqual([...source.getEntries().values()]);
      expect(response!.metadata.unique_id).toBe(before!.metadata.unique_id);
      expect(response!.metadata).toMatchObject({storageBackend: 'file', privacyLevel: 'sensitive', retentionDays: 7});
      const next = await store.findByName(USER, 'memories', 'owned-memory');
      expect(next!.contentHash).toBe(response!.contentHash);
      expect(next!.metadata).toMatchObject({storageBackend: 'file', privacyLevel: 'sensitive', retentionDays: 7});
      const entry = await publication.addEntry('Added using committed runtime config');
      expect(entry.privacyLevel).toBe('sensitive');
      const expectedExpiry = new Date(entry.timestamp);
      expectedExpiry.setDate(expectedExpiry.getDate() + 7);
      expect(Math.abs(entry.expiresAt!.getTime() - expectedExpiry.getTime())).toBeLessThan(1000);
      await publication.addEntry('Third entry stays within the original limit');
      await expect(publication.addEntry('Fourth entry must refuse')).rejects.toThrow('full');
      expect(publication.getEntries().size).toBe(3);
    } finally {await f.cleanup();}
  });

  it.each([
    {format: 'flat YAML', nested: false, frontmatter: false},
    {format: 'nested YAML', nested: true, frontmatter: false},
    {format: 'flat frontmatter', nested: false, frontmatter: true},
    {format: 'nested frontmatter', nested: true, frontmatter: true},
  ])('adopts the captured constructor identity for $format without a persisted ID', async ({nested, frontmatter}) => {
    const body = '# Legacy body without a persisted identity';
    const f = await fixture({}, undefined, false, raw => {
      const definition = yaml.load(raw) as Record<string, unknown> & {metadata: Record<string, unknown>};
      delete definition.metadata.unique_id;
      const {metadata, ...auxiliary} = definition;
      const serialized = yaml.dump(nested ? definition : {...metadata, ...auxiliary}, {lineWidth: -1, noRefs: true});
      return frontmatter ? `---\n${serialized}---\n\n${body}\n` : serialized;
    });
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const before = await store.findByName(USER, 'memories', 'owned-memory');
      expect(before!.metadata.unique_id).toBeUndefined();
      const find = jest.spyOn(manager, 'findGuardedMemoryForUpdate');
      const input = {userId: USER, type: 'memories' as const, canonicalName: 'owned-memory', expectedVersion: 1, now: new Date()};
      const response = await store.update({...input, expectedContentHash: before!.contentHash, metadata: {description: 'First edit'}});
      const found = find.mock.results[0];
      if (found.type !== 'return') throw new Error('Expected same-read identity capture');
      const observed = await found.value;
      expect(response!.metadata.unique_id).toBe(observed!.memory.id);
      expect(response!.metadata.unique_id).toMatch(/^memories_owned-memory_\d+$/u);
      const loaded = await manager.load('head.yaml');
      expect(loaded.instructions).toBe('Original instructions');
      expect(loaded.extensions).toEqual({nested: {value: 'original'}});
      expect([...loaded.getEntries().values()]).toEqual([...observed!.memory.getEntries().values()]);
      const subsequent = await store.findByName(USER, 'memories', 'owned-memory');
      expect(subsequent!.contentHash).toBe(response!.contentHash);
      expect(subsequent!.metadata.unique_id).toBe(response!.metadata.unique_id);
      const second = await store.update({...input, expectedContentHash: subsequent!.contentHash, metadata: {description: 'Second edit'}});
      expect(second!.metadata.unique_id).toBe(response!.metadata.unique_id);
      expect([...((await manager.load('head.yaml')).getEntries().values())]).toEqual([...loaded.getEntries().values()]);
      expect((await store.findByName(USER, 'memories', 'owned-memory'))!.contentHash).toBe(second!.contentHash);
    } finally {await f.cleanup();}
  });

  it.each(['unique_id', 'name'] as const)('refuses a changed persisted %s before any owned write', async field => {
    const f = await fixture();
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const before = await store.findByName(USER, 'memories', 'owned-memory');
      const raw = await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8');
      const write = jest.spyOn(f.owners, 'updateOwnedHead');
      await expect(store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1,
        expectedContentHash: before!.contentHash, now: new Date(), metadata: {[field]: 'Changed identity'}})).rejects.toThrow(field === 'name' ? 'rename' : 'identity change');
      expect(write).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8')).toBe(raw);
      expect(store.getPendingGuardedUpdate(USER, 'owned-memory')).toBeUndefined();
    } finally {await f.cleanup();}
  });

  it.each([
    {format: 'nested YAML', nested: true, frontmatter: false, persistedEntries: true},
    {format: 'flat YAML', nested: false, frontmatter: false, persistedEntries: true},
    {format: 'nested frontmatter with entries and Markdown', nested: true, frontmatter: true, persistedEntries: true},
    {format: 'flat frontmatter with entries and Markdown', nested: false, frontmatter: true, persistedEntries: true},
    {format: 'frontmatter with only a Markdown body', nested: false, frontmatter: true, persistedEntries: false},
    {format: 'frontmatter without entries or a body', nested: false, frontmatter: true, persistedEntries: false, emptyBody: true},
  ])('preserves same-read content and ETag preconditions for $format metadata edits', async ({nested, frontmatter, persistedEntries, emptyBody}) => {
    const body = emptyBody ? '' : '# Legacy memory\n\nRemember the original Markdown body.';
    let identity: string | undefined;
    const f = await fixture({maxEntries: 1, onFull: 'error'}, undefined, false, raw => {
      const definition = yaml.load(raw) as Record<string, unknown> & {metadata: Record<string, unknown>};
      identity = definition.metadata.unique_id as string;
      definition.metadata.custom = {nested: {value: 'metadata retained'}};
      if (!persistedEntries) delete definition.entries;
      const {metadata, ...auxiliary} = definition;
      const serialized = yaml.dump(nested ? definition : {...metadata, ...auxiliary}, {lineWidth: -1, noRefs: true});
      return frontmatter ? `---\n${serialized}---\n\n${body}\n` : serialized;
    });
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const before = await store.findByName(USER, 'memories', 'owned-memory');
      expect(before).not.toBeNull();
      if (frontmatter) {
        const editable = yaml.load(before!.content, {schema: yaml.JSON_SCHEMA}) as {entries: Array<{content: string}>};
        expect(editable.entries).toHaveLength(Number(persistedEntries) + Number(!emptyBody));
        if (!emptyBody) expect(editable.entries.filter(entry => entry.content === body)).toHaveLength(1);
      }
      const write = jest.spyOn(f.owners, 'updateOwnedHead');
      const input = {userId: USER, type: 'memories' as const, canonicalName: 'owned-memory', expectedVersion: 1, now: new Date()};
      await expect(store.update({...input, expectedContentHash: 'stale', metadata: {description: 'Refused'}})).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
      expect(write).not.toHaveBeenCalled();
      const find = jest.spyOn(manager, 'findGuardedMemoryForUpdate');
      const imported = jest.spyOn(manager, 'importElement');
      const response = await store.update({...input, expectedContentHash: before!.contentHash,
        metadata: {description: 'Metadata edit', maxEntries: 3}});
      const found = find.mock.results[0];
      if (found.type !== 'return') throw new Error('Expected captured memory lookup');
      const observed = await found.value;
      expect(write).toHaveBeenCalledTimes(1); expect(imported).not.toHaveBeenCalled();
      const loaded = await manager.load('head.yaml');
      const persisted = yaml.load(await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8')) as {metadata: Record<string, unknown>};
      expect(loaded.metadata.description).toBe('Metadata edit');
      expect(persisted.metadata.unique_id).toBe(identity);
      expect(persisted.metadata.custom).toEqual({nested: {value: 'metadata retained'}});
      expect(loaded.instructions).toBe('Original instructions');
      expect(loaded.extensions).toEqual({nested: {value: 'original'}});
      const entries = [...loaded.getEntries().values()];
      expect(entries).toHaveLength(Number(persistedEntries) + Number(frontmatter && !emptyBody));
      if (persistedEntries) expect(entries.find(entry => entry.content === 'Original entry')).toBeDefined();
      if (frontmatter && !emptyBody) {
        const capturedBody = [...observed!.memory.getEntries().values()].find(entry => entry.content === body)!;
        expect(capturedBody).toBeDefined();
        expect(entries.find(entry => entry.id === capturedBody.id)).toEqual(capturedBody);
        expect(observed!.memory.metadata.description).toBe('Original description');
      }
      expect(response!.metadata.description).toBe('Metadata edit');
      expect((await store.findByName(USER, 'memories', 'owned-memory'))!.contentHash).toBe(response!.contentHash);
      await store.update({...input, expectedContentHash: response!.contentHash, metadata: {description: 'Second metadata edit'}});
      expect((await manager.load('head.yaml')).getEntries().size).toBe(entries.length);
    } finally {await f.cleanup();}
  });

  it.each(['invalid', 'duplicate'])('retains %s raw frontmatter array entries for strict replacement refusal', async kind => {
    const f = await fixture({}, undefined, false, raw => {
      const definition = yaml.load(raw) as Record<string, unknown> & {entries: unknown[]};
      definition.entries.push(kind === 'duplicate' ? definition.entries[0] : {id: 'invalid'});
      return `---\n${yaml.dump(definition, {noRefs: true})}---\n\n# Preserved body\n`;
    });
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const before = await store.findByName(USER, 'memories', 'owned-memory');
      const raw = await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8');
      const write = jest.spyOn(f.owners, 'updateOwnedHead');
      await expect(store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1,
        expectedContentHash: before!.contentHash, now: new Date(), metadata: {description: 'Must refuse'}})).rejects.toThrow('Replacement contains invalid or duplicate entries');
      expect(write).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8')).toBe(raw);
      expect(store.getPendingGuardedUpdate(USER, 'owned-memory')).toBeUndefined();
    } finally {await f.cleanup();}
  });

  it.each([null, 'invalid entries', {content: 'Not an array'}])('refuses frontmatter with explicit malformed entries %j before any owned write', async entries => {
    const f = await fixture({}, undefined, false, raw => {
      const definition = yaml.load(raw) as Record<string, unknown>;
      return `---\n${yaml.dump({...definition, entries})}---\n\n# Preserved body\n`;
    });
    try {
      const {manager} = f.makeManager(); const store = consoleStore(manager);
      const before = await store.findByName(USER, 'memories', 'owned-memory');
      const raw = await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8');
      const write = jest.spyOn(f.owners, 'updateOwnedHead');
      await expect(store.update({userId: USER, type: 'memories', canonicalName: 'owned-memory', expectedVersion: 1,
        expectedContentHash: before!.contentHash, now: new Date(), metadata: {description: 'Must refuse'}})).rejects.toThrow('Incomplete memory baseline');
      expect(write).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(f.tenantRoot, 'head.yaml'), 'utf8')).toBe(raw);
      expect(store.getPendingGuardedUpdate(USER, 'owned-memory')).toBeUndefined();
    } finally {await f.cleanup();}
  });

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
