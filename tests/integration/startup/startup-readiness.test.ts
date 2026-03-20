/**
 * Integration tests for MCP Startup Race Hardening (Issue #706)
 *
 * These tests spawn the actual server process and verify:
 * 1. DOLLHOUSEMCP_READY sentinel appears on stderr after connect
 * 2. Tool calls sent immediately after READY succeed (buffered by deferred setup)
 * 3. get_build_info returns startup timing data and readiness status
 *
 * The key test injects artificial deferred-setup delay (3s) via
 * DOLLHOUSE_TEST_DEFERRED_DELAY_MS, then fires a tool call immediately after
 * READY. Without the buffering fix, this call would return incomplete data.
 * With the fix, the call is held until deferred setup finishes.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

const SERVER_PATH = path.join(process.cwd(), 'dist', 'index.js');
let nextId = 1;

/** Send a JSON-RPC request and wait for the matching response. */
function sendRequest(
  proc: ChildProcess,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 20_000,
): Promise<{ result?: any; error?: any }> {
  const id = nextId++;
  const request = { jsonrpc: '2.0', id, method, params };

  return new Promise((resolve, reject) => {
    let stdoutBuf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Request '${method}' (id=${id}) timed out after ${timeoutMs}ms. stdout buffer: ${stdoutBuf.slice(-200)}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      // Messages are newline-delimited JSON — try parsing each line
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop()!; // keep incomplete trailing chunk
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            cleanup();
            resolve(msg);
            return;
          }
        } catch {
          // Not valid JSON — ignore
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout?.removeListener('data', onData);
    };

    proc.stdout?.on('data', onData);
    proc.stdin?.write(JSON.stringify(request) + '\n');
  });
}

/** Wait for DOLLHOUSEMCP_READY on stderr (or timeout). */
function waitForReady(proc: ChildProcess, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderrBuf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`DOLLHOUSEMCP_READY not seen within ${timeoutMs}ms. stderr so far: ${stderrBuf.slice(-500)}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.includes('DOLLHOUSEMCP_READY')) {
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      proc.stderr?.removeListener('data', onData);
    };

    proc.stderr?.on('data', onData);
  });
}

describe('Startup Readiness (Issue #706)', () => {
  let testDir: string;
  let portfolioDir: string;

  beforeAll(async () => {
    // Verify build exists
    await fs.access(SERVER_PATH);
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-startup-test-'));
    portfolioDir = path.join(testDir, 'portfolio');
    await fs.mkdir(portfolioDir, { recursive: true });
    await fs.mkdir(path.join(portfolioDir, 'personas'), { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function spawnServer(extraEnv: Record<string, string> = {}): ChildProcess {
    // Build a clean env: remove JEST_WORKER_ID so the server's auto-start
    // guard doesn't suppress execution, and remove NODE_OPTIONS that may
    // include Jest-specific flags.
    const cleanEnv = { ...process.env };
    delete cleanEnv.JEST_WORKER_ID;
    delete cleanEnv.NODE_OPTIONS;

    return spawn('node', [SERVER_PATH], {
      env: {
        ...cleanEnv,
        NODE_ENV: 'production',
        DOLLHOUSE_DISABLE_ENCRYPTION: 'true',
        DOLLHOUSE_PORTFOLIO_DIR: portfolioDir,
        HOME: testDir,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  it('should emit DOLLHOUSEMCP_READY on stderr', async () => {
    const proc = spawnServer();
    try {
      await waitForReady(proc, 15_000);
      // If we get here, the sentinel was seen
      expect(true).toBe(true);
    } finally {
      proc.kill();
    }
  }, 20_000);

  it('should accept tool calls immediately after READY (with deferred delay)', async () => {
    // Inject 3s artificial delay into deferred setup.
    // Without buffering, a tool call sent during this window would return
    // incomplete data (deferredSetupComplete=false and possibly missing memories).
    // With buffering, the call is held until deferred setup finishes.
    const proc = spawnServer({ DOLLHOUSE_TEST_DEFERRED_DELAY_MS: '3000' });

    try {
      // Wait for server to emit READY (tools registered, connect done)
      await waitForReady(proc, 15_000);

      // MCP protocol handshake
      const initResp = await sendRequest(proc, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'startup-test', version: '1.0.0' },
      });
      expect(initResp.result).toBeDefined();

      // Send initialized notification (required by MCP protocol)
      proc.stdin?.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n');

      // Immediately call get_build_info via mcp_aql_read.
      // The deferred setup is still running (3s delay).
      // Phase 4 buffering should hold this call until deferred setup completes.
      const callResp = await sendRequest(proc, 'tools/call', {
        name: 'mcp_aql_read',
        arguments: { operation: 'get_build_info' },
      });

      // The response should exist and contain startup timing data
      expect(callResp.result).toBeDefined();
      expect(callResp.result.content).toBeDefined();
      expect(callResp.result.content.length).toBeGreaterThan(0);

      const text = callResp.result.content[0].text;
      // After buffering, deferred setup should be complete
      expect(text).toContain('Startup');
      expect(text).toContain('Ready');
    } finally {
      proc.kill();
    }
  }, 30_000);

  it('should return startup timing in get_build_info', async () => {
    const proc = spawnServer();

    try {
      await waitForReady(proc, 15_000);

      // Handshake
      await sendRequest(proc, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'startup-test', version: '1.0.0' },
      });
      proc.stdin?.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n');

      // Wait a moment for deferred setup to complete naturally
      await new Promise(resolve => setTimeout(resolve, 2000));

      const callResp = await sendRequest(proc, 'tools/call', {
        name: 'mcp_aql_read',
        arguments: { operation: 'get_build_info' },
      });

      const text = callResp.result.content[0].text;

      // Should contain startup timing section
      expect(text).toContain('Startup');
      expect(text).toContain('Critical Path');
      expect(text).toContain('Deferred Work');
      expect(text).toContain('Total Startup');
    } finally {
      proc.kill();
    }
  }, 25_000);

  it('should list tools after READY', async () => {
    const proc = spawnServer();

    try {
      await waitForReady(proc, 15_000);

      // Handshake
      await sendRequest(proc, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'startup-test', version: '1.0.0' },
      });
      proc.stdin?.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n');

      const listResp = await sendRequest(proc, 'tools/list', {});

      expect(listResp.result).toBeDefined();
      expect(listResp.result.tools).toBeDefined();
      expect(listResp.result.tools.length).toBeGreaterThan(0);

      // Should have CRUDE tools
      const toolNames = listResp.result.tools.map((t: any) => t.name);
      expect(toolNames).toContain('mcp_aql_read');
    } finally {
      proc.kill();
    }
  }, 20_000);
});
