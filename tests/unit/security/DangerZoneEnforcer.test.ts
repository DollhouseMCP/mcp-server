/**
 * Unit tests for DangerZoneEnforcer
 *
 * Tests programmatic enforcement of DANGER_ZONE safety tier.
 * Issue #402: Refactored for instance-based testing with mocked FileOperationsService.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { tmpdir } from 'node:os';
import path from 'path';

const TEST_SECURITY_DIR = path.join(tmpdir(), 'test-security');
const TEST_AGENT_NAME = 'test-agent';
const TEST_VERIFICATION_CODE = 'verify-123';
const TEST_ADMIN_TOKEN = 'test-clear-all-token';

// Create mock function for SecurityMonitor
const mockLogSecurityEvent = jest.fn();

// ESM mocking: use unstable_mockModule for proper mock isolation
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
    logSecurityEvent: mockLogSecurityEvent,
  },
}));

const mockMkdir = jest.fn<() => Promise<void>>().mockResolvedValue();
jest.unstable_mockModule('fs/promises', () => ({
  default: { mkdir: mockMkdir },
  mkdir: mockMkdir,
}));

// Dynamic import after mocking (required for ESM)
const { FileDangerZoneBlockStore } = await import('../../../src/state/FileDangerZoneBlockStore.js');
const { DangerZoneEnforcer } = await import('../../../src/security/DangerZoneEnforcer.js');

/**
 * Create a mock FileOperationsService with controlled read/write behavior
 */
interface MockFileOpsOptions {
  readFileResult?: string;
  readFileError?: Error;
  writeFileError?: Error;
}

function createMockReadFile(options?: MockFileOpsOptions) {
  if (options?.readFileError) {
    return jest.fn<() => Promise<string>>().mockRejectedValue(options.readFileError);
  }
  if (options?.readFileResult === undefined) {
    return jest.fn<() => Promise<string>>().mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    );
  }
  return jest.fn<() => Promise<string>>().mockResolvedValue(options.readFileResult);
}

function createMockFileOps(options?: MockFileOpsOptions) {
  return {
    readFile: createMockReadFile(options),
    createFileExclusive: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    withWriteLock: async (_path: string, operation: () => Promise<unknown>) => operation(),
    writeFile: options?.writeFileError
      ? jest.fn<() => Promise<void>>().mockRejectedValue(options.writeFileError)
      : jest.fn<() => Promise<void>>().mockResolvedValue(),
    // Minimal stubs for remaining FileOperationsService interface
    readElementFile: jest.fn<() => Promise<string>>().mockResolvedValue(''),
    deleteFile: jest.fn<() => Promise<void>>().mockResolvedValue(),
    fileExists: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
    listFiles: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
    ensureDirectory: jest.fn<() => Promise<void>>().mockResolvedValue(),
    createDirectory: jest.fn<() => Promise<void>>().mockResolvedValue(),
  } as any;
}

