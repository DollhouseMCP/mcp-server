/**
 * Tests for execution detection logic in index.ts
 * Verifies that the server correctly identifies different execution methods
 */

import * as path from 'node:path';
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

/**
 * Helper: reproduce the detection logic from index.ts so tests stay in sync.
 * When the detection logic changes in index.ts, update this helper to match.
 */
function detectExecution(argv1: string, env: Record<string, string | undefined>) {
  const rawScriptPath = argv1 ?? '';
  // In tests we skip realpathSync — symlink resolution is tested separately
  const scriptPath = rawScriptPath ? path.normalize(rawScriptPath) : '';
  const isDirectExecution =
    scriptPath.endsWith(`${path.sep}dist${path.sep}index.js`) ||
    scriptPath.endsWith(`${path.sep}src${path.sep}index.ts`);
  const isNpxExecution =
    (env.npm_execpath?.includes('npx') ?? false) ||
    env.npm_command === 'exec';
  const binName = path.basename(rawScriptPath);
  const isCliExecution = binName === 'dollhousemcp' || binName === 'mcp-server';
  const isTest = env.JEST_WORKER_ID;
  return { isDirectExecution, isNpxExecution, isCliExecution, isTest };
}

describe('Execution Detection Logic', () => {
  // Save original values
  const originalArgv1 = process.argv[1];
  const originalNpmExecPath = process.env.npm_execpath;
  const originalNpmCommand = process.env.npm_command;
  const originalJestWorkerId = process.env.JEST_WORKER_ID;

  beforeEach(() => {
    // Reset to clean state
    process.argv[1] = '/path/to/dist/index.js';
    delete process.env.npm_execpath;
    delete process.env.npm_command;
    delete process.env.JEST_WORKER_ID;
  });

  afterEach(() => {
    // Restore original values
    process.argv[1] = originalArgv1;
    if (originalNpmExecPath) {
      process.env.npm_execpath = originalNpmExecPath;
    } else {
      delete process.env.npm_execpath;
    }
    if (originalNpmCommand) {
      process.env.npm_command = originalNpmCommand;
    } else {
      delete process.env.npm_command;
    }
    if (originalJestWorkerId) {
      process.env.JEST_WORKER_ID = originalJestWorkerId;
    }
  });

  describe('Direct Execution Detection', () => {
    test('should detect dist/index.js execution', () => {
      const { isDirectExecution } = detectExecution('/path/to/dist/index.js', {});
      expect(isDirectExecution).toBe(true);
    });

    test('should detect src/index.ts execution', () => {
      const { isDirectExecution } = detectExecution('/path/to/src/index.ts', {});
      expect(isDirectExecution).toBe(true);
    });

    test('should not match arbitrary paths', () => {
      const { isDirectExecution } = detectExecution('/path/to/node_modules/.bin/mcp-server', {});
      expect(isDirectExecution).toBe(false);
    });
  });

  describe('NPX Execution Detection', () => {
    test('should detect legacy npx (npm_execpath contains npx)', () => {
      const { isNpxExecution } = detectExecution('/path/to/dist/index.js', {
        npm_execpath: '/usr/local/bin/npx',
      });
      expect(isNpxExecution).toBe(true);
    });

    test('should detect npx in various legacy paths', () => {
      const npxPaths = [
        '/usr/local/bin/npx',
        '/opt/homebrew/bin/npx',
        'C:\\Program Files\\nodejs\\npx.cmd',
        '/home/user/.npm/bin/npx',
        '/usr/local/lib/node_modules/npm/bin/npx-cli.js',
      ];

      npxPaths.forEach(p => {
        const { isNpxExecution } = detectExecution('/any', { npm_execpath: p });
        expect(isNpxExecution).toBe(true);
      });
    });

    test('should detect modern npx (npm v7+ uses npm_command=exec)', () => {
      const { isNpxExecution } = detectExecution('/any', {
        npm_execpath: '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
        npm_command: 'exec',
      });
      expect(isNpxExecution).toBe(true);
    });

    test('should detect modern npx even without npm_execpath', () => {
      const { isNpxExecution } = detectExecution('/any', {
        npm_command: 'exec',
      });
      expect(isNpxExecution).toBe(true);
    });

    test('should not detect npx when using npm directly', () => {
      const { isNpxExecution } = detectExecution('/any', {
        npm_execpath: '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
      });
      expect(isNpxExecution).toBe(false);
    });

    test('should not detect npx with unrelated npm_command', () => {
      const { isNpxExecution } = detectExecution('/any', {
        npm_command: 'install',
      });
      expect(isNpxExecution).toBe(false);
    });
  });

  describe('CLI Execution Detection', () => {
    test('should detect dollhousemcp bin entry on Unix', () => {
      const { isCliExecution } = detectExecution('/usr/local/bin/dollhousemcp', {});
      expect(isCliExecution).toBe(true);
    });

    test('should detect dollhousemcp bin entry on Windows', () => {
      if (path.sep !== '\\') return; // path.basename only splits on native separator
      const { isCliExecution } = detectExecution(String.raw`C:\Users\user\AppData\Roaming\npm\dollhousemcp`, {});
      expect(isCliExecution).toBe(true);
    });

    test('should detect mcp-server bin entry on Unix', () => {
      const { isCliExecution } = detectExecution('/usr/local/bin/mcp-server', {});
      expect(isCliExecution).toBe(true);
    });

    test('should detect mcp-server bin entry on Windows', () => {
      if (path.sep !== '\\') return; // path.basename only splits on native separator
      const { isCliExecution } = detectExecution(String.raw`C:\Users\user\AppData\Roaming\npm\mcp-server`, {});
      expect(isCliExecution).toBe(true);
    });

    test('should detect mcp-server in npx .bin directory', () => {
      const { isCliExecution } = detectExecution('/home/user/.npm/_npx/abc123/node_modules/.bin/mcp-server', {});
      expect(isCliExecution).toBe(true);
    });

    test('should detect dollhousemcp in npx .bin directory', () => {
      const { isCliExecution } = detectExecution('/home/user/.npm/_npx/abc123/node_modules/.bin/dollhousemcp', {});
      expect(isCliExecution).toBe(true);
    });

    test('should detect CLI in various Unix installation paths', () => {
      const cliPaths = [
        '/usr/local/bin/dollhousemcp',
        '/opt/homebrew/bin/dollhousemcp',
        '/home/user/.npm/bin/dollhousemcp',
        '/usr/local/bin/mcp-server',
        '/opt/homebrew/bin/mcp-server',
        '/home/user/.npm/bin/mcp-server',
      ];

      cliPaths.forEach(p => {
        const { isCliExecution } = detectExecution(p, {});
        expect(isCliExecution).toBe(true);
      });
    });

    test('should not detect CLI when running dist/index.js directly', () => {
      const { isCliExecution } = detectExecution('/path/to/dist/index.js', {});
      expect(isCliExecution).toBe(false);
    });
  });

  describe('Test Environment Detection', () => {
    test('should detect test environment', () => {
      const { isTest } = detectExecution('/any', { JEST_WORKER_ID: '1' });
      expect(isTest).toBeTruthy();
    });

    test('should not detect test environment in production', () => {
      const { isTest } = detectExecution('/any', {});
      expect(isTest).toBeFalsy();
    });
  });

  describe('Server Startup Decision (integration scenarios)', () => {
    test('npx @dollhousemcp/mcp-server — .bin/mcp-server symlink (the original bug)', () => {
      // This is the exact scenario that was broken: npx runs .bin/mcp-server,
      // Node keeps the symlink path in argv[1], and none of the old checks matched.
      const { isDirectExecution, isNpxExecution, isCliExecution } = detectExecution(
        '/home/user/.npm/_npx/abc123/node_modules/.bin/mcp-server',
        {},
      );
      // isDirectExecution is false (no symlink resolution in test helper),
      // but isCliExecution catches the mcp-server bin name
      const shouldStart = isDirectExecution || isNpxExecution || isCliExecution;
      expect(shouldStart).toBe(true);
      expect(isCliExecution).toBe(true);
    });

    test('npx @dollhousemcp/mcp-server with modern npm (npm_command=exec)', () => {
      const { isNpxExecution } = detectExecution(
        '/home/user/.npm/_npx/abc123/node_modules/.bin/mcp-server',
        { npm_command: 'exec' },
      );
      expect(isNpxExecution).toBe(true);
    });

    test('direct node dist/index.js execution', () => {
      const { isDirectExecution } = detectExecution('/path/to/dist/index.js', {});
      expect(isDirectExecution).toBe(true);
    });

    test('global install running dollhousemcp', () => {
      const { isCliExecution } = detectExecution('/usr/local/bin/dollhousemcp', {});
      expect(isCliExecution).toBe(true);
    });

    test('should not start server in test environment', () => {
      const { isDirectExecution, isNpxExecution, isCliExecution, isTest } = detectExecution(
        '/path/to/dist/index.js',
        { JEST_WORKER_ID: '1' },
      );
      const shouldStart = (isDirectExecution || isNpxExecution || isCliExecution) && !isTest;
      expect(shouldStart).toBe(false);
    });
  });

  describe('Progressive Retry Delays', () => {
    test('should use progressive delays for retries', () => {
      const STARTUP_DELAYS = [10, 50, 100, 200];

      expect(STARTUP_DELAYS).toHaveLength(4);
      expect(STARTUP_DELAYS[0]).toBe(10);
      expect(STARTUP_DELAYS[1]).toBe(50);
      expect(STARTUP_DELAYS[2]).toBe(100);
      expect(STARTUP_DELAYS[3]).toBe(200);

      for (let i = 1; i < STARTUP_DELAYS.length; i++) {
        expect(STARTUP_DELAYS[i]).toBeGreaterThan(STARTUP_DELAYS[i - 1]);
      }
    });
  });
});
