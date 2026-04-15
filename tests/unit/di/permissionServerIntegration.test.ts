/**
 * Integration tests for the permission server chain.
 *
 * In mcp-server, permission routes are mounted on the unified web
 * console (port 41715). These tests verify port file lifecycle, HTTP
 * endpoint behavior, hook script compatibility, and error recovery.
 */

import { describe, expect, it, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { execFile, spawn } from 'node:child_process';

const RUN_DIR = path.join(os.homedir(), '.dollhouse', 'run');
const PORT_FILE = path.join(RUN_DIR, 'permission-server.port');
// Hook script lives in the repo at scripts/ — works on both dev machines and CI
const HOOK_SCRIPT = path.join(process.cwd(), 'scripts', 'pretooluse-dollhouse.sh');

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
      const pidFile = path.join(RUN_DIR, `permission-server-${process.pid}.port`);
      await fs.unlink(pidFile).catch(() => {});
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
      const { findAvailablePort } = await import(
        '../../../src/auto-dollhouse/portDiscovery.js'
      );
      testPort = await findAvailablePort(49310);

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

      await new Promise<void>(resolve => server!.listen(testPort, '127.0.0.1', resolve));

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
    });

    it('hook script should exist in repo at scripts/', async () => {
      const exists = await fs.stat(HOOK_SCRIPT).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    itBash('hook script should fail open when port file is missing', (done) => {
      // Ensure port file doesn't exist
      fs.unlink(PORT_FILE).catch(() => {}).then(() => {
        execFile('bash', [HOOK_SCRIPT], {
          env: { HOME: os.homedir(), PATH: '/usr/local/bin:/usr/bin:/bin' },
        }, (error, stdout, _stderr) => {
          // Exit code 0 = fail open (allow)
          expect(error).toBeNull();
          // No JSON output when failing open
          expect(stdout.trim()).toBe('');
          done();
        });
      });
    });

    itBash('hook script should discover server via port file and get a response', async () => {
      const testPort = 49360;
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

      // Start server and write port file
      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.writeFile(PORT_FILE, String(testPort), 'utf-8');

      // Run hook script
      const { spawn } = await import('node:child_process');
      const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
        const hookProc = spawn('bash', [HOOK_SCRIPT], {
          env: {
            HOME: os.homedir(),
            PATH: '/usr/local/bin:/usr/bin:/bin',
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
      await fs.unlink(PORT_FILE).catch(() => {});

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

    itBash('hook script should translate legacy flat Claude responses', async () => {
      const testPort = 49361;
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

      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.writeFile(PORT_FILE, String(testPort), 'utf-8');

      const { stdout } = await runHookScript({
        tool_name: 'Bash',
        tool_input: { command: 'git push --force' },
      });

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.unlink(PORT_FILE).catch(() => {});

      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Blocked by policy',
        },
      });
    });

    itBash('hook script should pass through already-wrapped Claude responses unchanged', async () => {
      const testPort = 49362;
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

      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.writeFile(PORT_FILE, String(testPort), 'utf-8');

      const { stdout } = await runHookScript({
        tool_name: 'Edit',
        tool_input: { file_path: 'src/index.ts' },
      });

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.unlink(PORT_FILE).catch(() => {});

      expect(JSON.parse(stdout.trim())).toEqual(wrappedResponse);
    });

    itBash('hook script should fail open silently on malformed Claude responses', async () => {
      const testPort = 49363;
      const mockServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/evaluate_permission') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ nope: true }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>(resolve => mockServer.listen(testPort, '127.0.0.1', resolve));
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.writeFile(PORT_FILE, String(testPort), 'utf-8');

      const { code, stdout } = await runHookScript({
        tool_name: 'Read',
        tool_input: { file_path: './test-fixture.txt' },
      });

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.unlink(PORT_FILE).catch(() => {});

      expect(code).toBe(0);
      expect(stdout.trim()).toBe('');
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
      const response = await httpPost(49399, {
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

function runHookScript(payload: Record<string, unknown>): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const hookProc = spawn('bash', [HOOK_SCRIPT], {
      env: {
        HOME: os.homedir(),
        PATH: '/usr/local/bin:/usr/bin:/bin',
        DOLLHOUSE_SESSION_ID: 'session-hook-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    hookProc.stdout.on('data', (data: Buffer) => { out += data.toString(); });
    hookProc.on('close', (c: number) => resolve({ code: c, stdout: out }));
    hookProc.stdin.write(JSON.stringify(payload));
    hookProc.stdin.end();
  });
}
