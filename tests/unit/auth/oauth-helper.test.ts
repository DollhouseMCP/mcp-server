import { describe, it, expect } from '@jest/globals';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import type { IFileOperationsService } from '../../../src/services/FileOperationsService.js';

const TEST_CLIENT_ID = 'Ov23liABCDEFGHIJKLMNOP';

function realFileOperations(): IFileOperationsService {
  return {
    async createDirectory(directoryPath: string) {
      await fs.mkdir(directoryPath, { recursive: true });
    },
    async readElementFile(filePath: string) {
      return fs.readFile(filePath, 'utf-8');
    },
    async readFile(filePath: string) {
      return fs.readFile(filePath, 'utf-8');
    },
    async writeFile(filePath: string, content: string) {
      await fs.writeFile(filePath, content, 'utf-8');
    },
    async deleteFile(filePath: string) {
      await fs.unlink(filePath);
    },
    async chmod(filePath: string, mode: number) {
      await fs.chmod(filePath, mode);
    },
    async exists(filePath: string) {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    async listDirectory(directoryPath: string) {
      return fs.readdir(directoryPath);
    },
    async listDirectoryWithTypes(directoryPath: string) {
      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      return entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile()
      }));
    },
    async renameFile(oldPath: string, newPath: string) {
      await fs.rename(oldPath, newPath);
    },
    async stat(filePath: string) {
      return fs.stat(filePath);
    },
    resolvePath(relativePath: string, baseDirectory: string) {
      return path.resolve(baseDirectory, relativePath);
    },
    validatePath(filePath: string, baseDirectory: string) {
      const resolvedFile = path.resolve(filePath);
      const resolvedBase = path.resolve(baseDirectory);
      return resolvedFile === resolvedBase || resolvedFile.startsWith(`${resolvedBase}${path.sep}`);
    },
    async createFileExclusive(filePath: string, content: string) {
      try {
        await fs.writeFile(filePath, content, { flag: 'wx' });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return false;
        }
        throw error;
      }
    },
    async copyFile(sourcePath: string, destPath: string) {
      await fs.copyFile(sourcePath, destPath);
    },
    async appendFile(filePath: string, content: string) {
      await fs.appendFile(filePath, content, 'utf-8');
    }
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function json(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function runHelper(helperPath: string, tokenUrl: string, homeDir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawnHelper(helperPath, tokenUrl, homeDir, extraEnv);
  return waitForClose(child);
}

function spawnHelper(helperPath: string, tokenUrl: string, homeDir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn(process.execPath, [
    helperPath,
    'device-code-for-test',
    '1',
    '20',
    TEST_CLIENT_ID
  ], {
    env: {
      ...process.env,
      DOLLHOUSE_HOME_DIR: homeDir,
      DOLLHOUSE_OAUTH_TOKEN_URL: tokenUrl,
      DOLLHOUSE_OAUTH_DEBUG: 'true',
      DOLLHOUSE_TOKEN_SECRET: 'oauth-helper-test-secret',
      GITHUB_TOKEN: '',
      TEST_GITHUB_TOKEN: '',
      GITHUB_TEST_TOKEN: '',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout?.on('data', chunk => stdout.push(String(chunk)));
  child.stderr?.on('data', chunk => stderr.push(String(chunk)));

  return Object.assign(child, {
    readOutput: () => ({
      stdout: stdout.join(''),
      stderr: stderr.join('')
    })
  });
}

function waitForClose(child: ReturnType<typeof spawnHelper>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const output = child.readOutput();
      resolve({
        code,
        signal,
        stdout: output.stdout,
        stderr: output.stderr
      });
    });
  });
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForFileContent(filePath: string, expected: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.includes(expected)) return;
    } catch {
      // The helper may not have created the file yet.
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expected} in ${filePath}`);
}

async function expectInterruptedArtifacts(authDir: string): Promise<Record<string, unknown>> {
  const terminalResult = JSON.parse(
    await fs.readFile(path.join(authDir, 'oauth-helper-result.json'), 'utf-8')
  ) as Record<string, unknown>;
  expect(terminalResult.status).toBe('failed');
  expect(terminalResult.errorCode).toBe('interrupted');
  expect(terminalResult.message).toBe('OAuth helper was interrupted before authentication completed.');

  await expect(fs.access(path.join(authDir, 'oauth-helper-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.access(path.join(authDir, 'oauth-helper.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
  return terminalResult;
}

const TERMINATION_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

describe('oauth-helper.mjs', () => {
  it('uses the TokenManager instance API and does not keep a plaintext pending-token fallback', async () => {
    const helperSource = await fs.readFile(path.join(process.cwd(), 'oauth-helper.mjs'), 'utf-8');
    const distTokenManagerPath = path.join(process.cwd(), 'dist', 'security', 'tokenManager.js');

    await expect(fs.access(distTokenManagerPath)).resolves.toBeUndefined();

    const { TokenManager } = await import(pathToFileURL(distTokenManagerPath).href);

    expect(helperSource).toContain('new TokenManager(');
    expect(helperSource).toContain('tokenManager.storeGitHubToken(');
    expect(helperSource).not.toMatch(/\bTokenManager\.storeGitHubToken\s*\(/);
    expect(helperSource).not.toContain('pending_token.txt');
    expect(helperSource).toContain("from './oauth-state-coordinator.mjs'");
    expect(helperSource).not.toContain("from './dist/utils/OAuthStateCoordinator.js'");
    expect(helperSource).not.toContain('withOAuthStateLock,');
    expect(helperSource).not.toMatch(/\bcleanupStateFile\s*\(/);
    expect(helperSource).toMatch(/main\(\)\.catch[\s\S]*cleanupStateFileSync\(\)/);
    expect(typeof TokenManager.prototype.storeGitHubToken).toBe('function');
  });

  it('starts from a clean source layout without compiled coordinator output', async () => {
    const sourceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-clean-source-'));
    const helperPath = path.join(sourceDirectory, 'oauth-helper.mjs');
    await fs.copyFile(path.join(process.cwd(), 'oauth-helper.mjs'), helperPath);
    await fs.copyFile(
      path.join(process.cwd(), 'oauth-state-coordinator.mjs'),
      path.join(sourceDirectory, 'oauth-state-coordinator.mjs')
    );

    try {
      const child = spawn(process.execPath, [helperPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });

      expect(code).toBe(1);
      expect(stderr).toContain('Usage: oauth-helper.mjs');
      expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    } finally {
      await fs.rm(sourceDirectory, { recursive: true, force: true });
    }
  });

  it('stores a device-flow token where TokenManager can read it and writes a terminal result', async () => {
    const helperPath = path.join(process.cwd(), 'oauth-helper.mjs');
    const distTokenManagerPath = path.join(process.cwd(), 'dist', 'security', 'tokenManager.js');
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-e2e-'));
    const originalHomeDir = process.env.DOLLHOUSE_HOME_DIR;
    const originalTokenSecret = process.env.DOLLHOUSE_TOKEN_SECRET;
    const originalGithubToken = process.env.GITHUB_TOKEN;
    const originalTestGithubToken = process.env.TEST_GITHUB_TOKEN;
    const originalGithubTestToken = process.env.GITHUB_TEST_TOKEN;
    const expectedToken = 'gho_test_device_flow_token_1234567890';
    let polls = 0;

    await expect(fs.access(distTokenManagerPath)).resolves.toBeUndefined();

    const server = createServer(async (req, res) => {
      try {
        const body = JSON.parse(await readRequestBody(req)) as Record<string, unknown>;
        polls += 1;

        expect(req.method).toBe('POST');
        expect(body.client_id).toBe(TEST_CLIENT_ID);
        expect(body.device_code).toBe('device-code-for-test');
        expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code');

        json(res, 200, {
          access_token: expectedToken,
          token_type: 'bearer',
          scope: 'read:user'
        });
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : 'stub failure' });
      }
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('OAuth helper test server did not bind to a TCP port');
    }

    const authDir = path.join(tempHome, '.dollhouse', '.auth');
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(path.join(authDir, 'oauth-helper-state.json'), JSON.stringify({ stale: true }), 'utf-8');

    try {
      process.env.DOLLHOUSE_HOME_DIR = tempHome;
      process.env.DOLLHOUSE_TOKEN_SECRET = 'oauth-helper-test-secret';
      delete process.env.GITHUB_TOKEN;
      delete process.env.TEST_GITHUB_TOKEN;
      delete process.env.GITHUB_TEST_TOKEN;

      const result = await runHelper(helperPath, `http://127.0.0.1:${address.port}/token`, tempHome);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('GitHub authentication successful');
      expect(result.stderr).toBe('');
      expect(polls).toBe(1);

      const { TokenManager } = await import('../../../src/security/tokenManager.js');
      const tokenManager = new TokenManager(realFileOperations());
      await expect(tokenManager.retrieveGitHubToken()).resolves.toBe(expectedToken);

      const terminalResult = JSON.parse(
        await fs.readFile(path.join(authDir, 'oauth-helper-result.json'), 'utf-8')
      ) as Record<string, unknown>;
      expect(terminalResult.status).toBe('success');
      expect(terminalResult.attempts).toBe(1);
      expect(terminalResult.errorCode).toBeUndefined();

      await expect(fs.access(path.join(authDir, 'github_token.enc'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(authDir, 'pending_token.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(path.join(authDir, 'oauth-helper-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(path.join(authDir, 'oauth-helper.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });

      if (originalHomeDir === undefined) delete process.env.DOLLHOUSE_HOME_DIR;
      else process.env.DOLLHOUSE_HOME_DIR = originalHomeDir;
      if (originalTokenSecret === undefined) delete process.env.DOLLHOUSE_TOKEN_SECRET;
      else process.env.DOLLHOUSE_TOKEN_SECRET = originalTokenSecret;
      if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalGithubToken;
      if (originalTestGithubToken === undefined) delete process.env.TEST_GITHUB_TOKEN;
      else process.env.TEST_GITHUB_TOKEN = originalTestGithubToken;
      if (originalGithubTestToken === undefined) delete process.env.GITHUB_TEST_TOKEN;
      else process.env.GITHUB_TEST_TOKEN = originalGithubTestToken;
    }
  }, 15_000);

  it('persists GitHub slow_down backoff across polling attempts', async () => {
    const helperPath = path.join(process.cwd(), 'oauth-helper.mjs');
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-slow-down-'));
    const expectedToken = 'gho_test_slow_down_token_1234567890';
    let polls = 0;

    const server = createServer(async (_req, res) => {
      polls += 1;
      if (polls === 1) {
        json(res, 200, { error: 'slow_down' });
        return;
      }
      json(res, 200, {
        access_token: expectedToken,
        token_type: 'bearer',
        scope: 'read:user'
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('OAuth helper test server did not bind to a TCP port');
    }

    try {
      const result = await runHelper(helperPath, `http://127.0.0.1:${address.port}/token`, tempHome);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('GitHub authentication successful');
      expect(result.stderr).toBe('');
      expect(polls).toBe(2);

      const logPath = path.join(tempHome, '.dollhouse', 'oauth-helper.log');
      await expect(fs.readFile(logPath, 'utf-8')).resolves.toContain('increasing interval to 6s');
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }, 15_000);

  it.each(TERMINATION_SIGNALS)('handles %s before publishing readiness', async (signal) => {
    if (process.platform === 'win32') {
      return;
    }

    const helperPath = path.join(process.cwd(), 'oauth-helper.mjs');
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-early-interrupt-'));
    const authDir = path.join(tempHome, '.dollhouse', '.auth');
    const logFile = path.join(tempHome, '.dollhouse', 'oauth-helper.log');
    const flowId = 'prepared-early-flow';
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(
      path.join(authDir, 'oauth-helper-state.json'),
      JSON.stringify({
        flowId,
        userCode: 'EARLY-CODE',
        startTime: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString()
      }),
      'utf-8'
    );

    try {
      const child = spawnHelper(
        helperPath,
        'http://127.0.0.1:1/token',
        tempHome,
        {
          NODE_ENV: 'test',
          DOLLHOUSE_OAUTH_HELPER_FLOW_ID: flowId,
          DOLLHOUSE_OAUTH_HELPER_TEST_PRE_READY_DELAY_MS: '2000'
        }
      );
      await waitForFileContent(logFile, '[START] OAuth helper started');
      const claimedState = JSON.parse(
        await fs.readFile(path.join(authDir, 'oauth-helper-state.json'), 'utf-8')
      ) as Record<string, unknown>;
      expect(claimedState.flowId).toBe(flowId);
      expect(claimedState.pid).toBe(child.pid);
      await expect(fs.access(path.join(authDir, 'oauth-helper.pid'))).rejects.toMatchObject({ code: 'ENOENT' });

      expect(child.kill(signal)).toBe(true);
      const result = await waitForClose(child);

      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      const terminalResult = await expectInterruptedArtifacts(authDir);
      expect(terminalResult.flowId).toBe(flowId);
      expect(terminalResult.pid).toBe(child.pid);
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }, 15_000);

  it('preserves selected success and exit code when its result write fails', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const helperPath = path.join(process.cwd(), 'oauth-helper.mjs');
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-result-write-failure-'));
    const authDir = path.join(tempHome, '.dollhouse', '.auth');
    const resultFile = path.join(authDir, 'oauth-helper-result.json');
    const logFile = path.join(tempHome, '.dollhouse', 'oauth-helper.log');
    const server = createServer((_req, res) => {
      json(res, 200, {
        access_token: 'gho_test_result_write_failure_1234567890',
        token_type: 'bearer',
        scope: 'read:user'
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('OAuth helper test server did not bind to a TCP port');
    }

    await fs.mkdir(resultFile, { recursive: true });
    await fs.writeFile(path.join(authDir, 'oauth-helper-state.json'), JSON.stringify({ stale: true }), 'utf-8');

    try {
      const child = spawnHelper(
        helperPath,
        `http://127.0.0.1:${address.port}/token`,
        tempHome,
        {
          NODE_ENV: 'test',
          DOLLHOUSE_OAUTH_HELPER_TEST_POST_RESULT_DELAY_MS: '2000'
        }
      );
      await waitForFileContent(logFile, 'Failed to write terminal result');

      expect(child.kill('SIGTERM')).toBe(true);
      const result = await waitForClose(child);

      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      const resultPathStat = await fs.stat(resultFile);
      expect(resultPathStat.isDirectory()).toBe(true);
      await expect(fs.access(path.join(authDir, 'oauth-helper-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(path.join(authDir, 'oauth-helper.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }, 15_000);

  it.each(TERMINATION_SIGNALS)('writes a terminal result when interrupted by %s during polling', async (signal) => {
    if (process.platform === 'win32') {
      return;
    }

    const helperPath = path.join(process.cwd(), 'oauth-helper.mjs');
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-interrupt-'));

    const server = createServer((_req, res) => {
      json(res, 200, { error: 'authorization_pending' });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('OAuth helper test server did not bind to a TCP port');
    }

    const authDir = path.join(tempHome, '.dollhouse', '.auth');
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(path.join(authDir, 'oauth-helper-state.json'), JSON.stringify({ stale: true }), 'utf-8');

    try {
      const child = spawnHelper(helperPath, `http://127.0.0.1:${address.port}/token`, tempHome);
      await waitForFile(path.join(authDir, 'oauth-helper.pid'));

      expect(child.kill(signal)).toBe(true);
      const result = await waitForClose(child);

      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      await expectInterruptedArtifacts(authDir);
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }, 15_000);

  it.each(TERMINATION_SIGNALS)('preserves committed success when %s arrives late', async (signal) => {
    if (process.platform === 'win32') {
      return;
    }

    const helperPath = path.join(process.cwd(), 'oauth-helper.mjs');
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-late-signal-'));
    const expectedToken = 'gho_test_late_signal_token_1234567890';
    const server = createServer((_req, res) => {
      json(res, 200, {
        access_token: expectedToken,
        token_type: 'bearer',
        scope: 'read:user'
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('OAuth helper test server did not bind to a TCP port');
    }

    const authDir = path.join(tempHome, '.dollhouse', '.auth');
    const resultFile = path.join(authDir, 'oauth-helper-result.json');
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(path.join(authDir, 'oauth-helper-state.json'), JSON.stringify({ stale: true }), 'utf-8');

    try {
      const child = spawnHelper(
        helperPath,
        `http://127.0.0.1:${address.port}/token`,
        tempHome,
        {
          NODE_ENV: 'test',
          DOLLHOUSE_OAUTH_HELPER_TEST_POST_RESULT_DELAY_MS: '2000'
        }
      );
      await waitForFile(resultFile);
      const committedResult = await fs.readFile(resultFile, 'utf-8');
      expect(JSON.parse(committedResult)).toMatchObject({ status: 'success', attempts: 1 });

      expect(child.kill(signal)).toBe(true);
      const result = await waitForClose(child);

      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      await expect(fs.readFile(resultFile, 'utf-8')).resolves.toBe(committedResult);
      await expect(fs.access(path.join(authDir, 'oauth-helper-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(path.join(authDir, 'oauth-helper.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }, 15_000);

  it('does not remove state or pid files owned by a newer helper flow', async () => {
    const helperPath = path.join(process.cwd(), 'oauth-helper.mjs');
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-flow-race-'));
    let releaseOldFlow = false;

    const server = createServer((_req, res) => {
      json(res, 200, releaseOldFlow ? { error: 'expired_token' } : { error: 'authorization_pending' });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('OAuth helper test server did not bind to a TCP port');
    }

    const authDir = path.join(tempHome, '.dollhouse', '.auth');
    const pidFile = path.join(authDir, 'oauth-helper.pid');
    const stateFile = path.join(authDir, 'oauth-helper-state.json');
    const resultFile = path.join(authDir, 'oauth-helper-result.json');

    try {
      const child = spawnHelper(
        helperPath,
        `http://127.0.0.1:${address.port}/token`,
        tempHome,
        { DOLLHOUSE_OAUTH_HELPER_FLOW_ID: 'old-flow' }
      );
      await waitForFile(pidFile);

      await fs.writeFile(pidFile, '999999', 'utf-8');
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          pid: 999999,
          flowId: 'new-flow',
          userCode: 'NEW-FLOW',
          startTime: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120_000).toISOString()
        }, null, 2),
        'utf-8'
      );

      releaseOldFlow = true;
      const result = await waitForClose(child);

      expect(result.code).toBe(1);
      await expect(fs.readFile(pidFile, 'utf-8')).resolves.toBe('999999');
      const state = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
      expect(state.flowId).toBe('new-flow');
      expect(state.pid).toBe(999999);

      const terminalResult = JSON.parse(await fs.readFile(resultFile, 'utf-8')) as Record<string, unknown>;
      expect(terminalResult.status).toBe('expired');
      expect(terminalResult.flowId).toBe('old-flow');
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }, 15_000);
});
