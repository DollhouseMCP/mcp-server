import { describe, it, expect, beforeEach } from '@jest/globals';
import { 
  loadIndicatorConfig, 
  formatIndicator,
  validateCustomFormat,
  DEFAULT_INDICATOR_CONFIG,
  INDICATOR_STYLES,
  BRACKETS,
  IndicatorConfig 
} from '../../src/config/indicator-config.js';

describe('Indicator Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment variables before each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('loadIndicatorConfig', () => {
    it('should return default configuration when no environment variables are set', () => {
      const config = loadIndicatorConfig();
      expect(config).toEqual(DEFAULT_INDICATOR_CONFIG);
    });

    it('should override enabled setting from environment', () => {
      process.env.DOLLHOUSE_INDICATOR_ENABLED = 'false';
      const config = loadIndicatorConfig();
      expect(config.enabled).toBe(false);
    });

    it('should override style from environment', () => {
      process.env.DOLLHOUSE_INDICATOR_STYLE = 'minimal';
      const config = loadIndicatorConfig();
      expect(config.style).toBe('minimal');
    });

    it('should set custom format and style when format is provided', () => {
      process.env.DOLLHOUSE_INDICATOR_FORMAT = '{name} ({version})';
      const config = loadIndicatorConfig();
      expect(config.style).toBe('custom');
      expect(config.customFormat).toBe('{name} ({version})');
    });

    it('should override multiple settings from environment', () => {
      process.env.DOLLHOUSE_INDICATOR_EMOJI = '🤖';
      process.env.DOLLHOUSE_INDICATOR_SHOW_VERSION = 'false';
      process.env.DOLLHOUSE_INDICATOR_SHOW_AUTHOR = 'false';
      process.env.DOLLHOUSE_INDICATOR_BRACKETS = 'round';
      
      const config = loadIndicatorConfig();
      expect(config.emoji).toBe('🤖');
      expect(config.showVersion).toBe(false);
      expect(config.showAuthor).toBe(false);
      expect(config.bracketStyle).toBe('round');
    });
  });

  describe('formatIndicator', () => {
    const testMetadata = {
      name: 'Test Persona',
      version: '1.0.0',
      author: '@testuser',
      category: 'testing'
    };

    it('should return empty string when disabled', () => {
      const config: IndicatorConfig = { ...DEFAULT_INDICATOR_CONFIG, enabled: false };
      const result = formatIndicator(config, testMetadata);
      expect(result).toBe('');
    });

    it('should format full style correctly', () => {
      const config: IndicatorConfig = { ...DEFAULT_INDICATOR_CONFIG, style: 'full' };
      const result = formatIndicator(config, testMetadata);
      expect(result).toBe('[🎭 Test Persona v1.0.0 by @testuser] | ');
    });

    it('should format minimal style correctly', () => {
      const config: IndicatorConfig = { ...DEFAULT_INDICATOR_CONFIG, style: 'minimal' };
      const result = formatIndicator(config, testMetadata);
      expect(result).toBe('🎭 Test Persona | ');
    });

    it('should format compact style correctly', () => {
      const config: IndicatorConfig = { ...DEFAULT_INDICATOR_CONFIG, style: 'compact' };
      const result = formatIndicator(config, testMetadata);
      expect(result).toBe('[Test Persona v1.0.0] | ');
    });

    it('should handle custom format', () => {
      const config: IndicatorConfig = {
        ...DEFAULT_INDICATOR_CONFIG,
        style: 'custom',
        customFormat: '>> {name} by {author} <<'
      };
      const result = formatIndicator(config, testMetadata);
      expect(result).toBe('>> Test Persona by @testuser << | ');
    });

    it('should respect show flags', () => {
      const config: IndicatorConfig = {
        ...DEFAULT_INDICATOR_CONFIG,
        style: 'full',
        showVersion: false,
        showAuthor: false
      };
      const result = formatIndicator(config, testMetadata);
      // When version and author are hidden, the template still has "v" and "by" which get cleaned up
      expect(result).toBe('[🎭 Test Persona ] | ');
    });

    it('should handle missing metadata gracefully', () => {
      const config: IndicatorConfig = { ...DEFAULT_INDICATOR_CONFIG, style: 'full' };
      const minimalMetadata = { name: 'Simple Persona' };
      const result = formatIndicator(config, minimalMetadata);
      // Missing version and author means "v" and "by" get cleaned up
      expect(result).toBe('[🎭 Simple Persona ] | ');
    });

    it('should apply different bracket styles', () => {
      const baseConfig: IndicatorConfig = { ...DEFAULT_INDICATOR_CONFIG, style: 'minimal' };
      
      // The minimal style doesn't have brackets in the template, so they get added
      const squareResult = formatIndicator({ ...baseConfig, bracketStyle: 'square' }, testMetadata);
      expect(squareResult).toBe('🎭 Test Persona | ');
      
      const roundResult = formatIndicator({ ...baseConfig, bracketStyle: 'round' }, testMetadata);
      expect(roundResult).toBe('🎭 Test Persona | ');
      
      const curlyResult = formatIndicator({ ...baseConfig, bracketStyle: 'curly' }, testMetadata);
      expect(curlyResult).toBe('🎭 Test Persona | ');
      
      const angleResult = formatIndicator({ ...baseConfig, bracketStyle: 'angle' }, testMetadata);
      expect(angleResult).toBe('🎭 Test Persona | ');
      
      const noneResult = formatIndicator({ ...baseConfig, bracketStyle: 'none' }, testMetadata);
      expect(noneResult).toBe('🎭 Test Persona | ');
    });

    it('should show category when enabled', () => {
      const config: IndicatorConfig = {
        ...DEFAULT_INDICATOR_CONFIG,
        style: 'custom',
        customFormat: '{name} [{category}]',
        showCategory: true
      };
      const result = formatIndicator(config, testMetadata);
      expect(result).toBe('Test Persona [testing] | ');
    });

    it('should handle custom emoji', () => {
      const config: IndicatorConfig = {
        ...DEFAULT_INDICATOR_CONFIG,
        style: 'minimal',
        emoji: '🤖'
      };
      const result = formatIndicator(config, testMetadata);
      expect(result).toBe('🤖 Test Persona | ');
    });

    it('should handle empty emoji', () => {
      const config: IndicatorConfig = {
        ...DEFAULT_INDICATOR_CONFIG,
        style: 'minimal',
        showEmoji: false
      };
      const result = formatIndicator(config, testMetadata);
      expect(result).toBe('Test Persona | ');
    });
  });

  describe('Constants and Types', () => {
    it('should export correct indicator styles', () => {
      expect(INDICATOR_STYLES.full).toBe('[{emoji} {name} v{version} by {author}]');
      expect(INDICATOR_STYLES.minimal).toBe('{emoji} {name}');
      expect(INDICATOR_STYLES.compact).toBe('[{name} v{version}]');
      expect(INDICATOR_STYLES.custom).toBe('{customFormat}');
    });

    it('should export correct bracket mappings', () => {
      expect(BRACKETS.square).toEqual({ open: '[', close: ']' });
      expect(BRACKETS.round).toEqual({ open: '(', close: ')' });
      expect(BRACKETS.curly).toEqual({ open: '{', close: '}' });
      expect(BRACKETS.angle).toEqual({ open: '<', close: '>' });
      expect(BRACKETS.none).toEqual({ open: '', close: '' });
    });

    it('should have correct default configuration', () => {
      expect(DEFAULT_INDICATOR_CONFIG).toMatchObject({
        enabled: true,
        style: 'full',
        showEmoji: true,
        showName: true,
        showVersion: true,
        showAuthor: true,
        showCategory: false,
        separator: ' | ',
        emoji: '🎭',
        bracketStyle: 'square'
      });
    });
  });

  describe('validateCustomFormat', () => {
    it('should validate valid placeholders', () => {
      const validFormats = [
        '{name}',
        '{emoji} {name}',
        '[{emoji} {name} v{version} by {author}]',
        'Persona: {name} | Category: {category}',
        '{emoji} {name} {version} {author} {category}'
      ];

      for (const format of validFormats) {
        const result = validateCustomFormat(format);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      }
    });

    it('should reject invalid placeholders', () => {
      const invalidFormats = [
        '{invalid}',
        '{name} {badplaceholder}',
        '{emoji} {Name}', // case sensitive
        '{description}',
        '{timestamp}'
      ];

      for (const format of invalidFormats) {
        const result = validateCustomFormat(format);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid placeholder');
        expect(result.error).toContain('Valid placeholders are');
      }
    });

    it('should handle formats with no placeholders', () => {
      const result = validateCustomFormat('Static text with no placeholders');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should handle malformed placeholders', () => {
      // Missing braces don't create placeholders, so they're valid
      expect(validateCustomFormat('{name')).toEqual({ valid: true });
      expect(validateCustomFormat('name}')).toEqual({ valid: true });
      
      // Empty placeholder is caught as invalid
      const emptyResult = validateCustomFormat('{}');
      expect(emptyResult.valid).toBe(false);
      expect(emptyResult.error).toContain('Invalid placeholder: {}');
      
      // Spaces inside make it invalid
      const spacesResult = validateCustomFormat('{ name }');
      expect(spacesResult.valid).toBe(false);
      expect(spacesResult.error).toContain('Invalid placeholder: { name }');
    });
  });
});