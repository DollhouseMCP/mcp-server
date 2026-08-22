import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { crashFilesystemGuardOwner } from '../../helpers/crashFilesystemGuardOwner.js';
import {
  writeHandoffToken,
  readHandoffToken,
  handoffTokenPath,
  sweepHandoffArtifacts,
  acquireOAuthHelperFlowLock,
  cancelOAuthHelperFlow,
  isOAuthHelperFlowCancelled,
  releaseOAuthHelperFlowLock,
  LEGACY_PLAINTEXT_TOKEN_FILE,
  deleteHandoffToken,
} from '../../../src/security/oauthHelperTokenHandoff.js';

const TEST_CLIENT_ID = 'Ov23liABCDEFGHIJKLMNOP';
// A fixed UUID flow id used where the server would normally generate one.
const TEST_FLOW_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_TEST_FLOW_ID = '33333333-3333-4333-8333-333333333333';
const HELPER_FILENAME = 'oauth-helper.mjs';
const HELPER_STATE_FILE = 'oauth-helper-state.json';

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
      GITHUB_TOKEN: '',
      TEST_GITHUB_TOKEN: '',
      GITHUB_TEST_TOKEN: '',
      ...extraEnv
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  child.stdin.end('device-code-for-test');

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

async function prepareHelperFlow(homeDir: string, flowId = TEST_FLOW_ID) {
  const authDir = path.join(homeDir, '.dollhouse', '.auth');
  await fs.mkdir(authDir, { recursive: true });
  const flowLock = await acquireOAuthHelperFlowLock(authDir, flowId, Date.now() + 60_000);
  if (!flowLock) throw new Error('Expected OAuth helper flow lock');
  await fs.writeFile(
    path.join(authDir, HELPER_STATE_FILE),
    JSON.stringify({ flowId, lockId: flowLock.lockId, userCode: 'ABCD-1234' }),
    'utf8',
  );
  return { authDir, flowLock };
}

