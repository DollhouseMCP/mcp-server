/**
 * ConfigHandler Source Priority Tests
 *
 * Tests for source priority configuration management via dollhouse_config tool
 * Issue #1448 - Phase 4 of Element Sourcing Priority feature
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock modules using ESM approach
jest.unstable_mockModule('../../../../src/config/ConfigManager.js', () => ({
  ConfigManager: {
    getInstance: jest.fn(),
    resetForTesting: jest.fn()
  }
}));

jest.unstable_mockModule('../../../../src/security/errorHandler.js', () => ({
  SecureErrorHandler: {
    sanitizeError: jest.fn()
  }
}));

jest.unstable_mockModule('../../../../src/config/sourcePriority.js', () => ({
  ElementSource: {
    LOCAL: 'local',
    GITHUB: 'github',
    COLLECTION: 'collection'
  },
  DEFAULT_SOURCE_PRIORITY: {
    priority: ['local', 'github', 'collection'],
    stopOnFirst: true,
    checkAllForUpdates: false,
    fallbackOnError: true
  },
  getSourcePriorityConfig: jest.fn(),
  saveSourcePriorityConfig: jest.fn(),
  validateSourcePriority: jest.fn(),
  parseSourcePriorityOrder: jest.fn(),
  getSourceDisplayName: jest.fn()
}));

// Import after mocking
const { ConfigManager } = await import('../../../../src/config/ConfigManager.js');
const { SecureErrorHandler } = await import('../../../../src/security/errorHandler.js');
const { ConfigHandler } = await import('../../../../src/handlers/ConfigHandler.js');
const sourcePriority = await import('../../../../src/config/sourcePriority.js');

describe('ConfigHandler - Source Priority', () => {
  let configHandler: ConfigHandler;
  let mockConfigManager: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock ConfigManager
    mockConfigManager = {
      initialize: jest.fn().mockResolvedValue(undefined),
      getConfig: jest.fn(),
      updateSetting: jest.fn().mockResolvedValue(undefined),
      getSetting: jest.fn(),
      resetConfig: jest.fn().mockResolvedValue(undefined),
    };

    (ConfigManager.getInstance as jest.Mock).mockReturnValue(mockConfigManager);

    // Setup SecureErrorHandler mock
    (SecureErrorHandler.sanitizeError as jest.Mock).mockImplementation((error: any) => {
      return { message: error.message || 'Error occurred' };
    });

    // Setup source priority mocks
    (sourcePriority.getSourcePriorityConfig as jest.Mock).mockReturnValue({
      priority: ['local', 'github', 'collection'],
      stopOnFirst: true,
      checkAllForUpdates: false,
      fallbackOnError: true
    });

    (sourcePriority.getSourceDisplayName as jest.Mock).mockImplementation((source: string) => {
      const names: Record<string, string> = {
        local: 'Local Portfolio',
        github: 'GitHub Portfolio',
        collection: 'Community Collection'
      };
      return names[source] || source;
    });

    (sourcePriority.validateSourcePriority as jest.Mock).mockReturnValue({
      isValid: true,
      errors: []
    });

    (sourcePriority.parseSourcePriorityOrder as jest.Mock).mockImplementation((value: any) => {
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') return JSON.parse(value);
      return value;
    });

    (sourcePriority.saveSourcePriorityConfig as jest.Mock).mockResolvedValue(undefined);

    configHandler = new ConfigHandler();
  });

  describe('Get Source Priority Configuration', () => {
    it('should get source_priority configuration', async () => {
      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'get',
        setting: 'source_priority'
      });

      // Assert
      expect(sourcePriority.getSourcePriorityConfig).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Source Priority Configuration');
      expect(result.content[0].text).toContain('Local Portfolio → GitHub Portfolio → Community Collection');
      expect(result.content[0].text).toContain('Stop on First Match');
      expect(result.content[0].text).toContain('Check All for Updates');
      expect(result.content[0].text).toContain('Fallback on Error');
    });

    it('should support alternate setting path source.priority', async () => {
      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'get',
        setting: 'source.priority'
      });

      // Assert
      expect(sourcePriority.getSourcePriorityConfig).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Source Priority Configuration');
    });

    it('should include source_priority in full config display', async () => {
      // Arrange
      mockConfigManager.getConfig.mockReturnValue({
        user: { username: 'test' }
      });

      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'get'
      });

      // Assert
      expect(result.content[0].text).toContain('source_priority');
    });
  });

  describe('Set Source Priority Order', () => {
    it('should set source priority order', async () => {
      // Arrange
      const newOrder = ['github', 'local', 'collection'];
      (sourcePriority.parseSourcePriorityOrder as jest.Mock).mockReturnValue(newOrder);

      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.order',
        value: newOrder
      });

      // Assert
      expect(sourcePriority.parseSourcePriorityOrder).toHaveBeenCalledWith(newOrder);
      expect(sourcePriority.validateSourcePriority).toHaveBeenCalled();
      expect(sourcePriority.saveSourcePriorityConfig).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Source Priority Order Updated');
      expect(result.content[0].text).toContain('GitHub Portfolio → Local Portfolio → Community Collection');
    });

    it('should handle JSON string input', async () => {
      // Arrange
      const jsonInput = '["github", "local", "collection"]';
      const parsedOrder = ['github', 'local', 'collection'];
      (sourcePriority.parseSourcePriorityOrder as jest.Mock).mockReturnValue(parsedOrder);

      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.order',
        value: jsonInput
      });

      // Assert
      expect(sourcePriority.parseSourcePriorityOrder).toHaveBeenCalledWith(jsonInput);
      expect(sourcePriority.saveSourcePriorityConfig).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Updated');
    });

    it('should reject invalid source priority order', async () => {
      // Arrange
      (sourcePriority.parseSourcePriorityOrder as jest.Mock).mockReturnValue(['local', 'local']); // Duplicate
      (sourcePriority.validateSourcePriority as jest.Mock).mockReturnValue({
        isValid: false,
        errors: ['Duplicate sources in priority list']
      });

      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.order',
        value: ['local', 'local']
      });

      // Assert
      expect(result.content[0].text).toContain('Invalid Source Priority Configuration');
      expect(result.content[0].text).toContain('Duplicate sources in priority list');
      expect(sourcePriority.saveSourcePriorityConfig).not.toHaveBeenCalled();
    });

    it('should reject empty priority list', async () => {
      // Arrange
      (sourcePriority.parseSourcePriorityOrder as jest.Mock).mockReturnValue([]);
      (sourcePriority.validateSourcePriority as jest.Mock).mockReturnValue({
        isValid: false,
        errors: ['Priority list cannot be empty']
      });

      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.order',
        value: []
      });

      // Assert
      expect(result.content[0].text).toContain('Invalid Source Priority Configuration');
      expect(result.content[0].text).toContain('Priority list cannot be empty');
      expect(sourcePriority.saveSourcePriorityConfig).not.toHaveBeenCalled();
    });
  });

  describe('Set Source Priority Boolean Settings', () => {
    it('should set stop_on_first to true', async () => {
      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.stop_on_first',
        value: true
      });

      // Assert
      expect(sourcePriority.saveSourcePriorityConfig).toHaveBeenCalledWith(
        expect.objectContaining({ stopOnFirst: true })
      );
      expect(result.content[0].text).toContain('Source Priority Setting Updated');
    });

    it('should set check_all_for_updates to true', async () => {
      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.check_all_for_updates',
        value: true
      });

      // Assert
      expect(sourcePriority.saveSourcePriorityConfig).toHaveBeenCalledWith(
        expect.objectContaining({ checkAllForUpdates: true })
      );
      expect(result.content[0].text).toContain('Updated');
    });

    it('should set fallback_on_error to false', async () => {
      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.fallback_on_error',
        value: false
      });

      // Assert
      expect(sourcePriority.saveSourcePriorityConfig).toHaveBeenCalledWith(
        expect.objectContaining({ fallbackOnError: false })
      );
      expect(result.content[0].text).toContain('Updated');
    });

    it('should convert string "true" to boolean', async () => {
      // Act
      await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.stop_on_first',
        value: 'true'
      });

      // Assert
      expect(sourcePriority.saveSourcePriorityConfig).toHaveBeenCalledWith(
        expect.objectContaining({ stopOnFirst: true })
      );
    });

    it('should convert string "false" to boolean', async () => {
      // Act
      await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.stop_on_first',
        value: 'false'
      });

      // Assert
      expect(sourcePriority.saveSourcePriorityConfig).toHaveBeenCalledWith(
        expect.objectContaining({ stopOnFirst: false })
      );
    });

    it('should reject non-boolean values for boolean settings', async () => {
      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.stop_on_first',
        value: 'invalid'
      });

      // Assert
      expect(result.content[0].text).toContain('Invalid Value');
      expect(result.content[0].text).toContain('requires a boolean value');
      expect(sourcePriority.saveSourcePriorityConfig).not.toHaveBeenCalled();
    });

    it('should reject unknown source priority setting', async () => {
      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.unknown_setting',
        value: true
      });

      // Assert
      expect(result.content[0].text).toContain('Unknown Setting');
      expect(result.content[0].text).toContain('unknown_setting');
      expect(sourcePriority.saveSourcePriorityConfig).not.toHaveBeenCalled();
    });
  });

  describe('Reset Source Priority Configuration', () => {
    it('should reset source_priority section to defaults', async () => {
      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'reset',
        section: 'source_priority'
      });

      // Assert
      expect(sourcePriority.saveSourcePriorityConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: ['local', 'github', 'collection'],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        })
      );
      expect(result.content[0].text).toContain('Source Priority Reset');
      expect(result.content[0].text).toContain('Local Portfolio → GitHub Portfolio → Community Collection');
    });

    it('should support alternate reset path source.priority', async () => {
      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'reset',
        section: 'source.priority'
      });

      // Assert
      expect(sourcePriority.saveSourcePriorityConfig).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Reset');
    });

    it('should reset source_priority when resetting all config', async () => {
      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'reset'
      });

      // Assert
      expect(sourcePriority.saveSourcePriorityConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: ['local', 'github', 'collection']
        })
      );
      expect(mockConfigManager.resetConfig).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Configuration Reset');
    });
  });

  describe('Error Handling', () => {
    it('should handle parse errors gracefully', async () => {
      // Arrange
      (sourcePriority.parseSourcePriorityOrder as jest.Mock).mockImplementation(() => {
        throw new Error('Invalid JSON in source priority order');
      });

      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.order',
        value: 'invalid json'
      });

      // Assert
      expect(result.content[0].text).toContain('Configuration Update Failed');
      expect(result.content[0].text).toContain('Invalid JSON');
      expect(sourcePriority.saveSourcePriorityConfig).not.toHaveBeenCalled();
    });

    it('should handle save errors gracefully', async () => {
      // Arrange
      (sourcePriority.saveSourcePriorityConfig as jest.Mock).mockRejectedValue(
        new Error('Failed to save configuration')
      );

      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.stop_on_first',
        value: true
      });

      // Assert
      expect(result.content[0].text).toContain('Configuration Update Failed');
      expect(result.content[0].text).toContain('Failed to save');
    });

    it('should handle validation errors gracefully', async () => {
      // Arrange
      (sourcePriority.validateSourcePriority as jest.Mock).mockReturnValue({
        isValid: false,
        errors: ['Unknown source: invalid', 'Duplicate sources in priority list']
      });

      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.order',
        value: ['invalid', 'local', 'local']
      });

      // Assert
      expect(result.content[0].text).toContain('Invalid Source Priority Configuration');
      expect(result.content[0].text).toContain('Unknown source: invalid');
      expect(result.content[0].text).toContain('Duplicate sources');
    });
  });

  describe('camelCase vs snake_case Settings', () => {
    it('should handle stopOnFirst (camelCase)', async () => {
      // Act
      await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.stopOnFirst',
        value: true
      });

      // Assert
      expect(sourcePriority.saveSourcePriorityConfig).toHaveBeenCalledWith(
        expect.objectContaining({ stopOnFirst: true })
      );
    });

    it('should handle checkAllForUpdates (camelCase)', async () => {
      // Act
      await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.checkAllForUpdates',
        value: true
      });

      // Assert
      expect(sourcePriority.saveSourcePriorityConfig).toHaveBeenCalledWith(
        expect.objectContaining({ checkAllForUpdates: true })
      );
    });

    it('should handle fallbackOnError (camelCase)', async () => {
      // Act
      await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'source_priority.fallbackOnError',
        value: false
      });

      // Assert
      expect(sourcePriority.saveSourcePriorityConfig).toHaveBeenCalledWith(
        expect.objectContaining({ fallbackOnError: false })
      );
    });
  });
});
