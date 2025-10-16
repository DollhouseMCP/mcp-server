/**
 * Capability Index Resources Configuration Tests
 *
 * Tests for configuration management of capability index resources:
 * - Default configuration values
 * - Variant toggle behavior
 * - Boolean type validation
 * - Configuration export/import
 *
 * Ensures safe defaults and proper opt-in behavior.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
// FIX: Added node: prefix to built-in Node.js imports
// Previously: import * as path from 'path';
// Now: import * as path from 'node:path'; for Node.js convention
import * as path from 'node:path';

// Mock filesystem operations with proper implementations
jest.unstable_mockModule('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn(),
  mkdir: jest.fn(),
  rename: jest.fn(),
  unlink: jest.fn(),
  access: jest.fn(),
  copyFile: jest.fn(),
}));

jest.unstable_mockModule('os', () => ({
  homedir: jest.fn(),
}));

// Mock logger
jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
}));

// Import mocked modules and the class under test after mocking
const fs = await import('fs/promises');
const os = await import('os');
const { ConfigManager, CapabilityIndexResourcesConfig } = await import('../../../../src/config/ConfigManager.js');

describe('Capability Index Resources Configuration', () => {
  let configManager: ConfigManager;
  const mockHomedir = '/home/testuser';
  // FIX: Removed useless assignment to 'configDir'
  // Previously: const configDir = path.join(mockHomedir, '.dollhouse'); (never used)
  // Now: Removed unused variable

  beforeEach(async () => {
    // Clear all mocks
    jest.clearAllMocks();

    // Reset ConfigManager singleton
    ConfigManager.resetForTesting();

    // Mock os.homedir
    (os.homedir as jest.Mock).mockReturnValue(mockHomedir);

    // Mock filesystem - simulate no existing config file (fresh start)
    const mockAccess = fs.access as jest.MockedFunction<typeof fs.access>;
    const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
    const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
    const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
    const mockRename = fs.rename as jest.MockedFunction<typeof fs.rename>;

    mockAccess.mockRejectedValue({ code: 'ENOENT' }); // File doesn't exist
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);

    configManager = ConfigManager.getInstance();
    await configManager.initialize();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Default Configuration', () => {
    /**
     * Verifies that advertise_resources is disabled by default
     * for safety and opt-in behavior
     */
    it('should have advertise_resources disabled by default', () => {
      const config = configManager.getConfig();

      expect(config.elements?.enhanced_index?.resources?.advertise_resources).toBe(false);
    });

    /**
     * Verifies that summary variant is disabled by default
     * (requires opt-in due to ~2.5-3.5K token impact)
     */
    it('should have summary variant disabled by default', () => {
      const config = configManager.getConfig();
      const variants = config.elements?.enhanced_index?.resources?.variants;

      expect(variants?.summary).toBe(false);
    });

    /**
     * Verifies that full variant is disabled by default
     * (requires opt-in due to ~35-45K token impact)
     */
    it('should have full variant disabled by default', () => {
      const config = configManager.getConfig();
      const variants = config.elements?.enhanced_index?.resources?.variants;

      expect(variants?.full).toBe(false);
    });

    /**
     * Verifies that stats variant is enabled by default
     * (safe, only ~50 tokens, useful for measurement)
     */
    it('should have stats variant enabled by default', () => {
      const config = configManager.getConfig();
      const variants = config.elements?.enhanced_index?.resources?.variants;

      expect(variants?.stats).toBe(true);
    });

    /**
     * Verifies that all resource configuration fields exist
     * in the default configuration
     */
    it('should include all resource configuration fields', () => {
      const config = configManager.getConfig();
      const resources = config.elements?.enhanced_index?.resources;

      expect(resources).toBeDefined();
      expect(resources).toHaveProperty('advertise_resources');
      expect(resources).toHaveProperty('variants');
      expect(resources?.variants).toHaveProperty('summary');
      expect(resources?.variants).toHaveProperty('full');
      expect(resources?.variants).toHaveProperty('stats');
    });
  });

  describe('Configuration Updates', () => {
    /**
     * Verifies that advertise_resources can be enabled
     */
    it('should allow enabling advertise_resources', async () => {
      await configManager.updateSetting(
        'elements.enhanced_index.resources.advertise_resources',
        true
      );

      const config = configManager.getConfig();
      expect(config.elements?.enhanced_index?.resources?.advertise_resources).toBe(true);
    });

    /**
     * Verifies that summary variant can be enabled
     */
    it('should allow enabling summary variant', async () => {
      await configManager.updateSetting(
        'elements.enhanced_index.resources.variants.summary',
        true
      );

      const config = configManager.getConfig();
      expect(config.elements?.enhanced_index?.resources?.variants?.summary).toBe(true);
    });

    /**
     * Verifies that full variant can be enabled
     */
    it('should allow enabling full variant', async () => {
      await configManager.updateSetting(
        'elements.enhanced_index.resources.variants.full',
        true
      );

      const config = configManager.getConfig();
      expect(config.elements?.enhanced_index?.resources?.variants?.full).toBe(true);
    });

    /**
     * Verifies that stats variant can be disabled
     */
    it('should allow disabling stats variant', async () => {
      await configManager.updateSetting(
        'elements.enhanced_index.resources.variants.stats',
        false
      );

      const config = configManager.getConfig();
      expect(config.elements?.enhanced_index?.resources?.variants?.stats).toBe(false);
    });

    /**
     * Verifies that all variants can be enabled simultaneously
     */
    it('should allow enabling all variants', async () => {
      await configManager.updateSetting(
        'elements.enhanced_index.resources.variants.summary',
        true
      );
      await configManager.updateSetting(
        'elements.enhanced_index.resources.variants.full',
        true
      );
      await configManager.updateSetting(
        'elements.enhanced_index.resources.variants.stats',
        true
      );

      const config = configManager.getConfig();
      const variants = config.elements?.enhanced_index?.resources?.variants;

      expect(variants?.summary).toBe(true);
      expect(variants?.full).toBe(true);
      expect(variants?.stats).toBe(true);
    });

    /**
     * Verifies that all variants can be disabled simultaneously
     */
    it('should allow disabling all variants', async () => {
      await configManager.updateSetting(
        'elements.enhanced_index.resources.variants.summary',
        false
      );
      await configManager.updateSetting(
        'elements.enhanced_index.resources.variants.full',
        false
      );
      await configManager.updateSetting(
        'elements.enhanced_index.resources.variants.stats',
        false
      );

      const config = configManager.getConfig();
      const variants = config.elements?.enhanced_index?.resources?.variants;

      expect(variants?.summary).toBe(false);
      expect(variants?.full).toBe(false);
      expect(variants?.stats).toBe(false);
    });
  });

  describe('Type Validation', () => {
    /**
     * Verifies that advertise_resources accepts boolean values
     */
    it('should accept boolean values for advertise_resources', async () => {
      await configManager.updateSetting(
        'elements.enhanced_index.resources.advertise_resources',
        true
      );

      const config = configManager.getConfig();
      expect(typeof config.elements?.enhanced_index?.resources?.advertise_resources).toBe('boolean');
      expect(config.elements?.enhanced_index?.resources?.advertise_resources).toBe(true);
    });

    /**
     * Verifies that variant toggles accept boolean values
     */
    it('should accept boolean values for variant toggles', async () => {
      await configManager.updateSetting(
        'elements.enhanced_index.resources.variants.summary',
        true
      );

      const config = configManager.getConfig();
      expect(typeof config.elements?.enhanced_index?.resources?.variants?.summary).toBe('boolean');
      expect(config.elements?.enhanced_index?.resources?.variants?.summary).toBe(true);
    });

    /**
     * Verifies that boolean false values work correctly
     */
    it('should handle false values correctly', async () => {
      await configManager.updateSetting(
        'elements.enhanced_index.resources.advertise_resources',
        false
      );

      const config = configManager.getConfig();
      expect(config.elements?.enhanced_index?.resources?.advertise_resources).toBe(false);
    });
  });

  describe('Configuration Retrieval', () => {
    /**
     * Verifies that getSetting() can retrieve resource configuration
     */
    it('should retrieve resource configuration via getSetting()', () => {
      const resourceConfig = configManager.getSetting('elements.enhanced_index.resources');

      expect(resourceConfig).toBeDefined();
      expect(resourceConfig).toHaveProperty('advertise_resources');
      expect(resourceConfig).toHaveProperty('variants');
    });

    /**
     * Verifies that getSetting() can retrieve individual variant settings
     */
    it('should retrieve individual variant settings', () => {
      const summaryEnabled = configManager.getSetting(
        'elements.enhanced_index.resources.variants.summary'
      );
      const fullEnabled = configManager.getSetting(
        'elements.enhanced_index.resources.variants.full'
      );
      const statsEnabled = configManager.getSetting(
        'elements.enhanced_index.resources.variants.stats'
      );

      // Should return the default boolean values
      expect(summaryEnabled).toBe(false);
      expect(fullEnabled).toBe(false);
      expect(statsEnabled).toBe(true);
    });

    /**
     * Verifies that undefined is returned for non-existent settings
     */
    it('should return undefined for non-existent settings', () => {
      const nonExistent = configManager.getSetting(
        'elements.enhanced_index.resources.variants.nonexistent'
      );

      expect(nonExistent).toBeUndefined();
    });
  });

  describe('Configuration Reset', () => {
    /**
     * Verifies that resetConfig() restores default values
     */
    it('should restore defaults when reset', async () => {
      // Modify configuration
      await configManager.updateSetting(
        'elements.enhanced_index.resources.advertise_resources',
        true
      );
      await configManager.updateSetting(
        'elements.enhanced_index.resources.variants.summary',
        true
      );

      // Reset configuration
      await configManager.resetConfig();

      // Should be back to defaults
      const config = configManager.getConfig();
      expect(config.elements?.enhanced_index?.resources?.advertise_resources).toBe(false);
      expect(config.elements?.enhanced_index?.resources?.variants?.summary).toBe(false);
      expect(config.elements?.enhanced_index?.resources?.variants?.stats).toBe(true);
    });
  });

  describe('Configuration Formatting', () => {
    /**
     * Verifies that resource configuration is included in formatted output
     */
    it('should include resource configuration in formatted output', () => {
      const formatted = configManager.getFormattedConfig();

      expect(formatted).toContain('enhanced_index');
      expect(formatted).toContain('resources');
      expect(formatted).toContain('advertise_resources');
      expect(formatted).toContain('variants');
    });

    /**
     * Verifies that modified resource configuration is reflected in formatted output
     */
    it('should reflect modified resource configuration in formatted output', async () => {
      // Modify configuration
      await configManager.updateSetting(
        'elements.enhanced_index.resources.advertise_resources',
        true
      );
      await configManager.updateSetting(
        'elements.enhanced_index.resources.variants.summary',
        true
      );

      // Get formatted output
      const formatted = configManager.getFormattedConfig('elements.enhanced_index.resources');

      // Should include modified values
      expect(formatted).toContain('advertise_resources');
      expect(formatted).toContain('true');
      expect(formatted).toContain('summary');
    });
  });

  describe('Safe Defaults Philosophy', () => {
    /**
     * Verifies that default configuration follows safe defaults principle:
     * - No automatic resource advertising (opt-in)
     * - No large token variants enabled (opt-in)
     * - Only minimal stats variant enabled
     */
    it('should follow safe defaults principle', () => {
      const config = configManager.getConfig();
      const resources = config.elements?.enhanced_index?.resources;

      // No automatic advertising
      expect(resources?.advertise_resources).toBe(false);

      // No large variants by default
      expect(resources?.variants?.summary).toBe(false);  // ~2.5-3.5K tokens
      expect(resources?.variants?.full).toBe(false);     // ~35-45K tokens

      // Only safe minimal variant enabled
      expect(resources?.variants?.stats).toBe(true);     // ~50 tokens
    });

    /**
     * Verifies that configuration documentation reflects opt-in philosophy
     */
    it('should document opt-in behavior', () => {
      // This test documents the expected behavior
      // Users must explicitly enable resources
      const defaultConfig = configManager.getConfig();

      expect(defaultConfig.elements?.enhanced_index?.resources?.advertise_resources).toBe(false);
      // This means: "I understand the token impact and want to enable this feature"
    });
  });

  describe('Edge Cases', () => {
    /**
     * Verifies handling of missing enhanced_index section
     */
    it('should handle missing enhanced_index section gracefully', async () => {
      // Manually remove enhanced_index
      const config = configManager.getConfig();
      if (config.elements) {
        delete config.elements.enhanced_index;
      }

      // Should not crash when accessing
      const resources = config.elements?.enhanced_index?.resources;
      expect(resources).toBeUndefined();
    });

    /**
     * Verifies handling of partially missing configuration
     */
    it('should handle partially missing resource configuration', async () => {
      const config = configManager.getConfig();
      if (config.elements?.enhanced_index) {
        delete config.elements.enhanced_index.resources;
      }

      // Should not crash
      const resources = config.elements?.enhanced_index?.resources;
      expect(resources).toBeUndefined();
    });
  });

  describe('Configuration Validation', () => {
    /**
     * Verifies that invalid configuration paths are rejected
     */
    it('should handle invalid configuration paths', () => {
      const invalidPath = configManager.getSetting('invalid.path.that.does.not.exist');
      expect(invalidPath).toBeUndefined();
    });

    /**
     * Verifies that partial configuration paths work correctly
     */
    it('should handle partial configuration paths', () => {
      const variants = configManager.getSetting('elements.enhanced_index.resources.variants');

      expect(variants).toBeDefined();
      expect(variants).toHaveProperty('summary');
      expect(variants).toHaveProperty('full');
      expect(variants).toHaveProperty('stats');
    });
  });
});
