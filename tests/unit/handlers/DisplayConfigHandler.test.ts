import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { DisplayConfigHandler } from '../../../src/handlers/DisplayConfigHandler.js';
import type { IndicatorConfig } from '../../../src/config/indicator-config.js';
import type { Persona } from '../../../src/types/persona.js';
import type { PersonaManager } from '../../../src/persona/PersonaManager.js';
import type { InitializationService } from '../../../src/services/InitializationService.js';
import type { PersonaIndicatorService } from '../../../src/services/PersonaIndicatorService.js';

describe('DisplayConfigHandler', () => {
  let handler: DisplayConfigHandler;
  let personaManager: jest.Mocked<
    Pick<
      PersonaManager,
      'getIndicatorConfig' | 'updateIndicatorConfig' | 'getActivePersona'
    >
  >;
  let initService: jest.Mocked<Pick<InitializationService, 'ensureInitialized'>>;
  let indicatorService: jest.Mocked<
    Pick<PersonaIndicatorService, 'getPersonaIndicator' | 'updateConfig'>
  >;
  let indicatorConfig: IndicatorConfig;
  let activePersona: Persona | null;

  beforeEach(() => {
    indicatorConfig = {
      enabled: true,
      style: 'full',
      showVersion: true,
      showAuthor: true,
      showCategory: false,
      showEmoji: true,
      showName: true,
      emoji: '🎭',
      bracketStyle: 'square',
      separator: ' ',
      customFormat: undefined,
    };

    activePersona = {
      filename: 'test-persona.md',
      unique_id: 'test-persona',
      metadata: {
        name: 'Test Persona',
        version: '1.0.0',
        author: '@testuser',
        category: 'creative',
        description: 'A test persona',
      },
      content: 'Test persona content',
    } as Persona;

    personaManager = {
      getIndicatorConfig: jest.fn(() => indicatorConfig),
      updateIndicatorConfig: jest.fn((config: IndicatorConfig) => {
        indicatorConfig = { ...config };
      }),
      getActivePersona: jest.fn(() => activePersona),
    } as unknown as typeof personaManager;

    initService = {
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
    } as unknown as typeof initService;

    indicatorService = {
      getPersonaIndicator: jest.fn().mockReturnValue('[🎭 Test Persona v1.0.0] '),
      updateConfig: jest.fn(),
    } as unknown as typeof indicatorService;

    handler = new DisplayConfigHandler(
      personaManager as unknown as PersonaManager,
      initService as unknown as InitializationService,
      indicatorService as unknown as PersonaIndicatorService
    );
  });

  const expectConfigUpdated = (field: keyof IndicatorConfig, value: any) => {
    expect(indicatorConfig[field]).toBe(value);
    expect(personaManager.updateIndicatorConfig).toHaveBeenCalled();
    expect(indicatorService.updateConfig).toHaveBeenCalled();
  };

  describe('configureIndicator', () => {
    it('updates enabled setting', async () => {
      const result = await handler.configureIndicator({ enabled: false });

      expectConfigUpdated('enabled', false);
      expect(result.content[0].text).toContain('Indicator configuration updated successfully');
      expect(result.content[0].text).toContain('Enabled: false');
    });

    it('updates style setting', async () => {
      const result = await handler.configureIndicator({ style: 'minimal' });

      expectConfigUpdated('style', 'minimal');
      expect(result.content[0].text).toContain('Style: minimal');
    });

    it('updates showVersion setting', async () => {
      const result = await handler.configureIndicator({ showVersion: false });

      expectConfigUpdated('showVersion', false);
      expect(result.content[0].text).toContain('Show Version: false');
    });

    it('updates showAuthor setting', async () => {
      const result = await handler.configureIndicator({ showAuthor: false });

      expectConfigUpdated('showAuthor', false);
      expect(result.content[0].text).toContain('Show Author: false');
    });

    it('updates showCategory setting', async () => {
      const result = await handler.configureIndicator({ showCategory: true });

      expectConfigUpdated('showCategory', true);
      expect(result.content[0].text).toContain('Show Category: true');
    });

    it('updates emoji setting', async () => {
      const result = await handler.configureIndicator({ emoji: '🌟' });

      expectConfigUpdated('emoji', '🌟');
      expect(result.content[0].text).toContain('Emoji: 🌟');
    });

    it('updates bracketStyle setting', async () => {
      const result = await handler.configureIndicator({ bracketStyle: 'round' });

      expectConfigUpdated('bracketStyle', 'round');
      expect(result.content[0].text).toContain('Brackets: round');
    });

    it('updates multiple settings at once', async () => {
      await handler.configureIndicator({
        enabled: false,
        style: 'compact',
        showVersion: false,
        emoji: '✨',
      });

      expect(indicatorConfig.enabled).toBe(false);
      expect(indicatorConfig.style).toBe('compact');
      expect(indicatorConfig.showVersion).toBe(false);
      expect(indicatorConfig.emoji).toBe('✨');
    });

    it('validates custom format', async () => {
      const result = await handler.configureIndicator({ customFormat: '{invalid}' });

      expect(result.content[0].text).toContain('Invalid custom format');
      expect(personaManager.updateIndicatorConfig).not.toHaveBeenCalled();
    });

    it('accepts valid custom format', async () => {
      const result = await handler.configureIndicator({ customFormat: '{emoji} {name}' });

      expect(indicatorConfig.customFormat).toBe('{emoji} {name}');
      expect(result.content[0].text).toContain('Custom Format: {emoji} {name}');
    });

    it('shows example with active persona', async () => {
      const result = await handler.configureIndicator({ style: 'full' });

      expect(result.content[0].text).toContain('Example indicator:');
      expect(result.content[0].text).not.toContain('(none - indicators disabled)');
    });

    it('shows sample example when no active persona', async () => {
      activePersona = null;
      personaManager.getActivePersona.mockReturnValue(null);

      const result = await handler.configureIndicator({ style: 'full' });

      expect(result.content[0].text).toContain('Example indicator:');
    });

    it('includes environment variable instructions', async () => {
      const result = await handler.configureIndicator({ style: 'minimal' });

      expect(result.content[0].text).toContain('DOLLHOUSE_INDICATOR_ENABLED');
      expect(result.content[0].text).toContain('Configuration is temporary for this session');
    });

    it('propagates initialization', async () => {
      await handler.configureIndicator({ enabled: false });
      expect(initService.ensureInitialized).toHaveBeenCalled();
    });
  });

  describe('getIndicatorConfig', () => {
    it('returns current configuration with active persona', async () => {
      const result = await handler.getIndicatorConfig();

      expect(result.content[0].text).toContain('Current Indicator Configuration');
      expect(result.content[0].text).toContain('Enabled: true');
      expect(result.content[0].text).toContain('Style: full');
      expect(result.content[0].text).toContain('Emoji: 🎭');
      expect(result.content[0].text).toContain('Brackets: square');
    });

    it('shows example with active persona', async () => {
      const result = await handler.getIndicatorConfig();

      expect(result.content[0].text).toContain('Example with current settings:');
      expect(result.content[0].text).not.toContain('(none - indicators disabled)');
    });

    it('shows sample example when no active persona', async () => {
      activePersona = null;
      personaManager.getActivePersona.mockReturnValue(null);

      const result = await handler.getIndicatorConfig();

      expect(result.content[0].text).toContain('Example with current settings:');
    });

    it('shows custom format when set', async () => {
      indicatorConfig.customFormat = '{emoji} {name}';

      const result = await handler.getIndicatorConfig();

      expect(result.content[0].text).toContain('Custom Format: {emoji} {name}');
    });

    it('lists available styles and placeholders', async () => {
      const result = await handler.getIndicatorConfig();

      expect(result.content[0].text).toContain('Available styles:');
      expect(result.content[0].text).toContain('{emoji}');
    });

    it('includes persona indicator prefix', async () => {
      const result = await handler.getIndicatorConfig();

      expect(indicatorService.getPersonaIndicator).toHaveBeenCalled();
      expect(result.content[0].text).toContain('[🎭 Test Persona v1.0.0] ');
    });
    it('propagates initialization', async () => {
      await handler.getIndicatorConfig();
      expect(initService.ensureInitialized).toHaveBeenCalled();
    });
   });

   describe('indicator config mutations', () => {
     it('persists changes across multiple calls', async () => {
       await handler.configureIndicator({ enabled: false });
       expect(indicatorConfig.enabled).toBe(false);

       await handler.configureIndicator({ style: 'minimal' });
       expect(indicatorConfig.enabled).toBe(false);
       expect(indicatorConfig.style).toBe('minimal');

       await handler.configureIndicator({ emoji: '⭐' });
       expect(indicatorConfig.style).toBe('minimal');
       expect(indicatorConfig.emoji).toBe('⭐');
     });

     it('reflects updates in getIndicatorConfig', async () => {
       await handler.configureIndicator({
         enabled: false,
         style: 'compact',
         emoji: '🚀',
       });

       const result = await handler.getIndicatorConfig();

       expect(result.content[0].text).toContain('Enabled: false');
       expect(result.content[0].text).toContain('Style: compact');
       expect(result.content[0].text).toContain('Emoji: 🚀');
     });
   });
});
