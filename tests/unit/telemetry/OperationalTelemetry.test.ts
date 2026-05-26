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
import * as path from 'node:path';
import * as os from 'node:os';

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Mock dependencies BEFORE imports using ESM approach
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn()
  }
}));

jest.unstable_mockModule('../../../src/generated/version.js', () => ({
  PACKAGE_VERSION: '1.9.19'
}));

// Mock PostHog
jest.unstable_mockModule('posthog-node', () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    capture: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined)
  }))
}));

// Import after mocking
const { OperationalTelemetry } = await import('../../../src/telemetry/OperationalTelemetry.js');

// Inline mock factory for FileOperationsService (to avoid import issues with mocked modules)
function createMockFileOperationsService() {
  return {
    readFile: jest.fn().mockResolvedValue(''),
    readElementFile: jest.fn().mockResolvedValue(''),
    writeFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    createDirectory: jest.fn().mockResolvedValue(undefined),
    listDirectory: jest.fn().mockResolvedValue([]),
    listDirectoryWithTypes: jest.fn().mockResolvedValue([]),
    renameFile: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(false),
    stat: jest.fn().mockResolvedValue({} as any),
    resolvePath: jest.fn().mockReturnValue(''),
    validatePath: jest.fn().mockReturnValue(true),
    createFileExclusive: jest.fn().mockResolvedValue(true),
    copyFile: jest.fn().mockResolvedValue(undefined),
    chmod: jest.fn().mockResolvedValue(undefined),
    appendFile: jest.fn().mockResolvedValue(undefined),
  };
}

