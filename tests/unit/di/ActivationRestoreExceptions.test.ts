import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { FileActivationStateStore } from '../../../src/state/FileActivationStateStore.js';
import type { IActivationStateStore, PersistedActivation } from '../../../src/state/IActivationStateStore.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';

const types = ['persona', 'skill', 'agent', 'memory', 'ensemble'] as const;
type RestoreContainer = { restoreActivations(store: IActivationStateStore): Promise<void> };

function createContainer(failedType?: string) {
  const container = new DollhouseContainer();
  const callbacks = new Map(types.map(type => [type, jest.fn<() => Promise<{ success: boolean }>>()]));
  for (const type of types) {
    callbacks.get(type)!.mockResolvedValue({ success: true });
    if (type === failedType) callbacks.get(type)!.mockRejectedValueOnce(new Error('Injected storage outage'));
  }
  container.replace('PersonaManager', () => ({ activatePersona: callbacks.get('persona') }));
  container.replace('SkillManager', () => ({ activateSkill: callbacks.get('skill') }));
  container.replace('AgentManager', () => ({ activateAgentByStorageIdentity: callbacks.get('agent') }));
  container.replace('MemoryManager', () => ({ activateMemory: callbacks.get('memory'), getActiveMemories: async () => [] }));
  container.replace('EnsembleManager', () => ({ activateEnsemble: callbacks.get('ensemble') }));
  return { container: container as unknown as RestoreContainer, callbacks };
}

function record(name: string): PersistedActivation {
  return { name, filename: `${name}.md`, identity: { kind: 'file', value: `${name}.md` }, activatedAt: '2026-09-30T00:00:00.000Z' };
}

function createStore(records: Record<string, PersistedActivation[]>) {
  return {
    getActivations: (type: string) => records[type] ?? [],
    removeStaleActivation: jest.fn(), recordActivation: jest.fn(), getSessionId: () => 'restore-test',
  } as unknown as IActivationStateStore;
}

describe('Activation restoration exceptions (#2922)', () => {
  const tempDirs: string[] = [];
  const originalPersistence = process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE;
  afterEach(async () => {
    if (originalPersistence === undefined) delete process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE;
    else process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE = originalPersistence;
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
  });

  it.each(types)('retains the exact %s record on exception and restores later records', async type => {
    const failed = record('failed');
    const later = record('later');
    const store = createStore({ [type]: [failed, later] });
    const { container, callbacks } = createContainer(type);
    await container.restoreActivations(store);
    expect(store.removeStaleActivation).not.toHaveBeenCalled();
    expect(store.getActivations(type)).toEqual([failed, later]);
    expect(callbacks.get(type)).toHaveBeenCalledTimes(2);
  });

  it('preserves existing false-result pruning and successful agent identity upgrades', async () => {
    const missing = record('missing');
    const agent = record('agent');
    const store = createStore({ persona: [missing], agent: [agent] });
    const { container, callbacks } = createContainer();
    callbacks.get('persona')!.mockResolvedValue({ success: false });
    callbacks.get('agent')!.mockResolvedValue({ success: true, agent: { metadata: { name: 'renamed' } }, identity: agent.identity } as { success: boolean });
    await container.restoreActivations(store);
    expect(store.removeStaleActivation).toHaveBeenCalledTimes(1);
    expect(store.removeStaleActivation).toHaveBeenCalledWith('persona', missing.name, missing.filename, missing.identity);
    expect(store.recordActivation).toHaveBeenCalledWith('agent', 'renamed', undefined, agent.identity);
  });

  it('does not prune after a successful agent restore whose persistence callback throws', async () => {
    const agent = record('agent');
    const store = createStore({ agent: [agent] });
    const { container, callbacks } = createContainer();
    callbacks.get('agent')!.mockResolvedValue({ success: true, agent: { metadata: { name: agent.name } }, identity: agent.identity } as { success: boolean });
    jest.spyOn(store, 'recordActivation').mockImplementation(() => { throw new Error('Injected persistence failure'); });
    await container.restoreActivations(store);
    expect(store.removeStaleActivation).not.toHaveBeenCalled();
    expect(store.getActivations('agent')).toEqual([agent]);
  });

  it('does not repeat a false-result removal that throws', async () => {
    const store = createStore({ persona: [record('missing'), record('later')] });
    const { container, callbacks } = createContainer();
    callbacks.get('persona')!.mockResolvedValueOnce({ success: false });
    jest.spyOn(store, 'removeStaleActivation').mockImplementation(() => { throw new Error('Injected removal failure'); });
    await container.restoreActivations(store);
    expect(store.removeStaleActivation).toHaveBeenCalledTimes(1);
    expect(callbacks.get('persona')).toHaveBeenCalledTimes(2);
  });

  it('retains a real file-store snapshot across failed restore and a fresh successful retry', async () => {
    delete process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-restore-'));
    tempDirs.push(dir);
    const persisted = { version: 1, sessionId: 'restore-test', lastUpdated: '2026-09-30T00:00:00.000Z', activations: { skill: [record('retry')] } };
    const snapshotPath = path.join(dir, 'activations-restore-test.json');
    const originalBytes = JSON.stringify(persisted);
    await fs.writeFile(snapshotPath, originalBytes);
    const writeFile = jest.fn(async (filename: string, content: string) => fs.writeFile(filename, content));
    const fileOps = { readFile: (filename: string) => fs.readFile(filename, 'utf8'), writeFile } as unknown as FileOperationsService;
    const first = new FileActivationStateStore(fileOps, dir, 'restore-test');
    await first.initialize();
    const removal = jest.spyOn(first, 'removeStaleActivation');
    await createContainer('skill').container.restoreActivations(first);
    expect(removal).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(await fs.readFile(snapshotPath, 'utf8')).toBe(originalBytes);
    const restarted = new FileActivationStateStore(fileOps, dir, 'restore-test');
    await restarted.initialize();
    expect(restarted.getActivations('skill')).toEqual(persisted.activations.skill);
    const retry = createContainer();
    await retry.container.restoreActivations(restarted);
    expect(retry.callbacks.get('skill')).toHaveBeenCalledTimes(1);
    expect(writeFile).not.toHaveBeenCalled();
  });
});
