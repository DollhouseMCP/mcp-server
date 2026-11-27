import { isolatedServerEnv } from '../../helpers/isolated-server-env.cjs';
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

import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Hook script lives in the repo at scripts/ — works on both dev machines and CI
const HOOK_SCRIPT = path.join(process.cwd(), 'scripts', 'pretooluse-dollhouse.sh');
const CODEX_HOOK_SCRIPT = path.join(process.cwd(), 'scripts', 'pretooluse-codex.sh');
const CURSOR_HOOK_SCRIPT = path.join(process.cwd(), 'scripts', 'pretooluse-cursor.sh');
const GEMINI_HOOK_SCRIPT = path.join(process.cwd(), 'scripts', 'pretooluse-gemini.sh');
const VSCODE_HOOK_SCRIPT = path.join(process.cwd(), 'scripts', 'pretooluse-vscode.sh');
const WINDSURF_HOOK_SCRIPT = path.join(process.cwd(), 'scripts', 'pretooluse-windsurf.sh');
const SAFE_TEST_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const BASH_BINARY = '/bin/bash';

describe('Permission Server Integration', () => {
  // Use a unique tmp dir as the run directory for every test (DOLLHOUSE_RUN_DIR
  // override). Without this, parallel test execution races against
  // tests/unit/web/portDiscovery.test.ts on the shared `permission-server.port`.
  let RUN_DIR: string;
  let PORT_FILE: string;
  let PID_PORT_FILE: string;

  beforeEach(async () => {
    RUN_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'permsrv-integ-'));
    PORT_FILE = path.join(RUN_DIR, 'permission-server.port');
    PID_PORT_FILE = path.join(RUN_DIR, `permission-server-${process.pid}.port`);
    process.env.DOLLHOUSE_RUN_DIR = RUN_DIR;
  });

  afterEach(async () => {
    delete process.env.DOLLHOUSE_RUN_DIR;
    if (RUN_DIR) await fs.rm(RUN_DIR, { recursive: true, force: true });
  });

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

    itBash('hook script should defer a read when the port file is missing', async () => {
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dollhouse-hook-home-'));
      const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
        const hookProc = spawn(BASH_BINARY, [HOOK_SCRIPT], {
          env: isolatedServerEnv(tempHome, { HOME: tempHome, PATH: SAFE_TEST_PATH }),
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
      expect(stdout).toBe('');
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
          env: isolatedServerEnv(tempHome, { HOME: tempHome, PATH: SAFE_TEST_PATH }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        hookProc.stdout.on('data', (data: Buffer) => { out += data.toString(); });
        hookProc.on('close', (c: number) => resolve({ code: c, stdout: out }));
        hookProc.stdin.write(JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'pwd' },
        }));
        hookProc.stdin.end();
      });

      await fs.rm(tempHome, { recursive: true, force: true });

      expect(code).toBe(0);
      expect(stdout).toBe('');
    });

    itBash.each([
      ['Claude Code', HOOK_SCRIPT, { tool_name: 'MultiEdit' }, 0, 'ask'],
      ['VS Code', VSCODE_HOOK_SCRIPT, { toolName: 'createFile', toolArgs: {} }, 0, 'ask'],
      ['Codex', CODEX_HOOK_SCRIPT, { tool_name: 'exec_command' }, 0, 'deny'],
      ['Cursor preToolUse', CURSOR_HOOK_SCRIPT, { hook_event_name: 'preToolUse', tool_name: 'Shell' }, 0, 'deny'],
      ['Cursor Delete', CURSOR_HOOK_SCRIPT, { hook_event_name: 'preToolUse', tool_name: 'Delete' }, 0, 'deny'],
      ['Cursor MCP: merge', CURSOR_HOOK_SCRIPT, { hook_event_name: 'preToolUse', tool_name: 'McP:Merge_Pull_Request' }, 0, 'deny'],
      ['Cursor MCP: compound name', CURSOR_HOOK_SCRIPT, { hook_event_name: 'preToolUse', tool_name: 'MCP:Get_And_Delete' }, 0, 'deny'],
      ['Cursor beforeShellExecution', CURSOR_HOOK_SCRIPT, { hook_event_name: 'beforeShellExecution', command: 'pwd' }, 0, 'ask'],
      ['Gemini', GEMINI_HOOK_SCRIPT, { tool_name: 'run_shell_command' }, 0, 'deny'],
      ['Windsurf', WINDSURF_HOOK_SCRIPT, { agent_action_name: 'pre_mcp_tool_use', tool_info: { mcp_tool_name: 'create_issue' } }, 2, 'deny'],
    ] as const)('%s applies its supported outcome during an outage', async (_client, script, input, code, decision) => {
      const result = await runHookScript(input, {}, script);
      expect(result.code).toBe(code);
      if (code === 2) {
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('Restart the DollhouseMCP server');
        return;
      }
      const output = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput?.permissionDecision ?? output.permission ?? output.decision).toBe(decision);
      const reason = output.hookSpecificOutput?.permissionDecisionReason ?? output.user_message ?? output.reason;
      expect(reason).toContain('Restart the DollhouseMCP server');
      expect(reason).toContain(PORT_FILE);
      expect(reason).toContain('diagnostics at');
    });

    itBash('identifies unprefixed MCP tools from the native Cursor and Windsurf events', async () => {
      const cursor = await runHookScript({
        hook_event_name: 'beforeMCPExecution',
        tool_name: 'send_message',
        tool_input: '{"message":"hello"}',
        mcp_server_name: 'example',
      }, {}, CURSOR_HOOK_SCRIPT);
      expect(JSON.parse(cursor.stdout)).toEqual(expect.objectContaining({ permission: 'ask' }));

      const windsurf = await runHookScript({
        agent_action_name: 'pre_mcp_tool_use',
        tool_info: { mcp_tool_name: 'read_issue', mcp_tool_arguments: { number: 1 } },
      }, {}, WINDSURF_HOOK_SCRIPT);
      expect(windsurf).toEqual({ code: 0, stdout: '', stderr: '' });
    });

    itBash.each([HOOK_SCRIPT, VSCODE_HOOK_SCRIPT, CODEX_HOOK_SCRIPT, CURSOR_HOOK_SCRIPT, GEMINI_HOOK_SCRIPT, WINDSURF_HOOK_SCRIPT])(
      '%s emits no decision for a read during an outage',
      async (script) => {
        expect(await runHookScript({ tool_name: 'Read' }, {}, script)).toEqual({ code: 0, stdout: '', stderr: '' });
      },
    );

    itBash('defers a mixed-case MCP: read in Cursor', async () => {
      const result = await runHookScript(
        { hook_event_name: 'preToolUse', tool_name: 'McP:ReAd_File' }, {}, CURSOR_HOOK_SCRIPT,
      );
      expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    });

    itBash.each([
      ['Bash', true], ['Write', true], ['Edit', true], ['MultiEdit', true], ['NotebookEdit', true], ['WebFetch', true],
      ['BASH', true], ['PowerShell', true], ['Monitor', true],
      ['mcp__example__execute', true], ['mcp__example__create', true], ['mcp__example__update', true],
      ['mcp__example__delete', true], ['mcp__example__send', true],
      ['mcp__X__Execute', true], ['mcp__Read_Server__push_files', true],
      ['mcp__example__run_command', true], ['mcp__example__move_file', true], ['mcp__example__click', true],
      ['mcp__example__fetch', true], ['mcp__example__reader', true],
      ['mcp__example__get_and_delete', true], ['mcp__example__list_then_write', true],
      ['mcp__example__get_or_create_issue', true], ['mcp__example__find_and_replace', true],
      ['mcp__example__read_and_archive', true], ['mcp__example__Get-Delete', true],
      ['mcp__example__get.delete', true], ['mcp__example__view:delete', true],
      ['mcp__example__get/dElEtE', true], ['mcp__example__getAndDelete', true],
      ['mcp__example__getURLThenDelete', true], ['mcp__example__query', true],
      ['mcp__example__read', false], ['MCP__Example__List_Files', false],
      ['mcp__example__get_job', false], ['mcp__example__search', false],
      ['mcp__example__get_settings', false], ['mcp__example__list_assets', false],
      ['mcp__example__getSettings', false], ['mcp__example__listAssets', false],
      ['mcp__example__find', false], ['mcp__example__view', false], ['mcp__example__describe', false],
      ['mcp__example__fetch_without_side_effects', false], ['mcp__example__status', false], ['Read', false],
    ] as const)('classifies %s during an outage', async (toolName, shouldAsk) => {
      const { stdout } = await runHookScript({ tool_name: toolName });
      if (shouldAsk) expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('ask');
      else expect(stdout).toBe('');
    });

    itBash('supports configured high-risk tool names and MCP verbs', async () => {
      const env = {
        DOLLHOUSE_HOOK_OUTAGE_HIGH_RISK_TOOLS: 'READ',
        DOLLHOUSE_HOOK_OUTAGE_MCP_HIGH_RISK_PATTERN: 'SEARCH',
      };
      const read = await runHookScript({ tool_name: 'Read' }, env);
      const search = await runHookScript({ tool_name: 'mcp__example__search' }, env);
      const write = await runHookScript({ tool_name: 'Write' }, env);
      expect(JSON.parse(read.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
      expect(JSON.parse(search.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
      expect(write.stdout).toBe('');
    });

    itBash('defaults empty classification overrides and matches a configured read-only regex case-insensitively', async () => {
      const defaults = {
        DOLLHOUSE_HOOK_OUTAGE_HIGH_RISK_TOOLS: '',
        DOLLHOUSE_HOOK_OUTAGE_MCP_HIGH_RISK_PATTERN: '',
        DOLLHOUSE_HOOK_OUTAGE_MCP_READ_ONLY_PATTERN: '',
      };
      const bash = await runHookScript({ tool_name: 'Bash' }, defaults);
      const merge = await runHookScript({ tool_name: 'mcp__example__merge' }, defaults);
      const get = await runHookScript({ tool_name: 'mcp__example__get_file' }, defaults);
      expect(JSON.parse(bash.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
      expect(JSON.parse(merge.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
      expect(get.stdout).toBe('');
      const custom = await runHookScript({ tool_name: 'mcp__example__LOOKUP' }, {
        DOLLHOUSE_HOOK_OUTAGE_MCP_READ_ONLY_PATTERN: '^LOOKUP$',
      });
      expect(custom.stdout).toBe('');
    });

    itBash('keeps write, joining, and query words high-risk with a read-only override', async () => {
      const env = { DOLLHOUSE_HOOK_OUTAGE_MCP_READ_ONLY_PATTERN: '^(GET|QUERY)$' };
      for (const tool_name of ['mcp__example__get_delete', 'mcp__example__get_then_file', 'mcp__example__query']) {
        const { stdout } = await runHookScript({ tool_name }, env);
        expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('ask');
      }
    });

    itBash.each(['DOLLHOUSE_HOOK_OUTAGE_MCP_HIGH_RISK_PATTERN', 'DOLLHOUSE_HOOK_OUTAGE_MCP_READ_ONLY_PATTERN'])(
      'treats even a read as high-risk with an invalid %s',
      async variable => {
        const { stdout } = await runHookScript({ tool_name: 'mcp__example__read_file' }, { [variable]: '[' });
        expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('ask');
      },
    );

    itBash.each([
      ['unparseable JSON', '{"tool_name":', true],
      ['missing name', '{}', true],
      ['invalid Bash input', '{"tool_name":"Bash","tool_input":[]}', true],
      ['invalid Read input', '{"tool_name":"Read","tool_input":[]}', false],
    ] as const)('handles %s as an outage', async (_title, input, shouldAsk) => {
      const { stdout } = await runHookScript(input);
      if (shouldAsk) {
        expect(JSON.parse(stdout).hookSpecificOutput).toEqual(expect.objectContaining({
          permissionDecision: 'ask',
          permissionDecisionReason: expect.stringContaining('could not parse the hook tool name or input'),
        }));
      } else {
        expect(stdout).toBe('');
      }
    });

    itBash.each([
      ['non-JSON', '<html>503</html>', 200],
      ['malformed decision', '{"hookSpecificOutput":{"permissionDecision":"maybe"}}', 200],
      ['malformed decision', '{}', 200],
      ['malformed decision', '{"decision":"allow"}{"decision":"deny"}', 200],
      ['HTTP error', '{"decision":"allow"}', 503],
      ['reported that evaluation is unavailable', '{"status":"outage","decision":"allow"}', 503],
      ['reported that evaluation is unavailable', '{"status":"outage","decision":"allow"}', 200],
    ] as const)('uses the outage path for %s responses', async (failure, response, status) => {
      const server = http.createServer((_req, res) => res.writeHead(status).end(response));
      const port = await listenOnLoopback(server);
      await fs.writeFile(PORT_FILE, String(port));
      try {
        const highRisk = await runHookScript({ tool_name: 'Bash' });
        const lowRisk = await runHookScript({ tool_name: 'Read' });
        expect(JSON.parse(highRisk.stdout).hookSpecificOutput).toEqual(expect.objectContaining({
          permissionDecision: 'ask',
          permissionDecisionReason: expect.stringContaining(failure),
        }));
        expect(lowRisk.stdout).toBe('');
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    itBash.each([
      ['session_unavailable', 'no verified policy session', 'session authentication setup'],
      ['rate_limited', 'rate-limited', 'Wait before retrying'],
      ['invalid_decision', 'invalid decision', 'compatible versions'],
    ] as const)('names %s and gives the corresponding outage advice', async (code, summary, advice) => {
      const server = http.createServer((_req, res) => res.writeHead(503).end(JSON.stringify({
        status: 'outage', code, reason: 'untrusted server text',
      })));
      const port = await listenOnLoopback(server);
      await fs.writeFile(PORT_FILE, String(port));
      try {
        const { stdout } = await runHookScript({ tool_name: 'Bash' });
        const response = JSON.parse(stdout).hookSpecificOutput;
        expect(response.permissionDecision).toBe('ask');
        expect(response.permissionDecisionReason).toContain('DollhouseMCP Gatekeeper');
        expect(response.permissionDecisionReason).toContain(code);
        expect(response.permissionDecisionReason).toContain(summary);
        expect(response.permissionDecisionReason).toContain(advice);
        expect(response.permissionDecisionReason).not.toContain('Restart the DollhouseMCP server');
        expect(response.permissionDecisionReason).not.toContain('untrusted server text');
        const subsequent = await runHookScript({ tool_name: 'Bash' });
        expect(JSON.parse(subsequent.stdout).hookSpecificOutput.permissionDecisionReason).toContain(code);
        expect(subsequent.stdout).not.toContain(advice);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    itBash('warns fully once per outage and resets after a valid server decision', async () => {
      const server = http.createServer((_req, res) => res.end('{"decision":"allow"}'));
      const port = await listenOnLoopback(server);
      const highRisk = { tool_name: 'Bash' };
      const warning = 'Restart the DollhouseMCP server';
      try {
        const malformed = await runHookScript('{"tool_name":');
        expect(malformed.stdout).toContain("Check the client's hook configuration");
        expect(malformed.stdout).not.toContain(warning);
        expect((await runHookScript({ tool_name: 'Read' })).stdout).toBe('');
        const results = await Promise.all([runHookScript(highRisk), runHookScript(highRisk), runHookScript(highRisk)]);
        expect(results.filter(result => result.stdout.includes(warning))).toHaveLength(1);
        expect(results.map(result => JSON.parse(result.stdout).hookSpecificOutput.permissionDecision)).toEqual(['ask', 'ask', 'ask']);

        await fs.writeFile(PORT_FILE, String(port));
        expect(JSON.parse((await runHookScript(highRisk)).stdout).hookSpecificOutput.permissionDecision).toBe('allow');
        for (const tool_name of ['mcp__example__read_file', 'mcp__example__run_command']) {
          const evaluated = await runHookScript({ tool_name });
          expect(JSON.parse(evaluated.stdout).hookSpecificOutput.permissionDecision).toBe('allow');
        }
        await fs.unlink(PORT_FILE);

        expect((await runHookScript(highRisk)).stdout).toContain(warning);
        expect((await runHookScript(highRisk)).stdout).not.toContain(warning);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
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
          req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
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
          env: isolatedServerEnv(tempHome, {
            HOME: tempHome,
            PATH: SAFE_TEST_PATH,
            DOLLHOUSE_SESSION_ID: 'session-hook-test',
            DOLLHOUSE_RUN_DIR: tempRunDir,
          }),
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
          env: isolatedServerEnv(tempHome, {
            HOME: tempHome,
            PATH: SAFE_TEST_PATH,
            DOLLHOUSE_HOOK_PLATFORM: 'codex',
          }),
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
        { HOME: tempHome, DOLLHOUSE_RUN_DIR: tempRunDir },
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
        { HOME: tempHome, DOLLHOUSE_RUN_DIR: tempRunDir },
      );

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.rm(tempHome, { recursive: true, force: true });

      expect(JSON.parse(stdout.trim())).toEqual(wrappedResponse);
    });

    itBash('hook script should defer a read on a malformed Claude response', async () => {
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
      expect(stdout).toBe('');
    });

    itBash('hook script should ask for Bash and defer reads when permission requests time out', async () => {
      let testPort = 0;
      const mockServer = http.createServer((_req, _res) => {
        // Intentionally never respond so curl hits its max-time window.
      });

      testPort = await listenOnLoopback(mockServer);
      await fs.mkdir(RUN_DIR, { recursive: true });
      await fs.writeFile(PORT_FILE, String(testPort), 'utf-8');

      const env = {
        DOLLHOUSE_HOOK_INITIAL_TIMEOUT: '1',
        DOLLHOUSE_HOOK_MAX_RETRIES: '0',
      };
      const [read, bash] = await Promise.all([
        runHookScript({ tool_name: 'Read', tool_input: { file_path: './test-fixture.txt' } }, env),
        runHookScript({ tool_name: 'Bash', tool_input: { command: 'pwd' } }, env),
      ]);

      await new Promise<void>(resolve => mockServer.close(() => resolve()));
      await fs.unlink(PORT_FILE).catch(() => {});
      await fs.unlink(PID_PORT_FILE).catch(() => {});

      expect(read).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(bash.code).toBe(0);
      expect(JSON.parse(bash.stdout).hookSpecificOutput).toEqual(expect.objectContaining({
        permissionDecision: 'ask',
        permissionDecisionReason: expect.stringContaining('the permission server is not responding (timed out)'),
      }));
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
      expect(stdout).toBe('');
      expect(elapsedMs).toBeLessThan(20_000);
    }, 20000);

    itBash.each([
      [7, 'the permission server is not running or is refusing connections'],
      [28, 'the permission server is not responding (timed out)'],
    ] as const)('caps curl and explains transport error %s when retry budget is exhausted', async (curlExit, failure) => {
      const binDir = path.join(RUN_DIR, 'bin');
      const calls = path.join(RUN_DIR, 'curl-args');
      const fixedClock = path.join(RUN_DIR, 'fixed-clock.sh');
      await fs.mkdir(binDir);
      await fs.writeFile(fixedClock, 'unset SECONDS\nSECONDS=0\n');
      await fs.writeFile(path.join(binDir, 'curl'), [
        '#!/bin/bash',
        'printf "%s\\n" "$@" >> "$HOOK_TEST_CURL_ARGS"',
        'printf "\\n000"',
        `exit ${curlExit}`,
      ].join('\n'), { mode: 0o700 });
      await fs.writeFile(PORT_FILE, '41817');

      const { code, stdout } = await runHookScript({ tool_name: 'Bash' }, {
        PATH: [binDir, SAFE_TEST_PATH].join(path.delimiter),
        BASH_ENV: fixedClock,
        HOOK_TEST_CURL_ARGS: calls,
        DOLLHOUSE_HOOK_INITIAL_TIMEOUT: '30',
        DOLLHOUSE_HOOK_MAX_RETRIES: '5',
        DOLLHOUSE_HOOK_REQUEST_BUDGET_SECONDS: '1',
      });

      const args = (await fs.readFile(calls, 'utf8')).split('\n');
      expect(args.filter(arg => arg === '--max-time')).toHaveLength(1);
      expect(args[args.indexOf('--max-time') + 1]).toBe('1');
      expect(code).toBe(0);
      const response = JSON.parse(stdout).hookSpecificOutput;
      expect(response.permissionDecision).toBe('ask');
      expect(response.permissionDecisionReason).toContain("within the hook's request budget");
      expect(response.permissionDecisionReason).toContain(failure);
    });

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

    itBash('codex hook wrapper should block Bash when the server is not ready and record the outage', async () => {
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dollhouse-hook-home-'));
      const codexScript = path.join(tempHome, 'pretooluse-codex.sh');
      const sharedScript = path.join(tempHome, 'pretooluse-dollhouse.sh');
      const portHelper = path.join(tempHome, 'permission-port-discovery.sh');
      const configHelper = path.join(tempHome, 'permission-hook-config.sh');
      const runDir = path.join(tempHome, '.dollhouse', 'run');
      const diagnosticsLog = path.join(runDir, 'permission-hook-diagnostics', 'permission-hook-diagnostics.jsonl');
      const legacyLog = path.join(runDir, 'permission-hook-diagnostics.jsonl');
      const secretInput = 'fixture-private-command';
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(legacyLog, 'legacy evidence', { mode: 0o644 });
      for (const asset of ['permission-hook-diagnostics.mjs', 'recoverable-file-write-lock.mjs']) {
        await fs.copyFile(path.join(process.cwd(), 'scripts', asset), path.join(tempHome, asset));
      }

      await fs.copyFile(path.join(process.cwd(), 'scripts', 'pretooluse-codex.sh'), codexScript);
      await fs.copyFile(path.join(process.cwd(), 'scripts', 'pretooluse-dollhouse.sh'), sharedScript);
      await fs.copyFile(path.join(process.cwd(), 'scripts', 'permission-port-discovery.sh'), portHelper);
      await fs.copyFile(path.join(process.cwd(), 'scripts', 'permission-hook-config.sh'), configHelper);

      const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
        const hookProc = spawn(BASH_BINARY, [codexScript], {
          env: isolatedServerEnv(tempHome, {
            HOME: tempHome,
            PATH: [path.dirname(process.execPath), SAFE_TEST_PATH].join(path.delimiter),
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        hookProc.stdout.on('data', (data: Buffer) => { out += data.toString(); });
        hookProc.on('close', (c: number) => resolve({ code: c, stdout: out }));
        hookProc.stdin.write(JSON.stringify({
          toolName: 'Bash',
          toolInput: { command: secretInput },
        }));
        hookProc.stdin.end();
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('no usable permission server port file was found'),
        },
      });
      const diagnostics = await fs.readFile(diagnosticsLog, 'utf8');
      expect(diagnostics).not.toContain(secretInput);
      expect(JSON.parse(diagnostics)).toEqual({
        timestamp: expect.any(String),
        platform: 'codex',
        stage: 'port_discovery_failed',
        outcome: 'outage_deny',
        toolName: 'Bash',
        elapsedMs: expect.any(Number),
        attempt: 0,
        timeoutSeconds: 5,
      });
      expect((await fs.stat(diagnosticsLog)).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(legacyLog, 'utf8')).toBe('legacy evidence');
      expect((await fs.stat(legacyLog)).mode & 0o777).toBe(0o644);

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

    itBash('vscode hook wrapper should request approval on malformed responses', async () => {
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
      expect(JSON.parse(stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: expect.stringContaining('the permission server returned a malformed decision'),
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
  payload: Record<string, unknown> | string,
  envOverrides: Record<string, string> = {},
  scriptPath = HOOK_SCRIPT,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fixture = process.env.DOLLHOUSE_RUN_DIR!;
  return new Promise((resolve) => {
    const hookProc = spawn(BASH_BINARY, [scriptPath], {
      env: isolatedServerEnv(fixture, {
        DOLLHOUSE_PORTFOLIO_DIR: path.join(fixture, 'portfolio'),
        PATH: SAFE_TEST_PATH,
        DOLLHOUSE_SESSION_ID: 'session-hook-test',
        DOLLHOUSE_HOOK_DIAGNOSTICS_LOG: path.join(
          fixture,
          `permission-hook-test-${process.pid}-${Date.now()}-${randomUUID()}.jsonl`,
        ),
        DOLLHOUSE_RUN_DIR: fixture,
        ...envOverrides,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    hookProc.stdout.on('data', (data: Buffer) => { out += data.toString(); });
    hookProc.stderr.on('data', (data: Buffer) => { err += data.toString(); });
    hookProc.on('close', (c: number) => resolve({ code: c, stdout: out, stderr: err }));
    hookProc.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}