describe('OperationalTelemetry', () => {
  const originalEnv = process.env;
  const testUUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const testVersion = '1.9.19';

  // Instance for testing
  let telemetry: InstanceType<typeof OperationalTelemetry>;
  let mockFileOperations: ReturnType<typeof createMockFileOperationsService>;

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

    // Reset process.env and default to telemetry disabled unless explicitly set
    process.env = { ...originalEnv };
    process.env.DOLLHOUSE_TELEMETRY = 'true';

    // Create mock FileOperationsService
    mockFileOperations = createMockFileOperationsService();

    // Default mock implementation for readFile - throw ENOENT by default
    mockFileOperations.readFile.mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    );

    // Create fresh instance for each test
    telemetry = new OperationalTelemetry(mockFileOperations as any);
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('isEnabled()', () => {
    it('should return false by default when DOLLHOUSE_TELEMETRY is not set', () => {
      delete process.env.DOLLHOUSE_TELEMETRY;
      expect(telemetry.isEnabled()).toBe(false);
    });

    it('should return false when DOLLHOUSE_TELEMETRY=false', () => {
      process.env.DOLLHOUSE_TELEMETRY = 'false';
      expect(telemetry.isEnabled()).toBe(false);
    });

    it('should return false when DOLLHOUSE_TELEMETRY=FALSE (case insensitive)', () => {
      process.env.DOLLHOUSE_TELEMETRY = 'FALSE';
      expect(telemetry.isEnabled()).toBe(false);
    });

    it('should return false when DOLLHOUSE_TELEMETRY=0', () => {
      process.env.DOLLHOUSE_TELEMETRY = '0';
      expect(telemetry.isEnabled()).toBe(false);
    });

    it('should return true when DOLLHOUSE_TELEMETRY=true', () => {
      process.env.DOLLHOUSE_TELEMETRY = 'true';
      expect(telemetry.isEnabled()).toBe(true);
    });

    it('should return true when DOLLHOUSE_TELEMETRY=TRUE (case insensitive)', () => {
      process.env.DOLLHOUSE_TELEMETRY = 'TRUE';
      expect(telemetry.isEnabled()).toBe(true);
    });

    it('should return true when DOLLHOUSE_TELEMETRY=1', () => {
      process.env.DOLLHOUSE_TELEMETRY = '1';
      expect(telemetry.isEnabled()).toBe(true);
    });

    it('should return false for unrecognized values (opt-in model)', () => {
      process.env.DOLLHOUSE_TELEMETRY = 'maybe';
      expect(telemetry.isEnabled()).toBe(false);
    });

    it('should return false for empty string', () => {
      process.env.DOLLHOUSE_TELEMETRY = '';
      expect(telemetry.isEnabled()).toBe(false);
    });
  });

  describe('initialize() - telemetry disabled', () => {
    it('should skip all file operations when DOLLHOUSE_TELEMETRY=false', async () => {
      process.env.DOLLHOUSE_TELEMETRY = 'false';

      await telemetry.initialize();

      // No file operations should occur
      expect(mockFileOperations.readFile).not.toHaveBeenCalled();
      expect(mockFileOperations.writeFile).not.toHaveBeenCalled();
      expect(mockFileOperations.appendFile).not.toHaveBeenCalled();
      expect(mockFileOperations.createDirectory).not.toHaveBeenCalled();
    });

    it('should mark as initialized even when disabled', async () => {
      process.env.DOLLHOUSE_TELEMETRY = 'false';

      await telemetry.initialize();

      // Second call should not do anything
      await telemetry.initialize();

      expect(mockFileOperations.readFile).not.toHaveBeenCalled();
    });
  });

  describe('initialize() - UUID generation (first run)', () => {
    it('should generate new UUID on first run when file does not exist', async () => {
      // Mock file doesn't exist (readFile throws ENOENT)
      mockFileOperations.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      );

      await telemetry.initialize();

      const expectedPath = path.join(os.homedir(), '.dollhouse', '.telemetry-id');
      const expectedDir = path.join(os.homedir(), '.dollhouse');

      // Should try to read existing UUID
      expect(mockFileOperations.readFile).toHaveBeenCalledWith(
        expectedPath,
        expect.objectContaining({ source: 'OperationalTelemetry.ensureUUID' })
      );

      // Should create directory
      expect(mockFileOperations.createDirectory).toHaveBeenCalledWith(expectedDir);

      // Should write UUID to file
      expect(mockFileOperations.writeFile).toHaveBeenCalledWith(
        expectedPath,
        expect.stringMatching(uuidRegex),
        expect.objectContaining({ source: 'OperationalTelemetry.ensureUUID' })
      );
    });

    it('should use valid UUID v4 format', async () => {
      mockFileOperations.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      );

      await telemetry.initialize();

      const writeCalls = mockFileOperations.writeFile.mock.calls;
      // Find the UUID write call
      const uuidCall = writeCalls.find(call => (call[0] as string).includes('.telemetry-id'));

      expect(uuidCall).toBeDefined();
      const uuid = uuidCall![1];

      expect(uuid).toMatch(uuidRegex);
    });
  });

  describe('initialize() - UUID persistence (subsequent runs)', () => {
    it('should load existing UUID from file on subsequent runs', async () => {
      const existingUUID = '12345678-1234-4abc-89de-123456789abc';

      // Mock existing UUID file
      mockFileOperations.readFile.mockImplementation((filePath: string) => {
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

      await telemetry.initialize();

      // Should read UUID file
      expect(mockFileOperations.readFile).toHaveBeenCalledWith(
        path.join(os.homedir(), '.dollhouse', '.telemetry-id'),
        expect.objectContaining({ source: 'OperationalTelemetry.ensureUUID' })
      );

      // Should NOT write new UUID
      const writeUuidCalls = mockFileOperations.writeFile.mock.calls.filter(
        call => (call[0] as string).endsWith('.telemetry-id')
      );
      expect(writeUuidCalls).toHaveLength(0);
    });

    it('should trim whitespace from loaded UUID', async () => {
      const existingUUID = '12345678-1234-4abc-89de-123456789abc';

      // Mock UUID file with whitespace
      mockFileOperations.readFile.mockImplementation((filePath: string) => {
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

      await telemetry.initialize();

      // Should not write new UUID (existing one is valid)
      const writeUuidCalls = mockFileOperations.writeFile.mock.calls.filter(
        call => (call[0] as string).endsWith('.telemetry-id')
      );
      expect(writeUuidCalls).toHaveLength(0);
    });

    it('should generate new UUID if existing one is invalid format', async () => {
      // Mock invalid UUID in file
      mockFileOperations.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve('invalid-uuid-format');
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await telemetry.initialize();

      // Should write new UUID
      const uuidWriteCall = mockFileOperations.writeFile.mock.calls.find(
        call => (call[0] as string).includes('.telemetry-id')
      );
      expect(uuidWriteCall).toBeDefined();
      expect(uuidWriteCall![1]).toMatch(uuidRegex);
    });

    it('should reuse cached UUID on second initialize() call', async () => {
      mockFileOperations.readFile.mockImplementation((filePath: string) => {
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
      await telemetry.initialize();

      // Clear mock call history
      jest.clearAllMocks();

      // Reset initialized flag to test caching
      (telemetry as any).initialized = false;

      // Second initialization
      await telemetry.initialize();

      // Should read from file (not cached between class resets)
      expect(mockFileOperations.readFile).toHaveBeenCalled();
    });
  });

  describe('initialize() - installation event tracking', () => {
    it('should write installation event on first run', async () => {
      // Mock: UUID file doesn't exist, telemetry log doesn't exist
      mockFileOperations.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await telemetry.initialize();

      const expectedLogPath = path.join(os.homedir(), '.dollhouse', 'telemetry.log');

      // Should append installation event
      expect(mockFileOperations.appendFile).toHaveBeenCalledWith(
        expectedLogPath,
        expect.stringContaining('"event":"install"'),
        expect.objectContaining({ source: 'OperationalTelemetry.recordInstallation' })
      );

      // Verify event structure
      const appendCalls = mockFileOperations.appendFile.mock.calls;
      const logCall = appendCalls.find(call => (call[0] as string).endsWith('telemetry.log'));
      expect(logCall).toBeDefined();

      const eventLine = logCall![1] as string;
      const event = JSON.parse(eventLine.replace(/\n$/, ''));
      const uuidWriteCall = mockFileOperations.writeFile.mock.calls.find(
        call => (call[0] as string).includes('.telemetry-id')
      );

      expect(event).toMatchObject({
        event: 'install',
        install_id: uuidWriteCall?.[1],
        version: testVersion,
        os: expect.any(String),
        node_version: expect.any(String),
        mcp_client: expect.any(String),
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      });
    });

    it('should include correct system information in installation event', async () => {
      mockFileOperations.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await telemetry.initialize();

      const appendCalls = mockFileOperations.appendFile.mock.calls;
      const logCall = appendCalls.find(call => (call[0] as string).endsWith('telemetry.log'));
      const eventLine = logCall![1] as string;
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

      mockFileOperations.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve(testUUID);
        }
        if (filePath.endsWith('telemetry.log')) {
          return Promise.resolve(JSON.stringify(existingEvent) + '\n');
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await telemetry.initialize();

      // Should NOT append new event
      expect(mockFileOperations.appendFile).not.toHaveBeenCalled();
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

      mockFileOperations.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve(testUUID);
        }
        if (filePath.endsWith('telemetry.log')) {
          return Promise.resolve(JSON.stringify(oldVersionEvent) + '\n');
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await telemetry.initialize();

      const expectedLogPath = path.join(os.homedir(), '.dollhouse', 'telemetry.log');

      // Should append new event for current version
      expect(mockFileOperations.appendFile).toHaveBeenCalledWith(
        expectedLogPath,
        expect.stringContaining(`"version":"${testVersion}"`),
        expect.objectContaining({ source: 'OperationalTelemetry.recordInstallation' })
      );
    });

    it('should handle multiple events in telemetry log', async () => {
      const events = [
        { event: 'install', install_id: testUUID, version: '1.9.17', os: 'darwin', node_version: 'v18.0.0', mcp_client: 'claude-desktop', timestamp: '2025-10-01T10:00:00.000Z' },
        { event: 'install', install_id: testUUID, version: '1.9.18', os: 'darwin', node_version: 'v20.0.0', mcp_client: 'claude-code', timestamp: '2025-10-14T10:00:00.000Z' }
      ];

      // FIX (S2004): Use extracted helper to reduce nesting
      mockFileOperations.readFile.mockImplementation(createMultipleEventsMockReadFile(events));

      await telemetry.initialize();

      // Should append new event for current version
      expect(mockFileOperations.appendFile).toHaveBeenCalled();
    });

    it('should skip malformed lines in telemetry log', async () => {
      const logContent = `{"event":"install","install_id":"${testUUID}","version":"1.9.17","os":"darwin"}\nmalformed json line\n{"event":"install","install_id":"${testUUID}","version":"1.9.18","os":"darwin","node_version":"v20.0.0","mcp_client":"unknown","timestamp":"2025-10-14T10:00:00.000Z"}`;

      mockFileOperations.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve(testUUID);
        }
        if (filePath.endsWith('telemetry.log')) {
          return Promise.resolve(logContent);
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await telemetry.initialize();

      // Should still process and append new event (current version not found)
      expect(mockFileOperations.appendFile).toHaveBeenCalled();
    });

    it('should write installation event only once per installation', async () => {
      mockFileOperations.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      // First initialization
      await telemetry.initialize();

      const firstAppendCount = mockFileOperations.appendFile.mock.calls.length;
      expect(firstAppendCount).toBe(1);

      // Second initialization (should skip because already initialized)
      await telemetry.initialize();

      // Should not append again
      expect(mockFileOperations.appendFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('initialize() - error handling', () => {
    it('should handle missing directory gracefully', async () => {
      mockFileOperations.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );
      mockFileOperations.createDirectory.mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      );

      // Should not throw
      await expect(telemetry.initialize()).resolves.not.toThrow();

      // Should mark as initialized to prevent retry loops
      expect((telemetry as any).initialized).toBe(true);
    });

    it('should handle UUID file write permission errors', async () => {
      mockFileOperations.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );
      mockFileOperations.writeFile.mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      );

      // Should not throw
      await expect(telemetry.initialize()).resolves.not.toThrow();

      // Should mark as initialized
      expect((telemetry as any).initialized).toBe(true);
    });

    it('should handle telemetry log write errors', async () => {
      mockFileOperations.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );
      mockFileOperations.appendFile.mockRejectedValue(
        Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      );

      // Should not throw
      await expect(telemetry.initialize()).resolves.not.toThrow();

      // Should still mark as initialized
      expect((telemetry as any).initialized).toBe(true);
    });

    it('should handle telemetry log read errors gracefully', async () => {
      mockFileOperations.readFile.mockImplementation((filePath: string) => {
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
      await expect(telemetry.initialize()).resolves.not.toThrow();

      // Should try to write installation event
      expect(mockFileOperations.appendFile).toHaveBeenCalled();
    });

    it('should never throw exceptions from initialize()', async () => {
      // Simulate catastrophic failure
      mockFileOperations.readFile.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      // Should not throw
      await expect(telemetry.initialize()).resolves.not.toThrow();

      // Should mark as initialized
      expect((telemetry as any).initialized).toBe(true);
    });

    it('should handle empty telemetry log file', async () => {
      mockFileOperations.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve(testUUID);
        }
        if (filePath.endsWith('telemetry.log')) {
          return Promise.resolve('');
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await telemetry.initialize();

      // Should treat as first run and write event
      expect(mockFileOperations.appendFile).toHaveBeenCalled();
    });

    it('should handle telemetry log with only whitespace', async () => {
      mockFileOperations.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('.telemetry-id')) {
          return Promise.resolve(testUUID);
        }
        if (filePath.endsWith('telemetry.log')) {
          return Promise.resolve('   \n  \n  ');
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await telemetry.initialize();

      // Should treat as first run
      expect(mockFileOperations.appendFile).toHaveBeenCalled();
    });
  });

  describe('initialize() - idempotency', () => {
    it('should only initialize once even if called multiple times', async () => {
      mockFileOperations.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      // First call
      await telemetry.initialize();

      const firstCallCount = mockFileOperations.writeFile.mock.calls.length;

      // Second call
      await telemetry.initialize();

      // Third call
      await telemetry.initialize();

      // Should not make additional file operations
      expect(mockFileOperations.writeFile).toHaveBeenCalledTimes(firstCallCount);
    });

    it('should prevent re-initialization after error', async () => {
      mockFileOperations.readFile.mockRejectedValue(new Error('Test error'));

      // First call (will error but mark initialized)
      await telemetry.initialize();

      jest.clearAllMocks();

      // Second call
      await telemetry.initialize();

      // Should not attempt any file operations
      expect(mockFileOperations.readFile).not.toHaveBeenCalled();
    });
  });

  describe('MCP client detection', () => {
    it('should detect Claude Desktop from CLAUDE_DESKTOP_VERSION', async () => {
      process.env.CLAUDE_DESKTOP_VERSION = '1.0.0';
      delete process.env.CLAUDE_CODE;
      delete process.env.VSCODE_CWD;

      mockFileOperations.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await telemetry.initialize();

      const appendCalls = mockFileOperations.appendFile.mock.calls;
      const logCall = appendCalls.find(call => (call[0] as string).endsWith('telemetry.log'));
      const eventLine = logCall![1] as string;
      const event = JSON.parse(eventLine.replace(/\n$/, ''));

      expect(event.mcp_client).toBe('claude-desktop');
    });

    it('should detect Claude Code from TERM_PROGRAM', async () => {
      process.env.TERM_PROGRAM = 'claude-code';
      delete process.env.CLAUDE_DESKTOP_VERSION;
      delete process.env.VSCODE_CWD;

      mockFileOperations.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await telemetry.initialize();

      const appendCalls = mockFileOperations.appendFile.mock.calls;
      const logCall = appendCalls.find(call => (call[0] as string).endsWith('telemetry.log'));
      const eventLine = logCall![1] as string;
      const event = JSON.parse(eventLine.replace(/\n$/, ''));

      expect(event.mcp_client).toBe('claude-code');
    });

    it('should detect VS Code from VSCODE_CWD', async () => {
      process.env.VSCODE_CWD = '/workspace';
      delete process.env.CLAUDE_DESKTOP_VERSION;
      delete process.env.TERM_PROGRAM;

      mockFileOperations.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await telemetry.initialize();

      const appendCalls = mockFileOperations.appendFile.mock.calls;
      const logCall = appendCalls.find(call => (call[0] as string).endsWith('telemetry.log'));
      const eventLine = logCall![1] as string;
      const event = JSON.parse(eventLine.replace(/\n$/, ''));

      expect(event.mcp_client).toBe('vscode');
    });

    it('should return unknown for unrecognized environment', async () => {
      delete process.env.CLAUDE_DESKTOP_VERSION;
      delete process.env.CLAUDE_CODE;
      delete process.env.TERM_PROGRAM;
      delete process.env.VSCODE_CWD;

      mockFileOperations.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await telemetry.initialize();

      const appendCalls = mockFileOperations.appendFile.mock.calls;
      const logCall = appendCalls.find(call => (call[0] as string).endsWith('telemetry.log'));
      const eventLine = logCall![1] as string;
      const event = JSON.parse(eventLine.replace(/\n$/, ''));

      expect(event.mcp_client).toBe('unknown');
    });
  });

  describe('JSON Lines (JSONL) format', () => {
    it('should write events in valid JSONL format', async () => {
      mockFileOperations.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await telemetry.initialize();

      const appendCalls = mockFileOperations.appendFile.mock.calls;
      const logCall = appendCalls.find(call => (call[0] as string).endsWith('telemetry.log'));
      expect(logCall).toBeDefined();

      const eventLine = logCall![1] as string;

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
      mockFileOperations.readFile.mockImplementation(createMultipleEventsMockReadFile(events));

      await telemetry.initialize();

      // Should append new event as separate line
      expect(mockFileOperations.appendFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringMatching(/^\{.*\}\n$/),
        expect.any(Object)
      );
    });
  });

  describe('privacy compliance', () => {
    it('should not collect personal information in installation event', async () => {
      mockFileOperations.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      await telemetry.initialize();

      const appendCalls = mockFileOperations.appendFile.mock.calls;
      const logCall = appendCalls.find(call => (call[0] as string).endsWith('telemetry.log'));
      const eventLine = logCall![1] as string;
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
