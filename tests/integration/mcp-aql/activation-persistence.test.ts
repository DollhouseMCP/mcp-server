/**
 * Integration tests for Per-Session Activation Persistence (Issue #598)
 *
 * Tests the full round-trip through the real DI container:
 * 1. MCP-AQL activate_element → ElementCRUDHandler → ActivationStore records
 * 2. MCP-AQL deactivate_element → ElementCRUDHandler → ActivationStore removes
 * 3. ActivationStore persists to disk → new instance restores state
 * 4. Container.restoreActivations() replays persisted activations on startup
 * 5. Session isolation — different session IDs produce independent state files
 * 6. Stale element retention and explicit clearing after refused restore
 *
 * NOTE: These tests use the real Container wiring with an isolated portfolio
 * directory per test. The ActivationStore is resolved from DI and verified
 * through the MCP-AQL handler pipeline.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import type { IActivationStateStore } from '../../../src/state/IActivationStateStore.js';
import { FileActivationStateStore } from '../../../src/state/FileActivationStateStore.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { BackupService } from '../../../src/services/BackupService.js';
import { Memory } from '../../../src/elements/memories/Memory.js';
import { logger } from '../../../src/utils/logger.js';
import { ElementNotFoundError } from '../../../src/utils/ErrorHandler.js';
import { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import type { OperationResult } from '../../../src/handlers/mcp-aql/types.js';

import { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { SkillManager } from '../../../src/elements/skills/SkillManager.js';
import { EnsembleManager } from '../../../src/elements/ensembles/EnsembleManager.js';
import { AgentManager } from '../../../src/elements/agents/AgentManager.js';
import { RegistrySessionActivationStateAdapter } from '../../../src/web-console/modules/activations/SessionActivationStateAdapter.js';
import { SessionActivationRegistry } from '../../../src/state/SessionActivationState.js';
import { BaseElementManager } from '../../../src/elements/base/BaseElementManager.js';

import type { ConsoleRequest } from '../../../src/web-console/platform/ConsolePlatformTypes.js';

describe('Activation Persistence Integration (Issue #598)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let activationStore: IActivationStateStore;

  // Save env vars we modify
  let originalSessionId: string | undefined;
  let originalPersistenceFlag: string | undefined;

  beforeEach(async () => {
    originalSessionId = process.env.DOLLHOUSE_SESSION_ID;
    originalPersistenceFlag = process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE;

    // Set a test session ID so we get a predictable file path
    process.env.DOLLHOUSE_SESSION_ID = 'integration-test';
    delete process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE; // ensure enabled

    env = await createPortfolioTestEnvironment('mcp-aql-activation');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server and all managers
    preConfirmAllOperations(container);

    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    activationStore = container.resolve<IActivationStateStore>('ActivationStore');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await server.dispose();
    await env.cleanup();

    // Restore env vars
    if (originalSessionId === undefined) {
      delete process.env.DOLLHOUSE_SESSION_ID;
    } else {
      process.env.DOLLHOUSE_SESSION_ID = originalSessionId;
    }
    if (originalPersistenceFlag === undefined) {
      delete process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE;
    } else {
      process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE = originalPersistenceFlag;
    }
  });

  async function createActive(type: 'persona' | 'skill' | 'ensemble' | 'agent', name: string) {
    const create = await mcpAqlHandler.handleCreate({
      operation: 'create_element', element_type: type,
      params: { element_name: name, description: 'Activation lifecycle regression',
        instructions: 'Follow the test instructions.', content: 'Test instructions.', },
    }) as OperationResult;
    expect(create.success).toBe(true);
    const handler = container.resolve<ElementCRUDHandler>('ElementCRUDHandler');
    expect((await handler.activateElement(name, type)).content[0].text).not.toContain('❌');
    const manager = type === 'persona' ? container.resolve<PersonaManager>('PersonaManager')
      : type === 'skill' ? container.resolve<SkillManager>('SkillManager')
        : type === 'ensemble' ? container.resolve<EnsembleManager>('EnsembleManager')
          : container.resolve<AgentManager>('AgentManager');
    expect(activationStore.getActivations(type)).toHaveLength(1);
    expect(manager['getActivationSet']().size).toBe(1);
    return { handler, manager };
  }

  it.each([
    { type: 'persona' as const, byFilename: false },
    { type: 'persona' as const, byFilename: true },
    { type: 'skill' as const, byFilename: false },
    { type: 'ensemble' as const, byFilename: false },
    { type: 'agent' as const, byFilename: false },
    { type: 'agent' as const, byFilename: true },
  ])('clears LIVE and persisted $type after definition disappears (filename: $byFilename)', async ({ type, byFilename }) => {
    const name = `live-missing-${type}`;
    const { handler, manager } = await createActive(type, name);
    const record = activationStore.getActivations(type)[0];
    const filename = record.identity?.value ?? record.filename ?? `${name}.md`;
    const file = path.join(env.testDir, `${type}s`, filename);
    const original = await fs.readFile(file);
    await fs.unlink(file);
    manager.clearCache();
    await manager.scanAndEvict({ freshAfterInFlight: true });
    expect((await handler.deactivateElement(byFilename ? filename : name, type)).content[0].text).not.toContain('❌');
    expect(manager['getActivationSet']().size).toBe(0);
    expect(activationStore.getActivations(type)).toEqual([]);
    await fs.writeFile(file, original);
    manager.clearCache();
    await manager.scanAndEvict({ freshAfterInFlight: true });
    await container['restoreActivations'](activationStore);
    expect(manager['getActivationSet']().size).toBe(0);
  });

  it.each(['persona', 'skill', 'ensemble', 'agent'] as const)('delete clears the caller persisted %s activation and does not restore a recreation', async type => {
    const name = `delete-active-${type}`;
    const { handler, manager } = await createActive(type, name);
    const record = activationStore.getActivations(type)[0];
    const filename = record.identity?.value ?? record.filename ?? `${name}.md`;
    const file = path.join(env.testDir, `${type}s`, filename);
    const original = await fs.readFile(file);
    const other = container.resolve<SessionActivationRegistry>('SessionActivationRegistry').getOrCreate('other-session');
    const otherStore = new FileActivationStateStore(container.resolve('FileOperationsService'), path.join(env.testDir, 'other-state'), 'other-session');
    await otherStore.initialize();
    other.activationStore = otherStore;
    otherStore.recordActivation(type, name, record.filename, record.identity);
    expect((await handler.deleteElement({ name, type })).content[0].text).toContain('✅');
    expect(activationStore.getActivations(type)).toEqual([]);
    expect(manager['getActivationSet']().size).toBe(0);
    expect(otherStore.getActivations(type)).toHaveLength(1);
    const warn = jest.spyOn(logger, 'warn');
    await container['restoreActivations'](activationStore);
    expect(warn.mock.calls.filter(([message]) => message.startsWith('[Activation]'))).toEqual([]);
    await fs.writeFile(file, original);
    manager.clearCache();
    await manager.scanAndEvict({ freshAfterInFlight: true });
    await container['restoreActivations'](activationStore);
    expect(manager['getActivationSet']().size).toBe(0);
  });

  it.each([
    ['persona', false, false], ['skill', false, false], ['ensemble', false, false], ['agent', false, false], ['persona', true, false],
    ['skill', false, true], ['persona', false, true],
  ] as const)('preserves a recreated %s activation while old deletion cleanup is paused (inside manager=%s, backup pruning=%s)', async (type, insideManager, backupPruning) => {
    const name = `recreated-${type}`;
    const { handler, manager } = await createActive(type, name);
    const record = activationStore.getActivations(type)[0];
    const filename = record.identity?.value ?? record.filename ?? `${name}.md`;
    const file = path.join(env.testDir, `${type}s`, filename);
    const original = await fs.readFile(file);
    let entered!: () => void;
    const committed = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void;
    const barrier = new Promise<void>(resolve => { resume = resolve; });
    if (backupPruning) {
      const backup = new BackupService(container.resolve('FileOperationsService'), {
        enabled: true, backupRootDir: path.join(env.testDir, '.backups'), maxBackupsPerElement: 5,
      });
      jest.spyOn(manager as any, 'resolveBackupService').mockReturnValue(backup);
      jest.spyOn(backup, 'pruneBackups').mockImplementationOnce(async () => {
        entered();
        await barrier;
      });
    } else {
      const realDelete = insideManager ? BaseElementManager.prototype.delete.bind(manager) : manager.delete.bind(manager);
      jest.spyOn(insideManager ? BaseElementManager.prototype : manager, 'delete').mockImplementationOnce(async (locator, onCommitted) => {
        await realDelete(locator, onCommitted);
        entered();
        await barrier;
      });
    }
    const deletion = handler.deleteElement({ name, type });
    await committed;
    try {
      await fs.writeFile(file, original);
      manager.clearCache();
      await manager.scanAndEvict({ freshAfterInFlight: true });
      expect((await handler.activateElement(name, type)).content[0].text).not.toContain('❌');
    } finally {
      resume();
    }
    expect((await deletion).content[0].text).toContain('✅');
    expect(manager['getActivationSet']().size).toBe(1);
    expect(activationStore.getActivations(type)).toHaveLength(1);
  });

  it('deletes a healthy skill while retaining an unrelated throwing activation lookup', async () => {
    const { handler, manager } = await createActive('skill', 'healthy-skill');
    activationStore.recordActivation('skill', 'unloadable-skill');
    const find = manager.findByName.bind(manager);
    jest.spyOn(manager, 'findByName').mockImplementation(async name => {
      if (name === 'unloadable-skill') throw new Error('Malformed unrelated definition');
      return find(name);
    });
    expect((await handler.deleteElement({ name: 'healthy-skill', type: 'skill' })).content[0].text).toContain('✅');
    expect(activationStore.getActivations('skill').map(record => record.name)).toEqual(['unloadable-skill']);
    expect(manager['getActivationSet']().size).toBe(0);
  });

  it('clears saved persona activation when postcommit reload throws', async () => {
    const name = 'postcommit-reload-failure';
    const { handler } = await createActive('persona', name);
    const manager = container.resolve<PersonaManager>('PersonaManager');
    const failure = new Error('Injected postcommit reload failure');
    jest.spyOn(manager, 'reload').mockRejectedValueOnce(failure);
    const result = await handler.deleteElement({ name, type: 'persona' });
    expect(result.content[0].text).toContain('❌');
    expect(result.content[0].text).toContain(failure.message);
    await expect(fs.access(path.join(env.testDir, 'personas', `${name}.md`))).rejects.toThrow();
    expect(activationStore.getActivations('persona')).toEqual([]);
    expect(manager['getActivationSet']().size).toBe(0);
  });

  it.each(['skill', 'persona'] as const)('clears a doomed %s reactivated before deletion commits', async type => {
    const name = `precommit-${type}`;
    const { handler, manager } = await createActive(type, name);
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void;
    const barrier = new Promise<void>(resolve => { resume = resolve; });
    const backup = manager['createBackupBeforeDelete'].bind(manager);
    jest.spyOn(manager as any, 'createBackupBeforeDelete').mockImplementationOnce(async (file: unknown, onCommitted: unknown) => {
      entered();
      await barrier;
      return backup(file as string, onCommitted as (() => void) | undefined);
    });
    const deletion = handler.deleteElement({ name, type });
    await pending;
    try {
      expect((await handler.activateElement(name, type)).content[0].text).not.toContain('❌');
    } finally {
      resume();
    }
    expect((await deletion).content[0].text).toContain('✅');
    expect(activationStore.getActivations(type)).toEqual([]);
    expect(manager['getActivationSet']().size).toBe(0);
  });

  it.each([
    { type: 'skill' as const, initiallyActive: false },
    { type: 'persona' as const, initiallyActive: false },
    { type: 'skill' as const, initiallyActive: true },
    { type: 'persona' as const, initiallyActive: true },
  ])('clears newly accepted $type activation during deletion (initiallyActive=$initiallyActive)', async ({ type, initiallyActive }) => {
    const name = `Pending ${type}`;
    const { handler, manager } = await createActive(type, name);
    if (!initiallyActive) await handler.deactivateElement(name, type);
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void;
    const barrier = new Promise<void>(resolve => { resume = resolve; });
    const backup = manager['createBackupBeforeDelete'].bind(manager);
    jest.spyOn(manager as any, 'createBackupBeforeDelete').mockImplementationOnce(async (file: unknown, onCommitted: unknown) => {
      entered();
      await barrier;
      return backup(file as string, onCommitted as (() => void) | undefined);
    });
    const deletion = handler.deleteElement({ name, type });
    await pending;
    try {
      const alias = initiallyActive ? `pending-${type}` : name;
      expect((await handler.activateElement(alias, type)).content[0].text).not.toContain('❌');
      expect(activationStore.getActivations(type).length).toBeGreaterThan(0);
    } finally {
      resume();
    }
    expect((await deletion).content[0].text).toContain('✅');
    expect(activationStore.getActivations(type)).toEqual([]);
    expect(manager['getActivationSet']().size).toBe(0);
  });

  it.each(['skill', 'persona'] as const)('enrols console %s activation while an MCP delete is pending', async type => {
    const name = `console-${type}`;
    const { handler, manager } = await createActive(type, name);
    await handler.deactivateElement(name, type);
    const registry = container.resolve<SessionActivationRegistry>('SessionActivationRegistry');
    const sessionId = registry.getDefaultSessionId();
    registry.getOrCreate(sessionId).activationStore = activationStore;
    const adapter = new RegistrySessionActivationStateAdapter(registry, () => manager);
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void;
    const barrier = new Promise<void>(resolve => { resume = resolve; });
    const backup = manager['createBackupBeforeDelete'].bind(manager);
    jest.spyOn(manager as any, 'createBackupBeforeDelete').mockImplementationOnce(async (file: unknown, onCommitted: unknown) => {
      entered();
      await barrier;
      return backup(file as string, onCommitted as (() => void) | undefined);
    });
    const deletion = handler.deleteElement({ name, type });
    await pending;
    try {
      const result = await adapter.activate(sessionId, type === 'skill' ? 'skills' : 'personas', name);
      expect(result.record.name).toBe(name);
      expect(result.changed).toBe(true);
      expect(activationStore.getActivations(type)).toHaveLength(1);
    } finally {
      resume();
    }
    expect((await deletion).content[0].text).toContain('✅');
    expect(activationStore.getActivations(type)).toEqual([]);
    expect(manager['getActivationSet']().size).toBe(0);
  });

  it('enrols mixed-case skill activation through ActivationService during pending deletion', async () => {
    const { ActivationService } = await import('../../../src/web-console/modules/activations/ActivationService.js');
    const { InMemoryPortfolioElementStore } = await import('../../../src/web-console/stores/InMemoryPortfolioElementStore.js');
    const { InMemoryRuntimeSessionControlStore } = await import('../../../src/web-console/services/runtime/InMemoryRuntimeSessionControlStore.js');
    const type = 'skill';
    const name = 'My Console Skill';
    const { handler, manager } = await createActive(type, name);
    await handler.deactivateElement(name, type);
    const registry = container.resolve<SessionActivationRegistry>('SessionActivationRegistry');
    const sessionId = registry.getDefaultSessionId();
    registry.getOrCreate(sessionId).activationStore = activationStore;
    const adapter = new RegistrySessionActivationStateAdapter(registry, () => manager);
    const userId = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
    const now = new Date();
    const runtimeStore = new InMemoryRuntimeSessionControlStore();
    await runtimeStore.registerPresence({ sessionId, userId,
      accountCorrelationId: '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8', replicaId: 'test',
      transport: 'streamable-http', startedAt: now, lastActiveAt: now,
      leaseUntil: new Date(now.getTime() + 60000) });
    const portfolioStore = new InMemoryPortfolioElementStore();
    await portfolioStore.create({ userId, type: 'skills', name, displayName: name,
      metadata: { name }, content: 'Test instructions.', tags: [], now });
    const service = new ActivationService({ runtimeStore, portfolioStore, activationState: adapter, now: () => now });
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void;
    const barrier = new Promise<void>(resolve => { resume = resolve; });
    const backup = manager['createBackupBeforeDelete'].bind(manager);
    jest.spyOn(manager as any, 'createBackupBeforeDelete').mockImplementationOnce(async (file: unknown, onCommitted: unknown) => {
      entered();
      await barrier;
      return backup(file as string, onCommitted as (() => void) | undefined);
    });
    const deletion = handler.deleteElement({ name, type });
    await Promise.race([pending, deletion.then(result => { throw new Error(JSON.stringify(result)); })]);
    try {
      expect(manager.hasPendingActivationDeletions(sessionId)).toBe(true);
      expect(manager.hasPendingActivationDeletions('unrelated-session')).toBe(false);
      const result = await service.activate({ body: { type: 'skills', name },
        consoleAuthentication: { userId } } as ConsoleRequest, sessionId);
      expect(result.status).toBe(200);
      expect(registry.get(sessionId)?.skills.has('my console skill')).toBe(true);
      expect(activationStore.getActivations(type)).toHaveLength(1);
    } finally {
      resume();
    }
    expect((await deletion).content[0].text).toContain('✅');
    expect(activationStore.getActivations(type)).toEqual([]);
    expect(manager['getActivationSet']().size).toBe(0);
    expect(manager.hasPendingActivationDeletions(sessionId)).toBe(false);
  });

  it.each(['skill', 'persona'] as const)('preserves postcommit console %s activation', async type => {
    const name = `console-recreated-${type}`;
    const { handler, manager } = await createActive(type, name);
    const registry = container.resolve<SessionActivationRegistry>('SessionActivationRegistry');
    const sessionId = registry.getDefaultSessionId();
    registry.getOrCreate(sessionId).activationStore = activationStore;
    const adapter = new RegistrySessionActivationStateAdapter(registry, () => manager);
    const file = path.join(env.testDir, `${type}s`, `${name}.md`);
    const original = await fs.readFile(file);
    let entered!: () => void;
    const committed = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void;
    const barrier = new Promise<void>(resolve => { resume = resolve; });
    const realDelete = manager.delete.bind(manager);
    jest.spyOn(manager, 'delete').mockImplementationOnce(async (locator, onCommitted) => {
      await realDelete(locator, onCommitted);
      entered();
      await barrier;
    });
    const deletion = handler.deleteElement({ name, type });
    await committed;
    try {
      await fs.writeFile(file, original);
      manager.clearCache();
      await manager.scanAndEvict({ freshAfterInFlight: true });
      await adapter.activate(sessionId, type === 'skill' ? 'skills' : 'personas', name);
    } finally {
      resume();
    }
    expect((await deletion).content[0].text).toContain('✅');
    expect(manager['getActivationSet']().has(name)).toBe(true);
    expect(activationStore.getActivations(type)).toHaveLength(1);
  });

  it('clears accepted skill aliases before recreating a deleted definition', async () => {
    const { handler, manager } = await createActive('skill', 'My Skill');
    await handler.deactivateElement('My Skill', 'skill');
    expect((await handler.activateElement('my-skill', 'skill')).content[0].text).not.toContain('❌');
    expect(activationStore.getActivations('skill')[0].name).toBe('my-skill');
    const file = path.join(env.testDir, 'skills', 'my-skill.md');
    const original = await fs.readFile(file);
    manager.clearCache();
    expect((await handler.deleteElement({ name: 'My Skill', type: 'skill' })).content[0].text).toContain('✅');
    expect(activationStore.getActivations('skill')).toEqual([]);
    const warn = jest.spyOn(logger, 'warn');
    await container['restoreActivations'](activationStore);
    expect(warn.mock.calls.filter(([message]) => message.startsWith('[Activation]'))).toEqual([]);
    await fs.writeFile(file, original);
    manager.clearCache();
    await container['restoreActivations'](activationStore);
    expect(manager['getActivationSet']().size).toBe(0);
  });

  it.each(['delete', 'deactivate'])('uses the filename when duplicate persona names %s', async operation => {
    const { handler, manager } = await createActive('persona', 'duplicate-persona');
    const first = activationStore.getActivations('persona')[0];
    const firstFile = path.join(env.testDir, 'personas', first.filename!);
    const secondFilename = 'second-duplicate.md';
    await fs.copyFile(firstFile, path.join(env.testDir, 'personas', secondFilename));
    await (manager as PersonaManager).reload();
    await (manager as PersonaManager).activatePersona(secondFilename);
    const reference = secondFilename;
    const targetFilename = (await (manager as PersonaManager).findPersonaAsync(reference))!.filename;
    const retainedFilename = targetFilename === secondFilename ? first.filename! : secondFilename;
    activationStore.clearAll();
    // Put the wrong same-name record first to expose accidental OR-based matching.
    activationStore.recordActivation('persona', first.name, retainedFilename, { kind: 'file', value: retainedFilename });
    activationStore.recordActivation('persona', first.name, targetFilename, { kind: 'file', value: targetFilename });
    expect(activationStore.getActivations('persona')).toHaveLength(2);
    const response = operation === 'delete'
      ? await handler.deleteElement({ name: reference, type: 'persona' })
      : await handler.deactivateElement(reference, 'persona');
    expect(response.content[0].text).not.toContain('❌');
    expect(activationStore.getActivations('persona').map(record => record.filename)).toEqual([retainedFilename]);
    expect([...manager['getActivationSet']()]).toEqual([retainedFilename]);
  });

  it('deletes an active file memory through the memory-specific command', async () => {
    const manager = container.resolve<MemoryManager>('MemoryManager');
    const handler = container.resolve<ElementCRUDHandler>('ElementCRUDHandler');
    const name = 'delete-file-memory';
    await manager.save(new Memory({ name }, container.resolve('MetadataService')), `${name}.yaml`);
    await handler.activateElement(name, 'memory');
    expect(activationStore.getActivations('memory')).toHaveLength(1);
    const response = await handler.deleteElement({ name, type: 'memory' });
    expect(response.content[0].text).toContain('✅');
    expect(activationStore.getActivations('memory')).toEqual([]);
    expect(manager['getActivationSet']().size).toBe(0);
    expect(await manager.findByName(name)).toBeUndefined();
  });

  it('preserves a recreated memory activation while old delete completion is paused', async () => {
    const manager = container.resolve<MemoryManager>('MemoryManager');
    const handler = container.resolve<ElementCRUDHandler>('ElementCRUDHandler');
    const name = 'recreated-memory';
    const save = () => manager.save(new Memory({ name }, container.resolve('MetadataService')), `${name}.yaml`);
    await save();
    await handler.activateElement(name, 'memory');
    let entered!: () => void;
    const committed = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void;
    const barrier = new Promise<void>(resolve => { resume = resolve; });
    const realDelete = manager.delete.bind(manager);
    jest.spyOn(manager, 'delete').mockImplementationOnce(async (locator, onCommitted) => {
      await realDelete(locator, onCommitted);
      entered();
      await barrier;
    });
    const deletion = handler.deleteElement({ name, type: 'memory' });
    await committed;
    try {
      await save();
      expect((await handler.activateElement(name, 'memory')).content[0].text).not.toContain('❌');
    } finally {
      resume();
    }
    expect((await deletion).content[0].text).toContain('✅');
    expect(manager['getActivationSet']().has(name)).toBe(true);
    expect(activationStore.getActivations('memory')).toHaveLength(1);
  });

  it.each(['both fail', 'one succeeds', 'deactivate', 'reactivate'])('keeps overlapping persona deletes consistent: %s', async outcome => {
    const name = 'overlapping-delete-persona';
    const { handler, manager } = await createActive('persona', name);
    let entered!: () => void;
    const bothEntered = new Promise<void>(resolve => { entered = resolve; });
    const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    jest.spyOn(BaseElementManager.prototype, 'delete').mockImplementation((_locator, onCommitted) => new Promise<void>((resolve, reject) => {
      pending.push({ resolve: () => { onCommitted?.(); resolve(); }, reject });
      if (pending.length === 2) entered();
    }));
    jest.spyOn(manager as PersonaManager, 'reload').mockResolvedValue(undefined);
    const first = handler.deleteElement({ name, type: 'persona' });
    const second = handler.deleteElement({ name, type: 'persona' });
    await bothEntered;
    if (outcome === 'deactivate') await handler.deactivateElement(name, 'persona');
    if (outcome === 'reactivate') await handler.activateElement(name, 'persona');
    if (outcome === 'one succeeds') pending[0].resolve();
    else pending[0].reject(new Error('first refusal'));
    pending[1].reject(new Error('second refusal'));
    await Promise.all([first, second]);
    const count = outcome === 'both fail' || outcome === 'reactivate' ? 1 : 0;
    expect(manager['getActivationSet']().size).toBe(count);
    expect(activationStore.getActivations('persona')).toHaveLength(count);
  });

  it.each([false, true])('failed persona delete preserves state unless explicitly deactivated while pending (%s)', async deactivate => {
    const name = 'pending-delete-persona';
    const { handler, manager } = await createActive('persona', name);
    const record = activationStore.getActivations('persona')[0];
    let rejectDelete!: (reason: Error) => void;
    let signalEntered!: () => void;
    const entered = new Promise<void>(resolve => { signalEntered = resolve; });
    jest.spyOn(BaseElementManager.prototype, 'delete').mockImplementationOnce(() => {
      signalEntered();
      return new Promise<void>((_resolve, reject) => { rejectDelete = reject; });
    });
    const pending = handler.deleteElement({ name, type: 'persona' });
    await entered;
    if (deactivate) await handler.deactivateElement(record.filename!, 'persona');
    rejectDelete(new Error('Injected delete refusal'));
    expect((await pending).content[0].text).toContain('Injected delete refusal');
    expect(manager['getActivationSet']().size).toBe(deactivate ? 0 : 1);
    expect(activationStore.getActivations('persona')).toHaveLength(deactivate ? 0 : 1);
  });

  it.each([
    { type: 'persona', filename: 'missing-persona.md', reference: 'missing-persona.md' },
    { type: 'persona', filename: 'missing-persona.md', reference: 'missing-persona' },
    { type: 'skill', filename: undefined, reference: 'missing-skill' },
  ])('clears persisted-only $type by exact reference $reference after refused restore', async ({ type, filename, reference }) => {
    const name = `missing-${type}`;
    const identity = filename ? { kind: 'file' as const, value: filename } : undefined;
    activationStore.recordActivation(type, name, filename, identity);
    const warn = jest.spyOn(logger, 'warn');
    const restore = container as unknown as { restoreActivations(store: IActivationStateStore): Promise<void> };
    await restore.restoreActivations(activationStore);
    expect(activationStore.getActivations(type)).toHaveLength(1);
    const handler = container.resolve<ElementCRUDHandler>('ElementCRUDHandler');
    const remove = jest.spyOn(activationStore, 'recordDeactivation');
    await expect(handler.deactivateElement(reference.toUpperCase(), type)).rejects.toBeInstanceOf(ElementNotFoundError);
    expect(activationStore.getActivations(type)).toHaveLength(1);
    const result = await handler.deactivateElement(reference, type);
    expect(result.content[0].text).toContain('✅');
    expect(remove).toHaveBeenCalledWith(`${type}s`, name, filename, identity);
    expect(activationStore.getActivations(type)).toEqual([]);
    activationStore.recordActivation(type, name, filename, identity);
    await restore.restoreActivations(activationStore);
    expect(warn.mock.calls.filter(([message]) => message.startsWith('[Activation]'))).toHaveLength(2);
  });

  it.each(['persona', 'skill'])('keeps an unknown %s without a persisted record not-found', async type => {
    const handler = container.resolve<ElementCRUDHandler>('ElementCRUDHandler');
    await expect(handler.deactivateElement('never-stored', type)).rejects.toBeInstanceOf(ElementNotFoundError);
  });

  it.each([false, true])('uses the existing persistence callback for absent memory deactivation (throws: %s)', async throws => {
    const manager = container.resolve<MemoryManager>('MemoryManager');
    const handler = container.resolve<ElementCRUDHandler>('ElementCRUDHandler');
    const name = 'deleted-active-memory';
    await manager.save(new Memory({ name }, container.resolve('MetadataService')), 'deleted-active-memory.yaml');
    await manager.activateMemory(name);
    activationStore.recordActivation('memory', name);
    await manager.delete('deleted-active-memory.yaml');
    manager.clearCache();
    const remove = jest.spyOn(activationStore, 'recordDeactivation');
    if (throws) remove.mockImplementation(() => { throw new Error('Injected persistence failure'); });
    try {
      const result = await handler.deactivateElement(name, 'memory');
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith('memories', name, undefined, undefined);
      expect(activationStore.getActivations('memory').some(a => a.name === name)).toBe(throws);
      expect(result.content[0].text).toContain(throws ? 'Injected persistence failure' : 'deactivated');
      // Current handler publication is not atomic: a callback failure is
      // reported after the runtime reference was cleared, without rollback.
      expect((await manager.deactivateMemory(name)).success).toBe(false);
    } finally { remove.mockRestore(); }
  });

  describe('DI wiring verification', () => {
    it('should have ActivationStore registered as singleton', () => {
      const store1 = container.resolve<IActivationStateStore>('ActivationStore');
      const store2 = container.resolve<IActivationStateStore>('ActivationStore');
      expect(store1).toBe(store2);
    });

    it('should have ActivationStore with correct session ID', () => {
      expect(activationStore.getSessionId()).toBe('integration-test');
    });

    it('should have persistence enabled by default', () => {
      expect(activationStore.isEnabled()).toBe(true);
    });
  });

  describe('Activate → Store round-trip', () => {
    it('should record skill activation in ActivationStore after MCP-AQL activate_element', async () => {
      // Step 1: Create a skill so we have something to activate
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'skill',
        params: {
          element_name: 'test-activation-skill',
          description: 'A test skill for activation persistence',
          content: 'Test skill instructions for activation persistence testing.',
        },
      }) as OperationResult;
      expect(createResult.success).toBe(true);

      // Allow cache settle
      await new Promise(resolve => setTimeout(resolve, 500));

      // Step 2: Activate the skill via MCP-AQL
      const activateResult = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: {
          element_name: 'test-activation-skill',
          element_type: 'skill',
        },
      }) as OperationResult;
      expect(activateResult.success).toBe(true);

      // Step 3: Verify ActivationStore recorded the activation
      const storedActivations = activationStore.getActivations('skill');
      expect(storedActivations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'test-activation-skill' }),
        ])
      );
    });

    it('should record memory activation in ActivationStore after MCP-AQL activate_element', async () => {
      // Create a memory
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'memory',
        params: {
          element_name: 'test-activation-memory',
          description: 'A test memory for activation persistence',
        },
      }) as OperationResult;
      expect(createResult.success).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 500));

      // Activate via MCP-AQL
      const activateResult = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: {
          element_name: 'test-activation-memory',
          element_type: 'memory',
        },
      }) as OperationResult;
      expect(activateResult.success).toBe(true);

      // Verify ActivationStore recorded it
      const storedActivations = activationStore.getActivations('memory');
      expect(storedActivations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'test-activation-memory' }),
        ])
      );
    });

    it('should remove skill from ActivationStore after MCP-AQL deactivate_element', async () => {
      // Create and activate a skill
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'skill',
        params: {
          element_name: 'test-deactivation-skill',
          description: 'A test skill for deactivation persistence',
          content: 'Test skill instructions for deactivation.',
        },
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: {
          element_name: 'test-deactivation-skill',
          element_type: 'skill',
        },
      });

      // Verify it's in the store
      let stored = activationStore.getActivations('skill');
      expect(stored.some(a => a.name === 'test-deactivation-skill')).toBe(true);

      // Deactivate via MCP-AQL
      const deactivateResult = await mcpAqlHandler.handleRead({
        operation: 'deactivate_element',
        params: {
          element_name: 'test-deactivation-skill',
          element_type: 'skill',
        },
      }) as OperationResult;
      expect(deactivateResult.success).toBe(true);

      // Verify it's removed from the store
      stored = activationStore.getActivations('skill');
      expect(stored.some(a => a.name === 'test-deactivation-skill')).toBe(false);
    });
  });

  describe('get_active_elements reflects persisted state', () => {
    it('should include activated element in get_active_elements response', async () => {
      // Create and activate a skill
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'skill',
        params: {
          element_name: 'test-active-list-skill',
          description: 'Test skill for active listing',
          content: 'Active listing test instructions.',
        },
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: {
          element_name: 'test-active-list-skill',
          element_type: 'skill',
        },
      });

      // Get active elements via MCP-AQL
      const activeResult = await mcpAqlHandler.handleRead({
        operation: 'get_active_elements',
        params: { element_type: 'skill' },
      }) as OperationResult;

      expect(activeResult.success).toBe(true);
      if (activeResult.success) {
        // The response should contain our activated skill
        const data = activeResult.data;
        const text = typeof data === 'string' ? data : JSON.stringify(data);
        expect(text).toContain('test-active-list-skill');
      }
    });
  });

  describe('Disk persistence round-trip', () => {
    it('should persist activation to disk and load in new store instance', async () => {
      // Create a temp state dir we control
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-integration-'));

      try {
        // Create a store with known state dir
        const fileOps = container.resolve<any>('FileOperationsService');
        const store1 = new FileActivationStateStore(fileOps, stateDir);
        await store1.initialize();

        // Record some activations
        store1.recordActivation('skill', 'my-skill');
        store1.recordActivation('memory', 'my-memory');
        store1.recordActivation('persona', 'My Persona', 'my-persona.md');

        // Allow async persist to complete
        await new Promise(resolve => setTimeout(resolve, 300));

        // Verify file was written
        const files = await fs.readdir(stateDir);
        expect(files.some(f => f.startsWith('activations-'))).toBe(true);

        // Create a NEW store instance and load from the same directory
        const store2 = new FileActivationStateStore(fileOps, stateDir);
        await store2.initialize();

        // Verify round-trip
        const skills = store2.getActivations('skill');
        expect(skills).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'my-skill' })])
        );

        const memories = store2.getActivations('memory');
        expect(memories).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'my-memory' })])
        );

        const personas = store2.getActivations('persona');
        expect(personas).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'My Persona', filename: 'my-persona.md' }),
          ])
        );
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });

    it('should handle deactivation persisted across store instances', async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-deactivate-'));

      try {
        const fileOps = container.resolve<any>('FileOperationsService');

        // Store 1: activate two skills, deactivate one
        const store1 = new FileActivationStateStore(fileOps, stateDir);
        await store1.initialize();
        store1.recordActivation('skill', 'keep-me');
        store1.recordActivation('skill', 'remove-me');
        await new Promise(resolve => setTimeout(resolve, 200));

        store1.recordDeactivation('skill', 'remove-me');
        await new Promise(resolve => setTimeout(resolve, 200));

        // Store 2: load and verify
        const store2 = new FileActivationStateStore(fileOps, stateDir);
        await store2.initialize();

        const skills = store2.getActivations('skill');
        expect(skills.some(a => a.name === 'keep-me')).toBe(true);
        expect(skills.some(a => a.name === 'remove-me')).toBe(false);
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe('Session isolation', () => {
    it('should produce different files for different session IDs', async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-sessions-'));

      try {
        const fileOps = container.resolve<any>('FileOperationsService');

        // Session A: activate skill-a
        process.env.DOLLHOUSE_SESSION_ID = 'session-alpha';
        const storeA = new FileActivationStateStore(fileOps, stateDir);
        await storeA.initialize();
        storeA.recordActivation('skill', 'skill-a');
        await new Promise(resolve => setTimeout(resolve, 200));

        // Session B: activate skill-b (different skill)
        process.env.DOLLHOUSE_SESSION_ID = 'session-beta';
        const storeB = new FileActivationStateStore(fileOps, stateDir);
        await storeB.initialize();
        storeB.recordActivation('skill', 'skill-b');
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify file isolation
        const files = await fs.readdir(stateDir);
        expect(files).toContain('activations-session-alpha.json');
        expect(files).toContain('activations-session-beta.json');

        // Verify data isolation — reload each
        process.env.DOLLHOUSE_SESSION_ID = 'session-alpha';
        const reloadA = new FileActivationStateStore(fileOps, stateDir);
        await reloadA.initialize();
        expect(reloadA.getActivations('skill').some(a => a.name === 'skill-a')).toBe(true);
        expect(reloadA.getActivations('skill').some(a => a.name === 'skill-b')).toBe(false);

        process.env.DOLLHOUSE_SESSION_ID = 'session-beta';
        const reloadB = new FileActivationStateStore(fileOps, stateDir);
        await reloadB.initialize();
        expect(reloadB.getActivations('skill').some(a => a.name === 'skill-b')).toBe(true);
        expect(reloadB.getActivations('skill').some(a => a.name === 'skill-a')).toBe(false);
      } finally {
        // Restore session ID for afterEach
        process.env.DOLLHOUSE_SESSION_ID = 'integration-test';
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe('Stale element pruning', () => {
    it('should load stale activations into memory (pruning happens in Container.restoreActivations)', async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-stale-'));

      try {
        const fileOps = container.resolve<any>('FileOperationsService');

        // Write a fake activation file referencing a skill that doesn't exist
        const fakeState = {
          version: 1,
          sessionId: 'integration-test',
          lastUpdated: new Date().toISOString(),
          activations: {
            skill: [
              { name: 'nonexistent-skill-xyz', activatedAt: new Date().toISOString() },
            ],
          },
        };

        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          path.join(stateDir, 'activations-integration-test.json'),
          JSON.stringify(fakeState, null, 2)
        );

        // Load the store — should succeed (loads in-memory)
        const store = new FileActivationStateStore(fileOps, stateDir);
        await store.initialize();

        // The store should have the activation loaded
        const activations = store.getActivations('skill');
        expect(activations).toHaveLength(1);
        expect(activations[0].name).toBe('nonexistent-skill-xyz');
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe('Corrupt file resilience', () => {
    it('should start fresh when activation file contains invalid JSON', async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-corrupt-'));

      try {
        const fileOps = container.resolve<any>('FileOperationsService');

        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          path.join(stateDir, 'activations-integration-test.json'),
          'NOT_VALID_JSON{{{corrupted'
        );

        const store = new FileActivationStateStore(fileOps, stateDir);
        await store.initialize(); // Should not throw

        // Should start with empty activations
        expect(store.getActivations('skill')).toEqual([]);
        expect(store.getActivations('persona')).toEqual([]);
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });

    it('should start fresh when activation file has wrong version', async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-version-'));

      try {
        const fileOps = container.resolve<any>('FileOperationsService');

        const futureState = {
          version: 99,
          sessionId: 'integration-test',
          lastUpdated: new Date().toISOString(),
          activations: {
            skill: [{ name: 'future-skill', activatedAt: new Date().toISOString() }],
          },
        };

        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          path.join(stateDir, 'activations-integration-test.json'),
          JSON.stringify(futureState, null, 2)
        );

        const store = new FileActivationStateStore(fileOps, stateDir);
        await store.initialize();

        // Version mismatch should cause it to start fresh
        expect(store.getActivations('skill')).toEqual([]);
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe('Persistence disabled mode', () => {
    it('should not record activations when persistence is disabled', async () => {
      process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE = 'false';

      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-disabled-'));

      try {
        const fileOps = container.resolve<any>('FileOperationsService');
        const store = new FileActivationStateStore(fileOps, stateDir);
        await store.initialize();

        expect(store.isEnabled()).toBe(false);

        store.recordActivation('skill', 'should-not-persist');
        await new Promise(resolve => setTimeout(resolve, 200));

        // No activations recorded
        expect(store.getActivations('skill')).toEqual([]);

        // No file written
        const files = await fs.readdir(stateDir).catch(() => []);
        expect(files.filter(f => f.startsWith('activations-'))).toHaveLength(0);
      } finally {
        delete process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE;
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe('clearAll resets persisted state', () => {
    it('should clear all activations from store and persist empty state', async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-clear-'));

      try {
        const fileOps = container.resolve<any>('FileOperationsService');
        const store = new FileActivationStateStore(fileOps, stateDir);
        await store.initialize();

        store.recordActivation('skill', 'clear-test-skill');
        store.recordActivation('memory', 'clear-test-memory');
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify recorded
        expect(store.getActivations('skill')).toHaveLength(1);
        expect(store.getActivations('memory')).toHaveLength(1);

        // Clear all
        store.clearAll();
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(store.getActivations('skill')).toHaveLength(0);
        expect(store.getActivations('memory')).toHaveLength(0);

        // Reload from disk — should be empty
        const store2 = new FileActivationStateStore(fileOps, stateDir);
        await store2.initialize();
        expect(store2.getActivations('skill')).toHaveLength(0);
        expect(store2.getActivations('memory')).toHaveLength(0);
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  });
});
