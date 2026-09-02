import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  writeHandoffToken,
  readHandoffToken,
  handoffTokenPath,
  sweepHandoffArtifacts,
  LEGACY_PLAINTEXT_TOKEN_FILE,
} from '../../../src/security/oauthHelperTokenHandoff.js';

const TEST_CLIENT_ID = 'Ov23liABCDEFGHIJKLMNOP';
// A fixed UUID flow id used where the server would normally generate one.
const TEST_FLOW_ID = '11111111-1111-4111-8111-111111111111';
const HELPER_FILENAME = 'oauth-helper.mjs';
const HELPER_STATE_FILE = 'oauth-helper-state.json';
const HELPER_RESULT_FILE = 'oauth-helper-result.json';
const HELPER_PID_FILE = 'oauth-helper.pid';
const DOLLHOUSE_DIR = '.dollhouse';
const SERVER_BIND_ERROR = 'OAuth helper test server did not bind to a TCP port';

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
      // device_code now travels via env (out of argv); the stub endpoint asserts it below.
      DOLLHOUSE_OAUTH_HELPER_DEVICE_CODE: 'device-code-for-test',
      GITHUB_TOKEN: '',
      TEST_GITHUB_TOKEN: '',
      GITHUB_TEST_TOKEN: '',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', chunk => stdout.push(String(chunk)));
  child.stderr.on('data', chunk => stderr.push(String(chunk)));

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
    await fs.readFile(path.join(authDir, HELPER_RESULT_FILE), 'utf-8')
  ) as Record<string, unknown>;
  expect(terminalResult.status).toBe('failed');
  expect(terminalResult.errorCode).toBe('interrupted');
  expect(terminalResult.message).toBe('OAuth helper was interrupted before authentication completed.');

  await expect(fs.access(path.join(authDir, HELPER_STATE_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.access(path.join(authDir, HELPER_PID_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  return terminalResult;
}

const TERMINATION_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const itPosix = process.platform === 'win32' ? it.skip : it;

describe(HELPER_FILENAME, () => {
  it('coordinates terminal state and uses only the encrypted token handoff', async () => {
    const helperSource = await fs.readFile(path.join(process.cwd(), HELPER_FILENAME), 'utf-8');

    // The detached helper must hand the token off encrypted, not write the
    // canonical token store or a plaintext fallback (#2334).
    expect(helperSource).toContain('writeHandoffToken(');
    expect(helperSource).not.toContain('pending_token.txt');
    expect(helperSource).toContain("from './oauth-state-coordinator.mjs'");
    expect(helperSource).not.toContain("from './dist/utils/OAuthStateCoordinator.js'");
    expect(helperSource).not.toContain('withOAuthStateLock,');
    expect(helperSource).not.toMatch(/\bcleanupStateFile\s*\(/);
    const mainAwaitIndex = helperSource.indexOf('await main();');
    const fatalCatchIndex = helperSource.indexOf('} catch (error) {', mainAwaitIndex);
    const fatalCleanupIndex = helperSource.indexOf('cleanupStateFileSync();', fatalCatchIndex);
    expect(mainAwaitIndex).toBeGreaterThan(-1);
    expect(fatalCatchIndex).toBeGreaterThan(mainAwaitIndex);
    expect(fatalCleanupIndex).toBeGreaterThan(fatalCatchIndex);
    expect(helperSource).not.toMatch(/\bnew TokenManager\s*\(/);
    expect(helperSource).not.toMatch(/\bTokenManager\.storeGitHubToken\s*\(/);
  });

  it('starts from a clean source layout without compiled coordinator output', async () => {
    const sourceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-clean-source-'));
    const helperPath = path.join(sourceDirectory, HELPER_FILENAME);
    await fs.copyFile(path.join(process.cwd(), HELPER_FILENAME), helperPath);
    await fs.copyFile(
      path.join(process.cwd(), 'oauth-state-coordinator.mjs'),
      path.join(sourceDirectory, 'oauth-state-coordinator.mjs')
    );

    try {
      const child = spawn(process.execPath, [helperPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += String(chunk); });
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

  it('exits without polling when it cannot claim its prepared flow', async () => {
    const helperPath = path.join(process.cwd(), HELPER_FILENAME);
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-claim-failure-'));
    const authDir = path.join(tempHome, DOLLHOUSE_DIR, '.auth');
    const stateFile = path.join(authDir, HELPER_STATE_FILE);
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({ flowId: 'replacement-flow' }), 'utf8');

    try {
      const child = spawnHelper(
        helperPath,
        'http://127.0.0.1:1/token',
        tempHome,
        { DOLLHOUSE_OAUTH_HELPER_FLOW_ID: 'superseded-flow' }
      );
      const result = await waitForClose(child);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Unable to claim prepared OAuth flow state');
      await expect(fs.readFile(stateFile, 'utf8')).resolves.toContain('replacement-flow');
      await expect(fs.access(path.join(authDir, HELPER_PID_FILE)))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(path.join(authDir, HELPER_RESULT_FILE)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('hands a device-flow token to the server via the encrypted handoff and writes a terminal result', async () => {
    const helperPath = path.join(process.cwd(), HELPER_FILENAME);
    const distHandoffPath = path.join(process.cwd(), 'dist', 'security', 'oauthHelperTokenHandoff.js');
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-e2e-'));
    const originalTokenSecret = process.env.DOLLHOUSE_TOKEN_SECRET;
    const expectedToken = 'gho_test_device_flow_token_1234567890';
    let polls = 0;

    // The helper imports the compiled handoff module from dist/.
    await expect(fs.access(distHandoffPath)).resolves.toBeUndefined();

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
      throw new Error(SERVER_BIND_ERROR);
    }

    const authDir = path.join(tempHome, DOLLHOUSE_DIR, '.auth');
    await fs.mkdir(authDir, { recursive: true });
    // The server writes the state (with the flow id) before spawning; simulate that.
    await fs.writeFile(
      path.join(authDir, HELPER_STATE_FILE),
      JSON.stringify({ flowId: TEST_FLOW_ID, userCode: 'ABCD-1234' }),
      'utf-8'
    );

    try {
      // readHandoffToken (below) derives its key from DOLLHOUSE_TOKEN_SECRET, so
      // the test process must share the secret the helper was spawned with.
      process.env.DOLLHOUSE_TOKEN_SECRET = 'oauth-helper-test-secret';

      const result = await runHelper(
        helperPath,
        `http://127.0.0.1:${address.port}/token`,
        tempHome,
        { DOLLHOUSE_OAUTH_HELPER_FLOW_ID: TEST_FLOW_ID }
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('GitHub authentication successful');
      expect(result.stderr).toBe('');
      expect(polls).toBe(1);

      // The token is retrievable from the encrypted, flow-bound handoff — this is
      // what the server imports and stores through the session ITokenStore.
      await expect(readHandoffToken(authDir, TEST_FLOW_ID)).resolves.toBe(expectedToken);

      const terminalResult = JSON.parse(
        await fs.readFile(path.join(authDir, HELPER_RESULT_FILE), 'utf-8')
      ) as Record<string, unknown>;
      expect(terminalResult.status).toBe('success');
      expect(terminalResult.attempts).toBe(1);
      expect(terminalResult.flowId).toBe(TEST_FLOW_ID);
      expect(terminalResult.errorCode).toBeUndefined();

      // The helper must NOT write the canonical token store or a plaintext file —
      // only the server, on import, writes github_token.enc (file mode).
      await expect(fs.access(path.join(authDir, 'github_token.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(path.join(authDir, LEGACY_PLAINTEXT_TOKEN_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
      // Successful state remains until the server correlates and imports the
      // encrypted handoff; the PID belongs only to the helper process.
      await expect(fs.readFile(path.join(authDir, HELPER_STATE_FILE), 'utf8'))
        .resolves.toContain(TEST_FLOW_ID);
      await expect(fs.access(path.join(authDir, HELPER_PID_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
      if (originalTokenSecret === undefined) delete process.env.DOLLHOUSE_TOKEN_SECRET;
      else process.env.DOLLHOUSE_TOKEN_SECRET = originalTokenSecret;
    }
  }, 15_000);

  it('persists GitHub slow_down backoff across polling attempts', async () => {
    const helperPath = path.join(process.cwd(), HELPER_FILENAME);
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-slow-down-'));
    const expectedToken = 'gho_test_slow_down_token_1234567890';
    let polls = 0;

    const server = createServer((_req, res) => {
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
      throw new Error(SERVER_BIND_ERROR);
    }

    const authDir = path.join(tempHome, DOLLHOUSE_DIR, '.auth');
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(
      path.join(authDir, HELPER_STATE_FILE),
      JSON.stringify({ flowId: TEST_FLOW_ID, userCode: 'SLOW-DOWN' }),
      'utf-8'
    );

    const originalTokenSecret = process.env.DOLLHOUSE_TOKEN_SECRET;
    try {
      // A successful flow writes the encrypted handoff, which requires a flow id.
      process.env.DOLLHOUSE_TOKEN_SECRET = 'oauth-helper-test-secret';
      const result = await runHelper(
        helperPath,
        `http://127.0.0.1:${address.port}/token`,
        tempHome,
        { DOLLHOUSE_OAUTH_HELPER_FLOW_ID: TEST_FLOW_ID }
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('GitHub authentication successful');
      expect(result.stderr).toBe('');
      expect(polls).toBe(2);

      const logPath = path.join(tempHome, DOLLHOUSE_DIR, 'oauth-helper.log');
      await expect(fs.readFile(logPath, 'utf-8')).resolves.toContain('increasing interval to 6s');
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
      if (originalTokenSecret === undefined) delete process.env.DOLLHOUSE_TOKEN_SECRET;
      else process.env.DOLLHOUSE_TOKEN_SECRET = originalTokenSecret;
    }
  }, 15_000);

  itPosix.each(TERMINATION_SIGNALS)('handles %s before publishing readiness', async (signal) => {
    const helperPath = path.join(process.cwd(), HELPER_FILENAME);
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-early-interrupt-'));
    const authDir = path.join(tempHome, DOLLHOUSE_DIR, '.auth');
    const logFile = path.join(tempHome, DOLLHOUSE_DIR, 'oauth-helper.log');
    const flowId = 'prepared-early-flow';
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(
      path.join(authDir, HELPER_STATE_FILE),
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
        await fs.readFile(path.join(authDir, HELPER_STATE_FILE), 'utf-8')
      ) as Record<string, unknown>;
      expect(claimedState.flowId).toBe(flowId);
      expect(claimedState.pid).toBe(child.pid);
      await expect(fs.access(path.join(authDir, HELPER_PID_FILE))).rejects.toMatchObject({ code: 'ENOENT' });

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
    const helperPath = path.join(process.cwd(), HELPER_FILENAME);
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-result-write-failure-'));
    const authDir = path.join(tempHome, DOLLHOUSE_DIR, '.auth');
    const resultFile = path.join(authDir, HELPER_RESULT_FILE);
    const logFile = path.join(tempHome, DOLLHOUSE_DIR, 'oauth-helper.log');
    const flowId = TEST_FLOW_ID;
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
      throw new Error(SERVER_BIND_ERROR);
    }

    await fs.mkdir(resultFile, { recursive: true });
    await fs.writeFile(
      path.join(authDir, HELPER_STATE_FILE),
      JSON.stringify({ flowId, userCode: 'RESULT-WRITE-FAILURE' }),
      'utf-8'
    );

    try {
      const result = await runHelper(
        helperPath,
        `http://127.0.0.1:${address.port}/token`,
        tempHome,
        {
          NODE_ENV: 'test',
          DOLLHOUSE_OAUTH_HELPER_FLOW_ID: flowId,
        }
      );

      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      await expect(fs.readFile(logFile, 'utf-8')).resolves.toContain('Failed to write terminal result');
      const resultPathStat = await fs.stat(resultFile);
      expect(resultPathStat.isDirectory()).toBe(true);
      await expect(fs.readFile(path.join(authDir, HELPER_STATE_FILE), 'utf-8')).resolves.toContain(flowId);
      await expect(fs.access(handoffTokenPath(authDir, flowId))).resolves.toBeUndefined();
      await expect(fs.access(path.join(authDir, HELPER_PID_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }, 15_000);

  itPosix.each(TERMINATION_SIGNALS)('writes a terminal result when interrupted by %s during polling', async (signal) => {
    const helperPath = path.join(process.cwd(), HELPER_FILENAME);
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-interrupt-'));

    const server = createServer((_req, res) => {
      json(res, 200, { error: 'authorization_pending' });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error(SERVER_BIND_ERROR);
    }

    const authDir = path.join(tempHome, DOLLHOUSE_DIR, '.auth');
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(path.join(authDir, HELPER_STATE_FILE), JSON.stringify({ stale: true }), 'utf-8');

    try {
      const child = spawnHelper(helperPath, `http://127.0.0.1:${address.port}/token`, tempHome);
      await waitForFile(path.join(authDir, HELPER_PID_FILE));

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

  itPosix.each(TERMINATION_SIGNALS)('preserves committed success when %s arrives late', async (signal) => {
    const helperPath = path.join(process.cwd(), HELPER_FILENAME);
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
      throw new Error(SERVER_BIND_ERROR);
    }

    const authDir = path.join(tempHome, DOLLHOUSE_DIR, '.auth');
    const resultFile = path.join(authDir, HELPER_RESULT_FILE);
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(
      path.join(authDir, HELPER_STATE_FILE),
      JSON.stringify({ flowId: TEST_FLOW_ID, userCode: 'LATE-SIGNAL' }),
      'utf-8'
    );

    try {
      const child = spawnHelper(
        helperPath,
        `http://127.0.0.1:${address.port}/token`,
        tempHome,
        {
          NODE_ENV: 'test',
          DOLLHOUSE_OAUTH_HELPER_FLOW_ID: TEST_FLOW_ID,
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
      await expect(fs.readFile(path.join(authDir, HELPER_STATE_FILE), 'utf-8'))
        .resolves.toContain(TEST_FLOW_ID);
      await expect(fs.access(handoffTokenPath(authDir, TEST_FLOW_ID))).resolves.toBeUndefined();
      await expect(fs.access(path.join(authDir, HELPER_PID_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }, 15_000);

  itPosix('preserves completed handoff state when interrupted after the encrypted write', async () => {
    const helperPath = path.join(process.cwd(), HELPER_FILENAME);
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-post-handoff-signal-'));
    const expectedToken = 'gho_test_post_handoff_signal_1234567890';
    const server = createServer((_req, res) => {
      json(res, 200, { access_token: expectedToken, token_type: 'bearer', scope: 'read:user' });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error(SERVER_BIND_ERROR);
    }

    const authDir = path.join(tempHome, DOLLHOUSE_DIR, '.auth');
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(
      path.join(authDir, HELPER_STATE_FILE),
      JSON.stringify({ flowId: TEST_FLOW_ID, userCode: 'ABCD-1234' }),
      'utf-8',
    );
    const originalTokenSecret = process.env.DOLLHOUSE_TOKEN_SECRET;
    try {
      process.env.DOLLHOUSE_TOKEN_SECRET = 'oauth-helper-test-secret';
      const child = spawnHelper(helperPath, `http://127.0.0.1:${address.port}/token`, tempHome, {
        NODE_ENV: 'test',
        DOLLHOUSE_OAUTH_HELPER_FLOW_ID: TEST_FLOW_ID,
        DOLLHOUSE_OAUTH_HELPER_TEST_POST_HANDOFF_DELAY_MS: '5000',
      });
      const handoffPath = handoffTokenPath(authDir, TEST_FLOW_ID);
      await waitForFile(handoffPath);
      child.kill('SIGTERM');
      const result = await waitForClose(child);

      expect(result.code).toBe(0);
      const terminalResult = JSON.parse(
        await fs.readFile(path.join(authDir, HELPER_RESULT_FILE), 'utf-8'),
      ) as Record<string, unknown>;
      expect(terminalResult).toMatchObject({ status: 'success', flowId: TEST_FLOW_ID });
      await expect(readHandoffToken(authDir, TEST_FLOW_ID)).resolves.toBe(expectedToken);
      await expect(fs.readFile(path.join(authDir, HELPER_STATE_FILE), 'utf8'))
        .resolves.toContain(TEST_FLOW_ID);
      await expect(fs.access(path.join(authDir, HELPER_PID_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
      if (originalTokenSecret === undefined) delete process.env.DOLLHOUSE_TOKEN_SECRET;
      else process.env.DOLLHOUSE_TOKEN_SECRET = originalTokenSecret;
    }
  }, 15_000);

  it('does not remove state or pid files owned by a newer helper flow', async () => {
    const helperPath = path.join(process.cwd(), HELPER_FILENAME);
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-flow-race-'));
    let releaseOldFlow = false;

    const server = createServer((_req, res) => {
      json(res, 200, releaseOldFlow ? { error: 'expired_token' } : { error: 'authorization_pending' });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error(SERVER_BIND_ERROR);
    }

    const authDir = path.join(tempHome, DOLLHOUSE_DIR, '.auth');
    const pidFile = path.join(authDir, HELPER_PID_FILE);
    const stateFile = path.join(authDir, HELPER_STATE_FILE);
    const resultFile = path.join(authDir, HELPER_RESULT_FILE);
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(
      stateFile,
      JSON.stringify({
        flowId: 'old-flow',
        userCode: 'OLD-FLOW',
        startTime: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString()
      }),
      'utf8'
    );

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

      await expect(fs.access(resultFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('oauthHelperTokenHandoff', () => {
  const SECRET = 'oauth-handoff-unit-secret';
  const FLOW_A = '22222222-2222-4222-8222-222222222222';
  const FLOW_B = '33333333-3333-4333-8333-333333333333';
  let originalSecret: string | undefined;
  let tempRoot: string;

  beforeEach(async () => {
    originalSecret = process.env.DOLLHOUSE_TOKEN_SECRET;
    process.env.DOLLHOUSE_TOKEN_SECRET = SECRET;
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-handoff-'));
  });

  afterEach(async () => {
    if (originalSecret === undefined) delete process.env.DOLLHOUSE_TOKEN_SECRET;
    else process.env.DOLLHOUSE_TOKEN_SECRET = originalSecret;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('round-trips an encrypted token bound to a flow id', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    await writeHandoffToken(authDir, FLOW_A, 'gho_round_trip_token');

    // On-disk content is encrypted, not the raw token.
    const onDisk = await fs.readFile(handoffTokenPath(authDir, FLOW_A), 'utf-8');
    expect(onDisk).not.toContain('gho_round_trip_token');

    await expect(readHandoffToken(authDir, FLOW_A)).resolves.toBe('gho_round_trip_token');
  });

  it('round-trips using the machine-passphrase fallback when DOLLHOUSE_TOKEN_SECRET is unset', async () => {
    // Exercise the getMachinePassphrase() fallback path (the other tests always
    // set DOLLHOUSE_TOKEN_SECRET). Write and read run in the same process, so the
    // machine-derived passphrase matches and the token round-trips.
    delete process.env.DOLLHOUSE_TOKEN_SECRET;
    const authDir = path.join(tempRoot, 'user', '.auth');
    await writeHandoffToken(authDir, FLOW_A, 'gho_machine_fallback_token');
    await expect(readHandoffToken(authDir, FLOW_A)).resolves.toBe('gho_machine_fallback_token');
  });

  it('returns null for a different (stale/foreign) flow id', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    await writeHandoffToken(authDir, FLOW_A, 'gho_only_flow_a');
    await expect(readHandoffToken(authDir, FLOW_B)).resolves.toBeNull();
  });

  it('keeps two users\' handoffs isolated by their per-user auth dirs', async () => {
    const authDirUserA = path.join(tempRoot, 'userA', '.auth');
    const authDirUserB = path.join(tempRoot, 'userB', '.auth');
    await writeHandoffToken(authDirUserA, FLOW_A, 'gho_user_a_token');
    await writeHandoffToken(authDirUserB, FLOW_B, 'gho_user_b_token');

    await expect(readHandoffToken(authDirUserA, FLOW_A)).resolves.toBe('gho_user_a_token');
    await expect(readHandoffToken(authDirUserB, FLOW_B)).resolves.toBe('gho_user_b_token');
    // Neither user's flow id resolves in the other's directory.
    await expect(readHandoffToken(authDirUserA, FLOW_B)).resolves.toBeNull();
    await expect(readHandoffToken(authDirUserB, FLOW_A)).resolves.toBeNull();
  });

  it('rejects a non-UUID flow id to prevent path traversal', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    await expect(writeHandoffToken(authDir, '../../etc/evil', 'x')).rejects.toThrow(/flowId must be a UUID/);
  });

  it('sweeps stray handoff files and the legacy plaintext token', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    await writeHandoffToken(authDir, FLOW_A, 'gho_stray_token');
    await fs.writeFile(path.join(authDir, LEGACY_PLAINTEXT_TOKEN_FILE), 'plaintext-leftover', 'utf-8');

    await sweepHandoffArtifacts(authDir);

    await expect(fs.access(handoffTokenPath(authDir, FLOW_A))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(authDir, LEGACY_PLAINTEXT_TOKEN_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
