/**
 * Unit tests for FileConfirmationStore
 *
 * Tests file-backed Gatekeeper confirmation persistence — persist/restore cycle,
 * TTL expiry on load, Map serialization round-trip.
 *
 * Issue #1945
 */

import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const TEST_STATE_DIR = path.join(os.tmpdir(), 'dollhouse-test-state');
const TEST_SESSION_ID = 'test-session';
const CLI_RETAINED = 'cli-retained';

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
const mockReaddir = jest.fn<() => Promise<string[]>>().mockResolvedValue([]);
jest.unstable_mockModule('fs/promises', () => ({
  default: { mkdir: mockMkdir, readdir: mockReaddir },
  mkdir: mockMkdir,
  readdir: mockReaddir,
}));

const { FileConfirmationStore } = await import('../../../src/state/FileConfirmationStore.js');
const { StaticAuditHmacKeyResolver } = await import('../../../src/security/auditHmacKey.js');

const auditResolver = new StaticAuditHmacKeyResolver('44'.repeat(32));

function createMockFileOps(options?: {
  readFileResult?: string;
  readFileError?: Error;
}) {
  let readFileMock: jest.Mock<() => Promise<string>>;
  if (options?.readFileError) {
    readFileMock = jest.fn<() => Promise<string>>().mockRejectedValue(options.readFileError);
  } else if (options?.readFileResult === undefined) {
    readFileMock = jest.fn<() => Promise<string>>().mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    );
  } else {
    readFileMock = jest.fn<() => Promise<string>>().mockResolvedValue(options.readFileResult);
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
    mockReaddir.mockResolvedValue([]);
    mockFileOps = createMockFileOps();
    store = new FileConfirmationStore(mockFileOps, TEST_STATE_DIR, TEST_SESSION_ID, auditResolver);
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
        sessionId: TEST_SESSION_ID,
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
      store = new FileConfirmationStore(mockFileOps, TEST_STATE_DIR, TEST_SESSION_ID, auditResolver);

      await store.initialize();

      expect(store.getAllConfirmations()).toHaveLength(1);
      expect(store.getConfirmation('create_element')?.operation).toBe('create_element');
      expect(store.getPermissionPromptActive()).toBe(true);
    });

    it('should drop expired CLI approvals on load', async () => {
      const now = Date.now();
      const persisted = {
        version: 1,
        sessionId: TEST_SESSION_ID,
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
      store = new FileConfirmationStore(mockFileOps, TEST_STATE_DIR, TEST_SESSION_ID, auditResolver);

      await store.initialize();

      // Expired one should be dropped, fresh one should survive
      expect(store.getAllCliApprovals()).toHaveLength(1);
      expect(store.getCliApproval('cli-fresh')?.toolName).toBe('Edit');
      expect(store.getCliApproval('cli-expired')).toBeUndefined();
    });

    it('should handle corrupt JSON gracefully', async () => {
      mockFileOps = createMockFileOps({ readFileResult: 'not-json' });
      store = new FileConfirmationStore(mockFileOps, TEST_STATE_DIR, TEST_SESSION_ID, auditResolver);

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

    it('getRawApprovalDetail returns null when raw detail was not retained', async () => {
      store.saveCliApproval('cli-redacted', {
        requestId: 'cli-redacted',
        toolName: 'Bash',
        toolInputDigest: { command: { redacted: true } },
        toolInputHash: 'hmac_v1:test',
        riskLevel: 'moderate',
        riskScore: 50,
        irreversible: false,
        requestedAt: new Date().toISOString(),
        consumed: false,
        scope: 'single' as const,
        denyReason: 'test',
      });

      await expect(store.getRawApprovalDetail(TEST_SESSION_ID, 'cli-redacted')).resolves.toBeNull();
    });

    it('getRawApprovalDetail requires matching sessionId', async () => {
      store.saveCliApproval(CLI_RETAINED, {
        requestId: CLI_RETAINED,
        toolName: 'Bash',
        toolInputDigest: { command: { redacted: true } },
        toolInputHash: 'hmac_v1:test',
        toolInputDetail: { command: 'npm test' },
        riskLevel: 'moderate',
        riskScore: 50,
        irreversible: false,
        requestedAt: new Date().toISOString(),
        consumed: false,
        scope: 'single' as const,
        denyReason: 'test',
      });

      await expect(store.getRawApprovalDetail('other-session', CLI_RETAINED)).resolves.toBeNull();
      await expect(store.getRawApprovalDetail(TEST_SESSION_ID, CLI_RETAINED)).resolves.toEqual({ command: 'npm test' });
    });

    it('findApprovals returns digest-only refs and never raw detail', async () => {
      store.saveCliApproval(CLI_RETAINED, {
        requestId: CLI_RETAINED,
        toolName: 'Bash',
        toolInputDigest: { command: { redacted: true } },
        toolInputHash: 'hmac_v1:test',
        toolInputDetail: { command: 'npm test' },
        riskLevel: 'moderate',
        riskScore: 50,
        irreversible: false,
        requestedAt: new Date().toISOString(),
        consumed: false,
        scope: 'single' as const,
        denyReason: 'test',
      });

      const refs = await store.findApprovals({});
      expect(refs).toEqual([
        expect.objectContaining({
          sessionId: TEST_SESSION_ID,
          approvalId: CLI_RETAINED,
          digest: { command: { redacted: true } },
        }),
      ]);
      expect(JSON.stringify(refs)).not.toContain('npm test');
    });

    it('findApprovals scans other session files', async () => {
      const otherState = {
        version: 1,
        sessionId: 'other-session',
        lastUpdated: new Date().toISOString(),
        confirmations: [],
        cliApprovals: [[
          'cli-other',
          {
            requestId: 'cli-other',
            toolName: 'Edit',
            toolInput: { old_string: 'secret' },
            riskLevel: 'moderate',
            riskScore: 20,
            irreversible: false,
            requestedAt: new Date().toISOString(),
            consumed: false,
            scope: 'single',
            denyReason: 'test',
          },
        ]],
        cliSessionApprovals: [],
        permissionPromptActive: false,
      };
      mockReaddir.mockResolvedValue(['confirmations-other-session.json']);
      mockFileOps.readFile = jest.fn<() => Promise<string>>()
        .mockResolvedValueOnce(JSON.stringify(otherState));

      const refs = await store.findApprovals({});
      expect(refs).toEqual([
        expect.objectContaining({
          sessionId: 'other-session',
          approvalId: 'cli-other',
          toolName: 'Edit',
        }),
      ]);
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

      const writtenContent = mockFileOps.writeFile.mock.calls.at(-1)![1];

      const readMockFileOps = createMockFileOps({ readFileResult: writtenContent });
      const store2 = new FileConfirmationStore(readMockFileOps, TEST_STATE_DIR, TEST_SESSION_ID, auditResolver);
      await store2.initialize();

      expect(store2.getConfirmation('create_element:skill')?.operation).toBe('create_element');
      expect(store2.getConfirmation('create_element:skill')?.useCount).toBe(2);
      expect(store2.getCliApproval('cli-abc')?.toolName).toBe('Bash');
      expect(store2.getPermissionPromptActive()).toBe(true);
    });

    it('read-side shim upgrades old-shape records — restored approval has digest+hash and no raw toolInput', async () => {
      // Reviewer finding 2026-05-22: the original round-trip test asserted
      // only that `toolName` survives, which would pass even if the shim
      // silently dropped the audit fields. Pin the shim behavior explicitly:
      // an old-shape record persisted (with `toolInput`) must be restored
      // in the new shape with `toolInputDigest` and `toolInputHash`, and
      // the raw `toolInput` must not survive to the in-memory record.
      const oldShapeState = {
        version: 1,
        sessionId: TEST_SESSION_ID,
        lastUpdated: new Date().toISOString(),
        confirmations: [],
        cliApprovals: [[
          'cli-old',
          {
            requestId: 'cli-old',
            toolName: 'Bash',
            toolInput: { command: 'echo legacy' },
            riskLevel: 'moderate',
            riskScore: 40,
            irreversible: false,
            requestedAt: new Date().toISOString(),
            consumed: false,
            scope: 'single',
            denyReason: 'test',
          },
        ]],
        cliSessionApprovals: [],
        permissionPromptActive: false,
      };
      const readMockFileOps = createMockFileOps({ readFileResult: JSON.stringify(oldShapeState) });
      const store2 = new FileConfirmationStore(readMockFileOps, TEST_STATE_DIR, TEST_SESSION_ID, auditResolver);
      await store2.initialize();

      const restored = store2.getCliApproval('cli-old');
      expect(restored).toBeDefined();
      expect(restored?.toolName).toBe('Bash');
      // Shim produced new-shape fields:
      expect(restored?.toolInputDigest).toEqual(expect.objectContaining({
        command: expect.objectContaining({ redacted: true }),
      }));
      // Pin the exact hash hex: any silent change to canonicalJSON or the
      // HMAC ingredients would shift this value and break the test. Derived
      // by running:
      //   createHmac('sha256', Buffer.alloc(32, 0x44))
      //     .update('{"command":"echo legacy"}')
      //     .digest('hex')
      expect(restored?.toolInputHash).toBe(
        'static:21c11b8153f9d92547d0aaeab095c2a20f1d03e65179cd34eab6e0ab85e8a38a'
      );
      // Raw toolInput must NOT survive into the in-memory record:
      expect((restored as unknown as { toolInput?: unknown }).toolInput).toBeUndefined();
    });
  });
});
