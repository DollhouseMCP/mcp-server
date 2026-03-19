/**
 * PersonaIndicatorService - Persona Integration Tests
 *
 * Tests indicator formatting, configuration, and behavior specifically
 * for persona integration. Focuses on:
 * - Indicator configuration management
 * - Formatting with various persona names
 * - Context-specific rendering (CLI, MCP, logs)
 * - Multi-byte character handling (CJK, Arabic, emoji)
 * - Indicator update notifications
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PersonaIndicatorService } from '../../../src/services/PersonaIndicatorService.js';
import { formatIndicator, type IndicatorConfig } from '../../../src/config/indicator-config.js';
import type { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { StateChangeNotifier } from '../../../src/services/StateChangeNotifier.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';

const buildPersona = (name: string, overrides = {}) => ({
  metadata: {
    name,
    version: '1.0',
    author: 'Tester',
    category: 'general',
    ...overrides,
  },
  filename: `${name.toLowerCase().replace(/\s+/g, '-')}.md`,
});

describe('PersonaIndicatorService - Persona Integration', () => {
  let personaManager: jest.Mocked<Pick<PersonaManager, 'getActivePersona'>>;
  let notifier: StateChangeNotifier;
  let dispatcher: ElementEventDispatcher;

  beforeEach(() => {
    personaManager = {
      getActivePersona: jest.fn().mockReturnValue(null),
    };
    notifier = new StateChangeNotifier();
    dispatcher = new ElementEventDispatcher();
  });

  describe('Indicator Configuration Tests', () => {
    it('should use default indicator config', () => {
      personaManager.getActivePersona.mockReturnValue(
        buildPersona('Test Persona') as any
      );

      const config: IndicatorConfig = {
        enabled: true,
        style: 'full',
        showEmoji: true,
        showName: true,
        showVersion: true,
        showAuthor: true,
        showCategory: false,
        separator: ' | ',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const service = new PersonaIndicatorService(
        personaManager as unknown as PersonaManager,
        config,
        notifier,
        dispatcher
      );

      const indicator = service.getPersonaIndicator();
      expect(indicator).toContain('Test Persona');
      expect(indicator).toContain('🎭');
    });

    it('should update indicator config and persist changes', () => {
      personaManager.getActivePersona.mockReturnValue(
        buildPersona('Test Persona') as any
      );

      const config: IndicatorConfig = {
        enabled: true,
        style: 'full',
        showEmoji: true,
        showName: true,
        showVersion: true,
        showAuthor: true,
        showCategory: false,
        separator: ' | ',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const service = new PersonaIndicatorService(
        personaManager as unknown as PersonaManager,
        config,
        notifier,
        dispatcher
      );

      const initialIndicator = service.getPersonaIndicator();
      expect(initialIndicator).toContain('🎭');

      // Update config
      service.updateConfig({
        ...config,
        emoji: '🤖',
        showEmoji: true,
      });

      const updatedIndicator = service.getPersonaIndicator();
      expect(updatedIndicator).toContain('🤖');
      expect(updatedIndicator).not.toContain('🎭');
    });

    it('should change format string and apply correctly', () => {
      personaManager.getActivePersona.mockReturnValue(
        buildPersona('Creative Writer') as any
      );

      const config: IndicatorConfig = {
        enabled: true,
        style: 'minimal',
        showEmoji: true,
        showName: true,
        showVersion: false,
        showAuthor: false,
        showCategory: false,
        separator: ' ',
        emoji: '✨',
        bracketStyle: 'none',
      };

      const service = new PersonaIndicatorService(
        personaManager as unknown as PersonaManager,
        config,
        notifier,
        dispatcher
      );

      const indicator = service.getPersonaIndicator();
      expect(indicator).toContain('Creative Writer');
      expect(indicator).toContain('✨');
      expect(indicator).not.toContain('v1.0');
      expect(indicator).not.toContain('Tester');
    });

    it('should disable indicator when enabled state is false', () => {
      personaManager.getActivePersona.mockReturnValue(
        buildPersona('Test Persona') as any
      );

      const config: IndicatorConfig = {
        enabled: false,
        style: 'full',
        showEmoji: true,
        showName: true,
        showVersion: true,
        showAuthor: true,
        showCategory: false,
        separator: ' | ',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const service = new PersonaIndicatorService(
        personaManager as unknown as PersonaManager,
        config,
        notifier,
        dispatcher
      );

      const indicator = service.getPersonaIndicator();
      expect(indicator).toBe('');
    });
  });

  describe('Indicator Formatting Tests', () => {
    it('should format indicator with short name', () => {
      const config: IndicatorConfig = {
        enabled: true,
        style: 'compact',
        showEmoji: false,
        showName: true,
        showVersion: false,
        showAuthor: false,
        showCategory: false,
        separator: '',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const indicator = formatIndicator(config, {
        name: 'AI',
        version: '1.0',
        author: 'System',
      });

      expect(indicator).toContain('AI');
      expect(indicator).toMatch(/^\[AI\]/);
    });

    it('should format indicator with long name', () => {
      const config: IndicatorConfig = {
        enabled: true,
        style: 'compact',
        showEmoji: false,
        showName: true,
        showVersion: true,
        showAuthor: false,
        showCategory: false,
        separator: '',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const indicator = formatIndicator(config, {
        name: 'Creative Writer',
        version: '2.5',
        author: 'System',
      });

      expect(indicator).toContain('Creative Writer');
      expect(indicator).toMatch(/^\[Creative Writer v2\.5\]/);
    });

    it('should format indicator with special characters', () => {
      const config: IndicatorConfig = {
        enabled: true,
        style: 'compact',
        showEmoji: false,
        showName: true,
        showVersion: false,
        showAuthor: false,
        showCategory: false,
        separator: '',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const indicator = formatIndicator(config, {
        name: 'Test & Test',
        version: '1.0',
      });

      expect(indicator).toContain('Test & Test');
      expect(indicator).toMatch(/^\[Test & Test\]/);
    });

    it('should format indicator with Unicode characters', () => {
      const config: IndicatorConfig = {
        enabled: true,
        style: 'compact',
        showEmoji: false,
        showName: true,
        showVersion: false,
        showAuthor: false,
        showCategory: false,
        separator: '',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const indicator = formatIndicator(config, {
        name: 'Tëst',
        version: '1.0',
      });

      expect(indicator).toContain('Tëst');
      expect(indicator).toMatch(/^\[Tëst\]/);
    });

    it('should format indicator with emoji in name', () => {
      const config: IndicatorConfig = {
        enabled: true,
        style: 'compact',
        showEmoji: false,
        showName: true,
        showVersion: false,
        showAuthor: false,
        showCategory: false,
        separator: '',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const indicator = formatIndicator(config, {
        name: 'Test 😀',
        version: '1.0',
      });

      expect(indicator).toContain('Test 😀');
      expect(indicator).toMatch(/^\[Test 😀\]/);
    });
  });

  describe('Indicator Context Tests', () => {
    it('should format indicator for CLI output', () => {
      personaManager.getActivePersona.mockReturnValue(
        buildPersona('CLI Persona') as any
      );

      const config: IndicatorConfig = {
        enabled: true,
        style: 'full',
        showEmoji: true,
        showName: true,
        showVersion: true,
        showAuthor: true,
        showCategory: false,
        separator: ' | ',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const service = new PersonaIndicatorService(
        personaManager as unknown as PersonaManager,
        config,
        notifier,
        dispatcher
      );

      const indicator = service.getPersonaIndicator();
      expect(indicator).toContain('CLI Persona');
      expect(indicator).toContain('🎭');
      expect(indicator).toMatch(/\| $/); // Ends with separator
    });

    it('should format indicator for MCP responses', () => {
      personaManager.getActivePersona.mockReturnValue(
        buildPersona('MCP Persona') as any
      );

      const config: IndicatorConfig = {
        enabled: true,
        style: 'minimal',
        showEmoji: true,
        showName: true,
        showVersion: false,
        showAuthor: false,
        showCategory: false,
        separator: ' ',
        emoji: '🎭',
        bracketStyle: 'none',
      };

      const service = new PersonaIndicatorService(
        personaManager as unknown as PersonaManager,
        config,
        notifier,
        dispatcher
      );

      const indicator = service.getPersonaIndicator();
      expect(indicator).toContain('MCP Persona');
      expect(indicator).not.toContain('[');
      expect(indicator).not.toContain(']');
    });

    it('should format indicator for log messages', () => {
      personaManager.getActivePersona.mockReturnValue(
        buildPersona('Log Persona') as any
      );

      const config: IndicatorConfig = {
        enabled: true,
        style: 'compact',
        showEmoji: false,
        showName: true,
        showVersion: true,
        showAuthor: false,
        showCategory: false,
        separator: '',
        emoji: '🎭',
        bracketStyle: 'square', // compact style already uses brackets
      };

      const service = new PersonaIndicatorService(
        personaManager as unknown as PersonaManager,
        config,
        notifier,
        dispatcher
      );

      const indicator = service.getPersonaIndicator();
      expect(indicator).toContain('Log Persona');
      expect(indicator).toContain('v1.0');
      expect(indicator).toMatch(/^\[.*\]/);
    });

    it('should return empty string when indicator is disabled', () => {
      personaManager.getActivePersona.mockReturnValue(
        buildPersona('Disabled Persona') as any
      );

      const config: IndicatorConfig = {
        enabled: false,
        style: 'full',
        showEmoji: true,
        showName: true,
        showVersion: true,
        showAuthor: true,
        showCategory: false,
        separator: ' | ',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const service = new PersonaIndicatorService(
        personaManager as unknown as PersonaManager,
        config,
        notifier,
        dispatcher
      );

      const indicator = service.getPersonaIndicator();
      expect(indicator).toBe('');
    });
  });

  describe('Indicator Update Tests', () => {
    it('should update indicator on persona activation', () => {
      personaManager.getActivePersona.mockReturnValue(null);

      const config: IndicatorConfig = {
        enabled: true,
        style: 'full',
        showEmoji: true,
        showName: true,
        showVersion: true,
        showAuthor: true,
        showCategory: false,
        separator: ' | ',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const service = new PersonaIndicatorService(
        personaManager as unknown as PersonaManager,
        config,
        notifier,
        dispatcher
      );

      expect(service.getPersonaIndicator()).toBe('');

      // Activate a persona
      personaManager.getActivePersona.mockReturnValue(
        buildPersona('New Persona') as any
      );

      notifier.notifyPersonaChange({
        type: 'persona-activated',
        previousValue: null,
        newValue: 'new-persona.md',
        timestamp: new Date(),
      });

      const indicator = service.getPersonaIndicator();
      expect(indicator).toContain('New Persona');
    });

    it('should clear indicator on persona deactivation', () => {
      personaManager.getActivePersona.mockReturnValue(
        buildPersona('Active Persona') as any
      );

      const config: IndicatorConfig = {
        enabled: true,
        style: 'full',
        showEmoji: true,
        showName: true,
        showVersion: true,
        showAuthor: true,
        showCategory: false,
        separator: ' | ',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const service = new PersonaIndicatorService(
        personaManager as unknown as PersonaManager,
        config,
        notifier,
        dispatcher
      );

      expect(service.getPersonaIndicator()).toContain('Active Persona');

      // Deactivate persona
      personaManager.getActivePersona.mockReturnValue(null);

      notifier.notifyPersonaChange({
        type: 'persona-deactivated',
        previousValue: 'active-persona.md',
        newValue: null,
        timestamp: new Date(),
      });

      const indicator = service.getPersonaIndicator();
      expect(indicator).toBe('');
    });

    it('should update indicator on persona name change', () => {
      personaManager.getActivePersona.mockReturnValue(
        buildPersona('Original Name') as any
      );

      const config: IndicatorConfig = {
        enabled: true,
        style: 'full',
        showEmoji: true,
        showName: true,
        showVersion: true,
        showAuthor: true,
        showCategory: false,
        separator: ' | ',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const service = new PersonaIndicatorService(
        personaManager as unknown as PersonaManager,
        config,
        notifier,
        dispatcher
      );

      const initialIndicator = service.getPersonaIndicator();
      expect(initialIndicator).toContain('Original Name');

      // Update persona name
      personaManager.getActivePersona.mockReturnValue(
        buildPersona('Updated Name') as any
      );

      notifier.notifyPersonaChange({
        type: 'persona-activated',
        previousValue: 'original-name.md',
        newValue: 'updated-name.md',
        timestamp: new Date(),
      });

      const updatedIndicator = service.getPersonaIndicator();
      expect(updatedIndicator).toContain('Updated Name');
      expect(updatedIndicator).not.toContain('Original Name');
    });

    it('should trigger notification on indicator updates', () => {
      personaManager.getActivePersona.mockReturnValue(
        buildPersona('Test Persona') as any
      );

      const config: IndicatorConfig = {
        enabled: true,
        style: 'full',
        showEmoji: true,
        showName: true,
        showVersion: true,
        showAuthor: true,
        showCategory: false,
        separator: ' | ',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const service = new PersonaIndicatorService(
        personaManager as unknown as PersonaManager,
        config,
        notifier,
        dispatcher
      );

      // Cache initial indicator
      service.getPersonaIndicator();

      // Mock the listener to verify it's called
      const listenerSpy = jest.fn();
      notifier.on('state-change:persona-activated', listenerSpy);

      // Trigger state change
      notifier.notifyPersonaChange({
        type: 'persona-activated',
        previousValue: null,
        newValue: 'test-persona.md',
        timestamp: new Date(),
      });

      expect(listenerSpy).toHaveBeenCalled();
    });
  });

  describe('Multi-byte Character Tests', () => {
    it('should format indicator with CJK characters', () => {
      const config: IndicatorConfig = {
        enabled: true,
        style: 'compact',
        showEmoji: false,
        showName: true,
        showVersion: false,
        showAuthor: false,
        showCategory: false,
        separator: '',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const indicator = formatIndicator(config, {
        name: '日本語',
        version: '1.0',
      });

      expect(indicator).toContain('日本語');
      expect(indicator).toMatch(/^\[日本語\]/);
    });

    it('should format indicator with Arabic characters', () => {
      const config: IndicatorConfig = {
        enabled: true,
        style: 'compact',
        showEmoji: false,
        showName: true,
        showVersion: false,
        showAuthor: false,
        showCategory: false,
        separator: '',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const indicator = formatIndicator(config, {
        name: 'العربية',
        version: '1.0',
      });

      expect(indicator).toContain('العربية');
      expect(indicator).toMatch(/^\[العربية\]/);
    });

    it('should calculate proper string length for multi-byte characters', () => {
      personaManager.getActivePersona.mockReturnValue(
        buildPersona('日本語ペルソナ') as any
      );

      const config: IndicatorConfig = {
        enabled: true,
        style: 'compact',
        showEmoji: false,
        showName: true,
        showVersion: false,
        showAuthor: false,
        showCategory: false,
        separator: '',
        emoji: '🎭',
        bracketStyle: 'square',
      };

      const service = new PersonaIndicatorService(
        personaManager as unknown as PersonaManager,
        config,
        notifier,
        dispatcher
      );

      const indicator = service.getPersonaIndicator();

      // Verify full string is present (not truncated based on byte length)
      expect(indicator).toContain('日本語ペルソナ');

      // Verify character length, not byte length
      const name = '日本語ペルソナ';
      expect(name.length).toBe(7); // 7 characters
      // UTF-8 byte length would be much larger
      const byteLength = Buffer.from(name, 'utf8').length;
      expect(byteLength).toBeGreaterThan(name.length);

      // Ensure indicator contains all characters
      expect(indicator).toMatch(/\[日本語ペルソナ\]/);
    });
  });
});
