import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { GitHubAuthManager } from '../../../src/auth/GitHubAuthManager.js';
import type { ConfigManager } from '../../../src/config/ConfigManager.js';
import type { InitializationService } from '../../../src/services/InitializationService.js';
import type { PersonaIndicatorService } from '../../../src/services/PersonaIndicatorService.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import type { GitHubAuthHandler } from '../../../src/handlers/GitHubAuthHandler.js';

const { GitHubAuthHandler: GitHubAuthHandlerClass } = await import('../../../src/handlers/GitHubAuthHandler.js');

/**
 * Creates a FileOperationsService mock that passes through to real file operations.
 * This is needed because some tests use withTempHome() which creates real temp files.
 */
function createFileOperationsMock(): jest.Mocked<FileOperationsService> {
  return {
    exists: jest.fn().mockImplementation(async (filePath: string) => {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    }),
    createDirectory: jest.fn().mockImplementation(async (dirPath: string) => {
      await fs.mkdir(dirPath, { recursive: true });
    }),
    writeFile: jest.fn().mockImplementation(async (filePath: string, content: string) => {
      await fs.writeFile(filePath, content, 'utf-8');
    }),
    readFile: jest.fn().mockImplementation(async (filePath: string) => {
      return fs.readFile(filePath, 'utf-8');
    }),
    deleteFile: jest.fn().mockImplementation(async (filePath: string) => {
      try {
        await fs.unlink(filePath);
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
      }
    }),
    // Add other methods that might be needed (returning defaults)
    readElementFile: jest.fn(),
    listDirectory: jest.fn(),
    renameFile: jest.fn(),
    stat: jest.fn(),
    resolvePath: jest.fn(),
    validatePath: jest.fn(),
    createFileExclusive: jest.fn()
  } as unknown as jest.Mocked<FileOperationsService>;
}

