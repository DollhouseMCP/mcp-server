import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PersonaIndicatorService } from '../../../src/services/PersonaIndicatorService.js';
import { DEFAULT_INDICATOR_CONFIG } from '../../../src/config/indicator-config.js';
import type { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { StateChangeNotifier } from '../../../src/services/StateChangeNotifier.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { ElementType } from '../../../src/portfolio/types.js';

const buildPersona = (name: string) => ({
  metadata: {
    name,
    version: '1.0',
    author: 'Tester',
    category: 'general',
  },
});

describe('PersonaIndicatorService', () => {
  let personaManager: jest.Mocked<
    Pick<PersonaManager, 'getActivePersona' | 'getActivePersonaId'>
  >;
  let notifier: StateChangeNotifier;
  let dispatcher: ElementEventDispatcher;

  beforeEach(() => {
    personaManager = {
      getActivePersona: jest.fn().mockReturnValue(null),
      getActivePersonaId: jest.fn().mockReturnValue(null),
    };
    notifier = new StateChangeNotifier();
    dispatcher = new ElementEventDispatcher();
  });

  it('returns empty string when no persona is active', () => {
    const service = new PersonaIndicatorService(
      personaManager as unknown as PersonaManager,
      DEFAULT_INDICATOR_CONFIG,
      notifier,
      dispatcher
    );

    expect(service.getPersonaIndicator()).toBe('');
    expect(personaManager.getActivePersona).toHaveBeenCalled();
  });

  it('uses fallback provider when configured and no persona is active', () => {
    const service = new PersonaIndicatorService(
      personaManager as unknown as PersonaManager,
      DEFAULT_INDICATOR_CONFIG,
      notifier,
      dispatcher
    );

    service.setFallbackProvider(() => 'fallback-indicator');
    expect(service.getPersonaIndicator()).toBe('fallback-indicator');
  });

  it('formats indicator using active persona metadata', () => {
    personaManager.getActivePersona.mockReturnValue(
      buildPersona('Creative Muse') as any
    );

    const service = new PersonaIndicatorService(
      personaManager as unknown as PersonaManager,
      DEFAULT_INDICATOR_CONFIG,
      notifier,
      dispatcher
    );

    const indicator = service.getPersonaIndicator();

    expect(indicator).toContain('Creative Muse');
  });

  it('caches indicator until state change notification', () => {
    personaManager.getActivePersona.mockReturnValue(
      buildPersona('Persona A') as any
    );

    const service = new PersonaIndicatorService(
      personaManager as unknown as PersonaManager,
      DEFAULT_INDICATOR_CONFIG,
      notifier,
      dispatcher
    );

    const first = service.getPersonaIndicator();
    personaManager.getActivePersona.mockReturnValue(
      buildPersona('Persona B') as any
    );

    const cached = service.getPersonaIndicator();
    expect(cached).toBe(first);

    notifier.notifyPersonaChange({
      type: 'persona-activated',
      previousValue: null,
      newValue: 'persona-b',
      timestamp: new Date(),
    });

    const updated = service.getPersonaIndicator();
    expect(updated).not.toBe(first);
    expect(updated).toContain('Persona B');
  });

  it('registers notifier listeners when provided', async () => {
    const service = new PersonaIndicatorService(
      personaManager as unknown as PersonaManager,
      DEFAULT_INDICATOR_CONFIG,
      notifier,
      dispatcher
    );

    expect(notifier.listenerCount('state-change:persona-activated')).toBeGreaterThan(0);

    await service.dispose();
    expect(notifier.listenerCount('state-change:persona-activated')).toBe(0);
  });

  it('invalidates cache when dispatcher emits persona events', () => {
    personaManager.getActivePersona.mockReturnValue(
      buildPersona('Persona D') as any
    );

    const service = new PersonaIndicatorService(
      personaManager as unknown as PersonaManager,
      DEFAULT_INDICATOR_CONFIG,
      notifier,
      dispatcher
    );

    const first = service.getPersonaIndicator();
    personaManager.getActivePersona.mockReturnValue(
      buildPersona('Persona E') as any
    );

    dispatcher.emit('element:activate', {
      correlationId: 'test',
      elementType: ElementType.PERSONA,
      filePath: 'persona-e.md'
    });

    const updated = service.getPersonaIndicator();
    expect(updated).not.toBe(first);
    expect(updated).toContain('Persona E');
  });

  it('updates configuration dynamically', () => {
    personaManager.getActivePersona.mockReturnValue(
      buildPersona('Persona C') as any
    );

    const service = new PersonaIndicatorService(
      personaManager as unknown as PersonaManager,
      { ...DEFAULT_INDICATOR_CONFIG, showName: true, showEmoji: false },
      notifier,
      dispatcher
    );

    service.updateConfig({
      ...DEFAULT_INDICATOR_CONFIG,
      enabled: false,
    });

    const updated = service.getPersonaIndicator();
    expect(updated).toBe('');
  });
});
