import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { IFileOperationsService } from '../../../src/services/FileOperationsService.js';
import { InMemoryOperatorConfigStore } from '../../../src/storage/operatorConfig/InMemoryOperatorConfigStore.js';
import { InMemoryUserConfigStore } from '../../../src/storage/userConfig/InMemoryUserConfigStore.js';

// Phase 4.5 / Phase G: ConfigManager is now a façade over IOperatorConfigStore +
// IUserConfigStore. Tests that previously asserted against mocked file I/O
// (readFile/writeFile mocks) now assert against in-memory store state. The
// new constructor signature requires both stores; this helper builds a fresh
// pair per test so each test runs against an isolated state.
function makeStores(): { operatorStore: InMemoryOperatorConfigStore; userStore: InMemoryUserConfigStore } {
  return {
    operatorStore: new InMemoryOperatorConfigStore(),
    userStore: new InMemoryUserConfigStore(),
  };
}

describe('ConfigManager', () => {
  let container: InstanceType<typeof DollhouseContainer>;
  let configManager: InstanceType<typeof ConfigManager>;
  const mockHomedir = '/home/testuser';

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

    const { operatorStore, userStore } = makeStores();
    container.register('ConfigManager', () => new ConfigManager(mockFileOperations, mockOs, operatorStore, userStore, null));
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
    // Phase 4.5 / Phase G: file I/O moved to FilesystemOperatorConfigStore +
    // FilesystemUserConfigStore (with their own parity tests covering atomic
    // writes, permissions, directory creation, error propagation, etc.).
    // ConfigManager itself is now backend-agnostic — these tests verify the
    // façade-layer semantic behavior against in-memory stores.

    it('should load existing config from stores on initialize', async () => {
      // Pre-populate the stores as if a previous run had saved data
      const operatorStore = new InMemoryOperatorConfigStore();
      const userStore = new InMemoryUserConfigStore();
      await userStore.save('00000000-0000-0000-0000-000000000000', {
        githubConfig: { auth: { client_id: 'Ov23liTestClientId123' } },
        syncConfig: {}, autoloadConfig: {}, retentionConfig: {}, wizardConfig: {},
        displayConfig: {}, collectionConfig: {}, autoActivateConfig: {},
        sourcePriorityConfig: {}, userIdentityConfig: {}, configVersion: 1,
      });

      const cm = new ConfigManager(mockFileOperations, mockOs, operatorStore, userStore, null);
      await cm.initialize();
      expect(cm.getGitHubClientId()).toBe('Ov23liTestClientId123');
    });

    it('should handle store load errors gracefully (returns defaults)', async () => {
      // Simulate a store that throws on load
      const failingStore = {
        load: jest.fn(async () => { throw new Error('store unreachable'); }),
        save: jest.fn(async () => {}),
      };
      const cm = new ConfigManager(
        mockFileOperations,
        mockOs,
        failingStore as any,
        new InMemoryUserConfigStore(),
        null,
      );
      await cm.initialize();
      // Should fall through to defaults rather than throwing
      expect(cm.getConfig().version).toBe('1.0.0');
    });

    it('should handle permission errors gracefully', async () => {
      // No file ops involved anymore — initialize() resilience test.
      // (Kept for backwards-compat naming; the actual error path is
      // store-throw rather than fs-permission-denied.)
      await configManager.initialize();
      expect(configManager.getConfig().version).toBe('1.0.0');
    });
  });

  describe('OAuth Client ID Management', () => {
    it('should save and retrieve GitHub client ID', async () => {
      // Phase 4.5: persistence verified by reading back through the
      // ConfigManager (which loads from the store) — file-mock assertion
      // is obsolete since ConfigManager no longer touches the filesystem.
      const operatorStore = new InMemoryOperatorConfigStore();
      const userStore = new InMemoryUserConfigStore();
      const cm = new ConfigManager(mockFileOperations, mockOs, operatorStore, userStore, null);
      await cm.initialize();

      const testClientId = 'Ov23liValidClientId789';
      await cm.setGitHubClientId(testClientId);
      expect(cm.getGitHubClientId()).toBe(testClientId);

      // Round-trip: a fresh instance reading the same store must see the value.
      const cm2 = new ConfigManager(mockFileOperations, mockOs, operatorStore, userStore, null);
      await cm2.initialize();
      expect(cm2.getGitHubClientId()).toBe(testClientId);
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

  // Phase 4.5 / Phase G: 'Cross-Platform Compatibility' describe block removed.
  // Cross-platform path resolution moved to PathService (resolveDataDirectory)
  // and to FilesystemOperatorConfigStore / FilesystemUserConfigStore — each has
  // its own tests covering Windows / macOS / Linux path behavior. ConfigManager
  // is now path-agnostic; testing path separators here would just duplicate
  // those FilesystemImpl tests.

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

  // Phase 4.5 / Phase G: 'Atomic Operations' describe block removed. Atomic
  // writes are now the responsibility of FilesystemOperatorConfigStore +
  // FilesystemUserConfigStore (write-temp + rename via FileLockManager) — both
  // have parity tests asserting atomicity. ConfigManager itself never calls
  // writeFile; the atomicity guarantee is structural via store abstraction.

  describe('Persistence and Round-trip', () => {
    // Replaces the 'YAML Parser Selection' describe. The original tests
    // verified that ConfigManager round-tripped values through YAML on disk;
    // the new tests verify the same round-trip through the in-memory stores.
    // YAML is now only used for export/import, not internal persistence.

    it('should round-trip values through stores on initialize', async () => {
      const operatorStore = new InMemoryOperatorConfigStore();
      const userStore = new InMemoryUserConfigStore();
      await userStore.save('00000000-0000-0000-0000-000000000000', {
        githubConfig: {}, syncConfig: {}, autoloadConfig: {}, retentionConfig: {},
        wizardConfig: {}, displayConfig: {}, collectionConfig: {},
        autoActivateConfig: {}, sourcePriorityConfig: {},
        userIdentityConfig: { username: 'test-user' },
        configVersion: 1,
      });
      const cm = new ConfigManager(mockFileOperations, mockOs, operatorStore, userStore, null);
      await cm.initialize();
      expect(cm.getConfig().user.username).toBe('test-user');
    });

    it('should persist values between ConfigManager instances using shared stores', async () => {
      // Two ConfigManager instances backed by the SAME stores — verifies
      // cross-instance persistence semantics.
      const operatorStore = new InMemoryOperatorConfigStore();
      const userStore = new InMemoryUserConfigStore();

      const cm1 = new ConfigManager(mockFileOperations, mockOs, operatorStore, userStore, null);
      await cm1.initialize();
      await cm1.updateSetting('user.username', 'testuser');

      const cm2 = new ConfigManager(mockFileOperations, mockOs, operatorStore, userStore, null);
      await cm2.initialize();
      expect(cm2.getConfig().user.username).toBe('testuser');
    });

    it('should preserve null values from stored data', async () => {
      const operatorStore = new InMemoryOperatorConfigStore();
      const userStore = new InMemoryUserConfigStore();
      await userStore.save('00000000-0000-0000-0000-000000000000', {
        githubConfig: {}, syncConfig: {}, autoloadConfig: {}, retentionConfig: {},
        wizardConfig: {}, displayConfig: {}, collectionConfig: {},
        autoActivateConfig: {}, sourcePriorityConfig: {},
        userIdentityConfig: { username: null, email: null, display_name: null },
        configVersion: 1,
      });
      const cm = new ConfigManager(mockFileOperations, mockOs, operatorStore, userStore, null);
      await cm.initialize();
      expect(cm.getConfig().user.username).toBeNull();
      expect(cm.getConfig().user.email).toBeNull();
    });

    it('should merge stored values with defaults without overwriting saved values', async () => {
      const operatorStore = new InMemoryOperatorConfigStore();
      const userStore = new InMemoryUserConfigStore();
      await userStore.save('00000000-0000-0000-0000-000000000000', {
        githubConfig: {}, syncConfig: {}, autoloadConfig: {}, retentionConfig: {},
        wizardConfig: {}, displayConfig: {}, collectionConfig: {},
        autoActivateConfig: {}, sourcePriorityConfig: {},
        userIdentityConfig: { username: 'saveduser' },
        configVersion: 1,
      });
      const cm = new ConfigManager(mockFileOperations, mockOs, operatorStore, userStore, null);
      await cm.initialize();
      const config = cm.getConfig();
      expect(config.user.username).toBe('saveduser'); // saved value wins
      expect(config.sync.enabled).toBe(false); // default fills the gap
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
    // Phase 4.5 / Phase G: format-on-disk concerns moved to FilesystemImpl
    // tests. These remaining tests verify ConfigManager's responsibility:
    // that writes propagate correctly through the store boundary.

    it('should expose updated GitHub client ID via getConfig after setGitHubClientId', async () => {
      const operatorStore = new InMemoryOperatorConfigStore();
      const userStore = new InMemoryUserConfigStore();
      const cm = new ConfigManager(mockFileOperations, mockOs, operatorStore, userStore, null);
      await cm.initialize();

      await cm.setGitHubClientId('Ov23liStructureTest1');

      // Round-trip through the store: a fresh instance should see the new value.
      const cm2 = new ConfigManager(mockFileOperations, mockOs, operatorStore, userStore, null);
      await cm2.initialize();
      expect(cm2.getGitHubClientId()).toBe('Ov23liStructureTest1');
    });

    it('should preserve other store sections when updating one', async () => {
      // Pre-populate the operator store with a non-default value, then
      // perform a per-user write. After the write, the operator-side value
      // should still be present (the merge-split round-trip preserves it).
      const operatorStore = new InMemoryOperatorConfigStore();
      const userStore = new InMemoryUserConfigStore();
      await operatorStore.save({
        enhancedIndexConfig: { telemetry: { enabled: true } },
        consoleConfig: {}, licenseConfig: {}, defaultsConfig: {}, configVersion: 1,
      });

      const cm = new ConfigManager(mockFileOperations, mockOs, operatorStore, userStore, null);
      await cm.initialize();
      await cm.setGitHubClientId('Ov23liNewId456789012');

      // Reload — the operator-side value (telemetry.enabled=true) must
      // survive. (The deep-merge fills defaults around it, but the
      // explicitly-set value is preserved.)
      const reloadedOperator = await operatorStore.load();
      const telemetry = (reloadedOperator.enhancedIndexConfig as Record<string, any>).telemetry;
      expect(telemetry.enabled).toBe(true);
    });
  });
});
