/**
 * Integration tests for the permission server chain.
 *
 * In mcp-server, permission routes are mounted on the unified web
 * console (port 41715). These tests verify port file lifecycle, HTTP
 * endpoint behavior, hook script compatibility, and error recovery.
 *
 * Keep platform-specific stdout/exit assertions in sync with
 * docs/architecture/permission-hook-platform-contracts.md.
 */

import { describe, expect, it, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const RUN_DIR = path.join(os.homedir(), '.dollhouse', 'run');
const PORT_FILE = path.join(RUN_DIR, 'permission-server.port');
const PID_PORT_FILE = path.join(RUN_DIR, `permission-server-${process.pid}.port`);
// Hook script lives in the repo at scripts/ — works on both dev machines and CI
const HOOK_SCRIPT = path.join(process.cwd(), 'scripts', 'pretooluse-dollhouse.sh');
const CURSOR_HOOK_SCRIPT = path.join(process.cwd(), 'scripts', 'pretooluse-cursor.sh');
const GEMINI_HOOK_SCRIPT = path.join(process.cwd(), 'scripts', 'pretooluse-gemini.sh');
const VSCODE_HOOK_SCRIPT = path.join(process.cwd(), 'scripts', 'pretooluse-vscode.sh');
const WINDSURF_HOOK_SCRIPT = path.join(process.cwd(), 'scripts', 'pretooluse-windsurf.sh');
const SAFE_TEST_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const BASH_BINARY = '/bin/bash';

describe('Permission Server Integration', () => {

  describe('end-to-end HTTP endpoint', () => {
    let server: http.Server | undefined;
    let testPort: number;

    afterEach(async () => {
      if (server) {
        await new Promise<void>(resolve => server!.close(() => resolve()));
        server = undefined;
      }
      // Clean up port files
      await fs.unlink(PORT_FILE).catch(() => {});
      await fs.unlink(PID_PORT_FILE).catch(() => {});
    });

    it('should find a port and write a discoverable port file', async () => {
      const { findAvailablePort, writePortFile, cleanupPortFile } = await import(
        '../../../src/auto-dollhouse/portDiscovery.js'
      );

      testPort = await findAvailablePort(49300);
      const pidFile = await writePortFile(testPort);

      // Main port file should exist and contain the port
      const content = await fs.readFile(PORT_FILE, 'utf-8');
      expect(content.trim()).toBe(String(testPort));

      // PID-keyed file should also exist
      const pidContent = await fs.readFile(pidFile, 'utf-8');
      expect(pidContent.trim()).toBe(String(testPort));

      // Clean up immediately to avoid race with other test suites sharing the port file
      await cleanupPortFile();
      await fs.unlink(PORT_FILE).catch(() => {});
    });

    it('should accept POST /api/evaluate_permission and return a decision', async () => {
      // Start a minimal mock server that mimics the evaluate_permission endpoint
      server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/evaluate_permission') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            const parsed = JSON.parse(body);
            // Simulate: Read is safe, rm -rf is dangerous
            const decision = parsed.tool_name === 'Read' ? 'allow' : 'deny';
            const reason = decision === 'deny'
              ? `Tool "${parsed.tool_name}" denied by policy`
              : undefined;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: decision,
                ...(reason && { permissionDecisionReason: reason }),
              },
            }));
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      testPort = await listenOnLoopback(server);

      // Test safe tool
      const allowResponse = await httpPost(testPort, {
        tool_name: 'Read',
        input: {},
        platform: 'claude_code',
      });
      expect(allowResponse.hookSpecificOutput.permissionDecision).toBe('allow');

      // Test dangerous tool
      const denyResponse = await httpPost(testPort, {
        tool_name: 'Bash',
        input: { command: 'rm -rf /' },
        platform: 'claude_code',
      });
      expect(denyResponse.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(denyResponse.hookSpecificOutput.permissionDecisionReason).toContain('denied');
    });
  });

  describe('port cleanup registration', () => {
    it('should clean up PID-keyed port file via cleanupPortFile', async () => {
      const { writePortFile, cleanupPortFile } = await import(
        '../../../src/auto-dollhouse/portDiscovery.js'
      );

      const pidFile = await writePortFile(49350);

      // PID file should exist
      await expect(fs.stat(pidFile)).resolves.toBeDefined();

      // Cleanup should remove the PID file
      await cleanupPortFile();
      await expect(fs.stat(pidFile)).rejects.toThrow();

      // Clean up the main port file manually (cleanup only removes PID file)
      await fs.unlink(PORT_FILE).catch(() => {});
    });

    it('should register exit handlers via registerPortCleanup', async () => {
      const { registerPortCleanup } = await import(
        '../../../src/auto-dollhouse/portDiscovery.js'
      );

      // Should not throw when called
      expect(() => registerPortCleanup()).not.toThrow();

      // Verify exit listeners were registered (process.listenerCount increases)
      // We can't easily test the actual cleanup on exit, but we can verify
      // the handlers are registered
      const exitListeners = process.listenerCount('exit');
      expect(exitListeners).toBeGreaterThan(0);
    });
  });

  describe('hook script integration', () => {
    // Hook script requires bash — skip on Windows where bash is not available
    const isWindows = process.platform === 'win32';
    const itBash = isWindows ? it.skip : it;

    afterEach(async () => {
      await fs.unlink(PORT_FILE).catch(() => {});
      await fs.unlink(PID_PORT_FILE).catch(() => {});
    });

    it('hook script should exist in repo at scripts/', async () => {
      const exists = await fs.stat(HOOK_SCRIPT).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    itBash('hook script should fail open when port file is missing', async () => {
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dollhouse-hook-home-'));
      const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
        const hookProc = spawn(BASH_BINARY, [HOOK_SCRIPT], {
          env: { HOME: tempHome, PATH: SAFE_TEST_PATH },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        hookProc.stdout.on('data', (data: Buffer) => { out += data.toString(); });
        hookProc.on('close', (c: number) => resolve({ code: c, stdout: out }));
        hookProc.stdin.write(JSON.stringify({
          tool_name: 'Read',
          tool_input: { file_path: './test-fixture.txt' },
        }));
        hookProc.stdin.end();
      });

      await fs.rm(tempHome, { recursive: true, force: true });

      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    });

    itBash('hook script should no-op when authority mode is off for Claude Code', async () => {
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dollhouse-hook-home-'));
      const runDir = path.join(tempHome, '.dollhouse', 'run');
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, 'permission-authority.json'),
        JSON.stringify({
          version: 1,
          defaultMode: 'shared',
          updatedAt: '2026-04-17T00:00:00.000Z',
          hosts: {
            'claude-code': {
              mode: 'off',
              updatedAt: '2026-04-17T00:00:00.000Z',
            },
          },
        }),
        'utf-8',
      );

      const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
        const hookProc = spawn(BASH_BINARY, [HOOK_SCRIPT], {
          env: { HOME: tempHome, PATH: SAFE_TEST_PATH },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        hookProc.stdout.on('data', (data: Buffer) => { out += data.toString(); });
        hookProc.on('close', (c: number) => resolve({ code: c, stdout: out }));
        hookProc.stdin.write(JSON.stringify({
          tool_name: 'Read',
          tool_input: { file_path: './test-fixture.txt' },
        }));
        hookProc.stdin.end();
      });

      await fs.rm(tempHome, { recursive: true, force: true });

      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    });

    itBash('hook script should discover server via port file and get a response', async () => {
      let testPort = 0;
      let capturedBody: Record<string, unknown> | null = null;
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dollhouse-hook-home-'));
      const tempRunDir = path.join(tempHome, '.dollhouse', 'run');
      const tempPortFile = path.join(tempRunDir, 'permission-server.port');
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/evaluate_permission') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            capturedBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
              },
            }));
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      // Start server and write port file
      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(tempRunDir, { recursive: true });
      await fs.writeFile(tempPortFile, String(testPort), 'utf-8');

      // Run hook script
      const { spawn } = await import('node:child_process');
      const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
        const hookProc = spawn(BASH_BINARY, [HOOK_SCRIPT], {
          env: {
            HOME: tempHome,
            PATH: SAFE_TEST_PATH,
            DOLLHOUSE_SESSION_ID: 'session-hook-test',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        hookProc.stdout.on('data', (data: Buffer) => { out += data.toString(); });
        hookProc.on('close', (c: number) => resolve({ code: c, stdout: out }));
        hookProc.stdin.write(JSON.stringify({
          tool_name: 'Read',
          tool_input: { file_path: './test-fixture.txt' },
        }));
        hookProc.stdin.end();
      });

      // Cleanup and assert
      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.rm(tempHome, { recursive: true, force: true });

      expect(code).toBe(0);
      expect(capturedBody).toEqual({
        tool_name: 'Read',
        input: { file_path: './test-fixture.txt' },
        platform: 'claude_code',
        session_id: 'session-hook-test',
      });
      if (stdout.trim()) {
        const response = JSON.parse(stdout.trim());
        expect(response.hookSpecificOutput.permissionDecision).toBe('allow');
      }
    });

    itBash('hook script should forward Codex session metadata from the raw hook payload', async () => {
      let testPort = 0;
      let capturedBody: Record<string, unknown> | null = null;
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dollhouse-hook-home-'));
      const tempRunDir = path.join(tempHome, '.dollhouse', 'run');
      const tempPortFile = path.join(tempRunDir, 'permission-server.port');
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/evaluate_permission') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            capturedBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({}));
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(tempRunDir, { recursive: true });
      await fs.writeFile(tempPortFile, String(testPort), 'utf-8');

      const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
        const hookProc = spawn(BASH_BINARY, [HOOK_SCRIPT], {
          env: {
            HOME: tempHome,
            PATH: SAFE_TEST_PATH,
            DOLLHOUSE_HOOK_PLATFORM: 'codex',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        hookProc.stdout.on('data', (data: Buffer) => { out += data.toString(); });
        hookProc.on('close', (c: number) => resolve({ code: c, stdout: out }));
        hookProc.stdin.write(JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'pwd' },
          session_id: 'session-codex-raw',
          turn_id: 'turn-88',
          tool_use_id: 'tooluse-77',
          transcript_path: '/Users/codex/.codex/transcripts/session.jsonl',
          cwd: '/workspace/codex',
          model: 'gpt-5.4',
        }));
        hookProc.stdin.end();
      });

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.rm(tempHome, { recursive: true, force: true });

      expect(code).toBe(0);
      expect(stdout).toBe('');
      expect(capturedBody).toEqual({
        tool_name: 'Bash',
        input: { command: 'pwd' },
        platform: 'codex',
        session_id: 'session-codex-raw',
        turn_id: 'turn-88',
        tool_use_id: 'tooluse-77',
        transcript_path: '/Users/codex/.codex/transcripts/session.jsonl',
        cwd: '/workspace/codex',
        model: 'gpt-5.4',
      });
    });

    itBash('hook script should translate legacy flat Claude responses', async () => {
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dollhouse-hook-home-'));
      const tempRunDir = path.join(tempHome, '.dollhouse', 'run');
      const tempPortFile = path.join(tempRunDir, 'permission-server.port');
      let testPort = 0;
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/evaluate_permission') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            decision: 'deny',
            reason: 'Blocked by policy',
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(tempRunDir, { recursive: true });
      await fs.writeFile(tempPortFile, String(testPort), 'utf-8');

      const { stdout } = await runHookScript(
        {
          tool_name: 'Bash',
          tool_input: { command: 'git push --force' },
        },
        { HOME: tempHome },
      );

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.rm(tempHome, { recursive: true, force: true });

      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Blocked by policy',
        },
      });
    });

    itBash('hook script should pass through already-wrapped Claude responses unchanged', async () => {
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dollhouse-hook-home-'));
      const tempRunDir = path.join(tempHome, '.dollhouse', 'run');
      const tempPortFile = path.join(tempRunDir, 'permission-server.port');
      let testPort = 0;
      const wrappedResponse = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'Needs approval',
        },
      };
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/evaluate_permission') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(wrappedResponse));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(tempRunDir, { recursive: true });
      await fs.writeFile(tempPortFile, String(testPort), 'utf-8');

      const { stdout } = await runHookScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: 'src/index.ts' },
        },
        { HOME: tempHome },
      );

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.rm(tempHome, { recursive: true, force: true });

      expect(JSON.parse(stdout.trim())).toEqual(wrappedResponse);
    });

    itBash('hook script should fail open silently on malformed Claude responses', async () => {
      let testPort = 0;
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/evaluate_permission') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ nope: true }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.writeFile(PORT_FILE, String(testPort), 'utf-8');

      const { code, stdout } = await runHookScript({
        tool_name: 'Read',
        tool_input: { file_path: './test-fixture.txt' },
      });

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.unlink(PORT_FILE).catch(() => {});
      await fs.unlink(PID_PORT_FILE).catch(() => {});

      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    });

    itBash('hook script should fail open when permission requests time out', async () => {
      let testPort = 0;
      const mockServer = http.createServer((_req, _res) => {
        // Intentionally never respond so curl hits its max-time window.
      });

      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.writeFile(PORT_FILE, String(testPort), 'utf-8');

      const { code, stdout } = await runHookScript(
        {
          tool_name: 'Read',
          tool_input: { file_path: './test-fixture.txt' },
        },
        {
          DOLLHOUSE_HOOK_INITIAL_TIMEOUT: '1',
          DOLLHOUSE_HOOK_MAX_RETRIES: '0',
        },
      );

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.unlink(PORT_FILE).catch(() => {});
      await fs.unlink(PID_PORT_FILE).catch(() => {});

      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    });

    itBash('hook script should clamp invalid timeout and retry overrides to safe bounds', async () => {
      let testPort = 0;
      const mockServer = http.createServer((_req, _res) => {
        // Intentionally never respond so curl exercises the bounded timeout path.
      });

      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.writeFile(PORT_FILE, String(testPort), 'utf-8');

      const startedAt = Date.now();
      const { code, stdout } = await runHookScript(
        {
          tool_name: 'Read',
          tool_input: { file_path: './test-fixture.txt' },
        },
        {
          DOLLHOUSE_HOOK_INITIAL_TIMEOUT: '0',
          DOLLHOUSE_HOOK_MAX_RETRIES: '-1',
          DOLLHOUSE_HOOK_AUTHORITY_CACHE_TTL_SECONDS: '999',
        },
      );
      const elapsedMs = Date.now() - startedAt;

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.unlink(PORT_FILE).catch(() => {});
      await fs.unlink(PID_PORT_FILE).catch(() => {});

      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
      expect(elapsedMs).toBeLessThan(20_000);
    }, 20000);

    itBash('hook script should stay silent for Codex allow decisions', async () => {
      let testPort = 0;
      let capturedBody: Record<string, unknown> | null = null;
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/evaluate_permission') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            capturedBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              hookSpecificOutput: {
                permissionDecision: 'allow',
              },
            }));
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.writeFile(PORT_FILE, String(testPort), 'utf-8');

      const { code, stdout } = await runHookScript(
        {
          toolName: 'Bash',
          toolInput: { command: 'node -p "require(\'./package.json\').version"' },
        },
        { DOLLHOUSE_HOOK_PLATFORM: 'codex' },
      );

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.unlink(PORT_FILE).catch(() => {});
      await fs.unlink(PID_PORT_FILE).catch(() => {});

      expect(code).toBe(0);
      expect(capturedBody).toEqual({
        tool_name: 'Bash',
        input: { command: 'node -p "require(\'./package.json\').version"' },
        platform: 'codex',
        session_id: 'session-hook-test',
      });
      expect(stdout).toBe('');
    });

    itBash('codex hook wrapper should fail open silently when the server is not ready', async () => {
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dollhouse-hook-home-'));
      const codexScript = path.join(tempHome, 'pretooluse-codex.sh');
      const sharedScript = path.join(tempHome, 'pretooluse-dollhouse.sh');
      const portHelper = path.join(tempHome, 'permission-port-discovery.sh');
      const configHelper = path.join(tempHome, 'permission-hook-config.sh');
      const diagnosticsLog = path.join(tempHome, '.dollhouse', 'run', 'permission-hook-diagnostics.jsonl');

      await fs.copyFile(path.join(process.cwd(), 'scripts', 'pretooluse-codex.sh'), codexScript);
      await fs.copyFile(path.join(process.cwd(), 'scripts', 'pretooluse-dollhouse.sh'), sharedScript);
      await fs.copyFile(path.join(process.cwd(), 'scripts', 'permission-port-discovery.sh'), portHelper);
      await fs.copyFile(path.join(process.cwd(), 'scripts', 'permission-hook-config.sh'), configHelper);

      const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
        const hookProc = spawn(BASH_BINARY, [codexScript], {
          env: {
            HOME: tempHome,
            PATH: SAFE_TEST_PATH,
            DOLLHOUSE_HOOK_DIAGNOSTICS_LOG: diagnosticsLog,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        hookProc.stdout.on('data', (data: Buffer) => { out += data.toString(); });
        hookProc.on('close', (c: number) => resolve({ code: c, stdout: out }));
        hookProc.stdin.write(JSON.stringify({
          toolName: 'Bash',
          toolInput: { command: 'pwd' },
        }));
        hookProc.stdin.end();
      });

      expect(code).toBe(0);
      expect(stdout).toBe('');
      const diagnosticLines = (await fs.readFile(diagnosticsLog, 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(diagnosticLines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'received_input',
            platform: 'codex',
            rawInput: JSON.stringify({
              toolName: 'Bash',
              toolInput: { command: 'pwd' },
            }),
          }),
          expect.objectContaining({
            event: 'complete',
            outcome: 'fail_open',
            stage: 'port_discovery_failed',
            platform: 'codex',
            toolName: 'Bash',
            normalizedResponseLength: 0,
            emittedResponseLength: 0,
          }),
        ]),
      );

      await fs.rm(tempHome, { recursive: true, force: true });
    });

    itBash('hook script should preserve empty stdout for legacy Codex allow responses', async () => {
      let testPort = 0;
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/evaluate_permission') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({}));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.writeFile(PORT_FILE, String(testPort), 'utf-8');

      const { code, stdout } = await runHookScript(
        {
          toolName: 'Bash',
          toolInput: { command: 'pwd' },
        },
        { DOLLHOUSE_HOOK_PLATFORM: 'codex' },
      );

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.unlink(PORT_FILE).catch(() => {});
      await fs.unlink(PID_PORT_FILE).catch(() => {});

      expect(code).toBe(0);
      expect(stdout).toBe('');
    });

    itBash('cursor hook wrapper should preserve Cursor permission responses', async () => {
      let testPort = 0;
      let capturedBody: Record<string, unknown> | null = null;
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/evaluate_permission') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            capturedBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              permission: 'deny',
              reason: 'Blocked by policy',
            }));
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.writeFile(PORT_FILE, String(testPort), 'utf-8');

      const { code, stdout } = await runHookScript(
        {
          toolName: 'Bash',
          toolInput: { command: 'git status' },
        },
        {},
        CURSOR_HOOK_SCRIPT,
      );

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.unlink(PORT_FILE).catch(() => {});
      await fs.unlink(PID_PORT_FILE).catch(() => {});

      expect(code).toBe(0);
      expect(capturedBody).toEqual({
        tool_name: 'Bash',
        input: { command: 'git status' },
        platform: 'cursor',
        session_id: 'session-hook-test',
      });
      expect(JSON.parse(stdout.trim())).toEqual({
        permission: 'deny',
        reason: 'Blocked by policy',
      });
    });

    itBash('gemini hook wrapper should preserve Gemini decision payloads', async () => {
      let testPort = 0;
      let capturedBody: Record<string, unknown> | null = null;
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/evaluate_permission') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            capturedBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              decision: 'allow',
            }));
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.writeFile(PORT_FILE, String(testPort), 'utf-8');

      const { code, stdout } = await runHookScript(
        {
          toolName: 'Write',
          toolInput: { file_path: 'notes.txt' },
        },
        {},
        GEMINI_HOOK_SCRIPT,
      );

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.unlink(PORT_FILE).catch(() => {});
      await fs.unlink(PID_PORT_FILE).catch(() => {});

      expect(code).toBe(0);
      expect(capturedBody).toEqual({
        tool_name: 'Write',
        input: { file_path: 'notes.txt' },
        platform: 'gemini',
        session_id: 'session-hook-test',
      });
      expect(JSON.parse(stdout.trim())).toEqual({
        decision: 'allow',
      });
    });

    itBash('vscode hook wrapper should normalize terminal commands and preserve ask responses', async () => {
      let testPort = 0;
      let capturedBody: Record<string, unknown> | null = null;
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/evaluate_permission') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            capturedBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'ask',
                permissionDecisionReason: 'Needs approval',
              },
            }));
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.writeFile(PORT_FILE, String(testPort), 'utf-8');

      const { code, stdout } = await runHookScript(
        {
          toolName: 'runTerminalCommand',
          toolInput: { command: 'npm install' },
          cwd: '/workspace',
        },
        {},
        VSCODE_HOOK_SCRIPT,
      );

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.unlink(PORT_FILE).catch(() => {});
      await fs.unlink(PID_PORT_FILE).catch(() => {});

      expect(code).toBe(0);
      expect(capturedBody).toEqual({
        tool_name: 'Bash',
        input: {
          command: 'npm install',
          cwd: '/workspace',
        },
        platform: 'vscode',
        session_id: 'session-hook-test',
      });
      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'Needs approval',
        },
      });
    });

    itBash('vscode hook wrapper should fail open silently on malformed responses', async () => {
      let testPort = 0;
      let capturedBody: Record<string, unknown> | null = null;
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/evaluate_permission') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            capturedBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ unexpected: true }));
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.writeFile(PORT_FILE, String(testPort), 'utf-8');

      const { code, stdout } = await runHookScript(
        {
          toolName: 'runTerminalCommand',
          toolInput: { command: 'npm test' },
        },
        {},
        VSCODE_HOOK_SCRIPT,
      );

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.unlink(PORT_FILE).catch(() => {});
      await fs.unlink(PID_PORT_FILE).catch(() => {});

      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
      expect(capturedBody).toEqual({
        tool_name: 'Bash',
        input: { command: 'npm test' },
        platform: 'vscode',
        session_id: 'session-hook-test',
      });
    });

    itBash('windsurf hook wrapper should map deny decisions to exit code 2', async () => {
      let testPort = 0;
      let capturedBody: Record<string, unknown> | null = null;
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/evaluate_permission') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            capturedBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              allowed: false,
              reason: 'Blocked by policy',
            }));
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.writeFile(PORT_FILE, String(testPort), 'utf-8');

      const { code, stdout, stderr } = await runHookScript(
        {
          hook_event_name: 'pre_mcp_tool_use',
          tool_name: 'Read',
          tool_arguments: { file_path: 'src/index.ts' },
        },
        {},
        WINDSURF_HOOK_SCRIPT,
      );

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.unlink(PORT_FILE).catch(() => {});
      await fs.unlink(PID_PORT_FILE).catch(() => {});

      expect(code).toBe(2);
      expect(stdout.trim()).toBe('');
      expect(stderr).toContain('Blocked by policy');
      expect(capturedBody).toEqual({
        tool_name: 'Read',
        input: { file_path: 'src/index.ts' },
        platform: 'windsurf',
        session_id: 'session-hook-test',
      });
    });

    itBash('hook script should fall back to the newest live PID-keyed port file and restore the shared file', async () => {
      let testPort = 0;
      let capturedBody: Record<string, unknown> | null = null;
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/evaluate_permission') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            capturedBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
              },
            }));
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.unlink(PORT_FILE).catch(() => {});
      await fs.writeFile(PID_PORT_FILE, String(testPort), 'utf-8');

      const { code, stdout } = await runHookScript({
        tool_name: 'Read',
        tool_input: { file_path: './test-fixture.txt' },
      });

      const restoredPort = await fs.readFile(PORT_FILE, 'utf-8');

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.unlink(PORT_FILE).catch(() => {});
      await fs.unlink(PID_PORT_FILE).catch(() => {});

      expect(code).toBe(0);
      expect(restoredPort.trim()).toBe(String(testPort));
      expect(capturedBody).toEqual({
        tool_name: 'Read',
        input: { file_path: './test-fixture.txt' },
        platform: 'claude_code',
        session_id: 'session-hook-test',
      });
      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    });
  });

  describe('error recovery', () => {
    it('Container should log warning and continue when permission server fails', async () => {
      // Verify the Container's error handling pattern exists
      const containerSource = await fs.readFile(
        path.join(process.cwd(), 'src/di/Container.ts'),
        'utf-8'
      );

      // The catch block should log a warning, not throw
      expect(containerSource).toContain(
        "logger.warn('[Container] Permission server startup failed:'"
      );

      // It should still call endPhase (cleanup) even on error
      expect(containerSource).toContain("timer?.endPhase('permission_server')");
    });

    it('should handle unreachable server in HTTP request gracefully', async () => {
      // Hitting a port where nothing is listening should not crash
      const unusedPort = await reserveUnusedLoopbackPort();
      const response = await httpPost(unusedPort, {
        tool_name: 'Read',
        input: {},
        platform: 'claude_code',
      }).catch(err => ({ error: err.message }));

      expect(response).toHaveProperty('error');
    });
  });
});

