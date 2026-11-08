import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ElementUnreadableError } from '../../../src/elements/base/ElementReadError.js';
import { ElementResolver } from '../../../src/elements/base/ElementResolver.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../../src/elements/memories/Memory.js';
import { Ensemble } from '../../../src/elements/ensembles/Ensemble.js';
import { TemplateManager } from '../../../src/elements/templates/TemplateManager.js';
import { resolveElementTypes } from '../../../src/utils/elementTypeResolver.js';
import { SkillManager } from '../../../src/elements/skills/SkillManager.js';
import { EnsembleManager } from '../../../src/elements/ensembles/EnsembleManager.js';
import { AgentManager } from '../../../src/elements/agents/AgentManager.js';
import { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { SkillActivationStrategy } from '../../../src/handlers/strategies/SkillActivationStrategy.js';
import { AgentActivationStrategy } from '../../../src/handlers/strategies/AgentActivationStrategy.js';
import { EnsembleActivationStrategy } from '../../../src/handlers/strategies/EnsembleActivationStrategy.js';
import { MemoryActivationStrategy } from '../../../src/handlers/strategies/MemoryActivationStrategy.js';
import { PersonaActivationStrategy } from '../../../src/handlers/strategies/PersonaActivationStrategy.js';
import { TemplateActivationStrategy } from '../../../src/handlers/strategies/TemplateActivationStrategy.js';
import { RegistrySessionActivationStateAdapter } from '../../../src/web-console/modules/activations/SessionActivationStateAdapter.js';
import { SessionActivationRegistry } from '../../../src/state/SessionActivationState.js';
import { resolveElementByName } from '../../../src/handlers/element-crud/helpers.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { ValidationError } from '../../../src/security/errors.js';

afterEach(() => jest.restoreAllMocks());
const failure = new ElementUnreadableError('Definition storage unavailable');

describe('caller read dispositions', () => {
  it('direct agent deactivation propagates lookup failure without removing a live reference', async () => {
    const active = new Set(['broken']);
    const host = { scanAndEvict: async () => undefined, getActivationSet: () => active,
      getActivationNameMap: () => new Map(), findByName: async () => { throw failure; } };
    await expect(AgentManager.prototype.deactivateAgent.call(host as any, 'broken')).rejects.toBe(failure);
    expect([...active]).toEqual(['broken']);
  });
  it('legacy ensemble repair propagates the collection read failure before reading any definition', async () => {
    const readContent = jest.fn();
    const storageLayer = { cachedInstanceCurrency: 'currency-check', readCollection: async () => { throw failure; }, readContent };
    const host = { getElementType: () => ElementType.ENSEMBLE, readCollectionEvicting: () => storageLayer.readCollection(),
      storageLayer, portfolioManager: {}, fileOperations: {} };
    await expect(EnsembleManager.prototype.repairLegacyElementFields.call(host as any)).rejects.toBe(failure);
    expect(readContent).not.toHaveBeenCalled();
  });

  it('agent execution identity propagates a failed certification before reading definitions', async () => {
    const loadElementDefinition = jest.fn();
    const storageLayer = { cachedInstanceCurrency: 'currency-check', readIndexedPath: async () => { throw failure; } };
    const resolver = new ElementResolver({ classifyCallerText: async () => 'name', getFileExtension: () => '.md' } as any, {} as any, storageLayer as any);
    const host = Object.assign(Object.create(AgentManager.prototype), { getFilename: () => 'agent.md',
      storageLayer, nameEvidence: storageLayer, _resolver: resolver, loadElementDefinition });
    await expect(host.resolveExecutionIdentity('agent')).rejects.toBe(failure);
    expect(loadElementDefinition).not.toHaveBeenCalled();
  });
  it('CRUD resolution preserves a failed findByName and has no handler-side fallback', async () => {
    await expect(resolveElementByName({ findByName: async () => { throw failure; } }, 'unreadable')).rejects.toBe(failure);
    const findByName = jest.fn(async () => undefined);
    await expect(resolveElementByName({ findByName }, 'missing')).resolves.toBeUndefined();
    expect(findByName).toHaveBeenCalledWith('missing');
  });

  it('pending console activation refuses failed discovery before mutating live state', async () => {
    const registry = new SessionActivationRegistry();
    const recordPendingActivation = jest.fn();
    const adapter = new RegistrySessionActivationStateAdapter(registry, () => ({
      hasPendingActivationDeletions: () => true,
      findByStorageIdentity: async () => { throw failure; },
      findMany: async () => { throw failure; }, recordPendingActivation,
    }));
    await expect(adapter.activate('session', 'skills', 'unreadable')).rejects.toBe(failure);
    expect(registry.get('session')?.skills.size).toBe(0);
    expect(recordPendingActivation).not.toHaveBeenCalled();
  });

  it('pending console activation preserves proven-missing enrollment behavior', async () => {
    const registry = new SessionActivationRegistry();
    const recordPendingActivation = jest.fn();
    const adapter = new RegistrySessionActivationStateAdapter(registry, () => ({
      hasPendingActivationDeletions: () => true, findByStorageIdentity: async () => undefined,
      findMany: async () => [], recordPendingActivation,
    }));
    expect((await adapter.activate('session', 'skills', 'missing')).changed).toBe(true);
    expect(registry.get('session')?.skills.has('missing')).toBe(true);
    expect(recordPendingActivation).not.toHaveBeenCalled();
  });

  it('memory name repair refuses incomplete discovery before processing any entries', async () => {
    const progress = jest.fn();
    const host = { storageLayer: { invalidate: () => undefined }, list: async () => { throw failure; } };
    await expect(MemoryManager.prototype.repairCorruptedNames.call(host as any, progress)).rejects.toBe(failure);
    expect(progress).not.toHaveBeenCalled();
  });

  it.each([
    ['skillManager', SkillActivationStrategy.prototype], ['agentManager', AgentActivationStrategy.prototype],
    ['ensembleManager', EnsembleActivationStrategy.prototype], ['memoryManager', MemoryActivationStrategy.prototype],
    ['personaManager', PersonaActivationStrategy.prototype], ['templateManager', TemplateActivationStrategy.prototype],
  ] as const)('%s details propagate failed discovery instead of reporting not found', async (key, strategy) => {
    const host = { [key]: { findByName: async () => { throw failure; }, findPersonaAsync: async () => { throw failure; } } };
    await expect(strategy.getElementDetails.call(host as any, 'unreadable')).rejects.toBe(failure);
  });

  it('template activation refuses failed discovery before choosing a template', async () => {
    const host = { templateManager: { findByName: async () => { throw failure; } } };
    await expect(TemplateActivationStrategy.prototype.activate.call(host as any, 'unreadable')).rejects.toBe(failure);
  });

  it.each(['editPersona', 'validatePersona', 'deletePersona'] as const)('%s propagates failed persona discovery', async method => {
    const host = { findPersonaAsync: async () => { throw failure; } };
    const invoke = PersonaManager.prototype[method] as (...args: string[]) => Promise<unknown>;
    await expect(invoke.call(host as any, 'unreadable', 'description', 'Changed description')).rejects.toBe(failure);
  });

  it('ensemble member deactivation preserves persona lookup failure', async () => {
    const deactivatePersona = jest.fn();
    const host = { personaManager: { findPersonaAsync: async () => { throw failure; }, deactivatePersona } };
    await expect(EnsembleActivationStrategy.prototype['deactivateMember'].call(host as any,
      { element_type: 'persona', element_name: 'unreadable' } as any)).rejects.toBe(failure);
    expect(deactivatePersona).not.toHaveBeenCalled();
  });

  it('agent activation content refuses failed inventory before formatting a missing element', async () => {
    const format = jest.fn();
    const host = { _elementManagerResolver: () => ({ findByName: async () => { throw failure; } }),
      assertNoRuntimeActivationCycle: () => undefined, formatActivationElementContent: format };
    await expect(AgentManager.prototype['getElementContent'].call(host as any, 'skills', 'unreadable')).rejects.toBe(failure);
    expect(format).not.toHaveBeenCalled();
  });

  it('propagates scoped memory inventory failure without trying the unscoped manager', async () => {
    const resolver = jest.fn();
    const format = jest.fn();
    const assertCurrent = jest.fn();
    const findByName = jest.fn<() => Promise<never>>().mockRejectedValue(failure);
    const host = { _elementManagerResolver: resolver, assertNoRuntimeActivationCycle: () => {}, formatActivationElementContent: format };
    await expect(AgentManager.prototype['getElementContent'].call(host as any, 'memories', 'unreadable', undefined,
      { manager: { findByName }, assertCurrent } as any)).rejects.toBe(failure);
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    expect(findByName).toHaveBeenCalledWith('unreadable');
    expect(resolver).not.toHaveBeenCalled();
    expect(format).not.toHaveBeenCalled();
  });

  it('checks scoped memory currency after the lookup before formatting activation content', async () => {
    const conflict = new Error('Memory invocation changed');
    const assertCurrent = jest.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw conflict; });
    const format = jest.fn();
    const host = { assertNoRuntimeActivationCycle: () => {}, formatActivationElementContent: format };
    await expect(AgentManager.prototype['getElementContent'].call(host as any, 'memories', 'selected', undefined,
      { manager: { findByName: async () => undefined }, assertCurrent } as any)).rejects.toBe(conflict);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(format).not.toHaveBeenCalled();
  });

  it.each([
    ['skill', SkillManager.prototype.activateSkill], ['ensemble', EnsembleManager.prototype.activateEnsemble],
    ['agent', AgentManager.prototype.activateAgent], ['memory', MemoryManager.prototype.activateMemory],
    ['persona', PersonaManager.prototype.activatePersona],
  ] as const)('%s activation propagates a failed definition lookup without activating anything', async (_type, activate) => {
    const active = new Set<string>();
    const host = { findByName: async () => { throw failure; }, findPersonaAsync: async () => { throw failure; },
      scanAndEvict: async () => undefined, reportActiveSetPressure: async () => [], getActivationSet: () => active };
    await expect(activate.call(host as any, 'unreadable')).rejects.toBe(failure);
    expect(active.size).toBe(0);
  });

  it.each(['find', 'findMany'] as const)('shared %s refuses an incomplete predicate input', async method => {
    const predicate = jest.fn(() => true);
    const resolver = new ElementResolver({ list: async () => { throw failure; } } as any, {} as any, {} as any);
    await expect(resolver[method](predicate)).rejects.toBe(failure);
    expect(predicate).not.toHaveBeenCalled();
  });

  it.each(['find', 'findMany'] as const)('memory %s refuses an incomplete predicate input', async method => {
    const predicate = jest.fn(() => true);
    const host = { list: async () => { throw failure; } };
    await expect(MemoryManager.prototype[method].call(host as any, predicate)).rejects.toBe(failure);
    expect(predicate).not.toHaveBeenCalled();
  });

  it.each(['find', 'findByTrustLevel'] as const)('static memory %s propagates the collection failure', async method => {
    jest.spyOn(Memory as any, 'getStaticMemoryManager').mockReturnValue({ list: async () => { throw failure; } });
    const result = method === 'find' ? Memory.find({ tags: ['policy'] }) : Memory.findByTrustLevel('untrusted');
    await expect(result).rejects.toBe(failure);
  });

  it.each(['skill', 'persona'])('ensemble %s lookup never maps a failed read to not found', async type => {
    const manager = { list: async () => { throw failure; }, findPersonaAsync: async () => { throw failure; } };
    await expect(Ensemble.prototype['findElementInManager'].call({} as any, manager, 'member', type))
      .rejects.toBe(failure);
  });

  it.each(['skillManager', 'personaManager'] as const)('type inference refuses failed %s discovery', async key => {
    const manager = { findByName: async () => { throw failure; }, findPersonaAsync: async () => { throw failure; } };
    await expect(resolveElementTypes([{ element_name: 'unknown' }], { [key]: manager })).rejects.toBe(failure);
  });

  it('type inference passes a caller name refusal through unwrapped', async () => {
    const refusal = new ValidationError('Invalid skill path: Path traversal detected');
    const manager = { findByName: async () => { throw refusal; } };
    await expect(resolveElementTypes([{ element_name: '../outside' }], { skillManager: manager })).rejects.toBe(refusal);
  });

  it.each(['findByCategory', 'findByTag', 'getMostUsed'] as const)('%s preserves incomplete template evidence after filtering', async method => {
    const item = { metadata: { name: 'healthy', category: 'policy', tags: ['policy'], usage_count: 3 } };
    const failures = [{ reference: 'broken.md', error: failure }];
    const host = { listReport: async () => ({ items: [item], failures, complete: false }) };
    const report = method === 'getMostUsed'
      ? await TemplateManager.prototype.getMostUsed.call(host as any, 1)
      : await TemplateManager.prototype[method].call(host as any, 'policy');
    expect(report.items).toEqual([item]);
    expect(report.failures).toBe(failures);
    expect(report.complete).toBe(false);
  });
});
