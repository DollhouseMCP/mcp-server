import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createPersonaFindingFixture } from '../../helpers/persona-finding-fixture.js';
import { BaseElementManager } from '../../../src/elements/base/BaseElementManager.js';
import { logger } from '../../../src/utils/logger.js';
import { getActiveElementLimitConfig } from '../../../src/config/active-element-limits.js';
import { PersonaActivationStrategy } from '../../../src/handlers/strategies/PersonaActivationStrategy.js';
import type { PersonaIndicatorService } from '../../../src/services/PersonaIndicatorService.js';

describe('Persona activation references', () => {
  afterEach(() => jest.restoreAllMocks());

  it('retains an active reference after cache eviction and repeated cleanup', async () => {
    const { personaManager } = createPersonaFindingFixture();
    await personaManager.activatePersona('Creative Writer');
    personaManager.clearCache();
    const warn = jest.spyOn(logger, 'warn');
    personaManager['collectRetainedReferenceNotices']();
    personaManager['collectRetainedReferenceNotices']();
    expect(personaManager['getActivationSet']().has('Creative-Writer.md')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(personaManager['activationMetricsTracker'].getMetrics()).toBe(1);
  });

  it('clears warning suppression after explicit deactivation', async () => {
    const { personaManager } = createPersonaFindingFixture();
    await personaManager.activatePersona('Creative Writer');
    personaManager.clearCache();
    const warn = jest.spyOn(logger, 'warn');
    personaManager['collectRetainedReferenceNotices']();
    personaManager.deactivatePersona('Creative-Writer.md');
    personaManager['getActivationSet']().add('Creative-Writer.md');
    personaManager['collectRetainedReferenceNotices']();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each(['veto', 'storage failure'])('keeps activation and warning suppression when delete fails with %s', async reason => {
    const { personaManager } = createPersonaFindingFixture();
    await personaManager.activatePersona('Creative Writer');
    personaManager.clearCache();
    const warn = jest.spyOn(logger, 'warn');
    personaManager['collectRetainedReferenceNotices']();
    const failure = new Error(reason);
    jest.spyOn(BaseElementManager.prototype, 'delete').mockRejectedValueOnce(failure);
    await expect(personaManager.delete('Creative-Writer.md')).rejects.toBe(failure);
    expect(personaManager['getActivationSet']().has('Creative-Writer.md')).toBe(true);
    personaManager['collectRetainedReferenceNotices']();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each(['both fail', 'one succeeds', 'deactivate', 'reactivate'])('preserves concurrent delete obligations: %s', async outcome => {
    const { personaManager } = createPersonaFindingFixture();
    await personaManager.activatePersona('Creative Writer');
    const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    jest.spyOn(BaseElementManager.prototype, 'delete').mockImplementation((_locator, onCommitted) => new Promise<void>((resolve, reject) => {
      pending.push({ resolve: () => { onCommitted?.(); resolve(); }, reject });
    }));
    jest.spyOn(personaManager, 'reload').mockResolvedValue(undefined);
    const first = personaManager.delete('Creative-Writer.md');
    const second = personaManager.delete('Creative-Writer.md');
    const settled = Promise.allSettled([first, second]);
    if (outcome === 'deactivate') personaManager.deactivatePersona('Creative Writer');
    if (outcome === 'reactivate') await personaManager.activatePersona('Creative Writer');
    if (outcome === 'one succeeds') pending[0].resolve();
    else pending[0].reject(new Error('first failure'));
    pending[1].reject(new Error('second failure'));
    await settled;
    expect(personaManager.getActivePersonaIds()).toEqual(
      outcome === 'both fail' || outcome === 'reactivate' ? ['Creative-Writer.md'] : []);
  });

  it('explicitly deactivates the exact evicted reference', async () => {
    const { personaManager } = createPersonaFindingFixture();
    await personaManager.activatePersona('Creative Writer');
    personaManager.clearCache();
    expect(personaManager.deactivatePersona('Creative-Writer.md').success).toBe(true);
    expect(personaManager['getActivationSet']().size).toBe(0);
  });

  it('does not invent aliases for an evicted reference', async () => {
    const { personaManager } = createPersonaFindingFixture();
    await personaManager.activatePersona('Creative Writer');
    personaManager.clearCache();
    expect(personaManager.deactivatePersona('Creative Writer').success).toBe(false);
    expect(personaManager['getActivationSet']().has('Creative-Writer.md')).toBe(true);
  });

  it('includes the active-limit notice and retained references in the activation response', async () => {
    const { personaManager } = createPersonaFindingFixture();
    const { max } = getActiveElementLimitConfig('personas');
    for (let index = 0; index < max; index++) personaManager['getActivationSet']().add(`missing-${index}.md`);
    const persona = personaManager.findPersona('Creative Writer')!;
    persona.instructions = 'Write creatively.';
    const strategy = new PersonaActivationStrategy(personaManager,
      { getPersonaIndicator: () => '' } as PersonaIndicatorService);
    const response = await strategy.activate('Creative Writer');
    expect(response.content[0].text).toContain('Active personas limit reached');
    expect(response.content[0].text).toContain('Retained stale persona reference "missing-0.md"');
    expect(personaManager.getActivePersonaIds()).toHaveLength(max + 1);
  });

  it('keeps unknown names not-found and resolved inactive personas idempotent', async () => {
    const { personaManager } = createPersonaFindingFixture();
    jest.spyOn(personaManager, 'findPersonaAsync').mockResolvedValueOnce(undefined);
    const strategy = new PersonaActivationStrategy(personaManager,
      { getPersonaIndicator: () => '' } as PersonaIndicatorService);
    await expect(strategy.deactivate('unknown')).rejects.toThrow('not found');
    expect((await strategy.deactivate('Creative Writer')).content[0].text).toContain('already inactive');
  });

  it('allows a retained name-bound reference to bind to a recreated definition', () => {
    const { personaManager, seedPersona } = createPersonaFindingFixture();
    const original = personaManager.findPersona('Creative Writer')!;
    personaManager['getActivationSet']().add('Creative Writer');
    personaManager.clearCache();
    personaManager['collectRetainedReferenceNotices']();
    // Until durable identities land, retaining a name widens the re-binding window.
    const replacement = { ...original, unique_id: 'replacement', metadata: { ...original.metadata, unique_id: 'replacement' } };
    seedPersona(replacement);
    expect(personaManager.getActivePersonas()).toContain(replacement);
  });
});
