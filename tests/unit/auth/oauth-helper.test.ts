import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

describe('oauth-helper token handoff', () => {
  async function withTempHome(fn: (homeDir: string) => Promise<void>) {
    const tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-'));
    try {
      await fn(tempHome);
    } finally {
      await fsp.rm(tempHome, { recursive: true, force: true });
    }
  }

  it('stores device-flow tokens where GitHubAuthManager can read them', async () => {
    await withTempHome(async (homeDir) => {
      const mockFetchPath = path.join(homeDir, 'mock-fetch.mjs');
      await fsp.writeFile(
        mockFetchPath,
        [
          'globalThis.fetch = async () => ({',
          '  async json() {',
          "    return { access_token: 'gho_fake_token_for_repro_1234567890' };",
          '  }',
          '});',
          ''
        ].join('\n'),
        'utf8'
      );

      const authDir = path.join(homeDir, '.dollhouse', '.auth');
      await fsp.mkdir(authDir, { recursive: true });
      const statePath = path.join(authDir, 'oauth-helper-state.json');
      await fsp.writeFile(
        statePath,
        JSON.stringify({
          pid: 12345,
          deviceCode: 'device-code',
          userCode: 'TEST-CODE',
          startTime: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }),
        'utf8'
      );

      const result = spawnSync(
        process.execPath,
        [
          '--import',
          mockFetchPath,
          path.join(process.cwd(), 'oauth-helper.mjs'),
          'device-code',
          '1',
          '3',
          'Ov23liClient'
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: homeDir,
            USERPROFILE: homeDir,
            DOLLHOUSE_HOME_DIR: homeDir,
            DOLLHOUSE_TOKEN_SECRET: 'test-secret-only'
          },
          encoding: 'utf8',
          timeout: 10_000
        }
      );

      const pendingTokenPath = path.join(authDir, 'pending_token.txt');
      const encryptedTokenPath = path.join(authDir, 'github_token.enc');
      const resultPath = path.join(authDir, 'oauth-helper-result.json');

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('GitHub authentication successful');
      expect(fs.existsSync(encryptedTokenPath)).toBe(true);
      expect(fs.existsSync(pendingTokenPath)).toBe(false);
      expect(fs.existsSync(statePath)).toBe(false);
      expect(fs.existsSync(resultPath)).toBe(true);

      const terminalResult = JSON.parse(await fsp.readFile(resultPath, 'utf8'));
      expect(terminalResult.status).toBe('success');
      expect(terminalResult.attempts).toBe(1);
      expect(terminalResult.completedAt).toBeTruthy();
      expect(JSON.stringify(terminalResult)).not.toContain('gho_fake_token_for_repro_1234567890');

      const readTokenPath = path.join(homeDir, 'read-token.mjs');
      const tokenManagerUrl = pathToFileURL(
        path.join(process.cwd(), 'dist/security/tokenManager.js')
      ).href;
      await fsp.writeFile(
        readTokenPath,
        [
          "import fs from 'node:fs/promises';",
          `const { TokenManager } = await import(${JSON.stringify(tokenManagerUrl)});`,
          '',
          'const tokenManager = new TokenManager({',
          '  async createDirectory(directoryPath) {',
          '    await fs.mkdir(directoryPath, { recursive: true });',
          '  },',
          '  async readFile(filePath) {',
          "    return fs.readFile(filePath, 'utf8');",
          '  },',
          '  async writeFile(filePath, content) {',
          "    await fs.writeFile(filePath, content, { encoding: 'utf8' });",
          '  },',
          '  async chmod(filePath, mode) {',
          '    await fs.chmod(filePath, mode);',
          '  },',
          '  async exists(filePath) {',
          '    try {',
          '      await fs.access(filePath);',
          '      return true;',
          '    } catch {',
          '      return false;',
          '    }',
          '  }',
          '});',
          '',
          'const token = await tokenManager.retrieveGitHubToken();',
          'process.stdout.write(token ?? "");',
          ''
        ].join('\n'),
        'utf8'
      );

      const readResult = spawnSync(process.execPath, [readTokenPath], {
        cwd: homeDir,
        env: {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
          DOLLHOUSE_HOME_DIR: homeDir,
          DOLLHOUSE_TOKEN_SECRET: 'test-secret-only'
        },
        encoding: 'utf8',
        timeout: 10_000
      });

      expect(readResult.status).toBe(0);
      expect(readResult.stderr).toBe('');
      expect(readResult.stdout).toBe('gho_fake_token_for_repro_1234567890');
    });
  });

  it('records access denial as a terminal result without token data', async () => {
    await withTempHome(async (homeDir) => {
      const mockFetchPath = path.join(homeDir, 'mock-fetch.mjs');
      await fsp.writeFile(
        mockFetchPath,
        [
          'globalThis.fetch = async () => ({',
          '  async json() {',
          "    return { error: 'access_denied' };",
          '  }',
          '});',
          ''
        ].join('\n'),
        'utf8'
      );

      const result = spawnSync(
        process.execPath,
        [
          '--import',
          mockFetchPath,
          path.join(process.cwd(), 'oauth-helper.mjs'),
          'device-code',
          '1',
          '3',
          'Ov23liClient'
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: homeDir,
            USERPROFILE: homeDir,
            DOLLHOUSE_HOME_DIR: homeDir,
            DOLLHOUSE_TOKEN_SECRET: 'test-secret-only'
          },
          encoding: 'utf8',
          timeout: 10_000
        }
      );

      const resultPath = path.join(homeDir, '.dollhouse', '.auth', 'oauth-helper-result.json');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('OAUTH_ACCESS_DENIED');
      expect(fs.existsSync(resultPath)).toBe(true);

      const terminalResult = JSON.parse(await fsp.readFile(resultPath, 'utf8'));
      expect(terminalResult.status).toBe('denied');
      expect(terminalResult.error).toContain('User denied authorization');
      expect(JSON.stringify(terminalResult)).not.toContain('access_token');
      expect(JSON.stringify(terminalResult)).not.toContain('device-code');
    });
  });

  it('writes helper state and result files under DOLLHOUSE_HOME_DIR when configured', async () => {
    await withTempHome(async (homeDir) => {
      const dollhouseHome = path.join(homeDir, 'custom-dollhouse-home');
      const mockFetchPath = path.join(homeDir, 'mock-fetch.mjs');
      await fsp.writeFile(
        mockFetchPath,
        [
          'globalThis.fetch = async () => ({',
          '  async json() {',
          "    return { error: 'access_denied' };",
          '  }',
          '});',
          ''
        ].join('\n'),
        'utf8'
      );

      const authDir = path.join(dollhouseHome, '.dollhouse', '.auth');
      await fsp.mkdir(authDir, { recursive: true });
      const statePath = path.join(authDir, 'oauth-helper-state.json');
      await fsp.writeFile(
        statePath,
        JSON.stringify({
          pid: 12345,
          deviceCode: 'device-code',
          userCode: 'TEST-CODE',
          startTime: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }),
        'utf8'
      );

      const result = spawnSync(
        process.execPath,
        [
          '--import',
          mockFetchPath,
          path.join(process.cwd(), 'oauth-helper.mjs'),
          'device-code',
          '1',
          '3',
          'Ov23liClient'
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: homeDir,
            USERPROFILE: homeDir,
            DOLLHOUSE_HOME_DIR: dollhouseHome,
            DOLLHOUSE_TOKEN_SECRET: 'test-secret-only'
          },
          encoding: 'utf8',
          timeout: 10_000
        }
      );

      const resultPath = path.join(authDir, 'oauth-helper-result.json');
      const defaultHomeResultPath = path.join(homeDir, '.dollhouse', '.auth', 'oauth-helper-result.json');

      expect(result.status).toBe(1);
      expect(fs.existsSync(statePath)).toBe(false);
      expect(fs.existsSync(resultPath)).toBe(true);
      expect(fs.existsSync(defaultHomeResultPath)).toBe(false);
    });
  });
});