describe(HELPER_FILENAME, () => {
  it('writes the token to an encrypted handoff and keeps no plaintext or canonical store', async () => {
    const helperSource = await fs.readFile(path.join(process.cwd(), HELPER_FILENAME), 'utf-8');

    // The detached helper must hand the token off encrypted, not write the
    // canonical token store or a plaintext fallback (#2334).
    expect(helperSource).toContain('writeHandoffToken(');
    expect(helperSource).not.toContain('pending_token.txt');
    expect(helperSource).not.toMatch(/\bnew TokenManager\s*\(/);
    expect(helperSource).not.toMatch(/\bTokenManager\.storeGitHubToken\s*\(/);
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
      throw new Error('OAuth helper test server did not bind to a TCP port');
    }

    // The server publishes the flow lease and state before handing the device
    // flow to the detached process.
    const { authDir, flowLock } = await prepareHelperFlow(tempHome);

    try {
      // readHandoffToken (below) derives its key from DOLLHOUSE_TOKEN_SECRET, so
      // the test process must share the secret the helper was spawned with.
      process.env.DOLLHOUSE_TOKEN_SECRET = 'oauth-helper-test-secret';

      const result = await runHelper(
        helperPath,
        `http://127.0.0.1:${address.port}/token`,
        tempHome,
        {
          DOLLHOUSE_OAUTH_HELPER_FLOW_ID: TEST_FLOW_ID,
          DOLLHOUSE_OAUTH_HELPER_LOCK_ID: flowLock.lockId,
        }
      );

      expect(result).toMatchObject({
        code: 0,
        stdout: expect.stringContaining('GitHub authentication successful'),
        stderr: '',
      });
      expect(polls).toBe(1);

      // The token is retrievable from the encrypted, flow-bound handoff — this is
      // what the server imports and stores through the session ITokenStore.
      await expect(readHandoffToken(authDir, TEST_FLOW_ID)).resolves.toBe(expectedToken);

      const terminalResult = JSON.parse(
        await fs.readFile(path.join(authDir, 'oauth-helper-result.json'), 'utf-8')
      ) as Record<string, unknown>;
      expect(terminalResult.status).toBe('success');
      expect(terminalResult.attempts).toBe(1);
      expect(terminalResult.flowId).toBe(TEST_FLOW_ID);
      expect(terminalResult.errorCode).toBeUndefined();
      if (process.platform !== 'win32') {
        expect((await fs.stat(path.join(authDir, 'oauth-helper-result.json'))).mode & 0o777)
          .toBe(0o600);
      }
      expect((await fs.readdir(authDir)).filter(name =>
        name.startsWith('oauth-helper-result.json.') && name.endsWith('.tmp')))
        .toEqual([]);

      // The helper must NOT write the canonical token store or a plaintext file —
      // only the server, on import, writes github_token.enc (file mode).
      await expect(fs.access(path.join(authDir, 'github_token.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(path.join(authDir, LEGACY_PLAINTEXT_TOKEN_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
      // Successful state remains until the server correlates and imports the
      // encrypted handoff; the PID belongs only to the helper process.
      await expect(fs.readFile(path.join(authDir, HELPER_STATE_FILE), 'utf8'))
        .resolves.toContain(TEST_FLOW_ID);
      await expect(fs.access(path.join(authDir, 'oauth-helper.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
      if (originalTokenSecret === undefined) delete process.env.DOLLHOUSE_TOKEN_SECRET;
      else process.env.DOLLHOUSE_TOKEN_SECRET = originalTokenSecret;
    }
  }, 15_000);

  it('fails a successful token exchange when the terminal result cannot be durably published', async () => {
    const helperPath = path.join(process.cwd(), HELPER_FILENAME);
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-result-failure-'));
    const expectedToken = 'gho_result_publication_failure_1234567890';
    const server = createServer((_req, res) => {
      json(res, 200, { access_token: expectedToken, token_type: 'bearer', scope: 'read:user' });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('OAuth helper test server did not bind to a TCP port');
    }

    const { authDir, flowLock } = await prepareHelperFlow(tempHome);
    const resultPath = path.join(authDir, 'oauth-helper-result.json');
    await fs.mkdir(resultPath, { recursive: true });
    const originalTokenSecret = process.env.DOLLHOUSE_TOKEN_SECRET;
    try {
      process.env.DOLLHOUSE_TOKEN_SECRET = 'oauth-helper-test-secret';
      const result = await runHelper(
        helperPath,
        `http://127.0.0.1:${address.port}/token`,
        tempHome,
        {
          DOLLHOUSE_OAUTH_HELPER_FLOW_ID: TEST_FLOW_ID,
          DOLLHOUSE_OAUTH_HELPER_LOCK_ID: flowLock.lockId,
        },
      );

      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain('GitHub authentication successful');
      await expect(readHandoffToken(authDir, TEST_FLOW_ID)).resolves.toBe(expectedToken);
      await expect(fs.readFile(path.join(authDir, HELPER_STATE_FILE), 'utf8'))
        .resolves.toContain(TEST_FLOW_ID);
      expect((await fs.stat(resultPath)).isDirectory()).toBe(true);
      expect((await fs.readdir(authDir)).filter(name =>
        name.startsWith('oauth-helper-result.json.') && name.endsWith('.tmp')))
        .toEqual([]);
      await expect(fs.access(path.join(authDir, LEGACY_PLAINTEXT_TOKEN_FILE)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
      if (originalTokenSecret === undefined) delete process.env.DOLLHOUSE_TOKEN_SECRET;
      else process.env.DOLLHOUSE_TOKEN_SECRET = originalTokenSecret;
    }
  }, 15_000);

  it('publishes only the static sanitized message for a known OAuth error', async () => {
    const helperPath = path.join(process.cwd(), HELPER_FILENAME);
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-sanitized-result-'));
    const sensitiveDescription = 'gho_sensitive_provider_description_1234567890';
    const server = createServer((_req, res) => {
      json(res, 200, { error: 'access_denied', error_description: sensitiveDescription });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('OAuth helper test server did not bind to a TCP port');
    }

    const { flowLock } = await prepareHelperFlow(tempHome);
    try {
      const result = await runHelper(
        helperPath,
        `http://127.0.0.1:${address.port}/token`,
        tempHome,
        {
          DOLLHOUSE_OAUTH_HELPER_FLOW_ID: TEST_FLOW_ID,
          DOLLHOUSE_OAUTH_HELPER_LOCK_ID: flowLock.lockId,
        },
      );
      expect(result.code).toBe(1);

      const serialized = await fs.readFile(
        path.join(tempHome, '.dollhouse', '.auth', 'oauth-helper-result.json'),
        'utf8',
      );
      const terminalResult = JSON.parse(serialized) as Record<string, unknown>;
      expect(terminalResult).toMatchObject({
        status: 'denied',
        errorCode: 'access_denied',
        message: 'User denied the GitHub authorization request.',
      });
      expect(serialized).not.toContain(sensitiveDescription);
      expect(result.stderr).not.toContain(sensitiveDescription);
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
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
      throw new Error('OAuth helper test server did not bind to a TCP port');
    }

    const originalTokenSecret = process.env.DOLLHOUSE_TOKEN_SECRET;
    const { flowLock } = await prepareHelperFlow(tempHome);
    try {
      // A successful flow writes the encrypted handoff, which requires a flow id.
      process.env.DOLLHOUSE_TOKEN_SECRET = 'oauth-helper-test-secret';
      const result = await runHelper(
        helperPath,
        `http://127.0.0.1:${address.port}/token`,
        tempHome,
        {
          DOLLHOUSE_OAUTH_HELPER_FLOW_ID: TEST_FLOW_ID,
          DOLLHOUSE_OAUTH_HELPER_LOCK_ID: flowLock.lockId,
        }
      );

      expect(result).toMatchObject({
        code: 0,
        stdout: expect.stringContaining('GitHub authentication successful'),
        stderr: '',
      });
      expect(polls).toBe(2);

      const logPath = path.join(tempHome, '.dollhouse', 'oauth-helper.log');
      await expect(fs.readFile(logPath, 'utf-8')).resolves.toContain('increasing interval to 6s');
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
      if (originalTokenSecret === undefined) delete process.env.DOLLHOUSE_TOKEN_SECRET;
      else process.env.DOLLHOUSE_TOKEN_SECRET = originalTokenSecret;
    }
  }, 15_000);

  it('writes a terminal result when interrupted by SIGTERM', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const helperPath = path.join(process.cwd(), HELPER_FILENAME);
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
    const flowLock = await acquireOAuthHelperFlowLock(authDir, TEST_FLOW_ID, Date.now() + 60_000);
    if (!flowLock) throw new Error('Expected OAuth helper flow lock');
    await fs.writeFile(
      path.join(authDir, HELPER_STATE_FILE),
      JSON.stringify({
        flowId: TEST_FLOW_ID,
        lockId: flowLock.lockId,
        userCode: 'ABCD-1234',
      }),
      'utf-8',
    );

    try {
      const child = spawnHelper(helperPath, `http://127.0.0.1:${address.port}/token`, tempHome, {
        DOLLHOUSE_OAUTH_HELPER_FLOW_ID: TEST_FLOW_ID,
        DOLLHOUSE_OAUTH_HELPER_LOCK_ID: flowLock.lockId,
      });
      await waitForFile(path.join(authDir, 'oauth-helper.pid'));

      child.kill('SIGTERM');
      const result = await waitForClose(child);

      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();

      const terminalResult = JSON.parse(
        await fs.readFile(path.join(authDir, 'oauth-helper-result.json'), 'utf-8')
      ) as Record<string, unknown>;
      expect(terminalResult.status).toBe('failed');
      expect(terminalResult.errorCode).toBe('interrupted');
      expect(terminalResult.message).toBe('OAuth helper was interrupted before authentication completed.');
      expect((await fs.stat(path.join(authDir, 'oauth-helper-result.json'))).mode & 0o777)
        .toBe(0o600);
      expect((await fs.readdir(authDir)).filter(name =>
        name.startsWith('oauth-helper-result.json.') && name.endsWith('.tmp')))
        .toEqual([]);

      await expect(fs.access(path.join(authDir, HELPER_STATE_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(path.join(authDir, 'oauth-helper.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(acquireOAuthHelperFlowLock(authDir, SECOND_TEST_FLOW_ID, Date.now() + 60_000))
        .resolves.toMatchObject({ flowId: SECOND_TEST_FLOW_ID });
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }, 15_000);

  it('preserves completed handoff state when interrupted after the encrypted write', async () => {
    if (process.platform === 'win32') return;

    const helperPath = path.join(process.cwd(), HELPER_FILENAME);
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-helper-post-handoff-signal-'));
    const expectedToken = 'gho_test_post_handoff_signal_1234567890';
    const server = createServer((_req, res) => {
      json(res, 200, { access_token: expectedToken, token_type: 'bearer', scope: 'read:user' });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('OAuth helper test server did not bind to a TCP port');
    }

    const { authDir, flowLock } = await prepareHelperFlow(tempHome);
    const originalTokenSecret = process.env.DOLLHOUSE_TOKEN_SECRET;
    try {
      process.env.DOLLHOUSE_TOKEN_SECRET = 'oauth-helper-test-secret';
      const child = spawnHelper(helperPath, `http://127.0.0.1:${address.port}/token`, tempHome, {
        NODE_ENV: 'test',
        DOLLHOUSE_OAUTH_HELPER_FLOW_ID: TEST_FLOW_ID,
        DOLLHOUSE_OAUTH_HELPER_LOCK_ID: flowLock.lockId,
        DOLLHOUSE_OAUTH_HELPER_TEST_POST_HANDOFF_DELAY_MS: '5000',
      });
      const handoffPath = handoffTokenPath(authDir, TEST_FLOW_ID);
      await waitForFile(handoffPath);
      child.kill('SIGTERM');
      const result = await waitForClose(child);

      expect(result.code).toBe(0);
      const terminalResult = JSON.parse(
        await fs.readFile(path.join(authDir, 'oauth-helper-result.json'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(terminalResult).toMatchObject({ status: 'success', flowId: TEST_FLOW_ID });
      await expect(readHandoffToken(authDir, TEST_FLOW_ID)).resolves.toBe(expectedToken);
      await expect(fs.readFile(path.join(authDir, HELPER_STATE_FILE), 'utf8'))
        .resolves.toContain(TEST_FLOW_ID);
      await expect(fs.access(path.join(authDir, 'oauth-helper.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
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
      throw new Error('OAuth helper test server did not bind to a TCP port');
    }

    const { authDir, flowLock: oldFlowLock } = await prepareHelperFlow(tempHome);
    const pidFile = path.join(authDir, 'oauth-helper.pid');
    const stateFile = path.join(authDir, HELPER_STATE_FILE);
    const resultFile = path.join(authDir, 'oauth-helper-result.json');

    try {
      const child = spawnHelper(
        helperPath,
        `http://127.0.0.1:${address.port}/token`,
        tempHome,
        {
          DOLLHOUSE_OAUTH_HELPER_FLOW_ID: TEST_FLOW_ID,
          DOLLHOUSE_OAUTH_HELPER_LOCK_ID: oldFlowLock.lockId,
        }
      );
      await waitForFile(pidFile);

      await releaseOAuthHelperFlowLock(authDir, TEST_FLOW_ID, oldFlowLock.lockId);
      const newFlowLock = await acquireOAuthHelperFlowLock(
        authDir,
        SECOND_TEST_FLOW_ID,
        Date.now() + 60_000,
      );
      if (!newFlowLock) throw new Error('Expected successor OAuth helper flow lock');
      const successorPid = {
        version: 1,
        pid: 999999,
        flowId: SECOND_TEST_FLOW_ID,
        lockId: newFlowLock.lockId,
        incarnation: {
          source: 'darwin-ps',
          bootId: 'successor-boot',
          processStartId: 'successor-start',
        },
      };
      await fs.writeFile(pidFile, JSON.stringify(successorPid), 'utf-8');
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          pid: 999999,
          flowId: SECOND_TEST_FLOW_ID,
          lockId: newFlowLock.lockId,
          userCode: 'NEW-FLOW',
          startTime: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120_000).toISOString()
        }, null, 2),
        'utf-8'
      );
      const successorResult = JSON.stringify({
        status: 'success',
        flowId: SECOND_TEST_FLOW_ID,
        completedAt: new Date().toISOString(),
      });
      await fs.writeFile(resultFile, successorResult, 'utf8');

      releaseOldFlow = true;
      const result = await waitForClose(child);

      expect(result.code).toBe(1);
      await expect(fs.readFile(pidFile, 'utf-8')).resolves.toBe(JSON.stringify(successorPid));
      const state = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
      expect(state.flowId).toBe(SECOND_TEST_FLOW_ID);
      expect(state.pid).toBe(999999);

      const terminalResult = JSON.parse(await fs.readFile(resultFile, 'utf-8')) as Record<string, unknown>;
      expect(terminalResult.status).toBe('success');
      expect(terminalResult.flowId).toBe(SECOND_TEST_FLOW_ID);
    } finally {
      await closeServer(server);
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('oauthHelperTokenHandoff', () => {
  const SECRET = 'oauth-handoff-unit-secret';
  const FLOW_A = '22222222-2222-4222-8222-222222222222';
  const FLOW_B = SECOND_TEST_FLOW_ID;
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
    const tokenPath = handoffTokenPath(authDir, FLOW_A);

    // On-disk content is encrypted, not the raw token.
    const onDisk = await fs.readFile(tokenPath, 'utf-8');
    expect(onDisk).not.toContain('gho_round_trip_token');
    if (process.platform !== 'win32') {
      expect((await fs.stat(tokenPath)).mode & 0o777).toBe(0o600);
    }
    expect((await fs.readdir(authDir)).filter(name =>
      name.startsWith(`oauth-helper-token-${FLOW_A}.enc.`) && name.endsWith('.tmp')))
      .toEqual([]);

    await expect(readHandoffToken(authDir, FLOW_A)).resolves.toBe('gho_round_trip_token');
  });

  it('suppresses an absent handoff but surfaces every other deletion failure', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    await fs.mkdir(authDir, { recursive: true });

    await expect(deleteHandoffToken(authDir, FLOW_A)).resolves.toBeUndefined();

    await fs.mkdir(handoffTokenPath(authDir, FLOW_A));
    await expect(deleteHandoffToken(authDir, FLOW_A)).rejects.toMatchObject({
      code: expect.not.stringMatching(/^ENOENT$/u),
    });
  });

  it('creates and reuses a protected random per-user key when DOLLHOUSE_TOKEN_SECRET is unset', async () => {
    delete process.env.DOLLHOUSE_TOKEN_SECRET;
    const authDir = path.join(tempRoot, 'user', '.auth');
    await writeHandoffToken(authDir, FLOW_A, 'gho_random_key_token');
    const keyPath = path.join(authDir, 'oauth-helper-handoff.key');
    const firstKey = await fs.readFile(keyPath);

    await expect(readHandoffToken(authDir, FLOW_A)).resolves.toBe('gho_random_key_token');
    await writeHandoffToken(authDir, FLOW_B, 'gho_second_token');
    await expect(fs.readFile(keyPath)).resolves.toEqual(firstKey);
    expect(firstKey).toHaveLength(32);
    if (process.platform !== 'win32') {
      expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(authDir)).mode & 0o777).toBe(0o700);
    }
  });

  it('atomically selects one fully-written master key under concurrent first use', async () => {
    delete process.env.DOLLHOUSE_TOKEN_SECRET;
    const authDir = path.join(tempRoot, 'user', '.auth');
    let firstTempReady!: () => void;
    let allowFirstPublish!: () => void;
    const tempReady = new Promise<void>(resolve => { firstTempReady = resolve; });
    const publishGate = new Promise<void>(resolve => { allowFirstPublish = resolve; });

    const firstWrite = writeHandoffToken(
      authDir,
      FLOW_A,
      'gho_first_concurrent_token',
      undefined,
      {
        beforePublish: async temporaryPath => {
          const contents = await fs.readFile(temporaryPath);
          expect(contents).toHaveLength(32);
          if (process.platform !== 'win32') {
            expect((await fs.stat(temporaryPath)).mode & 0o777).toBe(0o600);
          }
          firstTempReady();
          await publishGate;
        },
      },
    );

    await tempReady;
    await writeHandoffToken(authDir, FLOW_B, 'gho_second_concurrent_token');
    allowFirstPublish();
    await firstWrite;

    await expect(readHandoffToken(authDir, FLOW_A)).resolves.toBe('gho_first_concurrent_token');
    await expect(readHandoffToken(authDir, FLOW_B)).resolves.toBe('gho_second_concurrent_token');
    await expect(fs.readFile(path.join(authDir, 'oauth-helper-handoff.key')))
      .resolves.toHaveLength(32);
  });

  it('does not publish or strand a master key when creation is interrupted before publication', async () => {
    delete process.env.DOLLHOUSE_TOKEN_SECRET;
    const authDir = path.join(tempRoot, 'user', '.auth');
    const keyPath = path.join(authDir, 'oauth-helper-handoff.key');

    await expect(writeHandoffToken(
      authDir,
      FLOW_A,
      'gho_interrupted_token',
      undefined,
      { beforePublish: async () => { throw new Error('simulated publication interruption'); } },
    )).rejects.toThrow('simulated publication interruption');

    await expect(fs.access(keyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(authDir)).filter(name => name.startsWith('oauth-helper-handoff.key.')))
      .toEqual([]);

    await writeHandoffToken(authDir, FLOW_A, 'gho_retry_token');
    await expect(readHandoffToken(authDir, FLOW_A)).resolves.toBe('gho_retry_token');
  });

  it('returns null for a different (stale/foreign) flow id', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    await writeHandoffToken(authDir, FLOW_A, 'gho_only_flow_a');
    await expect(readHandoffToken(authDir, FLOW_B)).resolves.toBeNull();
  });

  it('rejects ciphertext copied to a different flow because the flow and directory are AAD-bound', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    await writeHandoffToken(authDir, FLOW_A, 'gho_flow_bound_token');
    await fs.copyFile(handoffTokenPath(authDir, FLOW_A), handoffTokenPath(authDir, FLOW_B));

    await expect(readHandoffToken(authDir, FLOW_B)).rejects.toThrow();
  });

  it('rejects malformed base64 fields before invoking the decipher', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    await writeHandoffToken(authDir, FLOW_A, 'gho_valid_token');
    const tokenPath = handoffTokenPath(authDir, FLOW_A);
    const record = JSON.parse(await fs.readFile(tokenPath, 'utf8')) as Record<string, unknown>;
    record.iv = 'not-base64!';
    await fs.writeFile(tokenPath, JSON.stringify(record), { mode: 0o600 });

    await expect(readHandoffToken(authDir, FLOW_A)).rejects.toThrow(/malformed OAuth handoff record/);
  });

  it('reports malformed decrypted payloads without disclosing their contents', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    await fs.mkdir(authDir, { recursive: true });
    const sensitiveMalformedPlaintext = '{"token":"SENSITIVE-DECRYPTED-MARKER"';
    const salt = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const masterKey = crypto.createHash('sha256').update(SECRET, 'utf8').digest();
    const key = Buffer.from(crypto.hkdfSync(
      'sha256',
      masterKey,
      salt,
      Buffer.from(`DollhouseMCP-OAuthHandoff-v2:${FLOW_A}`, 'utf8'),
      32,
    ));
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(JSON.stringify({
        version: 2,
        flowId: FLOW_A,
        authDir: path.resolve(authDir),
      }), 'utf8'));
      const ciphertext = Buffer.concat([
        cipher.update(sensitiveMalformedPlaintext, 'utf8'),
        cipher.final(),
      ]);
      await fs.writeFile(handoffTokenPath(authDir, FLOW_A), JSON.stringify({
        version: 2,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      }), { mode: 0o600 });
    } finally {
      masterKey.fill(0);
      key.fill(0);
    }

    let message = '';
    try {
      await readHandoffToken(authDir, FLOW_A);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('OAuth handoff token is expired or malformed');
    expect(message).not.toContain('SENSITIVE-DECRYPTED-MARKER');
    await expect(fs.access(handoffTokenPath(authDir, FLOW_A))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deletes and rejects a handoff after its bounded expiry', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    await writeHandoffToken(authDir, FLOW_A, 'gho_expired_token', Date.now() - 1);

    await expect(readHandoffToken(authDir, FLOW_A)).rejects.toThrow(/expired or malformed/);
    await expect(fs.access(handoffTokenPath(authDir, FLOW_A))).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('durably fences a cancelled flow and rejects a late helper publication', async () => {
    const authDir = path.join(tempRoot, 'cancelled-user', '.auth');
    const fence = await cancelOAuthHelperFlow(authDir, FLOW_A, Date.now() + 60_000);

    expect(fence).toMatchObject({ flowId: FLOW_A, generation: expect.any(String) });
    await expect(isOAuthHelperFlowCancelled(authDir, FLOW_A)).resolves.toBe(true);
    await expect(writeHandoffToken(authDir, FLOW_A, 'gho_late_completion'))
      .rejects.toThrow('OAuth helper flow was cancelled');
    await expect(fs.access(handoffTokenPath(authDir, FLOW_A)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps cancellation idempotent so repeated disconnects retain one generation', async () => {
    const authDir = path.join(tempRoot, 'cancel-idempotent-user', '.auth');
    const first = await cancelOAuthHelperFlow(authDir, FLOW_A, Date.now() + 60_000);
    const second = await cancelOAuthHelperFlow(authDir, FLOW_A, Date.now() + 60_000);

    expect(second).toEqual(first);
  });

  it('rejects a non-UUID flow id to prevent path traversal', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    await expect(writeHandoffToken(authDir, '../../etc/evil', 'x')).rejects.toThrow(/flowId must be a UUID/);
  });

  it('sweeps stray handoff files and the legacy plaintext token', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    await writeHandoffToken(authDir, FLOW_A, 'gho_stray_token');
    const stale = new Date(Date.now() - 21 * 60 * 1000);
    await fs.utimes(handoffTokenPath(authDir, FLOW_A), stale, stale);
    await fs.writeFile(path.join(authDir, LEGACY_PLAINTEXT_TOKEN_FILE), 'plaintext-leftover', 'utf-8');
    const staleTemp = `${handoffTokenPath(authDir, FLOW_B)}.12345.tmp`;
    await fs.writeFile(staleTemp, 'orphaned-ciphertext', { mode: 0o600 });
    await fs.utimes(staleTemp, stale, stale);

    await sweepHandoffArtifacts(authDir);

    await expect(fs.access(handoffTokenPath(authDir, FLOW_A))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(authDir, LEGACY_PLAINTEXT_TOKEN_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(staleTemp)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('strictly sweeps only validated orphan master-key temp artifacts', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    await fs.mkdir(authDir, { recursive: true });
    const validTemp = path.join(
      authDir,
      'oauth-helper-handoff.key.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp',
    );
    const invalidUuid = path.join(authDir, 'oauth-helper-handoff.key.not-a-uuid.tmp');
    const extraSuffix = `${validTemp}.backup`;
    await Promise.all([
      fs.writeFile(validTemp, 'orphaned-key-material', { mode: 0o600 }),
      fs.writeFile(invalidUuid, 'keep', { mode: 0o600 }),
      fs.writeFile(extraSuffix, 'keep', { mode: 0o600 }),
    ]);

    await sweepHandoffArtifacts(authDir);

    await expect(fs.access(validTemp)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(invalidUuid, 'utf8')).resolves.toBe('keep');
    await expect(fs.readFile(extraSuffix, 'utf8')).resolves.toBe('keep');
  });

  it('removes its ciphertext temp file when atomic replacement fails', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    await fs.mkdir(handoffTokenPath(authDir, FLOW_A), { recursive: true });

    await expect(writeHandoffToken(authDir, FLOW_A, 'gho_never_persisted')).rejects.toThrow();

    const entries = await fs.readdir(authDir);
    expect(entries.filter(name => name.startsWith(`oauth-helper-token-${FLOW_A}.enc.`))).toEqual([]);
  });

  it('serializes active helper flows with an expiring per-user lease', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    const flowA = await acquireOAuthHelperFlowLock(authDir, FLOW_A, Date.now() + 60_000);
    expect(flowA).toMatchObject({ flowId: FLOW_A });
    await expect(acquireOAuthHelperFlowLock(authDir, FLOW_B, Date.now() + 60_000)).resolves.toBeNull();

    await releaseOAuthHelperFlowLock(authDir, FLOW_B, SECOND_TEST_FLOW_ID);
    await expect(acquireOAuthHelperFlowLock(authDir, FLOW_B, Date.now() + 60_000)).resolves.toBeNull();
    if (!flowA) throw new Error('Expected OAuth helper flow lock');
    await releaseOAuthHelperFlowLock(authDir, flowA.flowId, flowA.lockId);
    await expect(acquireOAuthHelperFlowLock(authDir, FLOW_B, Date.now() + 60_000))
      .resolves.toMatchObject({ flowId: FLOW_B });
  });

  it('serializes lock publication behind the interprocess guard under forced interleaving', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    let releaseFirst!: () => void;
    let firstReachedPublish!: () => void;
    const firstMayPublish = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstAtPublish = new Promise<void>(resolve => { firstReachedPublish = resolve; });

    const first = acquireOAuthHelperFlowLock(authDir, FLOW_A, Date.now() + 60_000, {
      beforePublish: async () => {
        firstReachedPublish();
        await firstMayPublish;
      },
    });
    await firstAtPublish;

    let secondSettled = false;
    const second = acquireOAuthHelperFlowLock(authDir, FLOW_B, Date.now() + 60_000)
      .finally(() => { secondSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(secondSettled).toBe(false);

    releaseFirst();
    const firstLock = await first;
    expect(firstLock).toMatchObject({ flowId: FLOW_A });
    await expect(second).resolves.toBeNull();

    if (!firstLock) throw new Error('Expected first lock to win guarded publication');
    await releaseOAuthHelperFlowLock(authDir, firstLock.flowId, firstLock.lockId);
  });

  it('recovers the helper-flow guard after its operating-system process is killed', async () => {
    if (process.platform === 'win32') return;
    const authDir = path.join(tempRoot, 'user', '.auth');
    const guardPath = path.join(authDir, 'oauth-helper-flow.lock.guard');
    await crashFilesystemGuardOwner(guardPath);

    const lock = await acquireOAuthHelperFlowLock(authDir, FLOW_A, Date.now() + 60_000);
    expect(lock).toMatchObject({ flowId: FLOW_A });
    if (!lock) throw new Error('Expected helper-flow lock after guard-owner recovery');
    await releaseOAuthHelperFlowLock(authDir, lock.flowId, lock.lockId);
    await expect(fs.access(guardPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims an expired helper-flow lease', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    await expect(acquireOAuthHelperFlowLock(authDir, FLOW_A, Date.now() - 1))
      .resolves.toMatchObject({ flowId: FLOW_A });
    await expect(acquireOAuthHelperFlowLock(authDir, FLOW_B, Date.now() + 60_000))
      .resolves.toMatchObject({ flowId: FLOW_B });
  });

  it('does not let an expired lock instance release its same-flow replacement', async () => {
    const authDir = path.join(tempRoot, 'user', '.auth');
    const stale = await acquireOAuthHelperFlowLock(authDir, FLOW_A, Date.now() - 1);
    const replacement = await acquireOAuthHelperFlowLock(authDir, FLOW_A, Date.now() + 60_000);
    if (!stale || !replacement) throw new Error('Expected both lock instances');
    expect(replacement.lockId).not.toBe(stale.lockId);

    await releaseOAuthHelperFlowLock(authDir, stale.flowId, stale.lockId);

    await expect(acquireOAuthHelperFlowLock(authDir, FLOW_B, Date.now() + 60_000)).resolves.toBeNull();
    await releaseOAuthHelperFlowLock(authDir, replacement.flowId, replacement.lockId);
    await expect(acquireOAuthHelperFlowLock(authDir, FLOW_B, Date.now() + 60_000))
      .resolves.toMatchObject({ flowId: FLOW_B });
  });
});
