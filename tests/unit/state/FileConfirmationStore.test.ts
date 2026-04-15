/**
 * Unit tests for FileConfirmationStore
 *
 * Tests file-backed Gatekeeper confirmation persistence — persist/restore cycle,
 * TTL expiry on load, Map serialization round-trip.
 *
 * Issue #1945
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: {
    logSecurityEvent: jest.fn(),
  },
}));

const mockMkdir = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('fs/promises', () => ({
  default: { mkdir: mockMkdir },
  mkdir: mockMkdir,
}));

const { FileConfirmationStore } = await import('../../../src/state/FileConfirmationStore.js');

function createMockFileOps(options?: {
  readFileResult?: string;
  readFileError?: Error;
}) {
  let readFileMock: jest.Mock<() => Promise<string>>;
  if (options?.readFileError) {
    readFileMock = jest.fn<() => Promise<string>>().mockRejectedValue(options.readFileError);
  } else if (options?.readFileResult !== undefined) {
    readFileMock = jest.fn<() => Promise<string>>().mockResolvedValue(options.readFileResult);
  } else {
    readFileMock = jest.fn<() => Promise<string>>().mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    );
  }
  return {
    readFile: readFileMock,
    writeFile: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as ReturnType<typeof createMockFileOps>;
}

describe('FileConfirmationStore', () => {
  let store: InstanceType<typeof FileConfirmationStore>;
  let mockFileOps: ReturnType<typeof createMockFileOps>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFileOps = createMockFileOps();
    store = new FileConfirmationStore(mockFileOps, '/tmp/test-state', 'test-session');
  });

  describe('initialize()', () => {
    it('should start fresh when no file exists', async () => {
      await store.initialize();
      expect(store.getAllConfirmations()).toEqual([]);
      expect(store.getAllCliApprovals()).toEqual([]);
    });

    it('should restore confirmations from disk', async () => {
      const persisted = {
        version: 1,
        sessionId: 'test-session',
        lastUpdated: '2026-04-13T00:00:00Z',
        confirmations: [
          ['create_element', {
            operation: 'create_element',
            confirmedAt: '2026-04-13T00:00:00Z',
            permissionLevel: 'CONFIRM_SESSION',
            useCount: 1,
          }],
        ],
        cliApprovals: [],
        cliSessionApprovals: [],
        permissionPromptActive: true,
      };
      mockFileOps = createMockFileOps({ readFileResult: JSON.stringify(persisted) });
      store = new FileConfirmationStore(mockFileOps, '/tmp/test-state', 'test-session');

      await store.initialize();

      expect(store.getAllConfirmations()).toHaveLength(1);
      expect(store.getConfirmation('create_element')?.operation).toBe('create_element');
      expect(store.getPermissionPromptActive()).toBe(true);
    });

    it('should drop expired CLI approvals on load', async () => {
      const now = Date.now();
      const persisted = {
        version: 1,
        sessionId: 'test-session',
        lastUpdated: new Date().toISOString(),
        confirmations: [],
        cliApprovals: [
          // Expired pending approval (10 minutes old, 5 min TTL)
          ['cli-expired', {
            requestId: 'cli-expired',
            toolName: 'Bash',
            toolInput: {},
            riskLevel: 'moderate',
            riskScore: 50,
            irreversible: false,
            requestedAt: new Date(now - 600_000).toISOString(),
            consumed: false,
            scope: 'single',
            denyReason: 'test',
            ttlMs: 300_000,
          }],
          // Fresh pending approval (10 seconds old, 5 min TTL)
          ['cli-fresh', {
            requestId: 'cli-fresh',
            toolName: 'Edit',
            toolInput: {},
            riskLevel: 'moderate',
            riskScore: 30,
            irreversible: false,
            requestedAt: new Date(now - 10_000).toISOString(),
            consumed: false,
            scope: 'single',
            denyReason: 'test',
            ttlMs: 300_000,
          }],
        ],
        cliSessionApprovals: [],
        permissionPromptActive: false,
      };
      mockFileOps = createMockFileOps({ readFileResult: JSON.stringify(persisted) });
      store = new FileConfirmationStore(mockFileOps, '/tmp/test-state', 'test-session');

      await store.initialize();

      // Expired one should be dropped, fresh one should survive
      expect(store.getAllCliApprovals()).toHaveLength(1);
      expect(store.getCliApproval('cli-fresh')?.toolName).toBe('Edit');
      expect(store.getCliApproval('cli-expired')).toBeUndefined();
    });

    it('should handle corrupt JSON gracefully', async () => {
      mockFileOps = createMockFileOps({ readFileResult: 'not-json' });
      store = new FileConfirmationStore(mockFileOps, '/tmp/test-state', 'test-session');

      await store.initialize();
      expect(store.getAllConfirmations()).toEqual([]);
    });
  });

  describe('confirmation CRUD', () => {
    it('should save and retrieve confirmations', () => {
      const record = {
        operation: 'delete_element',
        confirmedAt: new Date().toISOString(),
        permissionLevel: 'CONFIRM_SESSION' as const,
        useCount: 0,
      };
      store.saveConfirmation('delete_element', record);

      expect(store.getConfirmation('delete_element')).toEqual(record);
      expect(store.getAllConfirmations()).toHaveLength(1);
    });

    it('should delete confirmations', () => {
      store.saveConfirmation('op1', {
        operation: 'op1',
        confirmedAt: new Date().toISOString(),
        permissionLevel: 'CONFIRM_SESSION' as const,
        useCount: 0,
      });

      expect(store.deleteConfirmation('op1')).toBe(true);
      expect(store.getConfirmation('op1')).toBeUndefined();
    });

    it('should clear all confirmations', () => {
      store.saveConfirmation('op1', {
        operation: 'op1',
        confirmedAt: new Date().toISOString(),
        permissionLevel: 'CONFIRM_SESSION' as const,
        useCount: 0,
      });
      store.saveConfirmation('op2', {
        operation: 'op2',
        confirmedAt: new Date().toISOString(),
        permissionLevel: 'CONFIRM_SINGLE_USE' as const,
        useCount: 0,
      });

      store.clearAllConfirmations();
      expect(store.getAllConfirmations()).toEqual([]);
    });
  });

  describe('CLI approval CRUD', () => {
    it('should save and retrieve CLI approvals', () => {
      const record = {
        requestId: 'cli-123',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        riskLevel: 'moderate',
        riskScore: 50,
        irreversible: false,
        requestedAt: new Date().toISOString(),
        consumed: false,
        scope: 'single' as const,
        denyReason: 'test',
      };
      store.saveCliApproval('cli-123', record);

      expect(store.getCliApproval('cli-123')).toEqual(record);
      expect(store.getAllCliApprovals()).toHaveLength(1);
    });

    it('should save and retrieve session-scoped approvals', () => {
      const record = {
        requestId: 'cli-456',
        toolName: 'Bash',
        toolInput: {},
        riskLevel: 'moderate',
        riskScore: 30,
        irreversible: false,
        requestedAt: new Date().toISOString(),
        approvedAt: new Date().toISOString(),
        consumed: false,
        scope: 'tool_session' as const,
        denyReason: 'test',
      };
      store.saveCliSessionApproval('Bash', record);

      expect(store.getCliSessionApproval('Bash')).toEqual(record);
    });
  });

  describe('round-trip persistence', () => {
    it('should survive a write → read cycle', async () => {
      store.saveConfirmation('create_element:skill', {
        operation: 'create_element',
        confirmedAt: new Date().toISOString(),
        permissionLevel: 'CONFIRM_SESSION' as const,
        useCount: 2,
        elementType: 'skill',
      });
      store.saveCliApproval('cli-abc', {
        requestId: 'cli-abc',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
        riskLevel: 'moderate',
        riskScore: 40,
        irreversible: false,
        requestedAt: new Date().toISOString(),
        consumed: false,
        scope: 'single' as const,
        denyReason: 'test',
      });
      store.savePermissionPromptActive(true);

      await store.persist();
      await new Promise(resolve => setTimeout(resolve, 10));

      const writtenContent = mockFileOps.writeFile.mock.calls[mockFileOps.writeFile.mock.calls.length - 1][1];

      const readMockFileOps = createMockFileOps({ readFileResult: writtenContent });
      const store2 = new FileConfirmationStore(readMockFileOps, '/tmp/test-state', 'test-session');
      await store2.initialize();

      expect(store2.getConfirmation('create_element:skill')?.operation).toBe('create_element');
      expect(store2.getConfirmation('create_element:skill')?.useCount).toBe(2);
      expect(store2.getCliApproval('cli-abc')?.toolName).toBe('Bash');
      expect(store2.getPermissionPromptActive()).toBe(true);
    });
  });
});
