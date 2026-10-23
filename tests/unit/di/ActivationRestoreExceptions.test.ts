import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { FileActivationStateStore } from '../../../src/state/FileActivationStateStore.js';
import type { IActivationStateStore, PersistedActivation } from '../../../src/state/IActivationStateStore.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { ActivationMetricsTracker } from '../../../src/metrics/ActivationMetricsTracker.js';
import { logger } from '../../../src/utils/logger.js';

const types = ['persona', 'skill', 'agent', 'memory', 'ensemble'] as const;
type RestoreContainer = {
  restoreActivations(store: IActivationStateStore): Promise<void>;
  createTenantMemoryProvider(): unknown;
};

function createContainer(failedType?: string) {
  const container = new DollhouseContainer();
  const tracker = new ActivationMetricsTracker(() => 'restore-user');
  container.replace('ActivationMetricsTracker', () => tracker);
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
  return { container: container as unknown as RestoreContainer, callbacks, tracker };
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
    jest.restoreAllMocks();
    if (originalPersistence === undefined) delete process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE;
    else process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE = originalPersistence;
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
  });

  it.each(types)('retains the exact %s record on exception and restores later records', async type => {
    const failed = record('failed');
    const later = record('later');
    const store = createStore({ [type]: [failed, later] });
    const { container, callbacks, tracker } = createContainer(type);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await container.restoreActivations(store);
    expect(store.removeStaleActivation).not.toHaveBeenCalled();
    expect(store.getActivations(type)).toEqual([failed, later]);
    expect(callbacks.get(type)).toHaveBeenCalledTimes(2);
    callbacks.get(type)!.mockRejectedValueOnce(new Error('Repeated outage'));
    await container.restoreActivations(store);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(tracker.getMetrics()).toBe(1);
  });

  it.each(['persona', 'skill'])('retains %s records when activation returns false', async type => {
    const info = jest.spyOn(logger, 'info');
    const failed = record('refused');
    const store = createStore({ [type]: [failed] });
    const { container, callbacks } = createContainer();
    callbacks.get(type)!.mockResolvedValue({ success: false });
    await container.restoreActivations(store);
    expect(store.removeStaleActivation).not.toHaveBeenCalled();
    expect(store.getActivations(type)).toEqual([failed]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Restored 0 element(s), skipped 1'));
  });

  it('retains false-result records and successful agent identity upgrades', async () => {
    const missing = record('missing');
    const agent = record('agent');
    const store = createStore({ persona: [missing], agent: [agent] });
    const { container, callbacks } = createContainer();
    callbacks.get('persona')!.mockResolvedValue({ success: false });
    callbacks.get('agent')!.mockResolvedValue({ success: true, agent: { metadata: { name: 'renamed' } }, identity: agent.identity } as { success: boolean });
    await container.restoreActivations(store);
    expect(store.removeStaleActivation).not.toHaveBeenCalled();
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

  it('does not invoke removal for a false result', async () => {
    const store = createStore({ persona: [record('missing'), record('later')] });
    const { container, callbacks } = createContainer();
    callbacks.get('persona')!.mockResolvedValueOnce({ success: false });
    jest.spyOn(store, 'removeStaleActivation').mockImplementation(() => { throw new Error('Injected removal failure'); });
    await container.restoreActivations(store);
    expect(store.removeStaleActivation).not.toHaveBeenCalled();
    expect(callbacks.get('persona')).toHaveBeenCalledTimes(2);
  });

  it('rethrows the original restore error when the captured operation loses authority', async () => {
    const store = createStore({ persona: [record('lost-authority')] });
    const { container, callbacks } = createContainer();
    const cause = new Error('restore failed');
    let current = true;
    const assertCurrent = jest.fn(() => { if (!current) throw new Error('authority changed'); });
    jest.spyOn(container, 'createTenantMemoryProvider').mockReturnValue({
      capture: () => undefined,
      resolve: async () => ({ assertCurrent, manager: {} }),
    });
    callbacks.get('persona')!.mockImplementation(async () => { current = false; throw cause; });
    await expect(container.restoreActivations(store)).rejects.toBe(cause);
    expect(assertCurrent).toHaveBeenCalledTimes(3);
    expect(store.removeStaleActivation).not.toHaveBeenCalled();
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
