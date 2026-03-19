/**
 * Integration tests for MCP Protocol Compliance
 * Issue #10: Ensure server adheres to MCP protocol stdout/stderr requirements
 *
 * MCP Protocol Specification:
 * - MCP servers MUST only write JSON-RPC messages to stdout
 * - All other output (logging, debugging, errors) MUST be written to stderr
 *
 * Reference: https://modelcontextprotocol.io/
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

describe('MCP Protocol Compliance', () => {
  let testDir: string;
  let portfolioDir: string;

  beforeAll(async () => {
    // Create unique test directories
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-protocol-test-'));
    portfolioDir = path.join(testDir, 'portfolio');
    await fs.mkdir(portfolioDir, { recursive: true });
    await fs.mkdir(path.join(portfolioDir, 'personas'), { recursive: true });
  });

  afterAll(async () => {
    // Cleanup test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  /**
   * Test: Stdout should ONLY contain JSON-RPC messages (or be empty)
   *
   * This test spawns the server and verifies that nothing non-JSON
   * is written to stdout during initialization.
   *
   * Regression test for Issue #10: dotenv outputting to stdout
   */
  it('should not output non-JSON content to stdout during initialization', async () => {
    const serverPath = path.join(process.cwd(), 'dist', 'index.js');

    // Verify server build exists
    await expect(fs.access(serverPath)).resolves.toBeUndefined();

    const env = {
      ...process.env,
      NODE_ENV: 'production',
      DOLLHOUSE_DISABLE_ENCRYPTION: 'true',
      DOLLHOUSE_PORTFOLIO_DIR: portfolioDir,
      LOG_LEVEL: 'error',
      HOME: testDir,
    };

    let stdoutData = '';
    let stderrData = '';

    const proc: ChildProcess = spawn('node', [serverPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Collect stdout and stderr
    proc.stdout?.on('data', (data) => {
      stdoutData += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderrData += data.toString();
    });

    // Wait for server to initialize (give it more time for slower environments)
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill();
        resolve();
      }, 5000);

      // If server outputs "ready" to stderr, it's initialized
      proc.stderr?.on('data', (data) => {
        if (data.toString().includes('ready')) {
          clearTimeout(timeout);
          proc.kill();
          resolve();
        }
      });
    });

    // CRITICAL: stdout must be empty or contain only valid JSON-RPC
    // During initialization, before any MCP messages, it should be empty
    expect(stdoutData).toBe('');

    // Verify stderr contains expected server output (dotenv or server logs)
    // At minimum, it should have SOME output
    expect(stderrData.length).toBeGreaterThan(0);
  }, 15000);

  /**
   * Test: dotenv output should go to stderr, not stdout
   *
   * Specific regression test for Issue #10
   */
  it('should redirect dotenv output to stderr, not stdout', async () => {
    const serverPath = path.join(process.cwd(), 'dist', 'index.js');

    const env = {
      ...process.env,
      NODE_ENV: 'production',
      DOLLHOUSE_DISABLE_ENCRYPTION: 'true',
      DOLLHOUSE_PORTFOLIO_DIR: portfolioDir,
      LOG_LEVEL: 'debug', // Enable debug logging to ensure dotenv runs
      HOME: testDir,
    };

    let stdoutData = '';

    const proc: ChildProcess = spawn('node', [serverPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (data) => {
      stdoutData += data.toString();
    });

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        proc.kill();
        resolve();
      }, 5000);
    });

    // Verify no dotenv output appears in stdout
    expect(stdoutData).not.toContain('dotenv');
    expect(stdoutData).not.toContain('[dotenv@');
  }, 15000);

  /**
   * Test: Encryption disabled flag should be honored
   *
   * Regression test for Issue #10: encryption initialization error
   * Note: This test verifies the server doesn't crash with encryption disabled
   */
  it.skip('should start successfully with DOLLHOUSE_DISABLE_ENCRYPTION=true', async () => {
    const serverPath = path.join(process.cwd(), 'dist', 'index.js');

    const env = {
      ...process.env,
      NODE_ENV: 'production',
      DOLLHOUSE_DISABLE_ENCRYPTION: 'true',
      DOLLHOUSE_PORTFOLIO_DIR: portfolioDir,
      HOME: testDir,
    };

    let _stderrData = '';
    let serverReady = false;
    let encryptionError = false;

    const proc: ChildProcess = spawn('node', [serverPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stderr?.on('data', (data) => {
      const output = data.toString();
      _stderrData += output;

      if (output.includes('ready')) {
        serverReady = true;
      }

      if (output.includes('DOLLHOUSE_ENCRYPTION_SECRET')) {
        encryptionError = true;
      }
    });

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill();
        resolve();
      }, 5000);

      // Exit early if server is ready
      const checkInterval = setInterval(() => {
        if (serverReady) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          proc.kill();
          resolve();
        }
      }, 100);
    });

    // Server should reach ready state
    expect(serverReady).toBe(true);

    // Should NOT have encryption errors when disabled
    expect(encryptionError).toBe(false);
  }, 15000);

  /**
   * Test: Encryption enabled requires secret
   *
   * Verify that when encryption IS enabled, proper error handling occurs
   * Note: Skipped - encryption behavior is tested elsewhere
   */
  it.skip('should require DOLLHOUSE_ENCRYPTION_SECRET when encryption is enabled', async () => {
    const serverPath = path.join(process.cwd(), 'dist', 'index.js');

    const env = {
      ...process.env,
      NODE_ENV: 'production',
      DOLLHOUSE_DISABLE_ENCRYPTION: 'false', // Explicitly enable encryption
      DOLLHOUSE_PORTFOLIO_DIR: portfolioDir,
      HOME: testDir,
    };

    // Unset the encryption secret to trigger the error
    delete env.DOLLHOUSE_ENCRYPTION_SECRET;

    let _stderrData = '';
    let hasEncryptionError = false;

    const proc: ChildProcess = spawn('node', [serverPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stderr?.on('data', (data) => {
      const output = data.toString();
      _stderrData += output;

      if (output.includes('DOLLHOUSE_ENCRYPTION_SECRET')) {
        hasEncryptionError = true;
      }
    });

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill();
        resolve();
      }, 5000);

      // Exit early if we detect the error
      const checkInterval = setInterval(() => {
        if (hasEncryptionError) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          proc.kill();
          resolve();
        }
      }, 100);
    });

    // Should have encryption error when enabled without secret
    expect(hasEncryptionError).toBe(true);
  }, 15000);
});
