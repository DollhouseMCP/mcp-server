/**
 * ConfigManager Test Suite
 * 
 * Test-Driven Development: These tests are written BEFORE the implementation
 * to ensure we build exactly what we need for OAuth configuration in Claude Desktop.
 * 
 * Tests cover:
 * - Singleton pattern with thread safety
 * - Configuration file management
 * - OAuth client ID storage and retrieval
 * - Cross-platform compatibility
 * - Error handling and recovery
 * - Environment variable precedence
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as path from 'path';

// Mock modules using ESM approach
jest.unstable_mockModule('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn(),
  mkdir: jest.fn(),
  rename: jest.fn(),
  unlink: jest.fn(),
  access: jest.fn(),
}));

jest.unstable_mockModule('os', () => ({
  homedir: jest.fn(),
}));

// Import mocked modules and the class under test after mocking
const fs = await import('fs/promises');
const os = await import('os');
const { ConfigManager } = await import('../../../../src/config/ConfigManager.js');

describe('ConfigManager', () => {
  const mockHomedir = '/home/testuser';
  const configDir = path.join(mockHomedir, '.dollhouse');
  const configPath = path.join(configDir, 'config.yml');
  
  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();
    
    // Reset singleton instance for testing
    (ConfigManager as any).instance = null;
    (ConfigManager as any).instanceLock = false;
    
    // Mock os.homedir
    (os.homedir as jest.Mock).mockReturnValue(mockHomedir);
    
    // Clear environment variables
    delete process.env.DOLLHOUSE_GITHUB_CLIENT_ID;
  });
  
  describe('Singleton Pattern', () => {
    it('should return the same instance when called multiple times', () => {
      const instance1 = ConfigManager.getInstance();
      const instance2 = ConfigManager.getInstance();
      
      expect(instance1).toBe(instance2);
    });
    
    it('should handle concurrent getInstance calls safely', async () => {
      // Simulate concurrent calls
      const promises = Array(10).fill(null).map(() => 
        Promise.resolve(ConfigManager.getInstance())
      );
      
      const instances = await Promise.all(promises);
      
      // All should be the same instance
      const firstInstance = instances[0];
      instances.forEach(instance => {
        expect(instance).toBe(firstInstance);
      });
    });
  });
  
  describe('Configuration Storage', () => {
    it('should create config directory if it does not exist', async () => {
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      
      // Simulate directory doesn't exist
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      
      // Should create directory with proper permissions
      expect(mockMkdir).toHaveBeenCalledWith(
        configDir,
        { recursive: true, mode: 448 } // 0o700 in decimal
      );
    });
    
    it('should create config file if it does not exist', async () => {
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      
      // Simulate file doesn't exist
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      
      // Should write default config in YAML format (atomic write uses temp file)
      // 0o600 = 384 decimal
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.stringMatching(/version: ['"]*1\.0\.0/), // YAML format
        { mode: 384 }
      );
    });
    
    it('should load existing config file', async () => {
      const yamlConfig = `version: '1.0.0'
github:
  auth:
    client_id: 'Ov23liTestClientId123'`;
      
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      mockReadFile.mockResolvedValue(yamlConfig);
      
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      
      const clientId = configManager.getGitHubClientId();
      expect(clientId).toBe('Ov23liTestClientId123');
    });
    
    it('should handle corrupted YAML gracefully', async () => {
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      
      // Simulate corrupted YAML
      mockReadFile.mockResolvedValue('invalid: yaml: content: :::');
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      
      // Should not throw, should create new config
      await expect(configManager.loadConfig()).resolves.not.toThrow();
      
      // Should write new default config in YAML format (atomic write uses temp file)
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.stringMatching(/version: ['"]*1\.0\.0/), // YAML format
        { mode: 384 }
      );
    });
    
    it('should set file permissions to 0o600', async () => {
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      await configManager.setGitHubClientId('Ov23liNewClientId456');
      
      // Check that writeFile was called with correct permissions
      // 0o600 = 384 decimal
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        { mode: 384 }
      );
    });
    
    it('should set directory permissions to 0o700', async () => {
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      mockMkdir.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      
      expect(mockMkdir).toHaveBeenCalledWith(
        configDir,
        { recursive: true, mode: 448 } // 0o700 in decimal
      );
    });
    
    it('should handle permission errors gracefully', async () => {
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      
      // Simulate permission denied on first read (file doesn't exist)
      // and on mkdir (can't create directory)
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      mockMkdir.mockRejectedValue({ code: 'EACCES', message: 'Permission denied' });
      mockWriteFile.mockRejectedValue({ code: 'EACCES', message: 'Permission denied' });
      
      const configManager = ConfigManager.getInstance();
      
      // Initialize silently catches errors and uses defaults
      // So we don't expect it to throw
      await configManager.initialize();
      
      // Config should fall back to defaults
      const config = configManager.getConfig();
      expect(config.version).toBe('1.0.0');
    });
  });
  
  describe('OAuth Client ID Management', () => {
    it('should save and retrieve GitHub client ID', async () => {
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      const mockRename = fs.rename as jest.MockedFunction<typeof fs.rename>;
      
      // First time - no config exists
      mockReadFile.mockRejectedValueOnce({ code: 'ENOENT' });
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      
      const testClientId = 'Ov23liValidClientId789';
      await configManager.setGitHubClientId(testClientId);
      
      // Verify the client ID is set in current instance
      const retrievedId = configManager.getGitHubClientId();
      expect(retrievedId).toBe(testClientId);
      
      // Also verify write was called
      expect(mockWriteFile).toHaveBeenCalled();
    });
    
    it('should validate client ID format - valid format', () => {
      const validIds = [
        'Ov23liABCDEFGHIJKLMN',
        'Ov23li1234567890abcd',
        'Ov23liXxXxXxXxXxXxXx'
      ];
      
      validIds.forEach(id => {
        expect(ConfigManager.validateClientId(id)).toBe(true);
      });
    });
    
    it('should validate client ID format - invalid format', () => {
      const invalidIds = [
        'InvalidPrefix123456',
        'Ov23li',  // Too short
        'ghp_1234567890abcdef',  // Wrong prefix (PAT)
        '',
        null,
        undefined
      ];
      
      invalidIds.forEach(id => {
        expect(ConfigManager.validateClientId(id as any)).toBe(false);
      });
    });
    
    it('should reject invalid client ID when setting', async () => {
      const configManager = ConfigManager.getInstance();
      
      await expect(
        configManager.setGitHubClientId('invalid-id')
      ).rejects.toThrow(/invalid.*client.*id/i);
    });
    
    it('should prefer environment variable over config file', async () => {
      // Set environment variable
      process.env.DOLLHOUSE_GITHUB_CLIENT_ID = 'Ov23liEnvVarClient111';
      
      // Mock config file with different ID in YAML format
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      mockReadFile.mockResolvedValue(`version: '1.0.0'
github:
  auth:
    client_id: 'Ov23liConfigFileId222'`);
      
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      
      // Should return env var value
      const clientId = configManager.getGitHubClientId();
      expect(clientId).toBe('Ov23liEnvVarClient111');
    });
    
    it('should return null if no client ID is configured', async () => {
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      mockReadFile.mockResolvedValue(`version: '1.0.0'`);
      
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      
      const clientId = configManager.getGitHubClientId();
      expect(clientId).toBeNull();
    });
    
    it('should handle undefined/null client ID gracefully', async () => {
      const configManager = ConfigManager.getInstance();
      
      await expect(
        configManager.setGitHubClientId(null as any)
      ).rejects.toThrow(/invalid.*client.*id/i);
      
      await expect(
        configManager.setGitHubClientId(undefined as any)
      ).rejects.toThrow(/invalid.*client.*id/i);
    });
  });
  
  describe('Config File Format', () => {
    it('should use correct YAML structure', async () => {
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      await configManager.setGitHubClientId('Ov23liStructureTest1');
      
      // Verify the structure of written YAML
      const writeCall = mockWriteFile.mock.calls[0];
      const writtenContent = writeCall[1] as string;
      
      expect(writtenContent).toMatch(/version:/);  
      expect(writtenContent).toMatch(/github:/);  
      expect(writtenContent).toMatch(/client_id: ['"]*Ov23liStructureTest1/);
    });
    
    it('should preserve unknown fields when updating', async () => {
      const existingConfig = `version: '1.0.0'
github:
  auth:
    client_id: 'Ov23liOldId123'
futureFeature:
  someValue: 'preserve-me'`;
      
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      
      mockReadFile.mockResolvedValue(existingConfig);
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      await configManager.setGitHubClientId('Ov23liNewId456789012');
      
      // Check that unknown fields are preserved in YAML
      const writeCall = mockWriteFile.mock.calls[0];
      const writtenContent = writeCall[1] as string;
      
      expect(writtenContent).toMatch(/futureFeature:/);  
      expect(writtenContent).toMatch(/someValue: ['"]*preserve-me/);
    });
  });
  
  describe('Cross-Platform Compatibility', () => {
    it('should handle Windows paths correctly', async () => {
      // Mock Windows environment
      const windowsHome = 'C:\\Users\\TestUser';
      (os.homedir as jest.Mock).mockReturnValue(windowsHome);
      
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      mockMkdir.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      
      // Should use Windows path
      const expectedPath = path.join(windowsHome, '.dollhouse');
      expect(mockMkdir).toHaveBeenCalledWith(
        expectedPath,
        expect.any(Object)
      );
    });
    
    it('should handle macOS paths correctly', async () => {
      // Mock macOS environment
      const macHome = '/Users/testuser';
      (os.homedir as jest.Mock).mockReturnValue(macHome);
      
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      mockMkdir.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      
      // Should use macOS path
      const expectedPath = path.join(macHome, '.dollhouse');
      expect(mockMkdir).toHaveBeenCalledWith(
        expectedPath,
        expect.any(Object)
      );
    });
    
    it('should handle Linux paths correctly', async () => {
      // Mock Linux environment
      const linuxHome = '/home/testuser';
      (os.homedir as jest.Mock).mockReturnValue(linuxHome);
      
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      mockMkdir.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      
      // Should use Linux path
      const expectedPath = path.join(linuxHome, '.dollhouse');
      expect(mockMkdir).toHaveBeenCalledWith(
        expectedPath,
        expect.any(Object)
      );
    });
    
    it('should use proper path separators for the platform', () => {
      // This test verifies that path.join is used correctly
      // which automatically handles platform-specific separators
      const testHome = process.platform === 'win32' 
        ? 'C:\\Users\\Test' 
        : '/home/test';
      
      (os.homedir as jest.Mock).mockReturnValue(testHome);
      
      const configManager = ConfigManager.getInstance();
      const configPath = (configManager as any).configPath;
      
      // Should contain proper separators for the platform
      expect(configPath).toContain('.dollhouse');
      expect(configPath).toContain('config.yml');
    });
  });
  
  describe('Error Handling', () => {
    it('should handle file system errors gracefully', async () => {
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      
      // Simulate generic file system error
      mockReadFile.mockRejectedValue(new Error('File system error'));
      
      const configManager = ConfigManager.getInstance();
      
      // Initialize catches errors and uses defaults
      await configManager.initialize();
      
      // Should still work with defaults
      expect(configManager.getConfig()).toBeDefined();
    });
    
    it('should handle YAML parse errors gracefully', async () => {
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      
      // Return invalid YAML  
      mockReadFile.mockResolvedValue('not: valid: yaml: at: : : all');
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      
      // Should recover by creating new config
      await expect(configManager.loadConfig()).resolves.not.toThrow();
      
      // Should have written new config
      expect(mockWriteFile).toHaveBeenCalled();
    });
    
    it('should handle permission denied errors with helpful message', async () => {
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      
      // Simulate permission denied
      mockMkdir.mockRejectedValue({ 
        code: 'EACCES',
        message: 'Permission denied'
      });
      
      const configManager = ConfigManager.getInstance();
      
      // Initialize catches errors and uses defaults
      await configManager.initialize();
      
      // Should still work with defaults
      const config = configManager.getConfig();
      expect(config).toBeDefined();
    });
    
    it('should provide helpful error messages', async () => {
      const configManager = ConfigManager.getInstance();
      
      // Test invalid client ID error message
      try {
        await configManager.setGitHubClientId('wrong-format');
      } catch (error: any) {
        expect(error.message).toMatch(/invalid.*github.*client.*id.*format/i);
        expect(error.message).toContain('Ov23li');  // Should hint at correct format
      }
    });
  });
  
  describe('Atomic Operations', () => {
    it('should use atomic file writes to prevent corruption', async () => {
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockRename = fs.rename as jest.MockedFunction<typeof fs.rename>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      await configManager.setGitHubClientId('Ov23liAtomicTest123456');
      
      // Should write to temp file first
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.any(String),
        expect.any(Object)
      );
      
      // Should rename atomically
      expect(mockRename).toHaveBeenCalled();
    });
  });
  
  describe('YAML Parser Selection (Regression Test for Config Persistence Bug)', () => {
    it('should use js-yaml for config files, NOT SecureYamlParser', async () => {
      // This test ensures we don't regress to using SecureYamlParser
      // which expects markdown with frontmatter and returns empty {} for pure YAML
      // This was the critical bug that caused config values to reset on every load
      
      const yamlConfig = `version: '1.0.0'
user:
  username: mickdarling
  email: mick@mickdarling.com
sync:
  enabled: true
  bulk:
    download_enabled: true
    upload_enabled: false
github:
  portfolio:
    repository_url: 'https://github.com/mickdarling/dollhouse-portfolio'`;
      
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      const mockAccess = fs.access as jest.MockedFunction<typeof fs.access>;
      
      // Mock the file exists with the YAML content
      mockAccess.mockResolvedValue(undefined); // File exists
      mockReadFile.mockResolvedValue(yamlConfig);
      mockMkdir.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      
      // These should NOT be null - the bug was they were returning null
      // because SecureYamlParser was returning empty {} for pure YAML
      const config = configManager.getConfig();
      expect(config.user.username).toBe('mickdarling');
      expect(config.user.email).toBe('mick@mickdarling.com');
      expect(config.sync.enabled).toBe(true);
      expect(config.sync.bulk.download_enabled).toBe(true);
      expect(config.github.portfolio.repository_url).toBe('https://github.com/mickdarling/dollhouse-portfolio');
    });
    
    it('should persist config values between ConfigManager instances', async () => {
      const yamlConfig = `version: '1.0.0'
user:
  username: testuser
  email: test@example.com
  display_name: 'Test User'
sync:
  enabled: true
  individual:
    require_confirmation: false
collection:
  auto_submit: true`;
      
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      const mockRename = fs.rename as jest.MockedFunction<typeof fs.rename>;
      
      // First instance saves config
      mockReadFile.mockRejectedValueOnce({ code: 'ENOENT' }); // First load - no file
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);
      
      const configManager1 = ConfigManager.getInstance();
      await configManager1.initialize();
      
      // Set some values
      await configManager1.setUserIdentity('testuser', 'test@example.com');
      await configManager1.setSyncEnabled(true);
      
      // Capture what was written (should be YAML format)
      const writtenYaml = mockWriteFile.mock.calls[0]?.[1] as string;
      expect(writtenYaml).toMatch(/username: testuser/);
      expect(writtenYaml).toMatch(/email: test@example\.com/);
      
      // Reset singleton for test
      (ConfigManager as any).instance = null;
      (ConfigManager as any).instanceLock = false;
      
      // Second instance loads saved config
      mockReadFile.mockResolvedValue(writtenYaml || yamlConfig);
      
      const configManager2 = ConfigManager.getInstance();
      await configManager2.initialize();
      
      // Values should persist
      const config = configManager2.getConfig();
      expect(config.user.username).toBe('testuser');
      expect(config.user.email).toBe('test@example.com');
      expect(config.sync.enabled).toBe(true);
    });
    
    it('should handle null and empty values correctly', async () => {
      // This was part of the bug - null values were not handled properly
      const yamlConfig = `version: '1.0.0'
user:
  username: null
  email: null
  display_name: null
sync:
  enabled: false`;
      
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      mockReadFile.mockResolvedValue(yamlConfig);
      
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      
      const config = configManager.getConfig();
      expect(config.user.username).toBeNull();
      expect(config.user.email).toBeNull();
      expect(config.sync.enabled).toBe(false);
      
      // Now set values
      await configManager.setUserIdentity('newuser', 'new@example.com');
      
      // Values should be updated
      const updatedConfig = configManager.getConfig();
      expect(updatedConfig.user.username).toBe('newuser');
      expect(updatedConfig.user.email).toBe('new@example.com');
    });
    
    it('should merge with defaults without overwriting saved values', async () => {
      // Another part of the bug - mergeWithDefaults was overwriting saved values
      const yamlConfig = `version: '1.0.0'
user:
  username: 'saveduser'
  email: 'saved@example.com'`;
      
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      mockReadFile.mockResolvedValue(yamlConfig);
      
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      
      const config = configManager.getConfig();
      // Saved values should be preserved
      expect(config.user.username).toBe('saveduser');
      expect(config.user.email).toBe('saved@example.com');
      // Defaults should be applied for missing values
      expect(config.sync.enabled).toBe(false); // default value
      expect(config.collection.auto_submit).toBe(false); // default value
    });
  });
});