describe('GitHubAuthHandler (DI)', () => {
  let authManager: jest.Mocked<GitHubAuthManager>;
  let configManager: jest.Mocked<ConfigManager>;
  let initService: jest.Mocked<InitializationService>;
  let indicatorService: jest.Mocked<PersonaIndicatorService>;
  let fileOperations: jest.Mocked<FileOperationsService>;
  let handler: GitHubAuthHandler;

  beforeEach(() => {
    jest.clearAllMocks();

    authManager = {
      getAuthStatus: jest.fn(),
      initiateDeviceFlow: jest.fn(),
      formatAuthInstructions: jest.fn(),
      clearAuthentication: jest.fn(),
      resolveClientId: jest.fn()
    } as unknown as jest.Mocked<GitHubAuthManager>;
    authManager.formatAuthInstructions.mockImplementation((response: any) =>
      `Go to ${response?.verification_uri ?? 'https://github.com/login/device'} and enter code ${response?.user_code ?? ''}`
    );

    configManager = {
      initialize: jest.fn().mockResolvedValue(undefined),
      getGitHubClientId: jest.fn(),
      setGitHubClientId: jest.fn().mockResolvedValue(undefined)
    } as unknown as jest.Mocked<ConfigManager>;

    initService = {
      ensureInitialized: jest.fn().mockResolvedValue(undefined)
    } as unknown as jest.Mocked<InitializationService>;

    indicatorService = {
      getPersonaIndicator: jest.fn().mockReturnValue('>>')
    } as unknown as jest.Mocked<PersonaIndicatorService>;

    fileOperations = createFileOperationsMock();

    handler = new GitHubAuthHandlerClass(authManager, configManager, initService, indicatorService, fileOperations);
  });

  describe('setupGitHubAuth', () => {
    it('prefixes responses and ensures initialization when already connected', async () => {
      authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: true, username: 'tester' } as any);

      const result = await handler.setupGitHubAuth();

      expect(initService.ensureInitialized).toHaveBeenCalled();
      expect(result.content[0].text.startsWith('>>')).toBe(true);
      expect(result.content[0].text).toContain('Already Connected to GitHub');
    });

    it('returns configuration error when client ID is missing', async () => {
      authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false });
      authManager.initiateDeviceFlow.mockResolvedValue({
        device_code: 'device',
        user_code: 'ABCD',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5
      } as any);
      authManager.resolveClientId.mockResolvedValue(null);

      const result = await handler.setupGitHubAuth();

      expect(result.content[0].text).toContain('GitHub OAuth Configuration Error');
    });

    it('surfaces device-flow initiation errors', async () => {
      authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false });
      authManager.initiateDeviceFlow.mockRejectedValue(new Error('network boom'));

      const result = await handler.setupGitHubAuth();

      expect(result.content[0].text).toContain('Authentication Setup Failed');
      expect(result.content[0].text).toContain('network boom');
    });
  });

  describe('clearGitHubAuth', () => {
    it('delegates to auth manager and prefixes response', async () => {
      const response = await handler.clearGitHubAuth();

      expect(initService.ensureInitialized).toHaveBeenCalled();
      expect(authManager.clearAuthentication).toHaveBeenCalled();
      expect(response.content[0].text.startsWith('>>')).toBe(true);
      expect(response.content[0].text).toContain('GitHub Disconnected');
    });
  });

  describe('configureOAuth', () => {
    it('validates format before saving', async () => {
      const response = await handler.configureOAuth('invalid');

      expect(initService.ensureInitialized).toHaveBeenCalled();
      expect(configManager.initialize).toHaveBeenCalled();
      expect(response.content[0].text).toContain('Invalid Client ID Format');
    });

    it('reports current configuration when client_id omitted', async () => {
      authManager.resolveClientId.mockResolvedValue('Ov23li9gyNZP6m9aJ2EP1234');
      configManager.getGitHubClientId.mockReturnValue(undefined);

      const response = await handler.configureOAuth();

      expect(response.content[0].text).toContain('GitHub OAuth Configuration');
      expect(response.content[0].text).toContain('Using Default');
    });

    it('saves valid client id and confirms configuration', async () => {
      const validId = 'Ov23liABCDEFGHIJKLMN';

      const response = await handler.configureOAuth(validId);

      expect(configManager.setGitHubClientId).toHaveBeenCalledWith(validId);
      expect(response.content[0].text).toContain('Configured Successfully');
    });
  });

  describe('checkGitHubAuth', () => {
    it('reports connected status when authenticated', async () => {
      authManager.getAuthStatus.mockResolvedValue({
        isAuthenticated: true,
        username: 'tester',
        scopes: ['repo']
      } as any);
      const helperSpy = jest
        .spyOn(handler as any, 'checkOAuthHelperHealth')
        .mockResolvedValue({ exists: false });

      const response = await handler.checkGitHubAuth();

      expect(helperSpy).toHaveBeenCalled();
      expect(response.content[0].text).toContain('GitHub Connected');
      helperSpy.mockRestore();
    });

    it('reports active helper status when awaiting user action', async () => {
      authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false } as any);
      const helperSpy = jest.spyOn(handler as any, 'checkOAuthHelperHealth').mockResolvedValue({
        exists: true,
        isActive: true,
        expired: false,
        processAlive: true,
        hasLog: false,
        userCode: 'CODE1234',
        timeRemaining: 90
      });

      const response = await handler.checkGitHubAuth();

      expect(response.content[0].text).toContain('Authentication In Progress');
      expect(response.content[0].text).toContain('CODE1234');
      helperSpy.mockRestore();
    });
  });

  describe('setupGitHubAuth helper orchestration', () => {
    it('spawns helper and writes state file with device code details', async () => {
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-home-'));
      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;
      const originalOverride = process.env.DOLLHOUSE_HOME_DIR;
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
      process.env.DOLLHOUSE_HOME_DIR = tempHome;
      const helperPath = path.join(tempHome, 'oauth-helper.mjs');
      await fs.writeFile(helperPath, 'console.log(\"helper\");', 'utf-8');
      process.env.DOLLHOUSE_OAUTH_HELPER = helperPath;

      const unref = jest.fn();
      const spawnSpy = jest.spyOn(handler as any, 'spawnHelperProcess').mockReturnValue({
        pid: 4242,
        unref
      } as any);

      authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false } as any);
      authManager.resolveClientId.mockResolvedValue('Ov23liClient');
      authManager.initiateDeviceFlow.mockResolvedValue({
        device_code: 'device-code',
        user_code: 'CODE-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5
      } as any);

      const response = await handler.setupGitHubAuth();

      expect(response.content[0].text).toContain('CODE-1234');
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(unref).toHaveBeenCalled();
      expect(String(spawnSpy.mock.calls[0][0])).toContain('oauth-helper.mjs');

      const stateFile = path.join(tempHome, '.dollhouse', '.auth', 'oauth-helper-state.json');
      const state = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      expect(state.deviceCode).toBe('device-code');
      expect(state.userCode).toBe('CODE-1234');

      await fs.rm(tempHome, { recursive: true, force: true });
      delete process.env.DOLLHOUSE_OAUTH_HELPER;
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
      if (originalOverride) {
        process.env.DOLLHOUSE_HOME_DIR = originalOverride;
      } else {
        delete process.env.DOLLHOUSE_HOME_DIR;
      }
      spawnSpy.mockRestore();
    });
  });

  describe('checkGitHubAuth helper states', () => {
    async function withTempHome(fn: (homeDir: string) => Promise<void>) {
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-health-'));
      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;
      const originalOverride = process.env.DOLLHOUSE_HOME_DIR;
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
      process.env.DOLLHOUSE_HOME_DIR = tempHome;
      try {
        await fn(tempHome);
      } finally {
        process.env.HOME = originalHome;
        process.env.USERPROFILE = originalUserProfile;
        if (originalOverride) {
          process.env.DOLLHOUSE_HOME_DIR = originalOverride;
        } else {
          delete process.env.DOLLHOUSE_HOME_DIR;
        }
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    }

    it('reports authentication in progress when helper state exists', async () => {
      await withTempHome(async (homeDir) => {
        const stateDir = path.join(homeDir, '.dollhouse', '.auth');
        await fs.mkdir(stateDir, { recursive: true });
        const expiresAt = new Date(Date.now() + 120_000).toISOString();
        await fs.writeFile(
          path.join(stateDir, 'oauth-helper-state.json'),
          JSON.stringify({
            pid: 9999,
            deviceCode: 'device',
            userCode: 'STATE-9999',
            startTime: new Date().toISOString(),
            expiresAt
          }, null, 2),
          'utf-8'
        );

        const logPath = path.join(homeDir, '.dollhouse', 'oauth-helper.log');
        await fs.writeFile(logPath, 'INFO helper running', 'utf-8');

        const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => undefined as any);

        authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false } as any);
        const response = await handler.checkGitHubAuth();

        expect(response.content[0].text).toContain('Authentication In Progress');
        expect(response.content[0].text).toContain('STATE-9999');

        killSpy.mockRestore();
      });
    });

    it('reports expired helper status with log snippet', async () => {
      await withTempHome(async (homeDir) => {
        const stateDir = path.join(homeDir, '.dollhouse', '.auth');
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          path.join(stateDir, 'oauth-helper-state.json'),
          JSON.stringify({
            pid: 5555,
            deviceCode: 'device',
            userCode: 'EXPIRED-1234',
            startTime: new Date(Date.now() - 3600_000).toISOString(),
            expiresAt: new Date(Date.now() - 60_000).toISOString()
          }, null, 2),
          'utf-8'
        );

        const logPath = path.join(homeDir, '.dollhouse', 'oauth-helper.log');
        await fs.writeFile(logPath, 'ERROR polling failed', 'utf-8');

        authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false, hasToken: false } as any);
        const response = await handler.checkGitHubAuth();

        expect(response.content[0].text).toContain('Authentication Expired');
        expect(response.content[0].text).toContain('EXPIRED-1234');
        expect(response.content[0].text).toContain('ERROR polling failed');
      });
    });
  });
});
