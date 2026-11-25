import { PolicyUnavailableError } from '../../../../src/services/policy/PolicyUnavailableError.js';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ActivePolicyCollector, mapPolicyLookups, policyElementKey, toPolicyElementType, type ActivePolicyCollectorDeps } from '../../../../src/services/policy/ActivePolicyCollector.js';
import type { BaseElementManager } from '../../../../src/elements/base/BaseElementManager.js';
import { logger } from '../../../../src/utils/logger.js';

function fixture() {
  const reportFrom = <T>(read: () => Promise<T[]>) => jest.fn(async (options?: { afterLookup?: (element: T, reference: string) => Promise<void> }) => {
    const items = await read();
    for (const item of items) await options?.afterLookup?.(item, 'exact-active-reference');
    return { items, failures: [], complete: true };
  });
  const personaManager = {
    getActivePersonas: jest.fn<ActivePolicyCollectorDeps['personaManager']['getActivePersonas']>().mockReturnValue([]),
    resolveActivePersonas: jest.fn<ActivePolicyCollectorDeps['personaManager']['resolveActivePersonas']>().mockResolvedValue([]),
    getActiveReferenceReport: reportFrom(async () => personaManager.resolveActivePersonas()),
  };
  const skillManager = {
    getActiveSkills: jest.fn<ActivePolicyCollectorDeps['skillManager']['getActiveSkills']>().mockResolvedValue([]),
    getActiveReferenceReport: reportFrom(async () => skillManager.getActiveSkills()),
  };
  const agentManager = {
    getActiveAgents: jest.fn<ActivePolicyCollectorDeps['agentManager']['getActiveAgents']>().mockResolvedValue([]),
    getActivationIdentity: jest.fn<ActivePolicyCollectorDeps['agentManager']['getActivationIdentity']>().mockReturnValue(undefined),
    getActiveReferenceReport: reportFrom(async () => agentManager.getActiveAgents()),
  };
  const ensembleManager = {
    getActiveEnsembles: jest.fn<ActivePolicyCollectorDeps['ensembleManager']['getActiveEnsembles']>().mockResolvedValue([]),
    getActiveReferenceReport: reportFrom(async () => ensembleManager.getActiveEnsembles()),
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

  it.each(['personas', 'skills', 'agents', 'ensembles'] as const)('refuses enforcement when active %s cannot be collected', async type => {
    const error = new Error('unavailable');
    if (type === 'personas') f.personaManager.resolveActivePersonas.mockRejectedValue(error);
    if (type === 'skills') f.skillManager.getActiveSkills.mockRejectedValue(error);
    if (type === 'agents') f.agentManager.getActiveAgents.mockRejectedValue(error);
    if (type === 'ensembles') f.ensembleManager.getActiveEnsembles.mockRejectedValue(error);
    await expect(f.collector.collectActiveElementsForPolicy()).rejects.toBeInstanceOf(PolicyUnavailableError);
    expect(warning).not.toHaveBeenCalled();
  });

  it('refuses enforcement when fresh persona resolution fails', async () => {
    const error = new Error('unavailable');
    f.personaManager.resolveActivePersonas.mockRejectedValue(error);
    await expect(f.collector.collectActiveElementsForPolicy({ freshAfterInFlight: true })).rejects.toBeInstanceOf(PolicyUnavailableError);
    expect(warning).not.toHaveBeenCalled();
    expect(f.personaManager.getActivePersonas).not.toHaveBeenCalled();
  });

  it('refreshes ensemble members with the report freshness: advisory for the digest, enforcement by default', async () => {
    f.ensembleManager.getActiveEnsembles.mockResolvedValue([ensemble('healthy')]);
    const refreshForFreshness = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
    const findByName = jest.fn(async () => ({ metadata: { name: 'healthy' } }));
    f.getManagerForType.mockReturnValue({ refreshForFreshness, findByName } as unknown as BaseElementManager<any>);
    await f.collector.collectActiveElementsForReport({ freshness: 'advisory' });
    expect(refreshForFreshness).toHaveBeenCalledWith('advisory', { freshness: 'advisory' });
    refreshForFreshness.mockClear();
    await f.collector.collectActiveElementsForReport();
    expect(refreshForFreshness).toHaveBeenCalledWith(undefined, {});
  });

  it('refuses enforcement when an ensemble member lookup fails', async () => {
    f.ensembleManager.getActiveEnsembles.mockResolvedValue([ensemble('broken', 'healthy')]);
    const metadata = { name: 'healthy', gatekeeper: { deny: ['delete_element'] } };
    const refreshForFreshness = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const findByName = jest.fn(async (name: string) => {
      if (name === 'broken') throw new Error('unreadable');
      return { metadata };
    });
    f.getManagerForType.mockReturnValue({ refreshForFreshness, findByName } as unknown as BaseElementManager<any>);
    await expect(f.collector.collectActiveElementsForPolicy()).rejects.toBeInstanceOf(PolicyUnavailableError);
    expect(refreshForFreshness).toHaveBeenCalledTimes(1);
    expect(findByName).toHaveBeenCalledTimes(2);
    expect(warning).not.toHaveBeenCalled();
    expect(await f.collector.collectActiveElementsForReport()).toMatchObject({ complete: false,
      failures: [{ type: 'ensembles', reference: 'exact-active-reference', reason: expect.stringContaining('broken') }] });
  });

  it('lets a certified-absent ensemble member contribute no policy, and is no failure', async () => {
    f.ensembleManager.getActiveEnsembles.mockResolvedValue([ensemble('absent')]);
    f.getManagerForType.mockReturnValue({
      refreshForFreshness: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      findByName: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
    } as unknown as BaseElementManager<any>);
    expect(await f.collector.collectActiveElementsForReport()).toMatchObject({ complete: true, failures: [] });
    await expect(f.collector.collectActiveElementsForPolicy()).resolves.toEqual([expect.objectContaining({ name: 'team' })]);
  });

  it('reports a member of an unknown element type as a typed failure that leaves the report incomplete', async () => {
    f.ensembleManager.getActiveEnsembles.mockResolvedValue([ensemble('typo')]);
    // The fixture's handler lookup answers no manager for the member type.
    expect(await f.collector.collectActiveElementsForReport()).toMatchObject({ complete: false,
      failures: [{ type: 'ensembles', reference: 'exact-active-reference', reason: expect.stringContaining('No element manager is registered') }] });
    await expect(f.collector.collectActiveElementsForPolicy()).rejects.toBeInstanceOf(PolicyUnavailableError);
  });

  it.each(['personaManager', 'skillManager', 'agentManager', 'ensembleManager'] as const)(
    'keeps healthy policies in advisory output when %s has an unreadable reference', async key => {
      f[key].getActiveReferenceReport.mockImplementation(async (options: any) => {
        const item = { metadata: { name: 'healthy', gatekeeper: { deny: ['delete_element'] } } };
        await options?.afterLookup?.(item);
        return { items: [item], failures: [{ reference: 'broken', error: new Error('Definition unreadable') }], complete: false } as any;
      });
      const report = await f.collector.collectActiveElementsForReport();
      expect(report).toMatchObject({ complete: false,
        items: [expect.objectContaining({ name: 'healthy' })],
        failures: [expect.objectContaining({ reference: 'broken', reason: 'Definition unreadable' })],
      });
      await expect(f.collector.collectActiveElementsForPolicy()).rejects.toBeInstanceOf(PolicyUnavailableError);
    });

  it('propagates initialization failures before reading active managers', async () => {
    const error = new Error('initialization failed');
    f.ensureInitialized.mockRejectedValue(error);
    await expect(f.collector.collectActiveElementsForPolicy()).rejects.toBeInstanceOf(PolicyUnavailableError);
    expect(f.personaManager.getActivePersonas).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it('propagates a required fresh index failure', async () => {
    const error = new Error('index failed');
    f.personaManager.getActiveReferenceReport.mockRejectedValue(error);
    await expect(f.collector.collectActiveElementsForPolicy({ freshAfterInFlight: true })).rejects.toBeInstanceOf(PolicyUnavailableError);
    expect(f.personaManager.getActiveReferenceReport).toHaveBeenCalledWith({ scanOptions: { freshAfterInFlight: true } });
    expect(f.personaManager.resolveActivePersonas).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it('resolves members through each instance manager callback without caching across collections', async () => {
    const other = fixture();
    for (const current of [f, other]) current.ensembleManager.getActiveEnsembles.mockResolvedValue([ensemble('policy')]);
    const manager = (owner: string) => ({
      refreshForFreshness: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
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
      refreshForFreshness: jest.fn<() => Promise<void>>().mockResolvedValue(undefined), findByName,
    } as unknown as BaseElementManager<any>);
    const result = await f.collector.collectActiveElementsForPolicy();
    expect(result.map(({ type, name }) => [type, name])).toEqual([
      ['skill', 'active'], ['ensemble', 'first'], ['ensemble', 'second'], ['skill', 'shared'],
    ]);
    expect(findByName).toHaveBeenCalledTimes(1);
    expect(findByName).toHaveBeenCalledWith('shared', { refreshed: true });
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
