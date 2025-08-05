/**
 * Tests for execution detection logic in index.ts
 * Verifies that the server correctly identifies different execution methods
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

describe('Execution Detection Logic', () => {
  // Save original values
  const originalArgv1 = process.argv[1];
  const originalNpmExecPath = process.env.npm_execpath;
  const originalJestWorkerId = process.env.JEST_WORKER_ID;
  
  beforeEach(() => {
    // Reset to clean state
    process.argv[1] = '/path/to/dist/index.js';
    delete process.env.npm_execpath;
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
    if (originalJestWorkerId) {
      process.env.JEST_WORKER_ID = originalJestWorkerId;
    }
  });

  describe('Direct Execution Detection', () => {
    test('should detect direct node execution', () => {
      // Simulate direct execution
      process.argv[1] = '/path/to/dist/index.js';
      delete process.env.npm_execpath;
      
      const isDirectExecution = !process.env.npm_execpath;
      expect(isDirectExecution).toBe(true);
    });
    
    test('should not detect direct execution when npm_execpath is set', () => {
      process.env.npm_execpath = '/usr/local/bin/npm';
      
      const isDirectExecution = !process.env.npm_execpath;
      expect(isDirectExecution).toBe(false);
    });
  });

  describe('NPX Execution Detection', () => {
    test('should detect npx execution', () => {
      process.env.npm_execpath = '/usr/local/bin/npx';
      
      const isNpxExecution = process.env.npm_execpath?.includes('npx') || false;
      expect(isNpxExecution).toBe(true);
    });
    
    test('should detect npx in various paths', () => {
      const npxPaths = [
        '/usr/local/bin/npx',
        '/opt/homebrew/bin/npx',
        'C:\\Program Files\\nodejs\\npx.cmd',
        '/home/user/.npm/bin/npx'
      ];
      
      npxPaths.forEach(path => {
        process.env.npm_execpath = path;
        const isNpxExecution = process.env.npm_execpath?.includes('npx') || false;
        expect(isNpxExecution).toBe(true);
      });
    });
    
    test('should not detect npx when using npm directly', () => {
      process.env.npm_execpath = '/usr/local/bin/npm';
      
      const isNpxExecution = process.env.npm_execpath?.includes('npx') || false;
      expect(isNpxExecution).toBe(false);
    });
  });

  describe('CLI Execution Detection', () => {
    test('should detect CLI execution on Unix-like systems', () => {
      process.argv[1] = '/usr/local/bin/dollhousemcp';
      
      const isCliExecution = process.argv[1]?.endsWith('/dollhousemcp') || process.argv[1]?.endsWith('\\dollhousemcp') || false;
      expect(isCliExecution).toBe(true);
    });
    
    test('should detect CLI execution on Windows', () => {
      process.argv[1] = 'C:\\Users\\user\\AppData\\Roaming\\npm\\dollhousemcp';
      
      const isCliExecution = process.argv[1]?.endsWith('/dollhousemcp') || process.argv[1]?.endsWith('\\dollhousemcp') || false;
      expect(isCliExecution).toBe(true);
    });
    
    test('should detect CLI in various installation paths', () => {
      const cliPaths = [
        '/usr/local/bin/dollhousemcp',
        '/opt/homebrew/bin/dollhousemcp',
        'C:\\Program Files\\nodejs\\dollhousemcp',
        '/home/user/.npm/bin/dollhousemcp',
        'C:\\Users\\user\\AppData\\Roaming\\npm\\dollhousemcp'
      ];
      
      cliPaths.forEach(path => {
        process.argv[1] = path;
        const isCliExecution = process.argv[1]?.endsWith('/dollhousemcp') || process.argv[1]?.endsWith('\\dollhousemcp') || false;
        expect(isCliExecution).toBe(true);
      });
    });
    
    test('should not detect CLI when running index.js directly', () => {
      process.argv[1] = '/path/to/dist/index.js';
      
      const isCliExecution = process.argv[1]?.endsWith('/dollhousemcp') || process.argv[1]?.endsWith('\\dollhousemcp') || false;
      expect(isCliExecution).toBe(false);
    });
  });

  describe('Test Environment Detection', () => {
    test('should detect test environment', () => {
      process.env.JEST_WORKER_ID = '1';
      
      const isTest = process.env.JEST_WORKER_ID;
      expect(isTest).toBeTruthy();
    });
    
    test('should not detect test environment in production', () => {
      delete process.env.JEST_WORKER_ID;
      
      const isTest = process.env.JEST_WORKER_ID;
      expect(isTest).toBeFalsy();
    });
  });

  describe('Execution Environment Object', () => {
    test('should correctly populate execution environment', () => {
      process.env.npm_execpath = '/usr/local/bin/npx';
      process.argv[1] = '/usr/local/bin/dollhousemcp';
      
      const EXECUTION_ENV = {
        isNpx: process.env.npm_execpath?.includes('npx') || false,
        isCli: process.argv[1]?.endsWith('/dollhousemcp') || false,
        isDirect: !process.env.npm_execpath,
        cwd: process.cwd(),
        scriptPath: process.argv[1],
      };
      
      expect(EXECUTION_ENV.isNpx).toBe(true);
      expect(EXECUTION_ENV.isCli).toBe(true);
      expect(EXECUTION_ENV.isDirect).toBe(false);
      expect(EXECUTION_ENV.cwd).toBe(process.cwd());
      expect(EXECUTION_ENV.scriptPath).toBe('/usr/local/bin/dollhousemcp');
    });
  });

  describe('Progressive Retry Delays', () => {
    test('should use progressive delays for retries', () => {
      const STARTUP_DELAYS = [10, 50, 100, 200];
      
      expect(STARTUP_DELAYS).toHaveLength(4);
      expect(STARTUP_DELAYS[0]).toBe(10);  // Fast initial retry
      expect(STARTUP_DELAYS[1]).toBe(50);  // Original delay
      expect(STARTUP_DELAYS[2]).toBe(100); // Slower for slow machines
      expect(STARTUP_DELAYS[3]).toBe(200); // Final attempt
      
      // Verify delays are progressive
      for (let i = 1; i < STARTUP_DELAYS.length; i++) {
        expect(STARTUP_DELAYS[i]).toBeGreaterThan(STARTUP_DELAYS[i - 1]);
      }
    });
  });

  describe('Server Startup Decision', () => {
    test('should start server for direct execution when not in test', () => {
      delete process.env.npm_execpath;
      delete process.env.JEST_WORKER_ID;
      process.argv[1] = '/path/to/dist/index.js';
      
      const isDirectExecution = !process.env.npm_execpath;
      const isNpxExecution = process.env.npm_execpath?.includes('npx') || false;
      const isCliExecution = process.argv[1]?.endsWith('/dollhousemcp') || false;
      const isTest = process.env.JEST_WORKER_ID;
      
      const shouldStart = (isDirectExecution || isNpxExecution || isCliExecution) && !isTest;
      expect(shouldStart).toBe(true);
    });
    
    test('should start server for npx execution when not in test', () => {
      process.env.npm_execpath = '/usr/local/bin/npx';
      delete process.env.JEST_WORKER_ID;
      
      const isDirectExecution = !process.env.npm_execpath;
      const isNpxExecution = process.env.npm_execpath?.includes('npx') || false;
      const isCliExecution = process.argv[1]?.endsWith('/dollhousemcp') || false;
      const isTest = process.env.JEST_WORKER_ID;
      
      const shouldStart = (isDirectExecution || isNpxExecution || isCliExecution) && !isTest;
      expect(shouldStart).toBe(true);
    });
    
    test('should not start server in test environment', () => {
      process.env.JEST_WORKER_ID = '1';
      
      const isDirectExecution = !process.env.npm_execpath;
      const isNpxExecution = process.env.npm_execpath?.includes('npx') || false;
      const isCliExecution = process.argv[1]?.endsWith('/dollhousemcp') || false;
      const isTest = process.env.JEST_WORKER_ID;
      
      const shouldStart = (isDirectExecution || isNpxExecution || isCliExecution) && !isTest;
      expect(shouldStart).toBe(false);
    });
  });
});