describe('DangerZoneEnforcer', () => {
  let enforcer: InstanceType<typeof DangerZoneEnforcer>;
  let mockFileOps: ReturnType<typeof createMockFileOps>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFileOps = createMockFileOps();
    enforcer = new DangerZoneEnforcer(new FileDangerZoneBlockStore(mockFileOps, TEST_SECURITY_DIR));
    await enforcer.initialize();
    enforcer.setAdminToken(TEST_ADMIN_TOKEN);
  });

  describe('block()', () => {
    it('should block an agent', async () => {
      enforcer.block(
        TEST_AGENT_NAME,
        'Danger zone pattern matched',
        ['beetlejuice_beetlejuice_beetlejuice']
      );

      const result = (await enforcer.check(TEST_AGENT_NAME));
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('Danger zone pattern matched');
      expect(result.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Date(result.blockedAt ?? '').toISOString()).toBe(result.blockedAt);
    });

    it('should include verification ID if provided', async () => {
      enforcer.block(
        TEST_AGENT_NAME,
        'Danger zone',
        ['pattern'],
        TEST_VERIFICATION_CODE
      );

      const result = (await enforcer.check(TEST_AGENT_NAME));
      expect(result.blocked).toBe(true);
      expect(result.verificationId).toBe(TEST_VERIFICATION_CODE);
      expect(result.resolution).toContain(TEST_VERIFICATION_CODE);
    });

    it('should log enriched security event on block', () => {
      enforcer.block(
        'my-agent',
        'test reason',
        ['beetlejuice_beetlejuice_beetlejuice'],
        'v-1',
      );

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'AUTONOMY_DENIED',
          severity: 'HIGH',
          source: 'DangerZoneEnforcer.block',
          details: expect.stringContaining("Agent 'my-agent' blocked"),
          additionalData: expect.objectContaining({
            agentName: 'my-agent',
            reason: 'test reason',
            triggeredPatterns: ['beetlejuice_beetlejuice_beetlejuice'],
            verificationId: 'v-1',
            totalActiveBlocks: 1,
          }),
        })
      );
    });

    it('should persist to disk after blocking', async () => {
      enforcer.block(TEST_AGENT_NAME, 'Reason', ['pattern']);

      // Wait for fire-and-forget persist
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockFileOps.writeFile).toHaveBeenCalledWith(
        path.join(TEST_SECURITY_DIR, 'blocked-agents.json'),
        expect.stringContaining('"test-agent"')
      );
    });
  });

  describe('unblock()', () => {
    it('should unblock an agent', async () => {
      enforcer.block(TEST_AGENT_NAME, 'Blocked', []);

      const unblocked = (await enforcer.unblock(TEST_AGENT_NAME));
      expect(unblocked).toBe(true);

      const result = (await enforcer.check(TEST_AGENT_NAME));
      expect(result.blocked).toBe(false);
    });

    it('should return true for non-blocked agents', async () => {
      const unblocked = (await enforcer.unblock('never-blocked'));
      expect(unblocked).toBe(true);
    });

    it('should require matching verification ID', async () => {
      enforcer.block(TEST_AGENT_NAME, 'Blocked', [], TEST_VERIFICATION_CODE);

      // Wrong verification ID
      const wrongUnblock = (await enforcer.unblock(TEST_AGENT_NAME, 'wrong-id'));
      expect(wrongUnblock).toBe(false);

      // Still blocked
      expect((await enforcer.check(TEST_AGENT_NAME)).blocked).toBe(true);

      // Correct verification ID
      const correctUnblock = (await enforcer.unblock(TEST_AGENT_NAME, TEST_VERIFICATION_CODE));
      expect(correctUnblock).toBe(true);
      expect((await enforcer.check(TEST_AGENT_NAME)).blocked).toBe(false);
    });

    it('should log enriched unblock event with duration', async () => {
      enforcer.block(TEST_AGENT_NAME, 'Blocked', []);
      (await enforcer.unblock(TEST_AGENT_NAME));

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'DangerZoneEnforcer.unblock',
          details: expect.stringContaining("Agent 'test-agent' unblocked after verification"),
          additionalData: expect.objectContaining({
            agentName: TEST_AGENT_NAME,
            blockDurationMs: expect.any(Number),
          }),
        })
      );
    });

    it('should persist to disk after unblocking', async () => {
      enforcer.block(TEST_AGENT_NAME, 'Reason', []);
      await new Promise(resolve => setTimeout(resolve, 50));
      mockFileOps.writeFile.mockClear();

      (await enforcer.unblock(TEST_AGENT_NAME));
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockFileOps.writeFile).toHaveBeenCalled();
    });
  });

  describe('check()', () => {
    it('should return blocked=false for non-blocked agents', async () => {
      const result = (await enforcer.check('unblocked-agent'));
      expect(result.blocked).toBe(false);
      expect(result.reason).toBeUndefined();
      expect(result.resolution).toBeUndefined();
    });

    it('should return block details for blocked agents', async () => {
      enforcer.block('blocked-agent', 'Test reason', ['pattern1']);

      const result = (await enforcer.check('blocked-agent'));
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('Test reason');
      expect(result.resolution).toBeDefined();
    });

    // Issue #142 / #405: Actionable verify_challenge instructions
    it('should include verify_challenge guidance when verificationId is present', async () => {
      enforcer.block('verified-agent', 'DZ trigger', ['pattern'], 'verify-xyz');

      const result = (await enforcer.check('verified-agent'));
      expect(result.blocked).toBe(true);
      expect(result.resolution).toContain('verify_challenge');
      expect(result.resolution).toContain('verify-xyz');
      expect(result.resolution).toContain('code');
    });

    it('should show admin contact when no verificationId', async () => {
      enforcer.block('no-verify-agent', 'DZ trigger', ['pattern']);

      const result = (await enforcer.check('no-verify-agent'));
      expect(result.blocked).toBe(true);
      expect(result.resolution).toContain('administrator');
      expect(result.resolution).not.toContain('verify_challenge');
    });
  });

  describe('hasBlockedAgents()', () => {
    it('should return false when no agents blocked', async () => {
      expect((await enforcer.hasBlockedAgents())).toBe(false);
    });

    it('should return true when agents are blocked', async () => {
      enforcer.block('agent1', 'Reason', []);
      expect((await enforcer.hasBlockedAgents())).toBe(true);
    });
  });

  describe('getBlockedAgents()', () => {
    it('should return empty array when no agents blocked', async () => {
      expect((await enforcer.getBlockedAgents())).toEqual([]);
    });

    it('should return list of blocked agents', async () => {
      enforcer.block('agent1', 'Reason', []);
      enforcer.block('agent2', 'Reason', []);

      const blocked = (await enforcer.getBlockedAgents());
      expect(blocked).toHaveLength(2);
      expect(blocked).toContain('agent1');
      expect(blocked).toContain('agent2');
    });
  });

  describe('clearAll()', () => {
    it('should clear all blocks', async () => {
      enforcer.block('agent1', 'Reason', []);
      enforcer.block('agent2', 'Reason', []);

      expect((await enforcer.hasBlockedAgents())).toBe(true);

      expect(await enforcer.clearAll(TEST_ADMIN_TOKEN)).toBe(true);

      expect((await enforcer.hasBlockedAgents())).toBe(false);
      expect((await enforcer.getBlockedAgents())).toEqual([]);
    });

    it('should require admin token when configured', async () => {
      enforcer.setAdminToken('secret-token');
      enforcer.block('agent1', 'Reason', []);

      // Without token - should fail
      const failedClear = await enforcer.clearAll();
      expect(failedClear).toBe(false);
      expect((await enforcer.hasBlockedAgents())).toBe(true);

      // With wrong token - should fail
      const wrongTokenClear = await enforcer.clearAll('wrong-token');
      expect(wrongTokenClear).toBe(false);
      expect((await enforcer.hasBlockedAgents())).toBe(true);

      // With correct token - should succeed
      const successClear = await enforcer.clearAll('secret-token');
      expect(successClear).toBe(true);
      expect((await enforcer.hasBlockedAgents())).toBe(false);
    });

    it.each([undefined, '', 'unconfigured-token-sentinel'])('should refuse an unconfigured reset with token %p', async (token) => {
      enforcer.setAdminToken(null);
      enforcer.block('agent1', 'Reason', []);
      enforcer.block('agent2', 'Other reason', ['pattern']);
      // Finish the existing block writes before observing the attempted reset.
      await new Promise<void>(resolve => setImmediate(resolve));
      const contexts = await Promise.all((await enforcer.getBlockedAgents()).map(name => enforcer.check(name)));
      const metrics = enforcer.getMetrics();
      const writes = mockFileOps.writeFile.mock.calls.length;
      mockLogSecurityEvent.mockClear();

      expect(await enforcer.clearAll(token)).toBe(false);

      expect(await Promise.all((await enforcer.getBlockedAgents()).map(name => enforcer.check(name)))).toEqual(contexts);
      expect(enforcer.getMetrics()).toEqual(metrics);
      expect(mockFileOps.writeFile).toHaveBeenCalledTimes(writes);
      expect(mockLogSecurityEvent).toHaveBeenCalledTimes(1);
      expect(mockLogSecurityEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'AUTONOMY_DENIED',
        severity: 'HIGH',
        source: 'DangerZoneEnforcer.clearAll',
        additionalData: { tokenConfigured: false, tokenProvided: !!token },
      }));
      expect(JSON.stringify(mockLogSecurityEvent.mock.calls)).not.toContain('unconfigured-token-sentinel');
    });

    it('should log enriched clearAll event with agent names', async () => {
      enforcer.block('agent-a', 'Reason', []);
      enforcer.block('agent-b', 'Reason', []);
      mockLogSecurityEvent.mockClear();

      await enforcer.clearAll(TEST_ADMIN_TOKEN);

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'DangerZoneEnforcer.clearAll',
          details: expect.stringContaining('2 agents'),
          additionalData: expect.objectContaining({
            clearedAgents: expect.arrayContaining(['agent-a', 'agent-b']),
            count: 2,
          }),
        })
      );
    });
  });

  describe('input validation', () => {
    it('should reject empty agent name in block()', async () => {
      await expect(enforcer.block('', 'Reason', [])).rejects.toThrow(
        'block: Agent name is required'
      );
    });

    it('should reject whitespace-only agent name in block()', async () => {
      await expect(enforcer.block('   ', 'Reason', [])).rejects.toThrow(
        'block: Agent name cannot be empty'
      );
    });

    it('should reject invalid characters in agent name', async () => {
      await expect(enforcer.block('agent<script>', 'Reason', [])).rejects.toThrow(
        'block: Agent name contains invalid characters'
      );
      await expect(enforcer.block('agent/path', 'Reason', [])).rejects.toThrow(
        'block: Agent name contains invalid characters'
      );
    });

    it('should reject overly long agent names', async () => {
      const longName = 'a'.repeat(257);
      await expect(enforcer.block(longName, 'Reason', [])).rejects.toThrow(
        'block: Agent name exceeds maximum length'
      );
    });

    it('should reject empty agent name in unblock()', async () => {
      await expect(enforcer.unblock('')).rejects.toThrow(
        'unblock: Agent name is required'
      );
    });

    it('should reject empty agent name in check()', async () => {
      await expect(enforcer.check('')).rejects.toThrow(
        'check: Agent name is required'
      );
    });

    it('should trim whitespace from agent names', async () => {
      enforcer.block('  test-agent  ', 'Reason', []);

      // Should find it with trimmed name
      const result = (await enforcer.check(TEST_AGENT_NAME));
      expect(result.blocked).toBe(true);

      // Should also find it with whitespace (will be trimmed)
      const result2 = (await enforcer.check('  test-agent  '));
      expect(result2.blocked).toBe(true);
    });
  });

  describe('getMetrics()', () => {
    it('should return zero metrics initially', () => {
      const metrics = enforcer.getMetrics();
      expect(metrics.currentBlockedCount).toBe(0);
      expect(metrics.totalBlocksSinceStartup).toBe(0);
      expect(metrics.totalUnblocksSinceStartup).toBe(0);
      expect(metrics.totalClearAllCalls).toBe(0);
      expect(metrics.averageBlockDurationMs).toBe(0);
      expect(metrics.longestBlockDurationMs).toBe(0);
    });

    it('should track block count', () => {
      enforcer.block('agent1', 'Reason', []);
      enforcer.block('agent2', 'Reason', []);

      const metrics = enforcer.getMetrics();
      expect(metrics.currentBlockedCount).toBe(2);
      expect(metrics.totalBlocksSinceStartup).toBe(2);
    });

    it('should track unblock count', async () => {
      enforcer.block('agent1', 'Reason', []);
      (await enforcer.unblock('agent1'));

      const metrics = enforcer.getMetrics();
      expect(metrics.currentBlockedCount).toBe(0);
      expect(metrics.totalBlocksSinceStartup).toBe(1);
      expect(metrics.totalUnblocksSinceStartup).toBe(1);
    });

    it('should track clearAll calls', async () => {
      enforcer.block('agent1', 'Reason', []);
      await enforcer.clearAll(TEST_ADMIN_TOKEN);
      await enforcer.clearAll(TEST_ADMIN_TOKEN);

      const metrics = enforcer.getMetrics();
      expect(metrics.totalClearAllCalls).toBe(2);
    });

    it('should track block durations on unblock', async () => {
      enforcer.block('agent1', 'Reason', []);

      // Wait a tiny bit to ensure duration > 0
      await new Promise(resolve => setTimeout(resolve, 10));

      (await enforcer.unblock('agent1'));

      const metrics = enforcer.getMetrics();
      expect(metrics.averageBlockDurationMs).toBeGreaterThan(0);
      expect(metrics.longestBlockDurationMs).toBeGreaterThan(0);
    });
  });

  describe('initialize() - persistence loading', () => {
    it('should load persisted blocks from disk', async () => {
      const persistedData = JSON.stringify({
        version: 1,
        blocks: {
          'agent-x': {
            reason: 'Previous session block',
            triggeredPatterns: ['beetlejuice_beetlejuice_beetlejuice'],
            blockedAt: '2026-01-01T00:00:00.000Z',
            verificationId: 'v-abc',
            goalId: 'goal-abc',
          },
        },
      });

      const fileOps = createMockFileOps({ readFileResult: persistedData });
      const instance = new DangerZoneEnforcer(new FileDangerZoneBlockStore(fileOps, TEST_SECURITY_DIR));
      await instance.initialize();

      const result = (await instance.check('agent-x'));
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('Previous session block');
      expect(result.verificationId).toBe('v-abc');
      expect(result.eventId).toBe('v-abc');
      expect(result.goalId).toBe('goal-abc');
      expect(result.blockedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('should preserve a block with a safe timestamp when persisted blockedAt is invalid', async () => {
      const persistedData = JSON.stringify({
        version: 1,
        blocks: {
          'agent-invalid-time': {
            reason: 'Previous session block',
            triggeredPatterns: ['beetlejuice_beetlejuice_beetlejuice'],
            blockedAt: 'not-a-timestamp',
            verificationId: 'v-invalid-time',
          },
        },
      });

      const fileOps = createMockFileOps({ readFileResult: persistedData });
      const instance = new DangerZoneEnforcer(new FileDangerZoneBlockStore(fileOps, TEST_SECURITY_DIR));
      await instance.initialize();

      expect((await instance.check('agent-invalid-time'))).toEqual(expect.objectContaining({
        blocked: true,
        blockedAt: '1970-01-01T00:00:00.000Z',
        verificationId: 'v-invalid-time',
      }));
    });

    it('should start with empty blocks when file is missing', async () => {
      const fileOps = createMockFileOps({
        readFileError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      });
      const instance = new DangerZoneEnforcer(new FileDangerZoneBlockStore(fileOps, TEST_SECURITY_DIR));
      await instance.initialize();

      expect((await instance.hasBlockedAgents())).toBe(false);
    });

    it('should hold agent calls on corrupt JSON', async () => {
      const fileOps = createMockFileOps({ readFileResult: 'NOT VALID JSON{{{' });
      const instance = new DangerZoneEnforcer(new FileDangerZoneBlockStore(fileOps, TEST_SECURITY_DIR));
      await instance.initialize();

      expect((await instance.check('agent')).blocked).toBe(true);

      // Should log a security event about corruption
      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'DangerZoneEnforcer.initialize',
          severity: 'HIGH',
          details: expect.stringContaining('unavailable'),
        })
      );
    });

    it('should hold agent calls after disk read errors', async () => {
      const fileOps = createMockFileOps({
        readFileError: new Error('Permission denied'),
      });
      const instance = new DangerZoneEnforcer(new FileDangerZoneBlockStore(fileOps, TEST_SECURITY_DIR));
      await instance.initialize();

      // Should not throw, should start with empty blocks
      expect((await instance.check('agent')).blocked).toBe(true);
    });
  });

  describe('persistence - block survives new instance', () => {
    it('should persist block state that a new instance can restore', async () => {
      // Capture what was written to disk
      let writtenContent = '';
      const writeFileOps = createMockFileOps();
      writeFileOps.writeFile = jest.fn<(path: string, content: string) => Promise<void>>()
        .mockImplementation((_path: string, content: string) => {
          writtenContent = content;
          return Promise.resolve();
        });

      const instance1 = new DangerZoneEnforcer(new FileDangerZoneBlockStore(writeFileOps, TEST_SECURITY_DIR));
      await instance1.initialize();
      instance1.block(
        'agent-survive',
        'Persist test',
        ['pattern-a'],
        'verify-survive',
        { goalId: 'goal-survive' },
      );

      // Wait for fire-and-forget persist
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(writtenContent).toBeTruthy();

      // Create new instance that reads what was written
      const readFileOps = createMockFileOps({ readFileResult: writtenContent });
      const instance2 = new DangerZoneEnforcer(new FileDangerZoneBlockStore(readFileOps, TEST_SECURITY_DIR));
      await instance2.initialize();

      const result = (await instance2.check('agent-survive'));
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('Persist test');
      expect(result.verificationId).toBe('verify-survive');
      expect(result.eventId).toBeDefined();
      expect(result.goalId).toBe('goal-survive');
      expect(result.blockedAt).toBeDefined();
    });
  });

  describe('disk failure resilience', () => {
    it('should still enforce blocks in memory when disk write fails', async () => {
      const fileOps = createMockFileOps({
        writeFileError: new Error('Disk full'),
      });
      const instance = new DangerZoneEnforcer(new FileDangerZoneBlockStore(fileOps, TEST_SECURITY_DIR));
      await instance.initialize();

      // Block should work even though disk write will fail
      instance.block('agent-disk-fail', 'Disk failure test', ['pattern']);

      // Wait for fire-and-forget persist to fail silently
      await new Promise(resolve => setTimeout(resolve, 50));

      // In-memory enforcement still works
      const result = (await instance.check('agent-disk-fail'));
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('unavailable');
    });
  });

  describe('verification ID mismatch security event', () => {
    it('should log VERIFICATION_FAILED / HIGH on verification ID mismatch', async () => {
      enforcer.block(TEST_AGENT_NAME, 'Blocked', ['pattern'], 'correct-id');
      mockLogSecurityEvent.mockClear();

      (await enforcer.unblock(TEST_AGENT_NAME, 'wrong-id'));

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'VERIFICATION_FAILED',
          severity: 'HIGH',
          source: 'DangerZoneEnforcer.unblock',
          details: expect.stringContaining('verification ID mismatch'),
          additionalData: expect.objectContaining({
            agentName: TEST_AGENT_NAME,
            expectedVerificationId: 'correct-id',
            providedVerificationId: 'wrong-id',
            reason: 'verification_id_mismatch',
          }),
        })
      );
    });

    it('should NOT fire security event when unblocking a non-blocked agent', async () => {
      mockLogSecurityEvent.mockClear();

      (await enforcer.unblock('never-blocked'));

      expect(mockLogSecurityEvent).not.toHaveBeenCalled();
    });
  });

  describe('storage persist failure security event', () => {
    it('should report unavailable enforcement on storage persist failure', async () => {
      const fileOps = createMockFileOps({
        writeFileError: new Error('Disk full'),
      });
      const instance = new DangerZoneEnforcer(new FileDangerZoneBlockStore(fileOps, TEST_SECURITY_DIR));
      await instance.initialize();
      instance.setAdminToken(null);

      instance.block('agent-disk', 'Reason', ['pattern']);

      // Wait for fire-and-forget persist to fail
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'DANGER_ZONE_OPERATION',
          severity: 'MEDIUM',
          source: 'DangerZoneEnforcer.persistAsync',
          details: expect.stringContaining('enforcement is unavailable and agents are denied'),
          additionalData: expect.objectContaining({
            error: expect.stringContaining('Disk full'),
            activeBlocks: 1,
          }),
        })
      );
    });
  });

  describe('rolling window metrics', () => {
    it('should cap blockDurations at 1000 entries and still compute valid metrics', async () => {
      // Block and unblock 1005 times to exceed the window
      for (let i = 0; i < 1005; i++) {
        const name = `agent-${i}`;
        enforcer.block(name, 'Reason', []);
        (await enforcer.unblock(name));
      }

      const metrics = enforcer.getMetrics();
      expect(metrics.totalUnblocksSinceStartup).toBe(1005);
      expect(metrics.averageBlockDurationMs).not.toBeNaN();
      expect(metrics.longestBlockDurationMs).not.toBeNaN();
      expect(metrics.averageBlockDurationMs).toBeGreaterThanOrEqual(0);
      expect(metrics.longestBlockDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('audit context in block() (Issue #404)', () => {
    it('should include all audit fields in SecurityMonitor event', () => {
      mockLogSecurityEvent.mockClear();

      enforcer.block(
        'audit-agent',
        'Danger zone pattern matched',
        ['beetlejuice_beetlejuice_beetlejuice'],
        'v-audit',
        {
          stepNumber: 3,
          currentStepDescription: 'Execute shell command',
          currentStepOutcome: 'success',
          nextActionHint: 'beetlejuice_beetlejuice_beetlejuice',
          riskScore: 92,
          goalDescription: 'Clean up temporary files',
          goalId: 'goal-abc-123',
          safetyFactors: ['Safety tier: danger_zone', 'Dangerous operation detected'],
        }
      );

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'AUTONOMY_DENIED',
          severity: 'HIGH',
          source: 'DangerZoneEnforcer.block',
          additionalData: expect.objectContaining({
            agentName: 'audit-agent',
            reason: 'Danger zone pattern matched',
            triggeredPatterns: ['beetlejuice_beetlejuice_beetlejuice'],
            verificationId: 'v-audit',
            totalActiveBlocks: 1,
            stepNumber: 3,
            currentStepDescription: 'Execute shell command',
            currentStepOutcome: 'success',
            nextActionHint: 'beetlejuice_beetlejuice_beetlejuice',
            riskScore: 92,
            goalDescription: 'Clean up temporary files',
            goalId: 'goal-abc-123',
            safetyFactors: ['Safety tier: danger_zone', 'Dangerous operation detected'],
          }),
        })
      );
    });

    it('should still work without audit context (backward compat)', () => {
      mockLogSecurityEvent.mockClear();

      enforcer.block('compat-agent', 'Blocked', ['pattern'], 'v-1');

      const call = mockLogSecurityEvent.mock.calls.find(
        (c: any[]) => c[0]?.source === 'DangerZoneEnforcer.block'
      );
      expect(call).toBeDefined();
      if (!call) {
        throw new Error('Expected the compatibility audit event');
      }
      const additionalData = call[0].additionalData;

      // Existing fields present
      expect(additionalData.agentName).toBe('compat-agent');
      expect(additionalData.reason).toBe('Blocked');
      expect(additionalData.triggeredPatterns).toEqual(['pattern']);
      expect(additionalData.verificationId).toBe('v-1');
      expect(additionalData.totalActiveBlocks).toBe(1);

      // Audit fields are undefined (not provided)
      expect(additionalData.stepNumber).toBeUndefined();
      expect(additionalData.goalDescription).toBeUndefined();
      expect(additionalData.goalId).toBeUndefined();
      expect(additionalData.riskScore).toBeUndefined();
    });

    it('should handle partial audit context', () => {
      mockLogSecurityEvent.mockClear();

      enforcer.block(
        'partial-agent',
        'Partial test',
        ['drop table'],
        undefined,
        {
          stepNumber: 1,
          riskScore: 88,
          // No goalDescription, goalId, etc.
        }
      );

      const call = mockLogSecurityEvent.mock.calls.find(
        (c: any[]) => c[0]?.source === 'DangerZoneEnforcer.block'
      );
      expect(call).toBeDefined();
      if (!call) {
        throw new Error('Expected the partial-context audit event');
      }
      const additionalData = call[0].additionalData;

      expect(additionalData.stepNumber).toBe(1);
      expect(additionalData.riskScore).toBe(88);
      expect(additionalData.goalDescription).toBeUndefined();
      expect(additionalData.goalId).toBeUndefined();
      expect(additionalData.currentStepDescription).toBeUndefined();
    });
  });

  describe('test isolation', () => {
    it('should have independent state per instance', async () => {
      const enforcer1 = new DangerZoneEnforcer(new FileDangerZoneBlockStore(mockFileOps, TEST_SECURITY_DIR));
      await enforcer1.initialize();
      const enforcer2 = new DangerZoneEnforcer(new FileDangerZoneBlockStore(mockFileOps, TEST_SECURITY_DIR));
      await enforcer2.initialize();

      enforcer1.block('agent-1', 'Reason', []);

      // enforcer2 should NOT see enforcer1's block
      expect((await enforcer2.check('agent-1')).blocked).toBe(false);
      expect((await enforcer1.check('agent-1')).blocked).toBe(true);
    });
  });
});
