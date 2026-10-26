import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ActivePolicyCollector, mapPolicyLookups, policyElementKey, toPolicyElementType, type ActivePolicyCollectorDeps } from '../../../../src/services/policy/ActivePolicyCollector.js';
import type { BaseElementManager } from '../../../../src/elements/base/BaseElementManager.js';
import { logger } from '../../../../src/utils/logger.js';

function fixture() {
  const personaManager = {
    getActivePersonas: jest.fn<ActivePolicyCollectorDeps['personaManager']['getActivePersonas']>().mockReturnValue([]),
    resolveActivePersonas: jest.fn<ActivePolicyCollectorDeps['personaManager']['resolveActivePersonas']>().mockResolvedValue([]),
  };
  const skillManager = {
    getActiveSkills: jest.fn<ActivePolicyCollectorDeps['skillManager']['getActiveSkills']>().mockResolvedValue([]),
  };
  const agentManager = {
    getActiveAgents: jest.fn<ActivePolicyCollectorDeps['agentManager']['getActiveAgents']>().mockResolvedValue([]),
    getActivationIdentity: jest.fn<ActivePolicyCollectorDeps['agentManager']['getActivationIdentity']>().mockReturnValue(undefined),
  };
  const ensembleManager = {
    getActiveEnsembles: jest.fn<ActivePolicyCollectorDeps['ensembleManager']['getActiveEnsembles']>().mockResolvedValue([]),
  };
  const getManagerForType = jest.fn<ActivePolicyCollectorDeps['getManagerForType']>().mockReturnValue(undefined);
  const ensureInitialized = jest.fn<ActivePolicyCollectorDeps['ensureInitialized']>().mockResolvedValue(undefined);
  const deps = { personaManager, skillManager, agentManager, ensembleManager, getManagerForType, ensureInitialized };
  return { ...deps, collector: new ActivePolicyCollector(deps) };
}

function ensemble(...names: string[]) {
  return { metadata: { name: 'team', elements: names.map(name => ({ element_type: 'memory', element_name: name })) } } as unknown as Awaited<ReturnType<ActivePolicyCollectorDeps['ensembleManager']['getActiveEnsembles']>>[number];
}

