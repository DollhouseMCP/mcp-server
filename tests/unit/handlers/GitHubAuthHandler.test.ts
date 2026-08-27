import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { GitHubAuthManager } from '../../../src/auth/GitHubAuthManager.js';
import type { ConfigManager } from '../../../src/config/ConfigManager.js';
import type { InitializationService } from '../../../src/services/InitializationService.js';
import type { PersonaIndicatorService } from '../../../src/services/PersonaIndicatorService.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import type { GitHubAuthHandler } from '../../../src/handlers/GitHubAuthHandler.js';
import type { PathService } from '../../../src/paths/PathService.js';

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
      } catch (error: unknown) {
        const code = error instanceof Error && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
        if (code !== 'ENOENT') throw error;
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

async function waitForFileRemoval(filePath: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
    } catch {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for file removal: ${filePath}`);
}

describe('GitHubAuthHandler (DI)', () => {
  let authManager: jest.Mocked<GitHubAuthManager>;
  let configManager: jest.Mocked<ConfigManager>;
  let initService: jest.Mocked<InitializationService>;
  let indicatorService: jest.Mocked<PersonaIndicatorService>;
  let fileOperations: jest.Mocked<FileOperationsService>;
  let handler: GitHubAuthHandler;

  function handlerWithAuthDir(authDir: string): GitHubAuthHandler {
    const pathService = {
      getUserAuthDir: jest.fn().mockReturnValue(authDir)
    } as unknown as PathService;
    return new GitHubAuthHandlerClass(
      authManager,
      configManager,
      initService,
      indicatorService,
      fileOperations,
      pathService
    );
  }

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
    it('spawns helper and writes state file without persisting the device code', async () => {
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-home-'));
      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;
      const originalOverride = process.env.DOLLHOUSE_HOME_DIR;
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
      process.env.DOLLHOUSE_HOME_DIR = tempHome;
      const helperPath = path.join(tempHome, 'oauth-helper.mjs');
      await fs.writeFile(helperPath, 'console.log("helper");', 'utf-8');
      process.env.DOLLHOUSE_OAUTH_HELPER = helperPath;
      const staleResultFile = path.join(tempHome, '.dollhouse', '.auth', 'oauth-helper-result.json');
      await fs.mkdir(path.dirname(staleResultFile), { recursive: true });
      await fs.writeFile(staleResultFile, JSON.stringify({ status: 'failed' }), 'utf-8');

      const unref = jest.fn();
      const spawnSpy = jest.spyOn(handler as any, 'spawnHelperProcess').mockReturnValue({
        pid: 4242,
        unref,
        once: jest.fn()
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
      expect(state.deviceCode).toBeUndefined();
      expect(typeof state.flowId).toBe('string');
      expect(state.userCode).toBe('CODE-1234');
      await expect(fs.access(staleResultFile)).rejects.toMatchObject({ code: 'ENOENT' });

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

    it('preserves an early helper result without republishing state for the dead process', async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-early-result-'));
      const authDir = path.join(tempRoot, 'auth');
      const helperPath = path.join(tempRoot, 'oauth-helper.mjs');
      const stateFile = path.join(authDir, 'oauth-helper-state.json');
      const resultFile = path.join(authDir, 'oauth-helper-result.json');
      await fs.writeFile(helperPath, 'console.log("helper");', 'utf-8');
      await fs.mkdir(authDir, { recursive: true });
      await fs.writeFile(resultFile, JSON.stringify({ status: 'failed', flowId: 'stale-flow' }), 'utf-8');

      const originalHelper = process.env.DOLLHOUSE_OAUTH_HELPER;
      process.env.DOLLHOUSE_OAUTH_HELPER = helperPath;
      const scopedHandler = handlerWithAuthDir(authDir);
      const unref = jest.fn();
      const spawnSpy = jest.spyOn(scopedHandler as any, 'spawnHelperProcess').mockImplementation(
        (_path: string, _response: unknown, _clientId: string, flowId: string) => {
          const preparedState = JSON.parse(fsSync.readFileSync(stateFile, 'utf-8')) as Record<string, unknown>;
          expect(preparedState.flowId).toBe(flowId);
          expect(preparedState.pid).toBeUndefined();
          expect(fsSync.existsSync(resultFile)).toBe(false);

          fsSync.writeFileSync(resultFile, JSON.stringify({
            status: 'failed',
            flowId,
            pid: 4242,
            errorCode: 'interrupted'
          }));
          fsSync.unlinkSync(stateFile);
          return { pid: 4242, unref, once: jest.fn() } as any;
        }
      );

      try {
        authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false } as any);
        authManager.resolveClientId.mockResolvedValue('Ov23liClient');
        authManager.initiateDeviceFlow.mockResolvedValue({
          device_code: 'device-code',
          user_code: 'EARLY-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5
        } as any);

        const response = await scopedHandler.setupGitHubAuth();

        expect(response.content[0].text).toContain('EARLY-1234');
        expect(unref).toHaveBeenCalledTimes(1);
        await expect(fs.access(stateFile)).rejects.toMatchObject({ code: 'ENOENT' });
        const terminalResult = JSON.parse(await fs.readFile(resultFile, 'utf-8')) as Record<string, unknown>;
        expect(terminalResult.status).toBe('failed');
        expect(terminalResult.errorCode).toBe('interrupted');
        expect(terminalResult.pid).toBe(4242);
      } finally {
        spawnSpy.mockRestore();
        if (originalHelper === undefined) delete process.env.DOLLHOUSE_OAUTH_HELPER;
        else process.env.DOLLHOUSE_OAUTH_HELPER = originalHelper;
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    });

    it('removes prepared state when spawning the helper fails', async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-spawn-failure-state-'));
      const authDir = path.join(tempRoot, 'auth');
      const helperPath = path.join(tempRoot, 'oauth-helper.mjs');
      const stateFile = path.join(authDir, 'oauth-helper-state.json');
      await fs.writeFile(helperPath, 'console.log("helper");', 'utf-8');

      const originalHelper = process.env.DOLLHOUSE_OAUTH_HELPER;
      process.env.DOLLHOUSE_OAUTH_HELPER = helperPath;
      const scopedHandler = handlerWithAuthDir(authDir);
      const spawnSpy = jest.spyOn(scopedHandler as any, 'spawnHelperProcess').mockImplementation(() => {
        throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
      });

      try {
        authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false } as any);
        authManager.resolveClientId.mockResolvedValue('Ov23liClient');
        authManager.initiateDeviceFlow.mockResolvedValue({
          device_code: 'device-code',
          user_code: 'FAILED-SPAWN',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5
        } as any);

        const response = await scopedHandler.setupGitHubAuth();

        expect(response.content[0].text).toContain('OAuth Helper Launch Failed');
        await expect(fs.access(stateFile)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        spawnSpy.mockRestore();
        if (originalHelper === undefined) delete process.env.DOLLHOUSE_OAUTH_HELPER;
        else process.env.DOLLHOUSE_OAUTH_HELPER = originalHelper;
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    });

    it.each([
      ['emits an asynchronous spawn error', 'error', [new Error('async spawn failure')]],
      ['exits', 'exit', [1, null]]
    ] as const)('removes prepared state when the helper %s before claiming it', async (_scenario, event, eventArgs) => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-pre-claim-exit-'));
      const authDir = path.join(tempRoot, 'auth');
      const helperPath = path.join(tempRoot, 'oauth-helper.mjs');
      const stateFile = path.join(authDir, 'oauth-helper-state.json');
      await fs.writeFile(helperPath, 'console.log("helper");', 'utf-8');

      const originalHelper = process.env.DOLLHOUSE_OAUTH_HELPER;
      process.env.DOLLHOUSE_OAUTH_HELPER = helperPath;
      const scopedHandler = handlerWithAuthDir(authDir);
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const helper = {
        pid: 4242,
        unref: jest.fn(),
        once: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
          listeners.set(event, listener);
          return helper;
        })
      };
      const spawnSpy = jest.spyOn(scopedHandler as any, 'spawnHelperProcess').mockReturnValue(helper as any);

      try {
        authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false } as any);
        authManager.resolveClientId.mockResolvedValue('Ov23liClient');
        authManager.initiateDeviceFlow.mockResolvedValue({
          device_code: 'device-code',
          user_code: 'PRE-CLAIM-EXIT',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5
        } as any);

        const response = await scopedHandler.setupGitHubAuth();

        expect(response.content[0].text).toContain('PRE-CLAIM-EXIT');
        const preparedState = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
        expect(preparedState.flowId).toEqual(expect.any(String));
        expect(preparedState.pid).toBeUndefined();
        expect(listeners.has('error')).toBe(true);
        expect(listeners.has('exit')).toBe(true);

        listeners.get(event)?.(...eventArgs);

        await waitForFileRemoval(stateFile);
      } finally {
        spawnSpy.mockRestore();
        if (originalHelper === undefined) delete process.env.DOLLHOUSE_OAUTH_HELPER;
        else process.env.DOLLHOUSE_OAUTH_HELPER = originalHelper;
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    });

    it('writes OAuth helper state under each session auth dir when PathService is injected', async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-user-state-'));
      const helperPath = path.join(tempRoot, 'oauth-helper.mjs');
      await fs.writeFile(helperPath, 'console.log("helper");', 'utf-8');
      const originalHelper = process.env.DOLLHOUSE_OAUTH_HELPER;
      process.env.DOLLHOUSE_OAUTH_HELPER = helperPath;

      const aliceAuthDir = path.join(tempRoot, 'users', 'alice', 'auth');
      const bobAuthDir = path.join(tempRoot, 'users', 'bob', 'auth');
      const aliceHandler = handlerWithAuthDir(aliceAuthDir);
      const bobHandler = handlerWithAuthDir(bobAuthDir);
      const aliceSpawn = jest.spyOn(aliceHandler as any, 'spawnHelperProcess').mockReturnValue({
        pid: 1111,
        unref: jest.fn(),
        once: jest.fn()
      } as any);
      const bobSpawn = jest.spyOn(bobHandler as any, 'spawnHelperProcess').mockReturnValue({
        pid: 2222,
        unref: jest.fn(),
        once: jest.fn()
      } as any);

      try {
        authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false } as any);
        authManager.resolveClientId.mockResolvedValue('Ov23liClient');
        authManager.initiateDeviceFlow
          .mockResolvedValueOnce({
            device_code: 'alice-device',
            user_code: 'ALICE-CODE',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5
          } as any)
          .mockResolvedValueOnce({
            device_code: 'bob-device',
            user_code: 'BOB-CODE',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5
          } as any);

        await aliceHandler.setupGitHubAuth();
        await bobHandler.setupGitHubAuth();

        const aliceState = JSON.parse(
          await fs.readFile(path.join(aliceAuthDir, 'oauth-helper-state.json'), 'utf-8')
        );
        const bobState = JSON.parse(
          await fs.readFile(path.join(bobAuthDir, 'oauth-helper-state.json'), 'utf-8')
        );

        expect(aliceState.deviceCode).toBeUndefined();
        expect(typeof aliceState.flowId).toBe('string');
        expect(aliceState.userCode).toBe('ALICE-CODE');
        expect(bobState.deviceCode).toBeUndefined();
        expect(typeof bobState.flowId).toBe('string');
        expect(bobState.flowId).not.toBe(aliceState.flowId);
        expect(bobState.userCode).toBe('BOB-CODE');
        expect(aliceSpawn).toHaveBeenCalledTimes(1);
        expect(bobSpawn).toHaveBeenCalledTimes(1);
      } finally {
        aliceSpawn.mockRestore();
        bobSpawn.mockRestore();
        if (originalHelper === undefined) delete process.env.DOLLHOUSE_OAUTH_HELPER;
        else process.env.DOLLHOUSE_OAUTH_HELPER = originalHelper;
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
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

    it('reports terminal helper failure from result file without calling it active or crashed', async () => {
      await withTempHome(async (homeDir) => {
        const stateDir = path.join(homeDir, '.dollhouse', '.auth');
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          path.join(stateDir, 'oauth-helper-state.json'),
          JSON.stringify({
            pid: 7777,
            userCode: 'FAILED-7777',
            startTime: new Date(Date.now() - 10_000).toISOString(),
            expiresAt: new Date(Date.now() + 120_000).toISOString()
          }, null, 2),
          'utf-8'
        );
        await fs.writeFile(
          path.join(stateDir, 'oauth-helper-result.json'),
          JSON.stringify({
            status: 'failed',
            attempts: 2,
            completedAt: new Date().toISOString(),
            errorCode: 'token_storage_failed',
            message: 'OAuth token could not be stored securely.'
          }, null, 2),
          'utf-8'
        );

        authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false, hasToken: false } as any);

        const response = await handler.checkGitHubAuth();
        const text = response.content[0].text;

        expect(text).toContain('GitHub Authentication Failed');
        expect(text).toContain('OAuth token could not be stored securely.');
        expect(text).not.toContain('Authentication In Progress');
        expect(text).not.toContain('may have crashed');

        const diagnostics = await handler.getOAuthHelperStatus();
        const diagnosticsText = diagnostics.content[0].text;

        expect(diagnosticsText).toContain('FAILED');
        expect(diagnosticsText).toContain('Attempts:** 2');
        expect(diagnosticsText).not.toContain('ACTIVE - Authentication in progress');
        expect(diagnosticsText).not.toContain('may have crashed');
      });
    });

    it('ignores a stale helper result from an older OAuth flow while a newer flow is active', async () => {
      await withTempHome(async (homeDir) => {
        const stateDir = path.join(homeDir, '.dollhouse', '.auth');
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          path.join(stateDir, 'oauth-helper-state.json'),
          JSON.stringify({
            pid: 7777,
            flowId: 'new-flow',
            userCode: 'ACTIVE-7777',
            startTime: new Date(Date.now() - 10_000).toISOString(),
            expiresAt: new Date(Date.now() + 120_000).toISOString()
          }, null, 2),
          'utf-8'
        );
        await fs.writeFile(
          path.join(stateDir, 'oauth-helper-result.json'),
          JSON.stringify({
            status: 'failed',
            flowId: 'old-flow',
            pid: 1111,
            attempts: 3,
            completedAt: new Date().toISOString(),
            errorCode: 'expired_token',
            message: 'The previous GitHub authentication request expired.'
          }, null, 2),
          'utf-8'
        );

        const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => undefined as any);
        authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false, hasToken: false } as any);

        const response = await handler.checkGitHubAuth();
        const text = response.content[0].text;

        expect(text).toContain('Authentication In Progress');
        expect(text).toContain('ACTIVE-7777');
        expect(text).not.toContain('GitHub Authentication Failed');
        expect(text).not.toContain('previous GitHub authentication request expired');

        killSpy.mockRestore();
      });
    });

    it('ignores malformed helper result JSON without throwing or leaking raw content', async () => {
      await withTempHome(async (homeDir) => {
        const stateDir = path.join(homeDir, '.dollhouse', '.auth');
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(path.join(stateDir, 'oauth-helper-result.json'), '{not-json', 'utf-8');

        authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false, hasToken: false } as any);

        const response = await handler.checkGitHubAuth();
        const text = response.content[0].text;

        expect(text).toContain('Not Connected to GitHub');
        expect(text).not.toContain('{not-json');
      });
    });

    it('ignores malformed helper state JSON without checking an invalid process id', async () => {
      await withTempHome(async (homeDir) => {
        const stateDir = path.join(homeDir, '.dollhouse', '.auth');
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          path.join(stateDir, 'oauth-helper-state.json'),
          JSON.stringify({
            pid: -1,
            userCode: 'BAD-PID',
            startTime: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 120_000).toISOString()
          }),
          'utf-8'
        );

        const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => undefined as any);
        authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false, hasToken: false } as any);

        const response = await handler.checkGitHubAuth();
        const text = response.content[0].text;

        expect(text).toContain('Not Connected to GitHub');
        expect(text).not.toContain('BAD-PID');
        expect(killSpy).not.toHaveBeenCalled();

        killSpy.mockRestore();
      });
    });

    it('treats EPERM during helper process checks as alive', async () => {
      await withTempHome(async (homeDir) => {
        const stateDir = path.join(homeDir, '.dollhouse', '.auth');
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          path.join(stateDir, 'oauth-helper-state.json'),
          JSON.stringify({
            pid: 9999,
            userCode: 'EPERM-9999',
            startTime: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 120_000).toISOString()
          }, null, 2),
          'utf-8'
        );

        const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
          throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
        });

        authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false } as any);
        const response = await handler.checkGitHubAuth();

        expect(response.content[0].text).toContain('Authentication In Progress');
        expect(response.content[0].text).toContain('Process Status:** ✅ Running');

        killSpy.mockRestore();
      });
    });

    it('sanitizes helper result messages before rendering them', async () => {
      await withTempHome(async (homeDir) => {
        const stateDir = path.join(homeDir, '.dollhouse', '.auth');
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          path.join(stateDir, 'oauth-helper-state.json'),
          JSON.stringify({
            pid: 8888,
            userCode: 'FAILED-8888',
            startTime: new Date(Date.now() - 10_000).toISOString(),
            expiresAt: new Date(Date.now() + 120_000).toISOString()
          }, null, 2),
          'utf-8'
        );
        await fs.writeFile(
          path.join(stateDir, 'oauth-helper-result.json'),
          JSON.stringify({
            status: 'failed',
            attempts: 1,
            completedAt: new Date().toISOString(),
            errorCode: 'fatal_error',
            message: `Bad\u0000message ${'x'.repeat(700)}`
          }, null, 2),
          'utf-8'
        );

        authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false, hasToken: false } as any);

        const response = await handler.checkGitHubAuth();
        const text = response.content[0].text;

        expect(text).toContain('Bad message');
        expect(text).not.toContain('\u0000');
        expect(text).not.toContain('x'.repeat(600));
      });
    });

    it('removes stale plaintext pending-token fallback files before reporting disconnected status', async () => {
      await withTempHome(async (homeDir) => {
        const stateDir = path.join(homeDir, '.dollhouse', '.auth');
        const pendingToken = path.join(stateDir, 'pending_token.txt');
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(pendingToken, 'gho_stale_plaintext_token_from_old_flow', { mode: 0o600 });

        authManager.getAuthStatus.mockResolvedValue({ isAuthenticated: false, hasToken: false } as any);

        const response = await handler.checkGitHubAuth();
        const text = response.content[0].text;

        expect(text).toContain('Not Connected to GitHub');
        expect(text).toContain('stale plaintext OAuth fallback file from an earlier failed flow was removed');
        await expect(fs.access(pendingToken)).rejects.toMatchObject({ code: 'ENOENT' });
      });
    });
  });
});
