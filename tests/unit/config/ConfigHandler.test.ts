/**
 * ConfigHandler Tests
 *
 * Tests for the ConfigHandler class focusing on:
 * - Async handleWizard method behavior
 * - Wizard action path in handleConfigOperation
 * - Config display formatting in wizard context
 * - Current config values display accuracy
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ConfigHandler } from '../../../src/handlers/ConfigHandler.js';
import type { InitializationService } from '../../../src/services/InitializationService.js';
import type { PersonaIndicatorService } from '../../../src/services/PersonaIndicatorService.js';
import type { IndicatorConfig } from '../../../src/config/indicator-config.js';
import * as yaml from 'js-yaml';

describe('ConfigHandler', () => {
  let configHandler: InstanceType<typeof ConfigHandler>;
  let mockConfigManager: any;
  let mockInitService: jest.Mocked<Pick<InitializationService, 'ensureInitialized'>>;
  let mockPersonaIndicatorService: jest.Mocked<Pick<PersonaIndicatorService, 'getPersonaIndicator'>>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock ConfigManager
    mockConfigManager = {
      initialize: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getConfig: jest.fn<() => any>(),
      updateConfig: jest.fn<() => any>(),
      getSetting: jest.fn<() => any>(),
      setSetting: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      resetConfig: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      exportConfig: jest.fn<() => any>(),
      importConfig: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    mockInitService = {
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
    };

    mockPersonaIndicatorService = {
      getPersonaIndicator: jest.fn().mockReturnValue(''),
      getConfig: jest.fn<() => IndicatorConfig>().mockReturnValue({
        enabled: true,
        style: 'full',
        showEmoji: true,
        showName: true,
        showVersion: false,
        showAuthor: false,
        showCategory: false,
        separator: ' | ',
        emoji: '🎭',
        bracketStyle: 'square',
      }),
      updateConfig: jest.fn<(config: IndicatorConfig) => void>(),
    };

    configHandler = new ConfigHandler(
      mockConfigManager,
      mockInitService as unknown as InitializationService,
      mockPersonaIndicatorService as unknown as PersonaIndicatorService
    );
  });

  afterEach(async () => {
    jest.resetAllMocks();
  });

  describe('handleWizard', () => {
    it('should display current config before wizard steps', async () => {
      // Arrange
      const mockConfig = {
        user: {
          username: null,
          email: null,
          display_name: null,
        },
        github: {
          auth_token: null,
          default_repository: null,
        },
        portfolio: {
          auto_sync: false,
          sync_interval_minutes: 30,
        },
      };
      
      mockConfigManager.getConfig.mockReturnValue(mockConfig);

      // Act
      const result = await (configHandler as any).handleWizard();

      // Assert
      expect(mockConfigManager.getConfig).toHaveBeenCalled();
      expect(result.content[0].text).toContain('📊 Current Configuration:');
      expect(result.content[0].text).toContain('username: (not set - anonymous mode active)');
      expect(result.content[0].text).toContain('email: (optional - not set)');
    });

    it('should handle async operation correctly', async () => {
      // Arrange
      const mockConfig = {
        user: { username: 'testuser', email: 'test@example.com' },
      };
      
      mockConfigManager.getConfig.mockReturnValue(mockConfig);

      // Act
      const resultPromise = (configHandler as any).handleWizard();
      
      // Assert - Should return a promise
      expect(resultPromise).toBeInstanceOf(Promise);
      
      const result = await resultPromise;
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it('should show friendly null values', async () => {
      // Arrange
      const mockConfig = {
        user: {
          username: null,
          email: null,
          display_name: null,
        },
        github: {
          auth_token: null,
          default_repository: null,
        },
        portfolio: {
          sync_status: {
            last_sync: null,
            total_synced: 0,
          },
        },
      };
      
      mockConfigManager.getConfig.mockReturnValue(mockConfig);

      // Act
      const result = await (configHandler as any).handleWizard();

      // Assert - Check friendly null value replacements
      expect(result.content[0].text).toContain('(not set - anonymous mode active)');
      expect(result.content[0].text).toContain('(optional - not set)');
      expect(result.content[0].text).not.toContain(': null');
    });

    it('should include step-by-step guidance', async () => {
      // Arrange
      const mockConfig = { user: { username: null } };
      mockConfigManager.getConfig.mockReturnValue(mockConfig);

      // Act
      const result = await (configHandler as any).handleWizard();
      
      // Assert - Check for wizard steps
      expect(result.content[0].text).toContain('🎯 **Step 1: User Identity**');
      expect(result.content[0].text).toContain('🔐 **Step 2: GitHub Integration');
      expect(result.content[0].text).toContain('🔄 **Step 3: Portfolio Sync');
      expect(result.content[0].text).toContain('🎨 **Step 4: Display Preferences');
      expect(result.content[0].text).toContain('To set a username: Say');
      expect(result.content[0].text).toContain('To stay anonymous: Say');
    });

    it('should handle error gracefully', async () => {
      // Arrange
      const error = new Error('Config fetch failed');
      mockConfigManager.getConfig.mockImplementation(() => {
        throw error;
      });

      // Act
      const result = await configHandler.handleConfigOperation({ action: 'wizard' });

      // Assert - Error should be caught and sanitized
      expect(result.content[0].text).toContain('❌ Configuration operation failed');
      expect(result.content[0].text).toContain('Config fetch failed');
    });
  });

  describe('handleConfigOperation', () => {
    it('should handle wizard action correctly', async () => {
      // Arrange
      const mockConfig = { user: { username: 'test' } };
      mockConfigManager.getConfig.mockReturnValue(mockConfig);
      
      // Act
      const result = await configHandler.handleConfigOperation({ action: 'wizard' });
      
      // Assert
      expect(mockInitService.ensureInitialized).toHaveBeenCalled();
      expect(mockConfigManager.initialize).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Configuration Wizard');
      expect(result.content[0].text).toContain('Current Configuration');
    });

    it('should await handleWizard when action is wizard', async () => {
      // Arrange
      const mockConfig = { user: { username: null } };
      mockConfigManager.getConfig.mockReturnValue(mockConfig);
      
      // Act
      const result = await configHandler.handleConfigOperation({ action: 'wizard' });
      
      // Assert
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(mockInitService.ensureInitialized).toHaveBeenCalled();
      // Verify it was awaited (no unhandled promise rejection)
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  });

  describe('makeFriendlyConfig', () => {
    it('should transform null values to friendly messages', () => {
      // Arrange
      const config = {
        user: {
          username: null,
          email: null,
          display_name: null,
        },
        github: {
          auth_token: null,
          oauth_token: null,
        },
        portfolio: {
          sync_status: {
            last_sync: null,
            last_push: null,
            last_pull: null,
          },
        },
      };
      
      // Act
      const friendly = (configHandler as any).makeFriendlyConfig(config);
      
      // Assert
      expect(friendly.user.username).toBe('(not set - anonymous mode active)');
      expect(friendly.user.email).toBe('(optional - not set)');
      expect(friendly.user.display_name).toBe('(not set - will use username)');
      expect(friendly.github.auth_token).toBe('(not configured - GitHub features disabled)');
      expect(friendly.github.oauth_token).toBe('(not authenticated)');
      expect(friendly.portfolio.sync_status.last_sync).toBe('(never synced)');
    });

    it('should preserve non-null values', () => {
      // Arrange
      const config = {
        user: {
          username: 'testuser',
          email: 'test@example.com',
        },
        portfolio: {
          auto_sync: true,
          sync_interval_minutes: 60,
        },
      };
      
      // Act
      const friendly = (configHandler as any).makeFriendlyConfig(config);
      
      // Assert
      expect(friendly.user.username).toBe('testuser');
      expect(friendly.user.email).toBe('test@example.com');
      expect(friendly.portfolio.auto_sync).toBe(true);
      expect(friendly.portfolio.sync_interval_minutes).toBe(60);
    });

    it('should handle nested objects correctly', () => {
      // Arrange
      const config = {
        deeply: {
          nested: {
            value: null,
            another: 'test',
          },
        },
      };
      
      // Act
      const friendly = (configHandler as any).makeFriendlyConfig(config);
      
      // Assert
      expect(friendly.deeply.nested.value).toBe('(not set)');
      expect(friendly.deeply.nested.another).toBe('test');
    });
  });

  describe('YAML formatting', () => {
    it('should format config as valid YAML', async () => {
      // Arrange
      const mockConfig = {
        user: { username: 'test', email: null },
        portfolio: { auto_sync: false },
      };
      
      mockConfigManager.getConfig.mockReturnValue(mockConfig);
      
      // Act
      const result = await configHandler.handleConfigOperation({ action: 'wizard' });
      
      // Extract YAML portion (between the markers) 
      const content = result.content[0].text;
      const yamlMatch = content.match(/📊 Current Configuration:\*\*\n```yaml\n([\s\S]*?)\n```/);
      expect(yamlMatch).toBeTruthy();
      
      const yamlContent = yamlMatch![1];
      
      // Assert - Should be valid YAML
      expect(() => yaml.load(yamlContent)).not.toThrow();
      
      // Parse and verify structure
      const parsed = yaml.load(yamlContent) as any;
      expect(parsed.user.username).toBe('test');
      expect(parsed.user.email).toBe('(optional - not set)');
    });
  });

  describe('handleIndicatorSet (immediate + persistent config)', () => {
    beforeEach(() => {
      mockConfigManager.updateSetting = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    });

    it('should update indicator style with both persistence and runtime effect', async () => {
      // Arrange
      mockPersonaIndicatorService.getPersonaIndicator.mockReturnValue('[🎭 TestPersona]');

      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'display.indicator.style',
        value: 'minimal',
      });

      // Assert - Persistence
      expect(mockConfigManager.updateSetting).toHaveBeenCalledWith('display.indicator.style', 'minimal');

      // Assert - Runtime update
      expect(mockPersonaIndicatorService.getConfig).toHaveBeenCalled();
      expect(mockPersonaIndicatorService.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ style: 'minimal' })
      );

      // Assert - Success response
      expect(result.content[0].text).toContain('✅ **Indicator Configuration Updated**');
    });

    it('should coerce boolean strings to actual booleans', async () => {
      // Act
      await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'display.indicator.enabled',
        value: 'false',
      });

      // Assert - Should save as boolean, not string
      expect(mockConfigManager.updateSetting).toHaveBeenCalledWith('display.indicator.enabled', false);
      expect(mockPersonaIndicatorService.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false })
      );
    });

    it('should reject invalid indicator style values', async () => {
      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'display.indicator.style',
        value: 'invalid_style',
      });

      // Assert - Should not persist or update runtime
      expect(mockConfigManager.updateSetting).not.toHaveBeenCalled();
      expect(mockPersonaIndicatorService.updateConfig).not.toHaveBeenCalled();

      // Assert - Error response
      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('full, minimal, compact, custom');
    });

    it('should reject invalid bracket style values', async () => {
      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'display.indicator.bracketStyle',
        value: 'diamond',
      });

      // Assert
      expect(mockConfigManager.updateSetting).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('square, round, curly, angle, none');
    });

    it('should reject wrong type for boolean settings', async () => {
      // Act
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'display.indicator.showVersion',
        value: 'notaboolean', // not a valid boolean string
      });

      // Assert
      expect(mockConfigManager.updateSetting).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('boolean');
    });

    it('should validate custom format placeholders', async () => {
      // Act - Valid format
      const validResult = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'display.indicator.customFormat',
        value: '[{emoji} {name}]',
      });

      // Assert - Valid format should succeed
      expect(mockConfigManager.updateSetting).toHaveBeenCalledWith(
        'display.indicator.customFormat',
        '[{emoji} {name}]'
      );
      expect(validResult.content[0].text).toContain('✅');
    });

    it('should reject invalid custom format', async () => {
      // Act - Invalid format (invalid placeholder)
      const result = await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'display.indicator.customFormat',
        value: '[{invalid} {name}]',
      });

      // Assert
      expect(mockConfigManager.updateSetting).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Invalid placeholder');
    });

    it('should handle non-indicator settings normally', async () => {
      // Act - Regular (non-indicator) setting
      await configHandler.handleConfigOperation({
        action: 'set',
        setting: 'user.username',
        value: 'testuser',
      });

      // Assert - Should use normal path, not indicator handler
      expect(mockConfigManager.updateSetting).toHaveBeenCalledWith('user.username', 'testuser');
      // Runtime indicator service should NOT be called for non-indicator settings
      expect(mockPersonaIndicatorService.updateConfig).not.toHaveBeenCalled();
    });
  });
});
