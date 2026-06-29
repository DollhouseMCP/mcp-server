import { describe, it, expect } from '@jest/globals';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import type { IFileOperationsService } from '../../../src/services/FileOperationsService.js';

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

function runHelper(helperPath: string, tokenUrl: string, homeDir: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn(process.execPath, [
    helperPath,
    'device-code-for-test',
    '1',
    '20',
    'Ov23liTestClientId'
  ], {
    env: {
      ...process.env,
      DOLLHOUSE_HOME_DIR: homeDir,
      DOLLHOUSE_OAUTH_TOKEN_URL: tokenUrl,
      DOLLHOUSE_OAUTH_DEBUG: 'true',
      DOLLHOUSE_TOKEN_SECRET: 'oauth-helper-test-secret',
      GITHUB_TOKEN: '',
      TEST_GITHUB_TOKEN: '',
      GITHUB_TEST_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout?.on('data', chunk => stdout.push(String(chunk)));
  child.stderr?.on('data', chunk => stderr.push(String(chunk)));

  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      resolve({
        code,
        stdout: stdout.join(''),
        stderr: stderr.join('')
      });
    });
  });
}

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
    expect(typeof TokenManager.prototype.storeGitHubToken).toBe('function');
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
        expect(body.client_id).toBe('Ov23liTestClientId');
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
});
