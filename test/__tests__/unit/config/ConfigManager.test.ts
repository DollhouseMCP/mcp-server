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
  const configPath = path.join(configDir, 'config.json');
  
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
      await configManager.loadConfig();
      
      // Should create directory with proper permissions
      expect(mockMkdir).toHaveBeenCalledWith(
        configDir,
        { recursive: true, mode: 0o700 }
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
      await configManager.loadConfig();
      
      // Should write default config
      expect(mockWriteFile).toHaveBeenCalledWith(
        configPath,
        JSON.stringify({ version: '1.0.0' }, null, 2),
        { mode: 0o600 }
      );
    });
    
    it('should load existing config file', async () => {
      const mockConfig = {
        version: '1.0.0',
        oauth: {
          githubClientId: 'Ov23liTestClientId123'
        }
      };
      
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      mockReadFile.mockResolvedValue(JSON.stringify(mockConfig));
      
      const configManager = ConfigManager.getInstance();
      await configManager.loadConfig();
      
      const clientId = configManager.getGitHubClientId();
      expect(clientId).toBe('Ov23liTestClientId123');
    });
    
    it('should handle corrupted JSON gracefully', async () => {
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      
      // Simulate corrupted JSON
      mockReadFile.mockResolvedValue('{ invalid json');
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      
      // Should not throw, should create new config
      await expect(configManager.loadConfig()).resolves.not.toThrow();
      
      // Should write new default config
      expect(mockWriteFile).toHaveBeenCalledWith(
        configPath,
        JSON.stringify({ version: '1.0.0' }, null, 2),
        { mode: 0o600 }
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
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        { mode: 0o600 }
      );
    });
    
    it('should set directory permissions to 0o700', async () => {
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      mockMkdir.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      await configManager.loadConfig();
      
      expect(mockMkdir).toHaveBeenCalledWith(
        configDir,
        { recursive: true, mode: 0o700 }
      );
    });
    
    it('should handle permission errors gracefully', async () => {
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      
      // Simulate permission denied
      mockReadFile.mockRejectedValue({ code: 'EACCES' });
      mockMkdir.mockRejectedValue({ code: 'EACCES' });
      
      const configManager = ConfigManager.getInstance();
      
      // Should handle error gracefully
      await expect(configManager.loadConfig()).rejects.toThrow(/permission/i);
    });
  });
  
  describe('OAuth Client ID Management', () => {
    it('should save and retrieve GitHub client ID', async () => {
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      const testClientId = 'Ov23liValidClientId789';
      
      await configManager.setGitHubClientId(testClientId);
      
      // Mock reading the saved config
      mockReadFile.mockResolvedValue(JSON.stringify({
        version: '1.0.0',
        oauth: { githubClientId: testClientId }
      }));
      
      // Reload and verify
      await configManager.loadConfig();
      const retrievedId = configManager.getGitHubClientId();
      
      expect(retrievedId).toBe(testClientId);
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
      
      // Mock config file with different ID
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      mockReadFile.mockResolvedValue(JSON.stringify({
        version: '1.0.0',
        oauth: { githubClientId: 'Ov23liConfigFileId222' }
      }));
      
      const configManager = ConfigManager.getInstance();
      await configManager.loadConfig();
      
      // Should return env var value
      const clientId = configManager.getGitHubClientId();
      expect(clientId).toBe('Ov23liEnvVarClient111');
    });
    
    it('should return null if no client ID is configured', async () => {
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      mockReadFile.mockResolvedValue(JSON.stringify({ version: '1.0.0' }));
      
      const configManager = ConfigManager.getInstance();
      await configManager.loadConfig();
      
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
    it('should use correct JSON structure', async () => {
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      await configManager.setGitHubClientId('Ov23liStructureTest1');
      
      // Verify the structure of written JSON
      const writeCall = mockWriteFile.mock.calls[0];
      const writtenContent = JSON.parse(writeCall[1] as string);
      
      expect(writtenContent).toHaveProperty('version');
      expect(writtenContent).toHaveProperty('oauth.githubClientId');
      expect(writtenContent.oauth.githubClientId).toBe('Ov23liStructureTest1');
    });
    
    it('should preserve unknown fields when updating', async () => {
      const existingConfig = {
        version: '1.0.0',
        oauth: {
          githubClientId: 'Ov23liOldId123'
        },
        futureFeature: {
          someValue: 'preserve-me'
        }
      };
      
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      
      mockReadFile.mockResolvedValue(JSON.stringify(existingConfig));
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      
      const configManager = ConfigManager.getInstance();
      await configManager.loadConfig();
      await configManager.setGitHubClientId('Ov23liNewId456');
      
      // Check that unknown fields are preserved
      const writeCall = mockWriteFile.mock.calls[0];
      const writtenContent = JSON.parse(writeCall[1] as string);
      
      expect(writtenContent.futureFeature).toEqual({ someValue: 'preserve-me' });
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
      await configManager.loadConfig();
      
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
      await configManager.loadConfig();
      
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
      await configManager.loadConfig();
      
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
      expect(configPath).toContain('config.json');
    });
  });
  
  describe('Error Handling', () => {
    it('should handle file system errors gracefully', async () => {
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      
      // Simulate generic file system error
      mockReadFile.mockRejectedValue(new Error('File system error'));
      
      const configManager = ConfigManager.getInstance();
      
      await expect(configManager.loadConfig()).rejects.toThrow('File system error');
    });
    
    it('should handle JSON parse errors gracefully', async () => {
      const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
      const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
      const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
      
      // Return invalid JSON
      mockReadFile.mockResolvedValue('not valid json at all');
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
      
      await expect(configManager.loadConfig()).rejects.toThrow(/permission/i);
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
      await configManager.setGitHubClientId('Ov23liAtomicTest123');
      
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
});