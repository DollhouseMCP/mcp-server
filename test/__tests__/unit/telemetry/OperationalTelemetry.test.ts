/**
 * Unit tests for OperationalTelemetry class
 *
 * Tests anonymous installation telemetry system including UUID generation,
 * installation event tracking, opt-out handling, and graceful error handling.
 *
 * Issue #1358: Add minimal installation telemetry for v1.9.19
 *
 * @jest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock dependencies BEFORE imports using ESM approach
// NOTE: OperationalTelemetry imports from 'node:fs' not 'node:fs/promises', so we mock 'node:fs' with a promises property
jest.unstable_mockModule('node:fs', () => ({
  promises: {
    readFile: jest.fn().mockResolvedValue(''),
    writeFile: jest.fn().mockResolvedValue(undefined),
    appendFile: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined)
  }
}));

jest.unstable_mockModule('uuid', () => ({
  v4: jest.fn(() => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
}));

jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn()
  }
}));

jest.unstable_mockModule('../../../../src/constants/version.js', () => ({
  VERSION: '1.9.19'
}));

// Import after mocking
const fs = await import('node:fs');
const { OperationalTelemetry } = await import('../../../../src/telemetry/OperationalTelemetry.js');

// Type-safe mock helpers - access the promises property from the fs mock
const fsMock = fs.promises as jest.Mocked<typeof fs.promises>;

describe('OperationalTelemetry', () => {
  const originalEnv = process.env;
  const testUUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const testVersion = '1.9.19';

  // FIX (S2004): Extract mock implementation helpers to reduce function nesting
  // Helper: Mock readFile for multiple events scenario
  function createMultipleEventsMockReadFile(events: Array<Record<string, unknown>>) {
    return (filePath: string) => {
      if (filePath.endsWith('.telemetry-id')) {
        return Promise.resolve(testUUID);
      }
      if (filePath.endsWith('telemetry.log')) {
        return Promise.resolve(events.map(e => JSON.stringify(e)).join('\n') + '\n');
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
  }

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Reset process.env
    process.env = { ...originalEnv };

    // Reset static state (using any to access private members for testing)
    (OperationalTelemetry as any).installId = null;
    (OperationalTelemetry as any).initialized = false;

    // Default mock implementations
    fsMock.mkdir.mockResolvedValue(undefined);
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.appendFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('isEnabled()', () => {
    it('should return true by default when DOLLHOUSE_TELEMETRY is not set', () => {
      delete process.env.DOLLHOUSE_TELEMETRY;
      expect(OperationalTelemetry.isEnabled()).toBe(true);
    });

    it('should return false when DOLLHOUSE_TELEMETRY=false', () => {
      process.env.DOLLHOUSE_TELEMETRY = 'false';
      expect(OperationalTelemetry.isEnabled()).toBe(false);
    });

    it('should return false when DOLLHOUSE_TELEMETRY=FALSE (case insensitive)', () => {
      process.env.DOLLHOUSE_TELEMETRY = 'FALSE';
      expect(OperationalTelemetry.isEnabled()).toBe(false);
    });

    it('should return false when DOLLHOUSE_TELEMETRY=0', () => {
      process.env.DOLLHOUSE_TELEMETRY = '0';
      expect(OperationalTelemetry.isEnabled()).toBe(false);
    });

    it('should return true when DOLLHOUSE_TELEMETRY=true', () => {
      process.env.DOLLHOUSE_TELEMETRY = 'true';
      expect(OperationalTelemetry.isEnabled()).toBe(true);
    });

    it('should return true when DOLLHOUSE_TELEMETRY=TRUE (case insensitive)', () => {
      process.env.DOLLHOUSE_TELEMETRY = 'TRUE';
      expect(OperationalTelemetry.isEnabled()).toBe(true);
    });

    it('should return true when DOLLHOUSE_TELEMETRY=1', () => {
      process.env.DOLLHOUSE_TELEMETRY = '1';
      expect(OperationalTelemetry.isEnabled()).toBe(true);
    });

    it('should return true for unrecognized values (opt-out model)', () => {
      process.env.DOLLHOUSE_TELEMETRY = 'maybe';
      expect(OperationalTelemetry.isEnabled()).toBe(true);
    });

    it('should return true for empty string', () => {
      process.env.DOLLHOUSE_TELEMETRY = '';
      expect(OperationalTelemetry.isEnabled()).toBe(true);
    });
  });

  describe('initialize() - telemetry disabled', () => {
    it('should skip all file operations when DOLLHOUSE_TELEMETRY=false', async () => {
      process.env.DOLLHOUSE_TELEMETRY = 'false';

      await OperationalTelemetry.initialize();

      // No file operations should occur
      expect(fsMock.readFile).not.toHaveBeenCalled();
      expect(fsMock.writeFile).not.toHaveBeenCalled();
      expect(fsMock.appendFile).not.toHaveBeenCalled();
      expect(fsMock.mkdir).not.toHaveBeenCalled();
    });

    it('should mark as initialized even when disabled', async () => {
      process.env.DOLLHOUSE_TELEMETRY = 'false';

      await OperationalTelemetry.initialize();

      // Second call should not do anything
      await OperationalTelemetry.initialize();

      expect(fsMock.readFile).not.toHaveBeenCalled();
    });
  });

  describe('initialize() - UUID generation (first run)', () => {
    it('should generate new UUID on first run when file does not exist', async () => {
      // Mock file doesn't exist (readFile throws ENOENT)
      (fsMock.readFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      );

      await OperationalTelemetry.initialize();

      const expectedPath = path.join(os.homedir(), '.dollhouse', '.telemetry-id');

      // Should try to read existing UUID
      expect(fsMock.readFile).toHaveBeenCalledWith(expectedPath, 'utf-8');

      // Should create directory
      expect(fsMock.mkdir).toHaveBeenCalledWith(
        path.join(os.homedir(), '.dollhouse'),
        { recursive: true }
      );

      // Should write new UUID
      expect(fsMock.writeFile).toHaveBeenCalledWith(expectedPath, testUUID, 'utf-8');
    });

    it('should use valid UUID v4 format', async () => {
      (fsMock.readFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      );

      await OperationalTelemetry.initialize();

      const writeCalls = (fsMock.writeFile as Mock).mock.calls;
      const uuidCall = writeCalls.find(call => call[0].endsWith('.telemetry-id'));

      expect(uuidCall).toBeDefined();
      const uuid = uuidCall![1];

      // Validate UUID v4 format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuid).toMatch(uuidRegex);
    });
  });

  describe('initialize() - UUID persistence (subsequent runs)', () => {
    it('should load existing UUID from file on subsequent runs', async () => {
      const existingUUID = '12345678-1234-4abc-89de-123456789abc';

      // Mock existing UUID file
      (fsMock.readFile as Mock).mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve(existingUUID);
        }
        if (filePath.endsWith('telemetry.log')) {
          // Return existing install event
          return Promise.resolve(
            JSON.stringify({
              event: 'install',
              install_id: existingUUID,
              version: testVersion,
              os: 'darwin',
              node_version: 'v20.0.0',
              mcp_client: 'claude-code',
              timestamp: '2025-10-15T10:00:00.000Z'
            }) + '\n'
          );
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await OperationalTelemetry.initialize();

      // Should read UUID file
      expect(fsMock.readFile).toHaveBeenCalledWith(
        path.join(os.homedir(), '.dollhouse', '.telemetry-id'),
        'utf-8'
      );

      // Should NOT write new UUID
      const writeUuidCalls = (fsMock.writeFile as Mock).mock.calls.filter(
        call => call[0].endsWith('.telemetry-id')
      );
      expect(writeUuidCalls).toHaveLength(0);
    });

    it('should trim whitespace from loaded UUID', async () => {
      const existingUUID = '12345678-1234-4abc-89de-123456789abc';

      // Mock UUID file with whitespace
      (fsMock.readFile as Mock).mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve(`\n  ${existingUUID}  \n`);
        }
        if (filePath.endsWith('telemetry.log')) {
          return Promise.resolve(
            JSON.stringify({
              event: 'install',
              install_id: existingUUID,
              version: testVersion,
              os: 'darwin',
              node_version: 'v20.0.0',
              mcp_client: 'claude-code',
              timestamp: '2025-10-15T10:00:00.000Z'
            }) + '\n'
          );
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await OperationalTelemetry.initialize();

      // Should not write new UUID (existing one is valid)
      const writeUuidCalls = (fsMock.writeFile as Mock).mock.calls.filter(
        call => call[0].endsWith('.telemetry-id')
      );
      expect(writeUuidCalls).toHaveLength(0);
    });

    it('should generate new UUID if existing one is invalid format', async () => {
      // Mock invalid UUID in file
      (fsMock.readFile as Mock).mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve('invalid-uuid-format');
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await OperationalTelemetry.initialize();

      // Should write new valid UUID
      expect(fsMock.writeFile).toHaveBeenCalledWith(
        path.join(os.homedir(), '.dollhouse', '.telemetry-id'),
        testUUID,
        'utf-8'
      );
    });

    it('should reuse cached UUID on second initialize() call', async () => {
      (fsMock.readFile as Mock).mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve(testUUID);
        }
        if (filePath.endsWith('telemetry.log')) {
          return Promise.resolve(
            JSON.stringify({
              event: 'install',
              install_id: testUUID,
              version: testVersion,
              os: 'darwin',
              node_version: 'v20.0.0',
              mcp_client: 'claude-code',
              timestamp: '2025-10-15T10:00:00.000Z'
            }) + '\n'
          );
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      // First initialization
      await OperationalTelemetry.initialize();

      // Clear mock call history
      jest.clearAllMocks();

      // Reset initialized flag to test caching
      (OperationalTelemetry as any).initialized = false;

      // Second initialization
      await OperationalTelemetry.initialize();

      // Should read from file (not cached between class resets)
      expect(fsMock.readFile).toHaveBeenCalled();
    });
  });

  describe('initialize() - installation event tracking', () => {
    it('should write installation event on first run', async () => {
      // Mock: UUID file doesn't exist, telemetry log doesn't exist
      (fsMock.readFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await OperationalTelemetry.initialize();

      const expectedLogPath = path.join(os.homedir(), '.dollhouse', 'telemetry.log');

      // Should append installation event to log
      expect(fsMock.appendFile).toHaveBeenCalledWith(
        expectedLogPath,
        expect.stringContaining('"event":"install"'),
        'utf-8'
      );

      // Verify event structure
      const appendCalls = (fsMock.appendFile as Mock).mock.calls;
      const logCall = appendCalls.find(call => call[0] === expectedLogPath);
      expect(logCall).toBeDefined();

      const eventLine = logCall![1];
      const event = JSON.parse(eventLine.replace(/\n$/, ''));

      expect(event).toMatchObject({
        event: 'install',
        install_id: testUUID,
        version: testVersion,
        os: expect.any(String),
        node_version: expect.any(String),
        mcp_client: expect.any(String),
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      });
    });

    it('should include correct system information in installation event', async () => {
      (fsMock.readFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await OperationalTelemetry.initialize();

      const appendCalls = (fsMock.appendFile as Mock).mock.calls;
      const logCall = appendCalls.find(call => call[0].endsWith('telemetry.log'));
      const eventLine = logCall![1];
      const event = JSON.parse(eventLine.replace(/\n$/, ''));

      // OS should be one of the known platforms
      expect(['darwin', 'win32', 'linux']).toContain(event.os);

      // Node version should match process.version
      expect(event.node_version).toBe(process.version);

      // MCP client should be detected (or 'unknown')
      expect(event.mcp_client).toMatch(/^(claude-desktop|claude-code|vscode|unknown)$/);
    });

    it('should NOT write installation event if already exists for this version', async () => {
      const existingEvent = {
        event: 'install',
        install_id: testUUID,
        version: testVersion, // Same version
        os: 'darwin',
        node_version: 'v20.0.0',
        mcp_client: 'claude-code',
        timestamp: '2025-10-15T10:00:00.000Z'
      };

      (fsMock.readFile as Mock).mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve(testUUID);
        }
        if (filePath.endsWith('telemetry.log')) {
          return Promise.resolve(JSON.stringify(existingEvent) + '\n');
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await OperationalTelemetry.initialize();

      // Should NOT append new event
      expect(fsMock.appendFile).not.toHaveBeenCalled();
    });

    it('should write installation event for version upgrade', async () => {
      const oldVersionEvent = {
        event: 'install',
        install_id: testUUID,
        version: '1.9.18', // Old version
        os: 'darwin',
        node_version: 'v20.0.0',
        mcp_client: 'claude-code',
        timestamp: '2025-10-14T10:00:00.000Z'
      };

      (fsMock.readFile as Mock).mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve(testUUID);
        }
        if (filePath.endsWith('telemetry.log')) {
          return Promise.resolve(JSON.stringify(oldVersionEvent) + '\n');
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await OperationalTelemetry.initialize();

      // Should append new installation event for new version
      expect(fsMock.appendFile).toHaveBeenCalledWith(
        path.join(os.homedir(), '.dollhouse', 'telemetry.log'),
        expect.stringContaining(`"version":"${testVersion}"`),
        'utf-8'
      );
    });

    it('should handle multiple events in telemetry log', async () => {
      const events = [
        { event: 'install', install_id: testUUID, version: '1.9.17', os: 'darwin', node_version: 'v18.0.0', mcp_client: 'claude-desktop', timestamp: '2025-10-01T10:00:00.000Z' },
        { event: 'install', install_id: testUUID, version: '1.9.18', os: 'darwin', node_version: 'v20.0.0', mcp_client: 'claude-code', timestamp: '2025-10-14T10:00:00.000Z' }
      ];

      // FIX (S2004): Use extracted helper to reduce nesting
      (fsMock.readFile as Mock).mockImplementation(createMultipleEventsMockReadFile(events));

      await OperationalTelemetry.initialize();

      // Should append new event for current version
      expect(fsMock.appendFile).toHaveBeenCalled();
    });

    it('should skip malformed lines in telemetry log', async () => {
      const logContent = `{"event":"install","install_id":"${testUUID}","version":"1.9.17","os":"darwin"}\nmalformed json line\n{"event":"install","install_id":"${testUUID}","version":"1.9.18","os":"darwin","node_version":"v20.0.0","mcp_client":"unknown","timestamp":"2025-10-14T10:00:00.000Z"}`;

      (fsMock.readFile as Mock).mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve(testUUID);
        }
        if (filePath.endsWith('telemetry.log')) {
          return Promise.resolve(logContent);
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await OperationalTelemetry.initialize();

      // Should still process and append new event (current version not found)
      expect(fsMock.appendFile).toHaveBeenCalled();
    });

    it('should write installation event only once per installation', async () => {
      (fsMock.readFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      // First initialization
      await OperationalTelemetry.initialize();

      const firstAppendCount = (fsMock.appendFile as Mock).mock.calls.length;
      expect(firstAppendCount).toBe(1);

      // Second initialization (should skip because already initialized)
      await OperationalTelemetry.initialize();

      // Should not append again
      expect(fsMock.appendFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('initialize() - error handling', () => {
    it('should handle missing directory gracefully', async () => {
      (fsMock.readFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );
      (fsMock.mkdir as Mock).mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      );

      // Should not throw
      await expect(OperationalTelemetry.initialize()).resolves.not.toThrow();

      // Should mark as initialized to prevent retry loops
      expect((OperationalTelemetry as any).initialized).toBe(true);
    });

    it('should handle UUID file write permission errors', async () => {
      (fsMock.readFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );
      (fsMock.writeFile as Mock).mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      );

      // Should not throw
      await expect(OperationalTelemetry.initialize()).resolves.not.toThrow();

      // Should mark as initialized
      expect((OperationalTelemetry as any).initialized).toBe(true);
    });

    it('should handle telemetry log write errors', async () => {
      (fsMock.readFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );
      (fsMock.appendFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      );

      // Should not throw
      await expect(OperationalTelemetry.initialize()).resolves.not.toThrow();

      // Should still mark as initialized
      expect((OperationalTelemetry as any).initialized).toBe(true);
    });

    it('should handle telemetry log read errors gracefully', async () => {
      (fsMock.readFile as Mock).mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve(testUUID);
        }
        if (filePath.endsWith('telemetry.log')) {
          return Promise.reject(
            Object.assign(new Error('EIO: I/O error'), { code: 'EIO' })
          );
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      // Should treat as first run and attempt to write event
      await expect(OperationalTelemetry.initialize()).resolves.not.toThrow();

      // Should try to write installation event
      expect(fsMock.appendFile).toHaveBeenCalled();
    });

    it('should never throw exceptions from initialize()', async () => {
      // Simulate catastrophic failure
      (fsMock.readFile as Mock).mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      // Should not throw
      await expect(OperationalTelemetry.initialize()).resolves.not.toThrow();

      // Should mark as initialized
      expect((OperationalTelemetry as any).initialized).toBe(true);
    });

    it('should handle empty telemetry log file', async () => {
      (fsMock.readFile as Mock).mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve(testUUID);
        }
        if (filePath.endsWith('telemetry.log')) {
          return Promise.resolve('');
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await OperationalTelemetry.initialize();

      // Should treat as first run and write event
      expect(fsMock.appendFile).toHaveBeenCalled();
    });

    it('should handle telemetry log with only whitespace', async () => {
      (fsMock.readFile as Mock).mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve(testUUID);
        }
        if (filePath.endsWith('telemetry.log')) {
          return Promise.resolve('   \n  \n  ');
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await OperationalTelemetry.initialize();

      // Should treat as first run
      expect(fsMock.appendFile).toHaveBeenCalled();
    });
  });

  describe('initialize() - idempotency', () => {
    it('should only initialize once even if called multiple times', async () => {
      (fsMock.readFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      // First call
      await OperationalTelemetry.initialize();

      const firstCallCount = (fsMock.writeFile as Mock).mock.calls.length;

      // Second call
      await OperationalTelemetry.initialize();

      // Third call
      await OperationalTelemetry.initialize();

      // Should not make additional file operations
      expect(fsMock.writeFile).toHaveBeenCalledTimes(firstCallCount);
    });

    it('should prevent re-initialization after error', async () => {
      (fsMock.readFile as Mock).mockRejectedValue(new Error('Test error'));

      // First call (will error but mark initialized)
      await OperationalTelemetry.initialize();

      jest.clearAllMocks();

      // Second call
      await OperationalTelemetry.initialize();

      // Should not attempt any file operations
      expect(fsMock.readFile).not.toHaveBeenCalled();
    });
  });

  describe('MCP client detection', () => {
    it('should detect Claude Desktop from CLAUDE_DESKTOP_VERSION', async () => {
      process.env.CLAUDE_DESKTOP_VERSION = '1.0.0';
      delete process.env.CLAUDE_CODE;
      delete process.env.VSCODE_CWD;

      (fsMock.readFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await OperationalTelemetry.initialize();

      const appendCalls = (fsMock.appendFile as Mock).mock.calls;
      const logCall = appendCalls.find(call => call[0].endsWith('telemetry.log'));
      const eventLine = logCall![1];
      const event = JSON.parse(eventLine.replace(/\n$/, ''));

      expect(event.mcp_client).toBe('claude-desktop');
    });

    it('should detect Claude Code from TERM_PROGRAM', async () => {
      process.env.TERM_PROGRAM = 'claude-code';
      delete process.env.CLAUDE_DESKTOP_VERSION;
      delete process.env.VSCODE_CWD;

      (fsMock.readFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await OperationalTelemetry.initialize();

      const appendCalls = (fsMock.appendFile as Mock).mock.calls;
      const logCall = appendCalls.find(call => call[0].endsWith('telemetry.log'));
      const eventLine = logCall![1];
      const event = JSON.parse(eventLine.replace(/\n$/, ''));

      expect(event.mcp_client).toBe('claude-code');
    });

    it('should detect VS Code from VSCODE_CWD', async () => {
      process.env.VSCODE_CWD = '/workspace';
      delete process.env.CLAUDE_DESKTOP_VERSION;
      delete process.env.TERM_PROGRAM;

      (fsMock.readFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await OperationalTelemetry.initialize();

      const appendCalls = (fsMock.appendFile as Mock).mock.calls;
      const logCall = appendCalls.find(call => call[0].endsWith('telemetry.log'));
      const eventLine = logCall![1];
      const event = JSON.parse(eventLine.replace(/\n$/, ''));

      expect(event.mcp_client).toBe('vscode');
    });

    it('should return unknown for unrecognized environment', async () => {
      delete process.env.CLAUDE_DESKTOP_VERSION;
      delete process.env.CLAUDE_CODE;
      delete process.env.TERM_PROGRAM;
      delete process.env.VSCODE_CWD;

      (fsMock.readFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await OperationalTelemetry.initialize();

      const appendCalls = (fsMock.appendFile as Mock).mock.calls;
      const logCall = appendCalls.find(call => call[0].endsWith('telemetry.log'));
      const eventLine = logCall![1];
      const event = JSON.parse(eventLine.replace(/\n$/, ''));

      expect(event.mcp_client).toBe('unknown');
    });
  });

  describe('JSON Lines (JSONL) format', () => {
    it('should write events in valid JSONL format', async () => {
      (fsMock.readFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await OperationalTelemetry.initialize();

      const appendCalls = (fsMock.appendFile as Mock).mock.calls;
      const logCall = appendCalls.find(call => call[0].endsWith('telemetry.log'));
      expect(logCall).toBeDefined();

      const eventLine = logCall![1];

      // Should end with newline
      expect(eventLine).toMatch(/\n$/);

      // Should be valid JSON (without the newline)
      const jsonContent = eventLine.replace(/\n$/, '');
      expect(() => JSON.parse(jsonContent)).not.toThrow();
    });

    it('should append multiple events as separate lines', async () => {
      const events = [
        { event: 'install', install_id: testUUID, version: '1.9.17', os: 'darwin', node_version: 'v18.0.0', mcp_client: 'unknown', timestamp: '2025-10-01T10:00:00.000Z' }
      ];

      // FIX (S2004): Use extracted helper to reduce nesting
      (fsMock.readFile as Mock).mockImplementation(createMultipleEventsMockReadFile(events));

      await OperationalTelemetry.initialize();

      // Should append new event as separate line
      expect(fsMock.appendFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringMatching(/^\{.*\}\n$/),
        'utf-8'
      );
    });
  });

  describe('privacy compliance', () => {
    it('should not collect personal information in installation event', async () => {
      (fsMock.readFile as Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await OperationalTelemetry.initialize();

      const appendCalls = (fsMock.appendFile as Mock).mock.calls;
      const logCall = appendCalls.find(call => call[0].endsWith('telemetry.log'));
      const eventLine = logCall![1];
      const event = JSON.parse(eventLine.replace(/\n$/, ''));

      // Should only contain expected fields
      const allowedFields = ['event', 'install_id', 'version', 'os', 'node_version', 'mcp_client', 'timestamp'];
      const eventFields = Object.keys(event);

      expect(eventFields.sort()).toEqual(allowedFields.sort());

      // Should not contain user-specific paths
      expect(JSON.stringify(event)).not.toMatch(/\/Users\/[^/]+\//);
      expect(JSON.stringify(event)).not.toMatch(/C:\\Users\\[^\\]+\\/);

      // Should not contain hostname
      expect(JSON.stringify(event)).not.toContain(os.hostname());

      // UUID should be anonymous (no correlation to user identity)
      expect(event.install_id).toMatch(/^[0-9a-f-]+$/);
    });
  });
});