/**
 * Helper: POST JSON to localhost and parse response.
 */
function httpPost(port: number, body: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/evaluate_permission',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 5000,
      },
      (res) => {
        let responseData = '';
        res.on('data', chunk => { responseData += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseData));
          } catch {
            resolve({ raw: responseData });
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

/**
 * Bind a test server on loopback using an OS-assigned port.
 */
function listenOnLoopback(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to determine loopback port'));
        return;
      }
      resolve(address.port);
    });
  });
}

/**
 * Reserve an unused loopback port, then immediately release it so the caller
 * can verify connection-failure behavior against a realistically free port.
 */
async function reserveUnusedLoopbackPort(): Promise<number> {
  const placeholderServer = http.createServer();
  const port = await listenOnLoopback(placeholderServer);
  await new Promise<void>((resolve, reject) => {
    placeholderServer.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}

function runHookScript(
  payload: Record<string, unknown>,
  envOverrides: Record<string, string> = {},
  scriptPath = HOOK_SCRIPT,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const hookProc = spawn(BASH_BINARY, [scriptPath], {
      env: {
        HOME: os.homedir(),
        PATH: SAFE_TEST_PATH,
        DOLLHOUSE_SESSION_ID: 'session-hook-test',
        DOLLHOUSE_HOOK_DIAGNOSTICS_LOG: path.join(
          os.tmpdir(),
          `permission-hook-test-${process.pid}-${Date.now()}-${randomUUID()}.jsonl`,
        ),
        ...envOverrides,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    hookProc.stdout.on('data', (data: Buffer) => { out += data.toString(); });
    hookProc.stderr.on('data', (data: Buffer) => { err += data.toString(); });
    hookProc.on('close', (c: number) => resolve({ code: c, stdout: out, stderr: err }));
    hookProc.stdin.write(JSON.stringify(payload));
    hookProc.stdin.end();
  });
}
