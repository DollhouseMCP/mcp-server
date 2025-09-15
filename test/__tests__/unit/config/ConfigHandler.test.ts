/**
 * ConfigHandler Tests
 * 
 * Tests for the ConfigHandler class focusing on:
 * - Async handleWizard method behavior
 * - Wizard action path in handleConfigOperation
 * - Config display formatting in wizard context
 * - Current config values display accuracy
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as yaml from 'js-yaml';

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

// Import after mocking
const { ConfigManager } = await import('../../../../src/config/ConfigManager.js');
const { SecureErrorHandler } = await import('../../../../src/security/errorHandler.js');
const { ConfigHandler } = await import('../../../../src/handlers/ConfigHandler.js');

describe('ConfigHandler', () => {
  let configHandler: ConfigHandler;
  let mockConfigManager: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset singleton for testing
    (ConfigManager.resetForTesting as jest.Mock)();
    
    // Setup mock ConfigManager
    mockConfigManager = {
      initialize: jest.fn().mockResolvedValue(undefined),
      getConfig: jest.fn(),
      updateConfig: jest.fn(),
      getSetting: jest.fn(),
      setSetting: jest.fn().mockResolvedValue(undefined),
      resetConfig: jest.fn().mockResolvedValue(undefined),
      exportConfig: jest.fn(),
      importConfig: jest.fn().mockResolvedValue(undefined),
    };
    
    (ConfigManager.getInstance as jest.Mock).mockReturnValue(mockConfigManager);
    
    // Setup SecureErrorHandler mock
    (SecureErrorHandler.sanitizeError as jest.Mock).mockImplementation((error: any) => {
      return { message: error.message || 'Error occurred' };
    });
    
    configHandler = new ConfigHandler();
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
      const result = await configHandler.handleWizard();
      
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
      const resultPromise = configHandler.handleWizard();
      
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
      const result = await configHandler.handleWizard();
      
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
      const result = await configHandler.handleWizard();
      
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
      expect(SecureErrorHandler.sanitizeError).toHaveBeenCalledWith(error);
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
});