describe('ActivePolicyCollector', () => {
  let f: ReturnType<typeof fixture>;
  let warning: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    f = fixture();
    warning = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['personas', 'skills', 'agents', 'ensembles'] as const)('skips and warns when active %s cannot be collected', async type => {
    const error = new Error('unavailable');
    if (type === 'personas') f.personaManager.getActivePersonas.mockImplementation(() => { throw error; });
    if (type === 'skills') f.skillManager.getActiveSkills.mockRejectedValue(error);
    if (type === 'agents') f.agentManager.getActiveAgents.mockRejectedValue(error);
    if (type === 'ensembles') f.ensembleManager.getActiveEnsembles.mockRejectedValue(error);
    expect(await f.collector.collectActiveElementsForPolicy()).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(`Failed to gather active ${type} for policy evaluation`, { error });
    expect(f.ensembleManager.getActiveEnsembles).toHaveBeenCalledTimes(1);
  });

  it('skips and warns when fresh persona resolution fails', async () => {
    const error = new Error('unavailable');
    f.personaManager.resolveActivePersonas.mockRejectedValue(error);
    expect(await f.collector.collectActiveElementsForPolicy({ freshAfterInFlight: true })).toEqual([]);
    expect(warning).toHaveBeenCalledWith('Failed to gather active personas for policy evaluation', { error });
    expect(f.personaManager.getActivePersonas).not.toHaveBeenCalled();
  });

  it('silently skips a failed member lookup while preserving later policy members', async () => {
    f.ensembleManager.getActiveEnsembles.mockResolvedValue([ensemble('broken', 'healthy')]);
    const metadata = { name: 'healthy', gatekeeper: { deny: ['delete_element'] } };
    const refreshIndex = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const findByName = jest.fn(async (name: string) => {
      if (name === 'broken') throw new Error('unreadable');
      return { metadata };
    });
    f.getManagerForType.mockReturnValue({ refreshIndex, findByName } as unknown as BaseElementManager<any>);
    expect(await f.collector.collectActiveElementsForPolicy()).toEqual([
      { type: 'ensemble', name: 'team', metadata: ensemble('broken', 'healthy').metadata },
      { type: 'memory', name: 'healthy', metadata },
    ]);
    expect(refreshIndex).toHaveBeenCalledTimes(1);
    expect(findByName).toHaveBeenCalledTimes(2);
    expect(warning).not.toHaveBeenCalled();
  });

  it('propagates initialization failures before reading active managers', async () => {
    const error = new Error('initialization failed');
    f.ensureInitialized.mockRejectedValue(error);
    await expect(f.collector.collectActiveElementsForPolicy()).rejects.toBe(error);
    expect(f.personaManager.getActivePersonas).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it('propagates a required fresh index failure', async () => {
    const error = new Error('index failed');
    const refreshIndex = jest.fn<() => Promise<void>>().mockRejectedValue(error);
    f.getManagerForType.mockReturnValue({ refreshIndex } as unknown as BaseElementManager<any>);
    await expect(f.collector.collectActiveElementsForPolicy({ freshAfterInFlight: true })).rejects.toBe(error);
    expect(refreshIndex).toHaveBeenCalledWith({ freshAfterInFlight: true });
    expect(f.personaManager.resolveActivePersonas).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it('resolves members through each instance manager callback without caching across collections', async () => {
    const other = fixture();
    for (const current of [f, other]) current.ensembleManager.getActiveEnsembles.mockResolvedValue([ensemble('policy')]);
    const manager = (owner: string) => ({
      refreshIndex: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      findByName: jest.fn(async () => ({ metadata: { name: owner, gatekeeper: { deny: [owner] } } })),
    }) as unknown as BaseElementManager<any>;
    f.getManagerForType.mockReturnValue(manager('first'));
    other.getManagerForType.mockReturnValue(manager('second'));
    expect((await f.collector.collectActiveElementsForPolicy())[1].metadata.name).toBe('first');
    expect((await other.collector.collectActiveElementsForPolicy())[1].metadata.name).toBe('second');
    f.getManagerForType.mockReturnValue(manager('next'));
    expect((await f.collector.collectActiveElementsForPolicy())[1].metadata.name).toBe('next');
    expect(f.getManagerForType).toHaveBeenCalledWith('memories');
    expect(other.getManagerForType).toHaveBeenCalledWith('memories');
  });

  it('deduplicates active elements and members shared by multiple ensembles', async () => {
    const active = { metadata: { name: 'active' } };
    f.skillManager.getActiveSkills.mockResolvedValue([active] as Awaited<ReturnType<typeof f.skillManager.getActiveSkills>>);
    const members = [
      { element_type: 'skills', element_name: 'active' },
      { element_type: 'skill', element_name: 'shared' },
    ];
    f.ensembleManager.getActiveEnsembles.mockResolvedValue(['first', 'second'].map(name => ({
      metadata: { name, elements: members },
    })) as Awaited<ReturnType<typeof f.ensembleManager.getActiveEnsembles>>);
    const findByName = jest.fn(async (name: string) => ({ metadata: { name, gatekeeper: { deny: ['delete_element'] } } }));
    f.getManagerForType.mockReturnValue({
      refreshIndex: jest.fn<() => Promise<void>>().mockResolvedValue(undefined), findByName,
    } as unknown as BaseElementManager<any>);
    const result = await f.collector.collectActiveElementsForPolicy();
    expect(result.map(({ type, name }) => [type, name])).toEqual([
      ['skill', 'active'], ['ensemble', 'first'], ['ensemble', 'second'], ['skill', 'shared'],
    ]);
    expect(findByName).toHaveBeenCalledTimes(1);
    expect(findByName).toHaveBeenCalledWith('shared');
    expect(result.filter(element => element.name === 'active')).toHaveLength(1);
    expect(result.filter(element => element.name === 'shared')).toHaveLength(1);
  });

  it('keys persona policies by storage identity when supplied and by name otherwise', () => {
    expect(policyElementKey('personas', 'Example', 'stored-id')).toBe('persona:identity:stored-id');
    expect(policyElementKey('personas', 'Example')).toBe('persona:name:Example');
  });

  it.each([
    ['personas', 'persona'], ['skills', 'skill'], ['templates', 'template'],
    ['agents', 'agent'], ['memories', 'memory'], ['ensembles', 'ensemble'], ['UnKnOwN', 'unknown'],
  ])('maps policy type %s to %s', (type, expected) => {
    expect(toPolicyElementType(type)).toBe(expected);
  });

  it('preserves lookup input order while limiting concurrency to eight', async () => {
    const inputs = Array.from({ length: 20 }, (_, index) => index);
    const releases: Array<() => void> = [];
    const completed: number[] = [];
    let inFlight = 0;
    let maximum = 0;
    const result = mapPolicyLookups(inputs, async value => {
      inFlight += 1;
      maximum = Math.max(maximum, inFlight);
      await new Promise<void>(resolve => { releases[value] = resolve; });
      completed.push(value);
      inFlight -= 1;
      return value * 2;
    });
    for (let start = 0; start < inputs.length; start += 8) {
      const end = Math.min(start + 8, inputs.length);
      expect(releases).toHaveLength(end);
      for (let index = end - 1; index >= start; index -= 1) releases[index]();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(await result).toEqual(inputs.map(value => value * 2));
    expect(maximum).toBe(8);
    expect(inFlight).toBe(0);
    expect(completed.slice(0, 8)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
  });
});
