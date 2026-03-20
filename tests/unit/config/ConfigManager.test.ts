import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { IFileOperationsService } from '../../../src/services/FileOperationsService.js';
import * as path from 'path';

describe('ConfigManager', () => {
  let container: InstanceType<typeof DollhouseContainer>;
  let configManager: InstanceType<typeof ConfigManager>;
  const mockHomedir = '/home/testuser';
  const configDir = path.join(mockHomedir, '.dollhouse');

  let mockFileOperations: jest.Mocked<IFileOperationsService>;
  let mockOs: any;

  beforeEach(() => {
    mockFileOperations = {
      readFile: jest.fn(),
      readElementFile: jest.fn(),
      writeFile: jest.fn(),
      deleteFile: jest.fn(),
      createDirectory: jest.fn(),
      listDirectory: jest.fn(),
      listDirectoryWithTypes: jest.fn(),
      renameFile: jest.fn(),
      exists: jest.fn(),
      stat: jest.fn(),
      resolvePath: jest.fn(),
      validatePath: jest.fn(),
      createFileExclusive: jest.fn(),
      copyFile: jest.fn(),
      chmod: jest.fn(),
      appendFile: jest.fn(),
    } as jest.Mocked<IFileOperationsService>;

    mockOs = {
      homedir: jest.fn(),
    };

    container = new DollhouseContainer();
    mockOs.homedir.mockReturnValue(mockHomedir);
    delete process.env.DOLLHOUSE_GITHUB_CLIENT_ID;

    container.register('ConfigManager', () => new ConfigManager(mockFileOperations, mockOs));
    configManager = container.resolve('ConfigManager');
  });

  afterEach(async () => {
    await container.dispose();
  });

  describe('DI Container Instance Management', () => {
    it('should return the same instance when resolved multiple times', () => {
      const instance1 = container.resolve('ConfigManager');
      const instance2 = container.resolve('ConfigManager');
      expect(instance1).toBe(instance2);
    });

    it('should handle concurrent resolve calls safely', async () => {
      const promises = new Array(10).fill(null).map(() => Promise.resolve(container.resolve('ConfigManager')));
      const instances = await Promise.all(promises);
      const firstInstance = instances[0];
      instances.forEach(instance => {
        expect(instance).toBe(firstInstance);
      });
    });
  });

  describe('Configuration Storage', () => {
    it('should create config directory if it does not exist', async () => {
      mockFileOperations.exists.mockResolvedValue(false);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.writeFile.mockResolvedValue(undefined);
      mockFileOperations.renameFile.mockResolvedValue(undefined);

      await configManager.initialize();

      // Verify createDirectory was called with the config directory
      expect(mockFileOperations.createDirectory).toHaveBeenCalledWith(configDir);

      // Verify chmod was called to set directory permissions
      expect(mockFileOperations.chmod).toHaveBeenCalledWith(
        configDir,
        0o700,
        expect.objectContaining({ source: 'ConfigManager.initialize' })
      );
    });

    it('should create config file if it does not exist', async () => {
      mockFileOperations.exists.mockResolvedValue(false);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.writeFile.mockResolvedValue(undefined);
      mockFileOperations.renameFile.mockResolvedValue(undefined);

      await configManager.initialize();

      // writeFile is called with temp path first, then renamed
      expect(mockFileOperations.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.any(String),
        expect.objectContaining({ source: 'ConfigManager.saveConfig' })
      );
    });

    it('should load existing config file', async () => {
      const yamlConfig = `version: '1.0.0'\ngithub:\n  auth:\n    client_id: 'Ov23liTestClientId123'`;
      mockFileOperations.exists.mockResolvedValue(true);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.readFile.mockResolvedValue(yamlConfig);

      await configManager.initialize();
      expect(configManager.getGitHubClientId()).toBe('Ov23liTestClientId123');
    });

    it('should handle corrupted YAML gracefully', async () => {
      mockFileOperations.exists.mockResolvedValue(true);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.readFile.mockResolvedValue('invalid: yaml: content');

      await expect(configManager.initialize()).resolves.not.toThrow();
      expect(configManager.getConfig().version).toBe('1.0.0');
    });

    it('should set file permissions to 0o600', async () => {
      mockFileOperations.exists.mockResolvedValue(false);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.writeFile.mockResolvedValue(undefined);
      mockFileOperations.renameFile.mockResolvedValue(undefined);

      await configManager.setGitHubClientId('Ov23liNewClientId456');

      // chmod should be called with 0o600 for the temp file
      expect(mockFileOperations.chmod).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        0o600,
        expect.objectContaining({ source: 'ConfigManager.saveConfig' })
      );
    });

    it('should set directory permissions to 0o700', async () => {
      mockFileOperations.exists.mockResolvedValue(false);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.writeFile.mockResolvedValue(undefined);
      mockFileOperations.renameFile.mockResolvedValue(undefined);

      await configManager.initialize();

      // Verify chmod was called with 0o700 for directory
      expect(mockFileOperations.chmod).toHaveBeenCalledWith(
        configDir,
        0o700,
        expect.objectContaining({ source: 'ConfigManager.initialize' })
      );
    });

    it('should handle permission errors gracefully', async () => {
      mockFileOperations.createDirectory.mockRejectedValue({ code: 'EACCES' });
      await configManager.initialize();
      expect(configManager.getConfig().version).toBe('1.0.0');
    });

    describe('saveConfig error handling', () => {
      it('propagates write errors (disk full) and attempts cleanup', async () => {
        mockFileOperations.exists.mockResolvedValue(false);
        mockFileOperations.createDirectory.mockResolvedValue(undefined);
        mockFileOperations.chmod.mockResolvedValue(undefined);
        const writeError = new Error('Disk full');
        mockFileOperations.writeFile.mockRejectedValue(writeError);

        await configManager.initialize();
        await expect(configManager['saveConfig']()).rejects.toThrow('Disk full');
        expect(mockFileOperations.writeFile).toHaveBeenCalled();
        expect(mockFileOperations.renameFile).not.toHaveBeenCalled();
      });

      it('propagates rename errors (permission denied)', async () => {
        mockFileOperations.exists.mockResolvedValue(true);
        mockFileOperations.createDirectory.mockResolvedValue(undefined);
        mockFileOperations.chmod.mockResolvedValue(undefined);
        mockFileOperations.readFile.mockResolvedValue('version: "1.0.0"');
        mockFileOperations.copyFile.mockResolvedValue(undefined);
        mockFileOperations.writeFile.mockResolvedValue(undefined);
        mockFileOperations.renameFile.mockRejectedValue(new Error('Permission denied'));

        await configManager.initialize();
        await expect(configManager['saveConfig']()).rejects.toThrow('Permission denied');
        expect(mockFileOperations.renameFile).toHaveBeenCalled();
      });
    });
  });

  describe('OAuth Client ID Management', () => {
    it('should save and retrieve GitHub client ID', async () => {
      mockFileOperations.exists.mockResolvedValue(false);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.writeFile.mockResolvedValue(undefined);
      mockFileOperations.renameFile.mockResolvedValue(undefined);

      await configManager.initialize();
      const testClientId = 'Ov23liValidClientId789';
      await configManager.setGitHubClientId(testClientId);
      expect(configManager.getGitHubClientId()).toBe(testClientId);
      expect(mockFileOperations.writeFile).toHaveBeenCalled();
    });

    it('should validate client ID format - valid format', () => {
      expect(ConfigManager.validateClientId('Ov23liABCDEFGHIJKLMN')).toBe(true);
    });

    it('should validate client ID format - invalid format', () => {
      expect(ConfigManager.validateClientId('invalid-id')).toBe(false);
    });

    it('should reject invalid client ID when setting', async () => {
      await expect(configManager.setGitHubClientId('invalid-id')).rejects.toThrow(/invalid.*client.*id/i);
    });

    it('should prefer environment variable over config file', async () => {
      process.env.DOLLHOUSE_GITHUB_CLIENT_ID = 'Ov23liEnvVarClient111';
      mockFileOperations.exists.mockResolvedValue(true);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.readFile.mockResolvedValue(`github:\n  auth:\n    client_id: 'Ov23liConfigFileId222'`);

      await configManager.initialize();
      expect(configManager.getGitHubClientId()).toBe('Ov23liEnvVarClient111');
    });

    it('should return null if no client ID is configured', async () => {
      mockFileOperations.exists.mockResolvedValue(true);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.readFile.mockResolvedValue('version: 1.0.0');

      await configManager.initialize();
      expect(configManager.getGitHubClientId()).toBeNull();
    });

    it('should handle undefined/null client ID gracefully', async () => {
      await expect(configManager.setGitHubClientId(null as any)).rejects.toThrow();
    });
  });

  describe('Cross-Platform Compatibility', () => {
    it('should handle Windows paths correctly', async () => {
      const windowsHome = 'C:\\Users\\TestUser';
      mockOs.homedir.mockReturnValue(windowsHome);
      const winConfigManager = new ConfigManager(mockFileOperations, mockOs);
      mockFileOperations.exists.mockResolvedValue(false);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.writeFile.mockResolvedValue(undefined);
      mockFileOperations.renameFile.mockResolvedValue(undefined);

      await winConfigManager.initialize();
      const expectedPath = path.join(windowsHome, '.dollhouse');

      // Verify createDirectory was called with the expected path
      expect(mockFileOperations.createDirectory).toHaveBeenCalledWith(expectedPath);
    });

    it('should handle macOS paths correctly', async () => {
      const macHome = '/Users/testuser';
      mockOs.homedir.mockReturnValue(macHome);
      const macConfigManager = new ConfigManager(mockFileOperations, mockOs);
      mockFileOperations.exists.mockResolvedValue(false);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.writeFile.mockResolvedValue(undefined);
      mockFileOperations.renameFile.mockResolvedValue(undefined);

      await macConfigManager.initialize();
      const expectedPath = path.join(macHome, '.dollhouse');

      // Verify createDirectory was called with the expected path
      expect(mockFileOperations.createDirectory).toHaveBeenCalledWith(expectedPath);
    });

    it('should handle Linux paths correctly', async () => {
      mockFileOperations.exists.mockResolvedValue(false);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.writeFile.mockResolvedValue(undefined);
      mockFileOperations.renameFile.mockResolvedValue(undefined);

      await configManager.initialize();

      // Verify createDirectory was called with the config directory
      expect(mockFileOperations.createDirectory).toHaveBeenCalledWith(configDir);
    });

    it('should use proper path separators for the platform', () => {
        const configPath = (configManager as any).configPath;
        expect(configPath).toContain('.dollhouse');
        expect(configPath).toContain('config.yml');
    });
  });

  describe('Error Handling', () => {
    it('should handle file system errors gracefully', async () => {
      mockFileOperations.exists.mockResolvedValue(true);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.readFile.mockRejectedValue(new Error('File system error'));

      await configManager.initialize();
      expect(configManager.getConfig()).toBeDefined();
    });

    it('should handle YAML parse errors gracefully', async () => {
      mockFileOperations.exists.mockResolvedValue(true);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.readFile.mockResolvedValue('not: valid: yaml');

      await expect(configManager.initialize()).resolves.not.toThrow();
      expect(configManager.getConfig().version).toBe('1.0.0');
    });

    it('should handle permission denied errors with helpful message', async () => {
        mockFileOperations.createDirectory.mockRejectedValue({ code: 'EACCES' });
        await configManager.initialize();
        expect(configManager.getConfig()).toBeDefined();
    });

    it('should provide helpful error messages', async () => {
        await expect(configManager.setGitHubClientId('bad-id')).rejects.toThrow(/invalid.*github.*client.*id/i);
    });
  });

  describe('Atomic Operations', () => {
    it('should use atomic file writes to prevent corruption', async () => {
      mockFileOperations.exists.mockResolvedValue(false);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.writeFile.mockResolvedValue(undefined);
      mockFileOperations.renameFile.mockResolvedValue(undefined);

      await configManager.setGitHubClientId('Ov23liAtomicTest123456');

      expect(mockFileOperations.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.any(String),
        expect.any(Object)
      );
      expect(mockFileOperations.renameFile).toHaveBeenCalled();
    });
  });

  describe('YAML Parser Selection (Regression Test for Config Persistence Bug)', () => {
    it('should use js-yaml for config files, NOT SecureYamlParser', async () => {
      const yamlConfig = `user:\n  username: test-user`;
      mockFileOperations.exists.mockResolvedValue(true);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.readFile.mockResolvedValue(yamlConfig);

      await configManager.initialize();
      expect(configManager.getConfig().user.username).toBe('test-user');
    });

    it('should persist config values between ConfigManager instances', async () => {
        mockFileOperations.exists.mockResolvedValueOnce(false);
        mockFileOperations.createDirectory.mockResolvedValue(undefined);
        mockFileOperations.chmod.mockResolvedValue(undefined);
        mockFileOperations.writeFile.mockResolvedValue(undefined);
        mockFileOperations.renameFile.mockResolvedValue(undefined);

        await configManager.initialize();
        await configManager.updateSetting('user.username', 'testuser');
        const savedConfig = `user:\n  username: testuser`;
        mockFileOperations.readFile.mockResolvedValue(savedConfig);
        mockFileOperations.exists.mockResolvedValue(true);

        const newContainer = new DollhouseContainer();
        newContainer.register('ConfigManager', () => new ConfigManager(mockFileOperations, mockOs));
        const configManager2 = newContainer.resolve('ConfigManager') as InstanceType<typeof ConfigManager>;
        await configManager2.initialize();
        expect(configManager2.getConfig().user.username).toBe('testuser');
    });

    it('should handle null and empty values correctly', async () => {
        const yamlConfig = `user:\n  username: null`;
        mockFileOperations.exists.mockResolvedValue(true);
        mockFileOperations.createDirectory.mockResolvedValue(undefined);
        mockFileOperations.chmod.mockResolvedValue(undefined);
        mockFileOperations.readFile.mockResolvedValue(yamlConfig);

        await configManager.initialize();
        expect(configManager.getConfig().user.username).toBeNull();
    });

    it('should merge with defaults without overwriting saved values', async () => {
        const yamlConfig = `user:\n  username: 'saveduser'`;
        mockFileOperations.exists.mockResolvedValue(true);
        mockFileOperations.createDirectory.mockResolvedValue(undefined);
        mockFileOperations.chmod.mockResolvedValue(undefined);
        mockFileOperations.readFile.mockResolvedValue(yamlConfig);

        await configManager.initialize();
        const config = configManager.getConfig();
        expect(config.user.username).toBe('saveduser');
        expect(config.sync.enabled).toBe(false);
    });
  });

  describe('Prototype Pollution Protection', () => {
    it('should reject __proto__ in updateSetting path', async () => {
      await expect(configManager.updateSetting('__proto__.polluted', 'evil')).rejects.toThrow();
    });

    it('should reject constructor in updateSetting path', async () => {
      await expect(configManager.updateSetting('user.constructor.polluted', 'evil')).rejects.toThrow();
    });

    it('should reject prototype in updateSetting path', async () => {
      await expect(configManager.updateSetting('sync.prototype.polluted', 'evil')).rejects.toThrow();
    });

    it('should reject __proto__ in resetConfig section', async () => {
        mockFileOperations.exists.mockResolvedValue(false);
        mockFileOperations.createDirectory.mockResolvedValue(undefined);
        mockFileOperations.chmod.mockResolvedValue(undefined);
        mockFileOperations.writeFile.mockResolvedValue(undefined);
        mockFileOperations.renameFile.mockResolvedValue(undefined);

        await configManager.initialize();
        await expect(configManager.resetConfig('__proto__')).rejects.toThrow();
    });

    it('should reject constructor in resetConfig section', async () => {
        mockFileOperations.exists.mockResolvedValue(false);
        mockFileOperations.createDirectory.mockResolvedValue(undefined);
        mockFileOperations.chmod.mockResolvedValue(undefined);
        mockFileOperations.writeFile.mockResolvedValue(undefined);
        mockFileOperations.renameFile.mockResolvedValue(undefined);

        await configManager.initialize();
        await expect(configManager.resetConfig('constructor')).rejects.toThrow();
    });

    it('should allow valid paths in updateSetting', async () => {
        mockFileOperations.exists.mockResolvedValue(false);
        mockFileOperations.createDirectory.mockResolvedValue(undefined);
        mockFileOperations.chmod.mockResolvedValue(undefined);
        mockFileOperations.writeFile.mockResolvedValue(undefined);
        mockFileOperations.renameFile.mockResolvedValue(undefined);

        await configManager.initialize();
        const result = await configManager.updateSetting('user.username', 'testuser');
        expect(result.success).toBe(true);
    });

    it('should allow valid sections in resetConfig', async () => {
        mockFileOperations.exists.mockResolvedValue(false);
        mockFileOperations.createDirectory.mockResolvedValue(undefined);
        mockFileOperations.chmod.mockResolvedValue(undefined);
        mockFileOperations.writeFile.mockResolvedValue(undefined);
        mockFileOperations.renameFile.mockResolvedValue(undefined);

        await configManager.initialize();
        const result = await configManager.resetConfig('user');
        expect(result.success).toBe(true);
    });
  });

  describe('Config File Format', () => {
    it('should use correct YAML structure', async () => {
      mockFileOperations.exists.mockResolvedValue(false);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.writeFile.mockResolvedValue(undefined);
      mockFileOperations.renameFile.mockResolvedValue(undefined);

      await configManager.setGitHubClientId('Ov23liStructureTest1');

      const writeCall = mockFileOperations.writeFile.mock.calls[0];
      const writtenContent = writeCall[1] as string;

      expect(writtenContent).toMatch(/version:/);
      expect(writtenContent).toMatch(/github:/);
      expect(writtenContent).toMatch(/client_id: ['"]*Ov23liStructureTest1/);
    });

    it('should preserve unknown fields when updating', async () => {
      const existingConfig = `version: '1.0.0'\ngithub:\n  auth:\n    client_id: 'Ov23liOldId123'\nfutureFeature:\n  someValue: 'preserve-me'`;

      mockFileOperations.readFile.mockResolvedValue(existingConfig);
      mockFileOperations.exists.mockResolvedValue(true);
      mockFileOperations.createDirectory.mockResolvedValue(undefined);
      mockFileOperations.chmod.mockResolvedValue(undefined);
      mockFileOperations.copyFile.mockResolvedValue(undefined);
      mockFileOperations.writeFile.mockResolvedValue(undefined);
      mockFileOperations.renameFile.mockResolvedValue(undefined);

      await configManager.initialize();
      await configManager.setGitHubClientId('Ov23liNewId456789012');

      const writeCall = mockFileOperations.writeFile.mock.calls[0];
      const writtenContent = writeCall[1] as string;

      expect(writtenContent).toMatch(/futureFeature:/);
      expect(writtenContent).toMatch(/someValue: ['"]*preserve-me/);
    });
  });
});
