/**
 * Unit tests for DangerZoneEnforcer
 *
 * Tests programmatic enforcement of DANGER_ZONE safety tier.
 * Issue #402: Refactored for instance-based testing with mocked FileOperationsService.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import path from 'path';

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

const mockMkdir = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('fs/promises', () => ({
  default: { mkdir: mockMkdir },
  mkdir: mockMkdir,
}));

// Dynamic import after mocking (required for ESM)
const { DangerZoneEnforcer } = await import('../../../src/security/DangerZoneEnforcer.js');

/**
 * Create a mock FileOperationsService with controlled read/write behavior
 */
function createMockFileOps(options?: {
  readFileResult?: string;
  readFileError?: Error;
  writeFileError?: Error;
}) {
  return {
    readFile: options?.readFileError
      ? jest.fn<() => Promise<string>>().mockRejectedValue(options.readFileError)
      : options?.readFileResult !== undefined
        ? jest.fn<() => Promise<string>>().mockResolvedValue(options.readFileResult)
        : jest.fn<() => Promise<string>>().mockRejectedValue(
            Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          ),
    writeFile: options?.writeFileError
      ? jest.fn<() => Promise<void>>().mockRejectedValue(options.writeFileError)
      : jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    // Minimal stubs for remaining FileOperationsService interface
    readElementFile: jest.fn<() => Promise<string>>().mockResolvedValue(''),
    deleteFile: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    fileExists: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
    listFiles: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
    ensureDirectory: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as any;
}

describe('DangerZoneEnforcer', () => {
  let enforcer: InstanceType<typeof DangerZoneEnforcer>;
  let mockFileOps: ReturnType<typeof createMockFileOps>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFileOps = createMockFileOps();
    enforcer = new DangerZoneEnforcer(mockFileOps, '/tmp/test-security');
    enforcer.setAdminToken(null); // Disable admin token for most tests
  });

  describe('block()', () => {
    it('should block an agent', () => {
      enforcer.block(
        'test-agent',
        'Danger zone pattern matched',
        ['rm -rf', 'drop database']
      );

      const result = enforcer.check('test-agent');
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('Danger zone pattern matched');
    });

    it('should include verification ID if provided', () => {
      enforcer.block(
        'test-agent',
        'Danger zone',
        ['pattern'],
        'verify-123'
      );

      const result = enforcer.check('test-agent');
      expect(result.blocked).toBe(true);
      expect(result.verificationId).toBe('verify-123');
      expect(result.resolution).toContain('verify-123');
    });

    it('should log enriched security event on block', () => {
      enforcer.block('my-agent', 'test reason', ['rm -rf', 'drop db'], 'v-1');

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'AUTONOMY_DENIED',
          severity: 'HIGH',
          source: 'DangerZoneEnforcer.block',
          details: expect.stringContaining("Agent 'my-agent' blocked"),
          additionalData: expect.objectContaining({
            agentName: 'my-agent',
            reason: 'test reason',
            triggeredPatterns: ['rm -rf', 'drop db'],
            verificationId: 'v-1',
            totalActiveBlocks: 1,
          }),
        })
      );
    });

    it('should persist to disk after blocking', async () => {
      enforcer.block('test-agent', 'Reason', ['pattern']);

      // Wait for fire-and-forget persist
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockFileOps.writeFile).toHaveBeenCalledWith(
        path.join('/tmp/test-security', 'blocked-agents.json'),
        expect.stringContaining('"test-agent"')
      );
    });
  });

  describe('unblock()', () => {
    it('should unblock an agent', () => {
      enforcer.block('test-agent', 'Blocked', []);

      const unblocked = enforcer.unblock('test-agent');
      expect(unblocked).toBe(true);

      const result = enforcer.check('test-agent');
      expect(result.blocked).toBe(false);
    });

    it('should return true for non-blocked agents', () => {
      const unblocked = enforcer.unblock('never-blocked');
      expect(unblocked).toBe(true);
    });

    it('should require matching verification ID', () => {
      enforcer.block('test-agent', 'Blocked', [], 'verify-123');

      // Wrong verification ID
      const wrongUnblock = enforcer.unblock('test-agent', 'wrong-id');
      expect(wrongUnblock).toBe(false);

      // Still blocked
      expect(enforcer.check('test-agent').blocked).toBe(true);

      // Correct verification ID
      const correctUnblock = enforcer.unblock('test-agent', 'verify-123');
      expect(correctUnblock).toBe(true);
      expect(enforcer.check('test-agent').blocked).toBe(false);
    });

    it('should log enriched unblock event with duration', () => {
      enforcer.block('test-agent', 'Blocked', []);
      enforcer.unblock('test-agent');

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'DangerZoneEnforcer.unblock',
          details: expect.stringContaining("Agent 'test-agent' unblocked after verification"),
          additionalData: expect.objectContaining({
            agentName: 'test-agent',
            blockDurationMs: expect.any(Number),
          }),
        })
      );
    });

    it('should persist to disk after unblocking', async () => {
      enforcer.block('test-agent', 'Reason', []);
      await new Promise(resolve => setTimeout(resolve, 50));
      mockFileOps.writeFile.mockClear();

      enforcer.unblock('test-agent');
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockFileOps.writeFile).toHaveBeenCalled();
    });
  });

  describe('check()', () => {
    it('should return blocked=false for non-blocked agents', () => {
      const result = enforcer.check('unblocked-agent');
      expect(result.blocked).toBe(false);
      expect(result.reason).toBeUndefined();
      expect(result.resolution).toBeUndefined();
    });

    it('should return block details for blocked agents', () => {
      enforcer.block('blocked-agent', 'Test reason', ['pattern1']);

      const result = enforcer.check('blocked-agent');
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('Test reason');
      expect(result.resolution).toBeDefined();
    });

    // Issue #142 / #405: Actionable verify_challenge instructions
    it('should include verify_challenge guidance when verificationId is present', () => {
      enforcer.block('verified-agent', 'DZ trigger', ['pattern'], 'verify-xyz');

      const result = enforcer.check('verified-agent');
      expect(result.blocked).toBe(true);
      expect(result.resolution).toContain('verify_challenge');
      expect(result.resolution).toContain('verify-xyz');
      expect(result.resolution).toContain('code');
    });

    it('should show admin contact when no verificationId', () => {
      enforcer.block('no-verify-agent', 'DZ trigger', ['pattern']);

      const result = enforcer.check('no-verify-agent');
      expect(result.blocked).toBe(true);
      expect(result.resolution).toContain('administrator');
      expect(result.resolution).not.toContain('verify_challenge');
    });
  });

  describe('hasBlockedAgents()', () => {
    it('should return false when no agents blocked', () => {
      expect(enforcer.hasBlockedAgents()).toBe(false);
    });

    it('should return true when agents are blocked', () => {
      enforcer.block('agent1', 'Reason', []);
      expect(enforcer.hasBlockedAgents()).toBe(true);
    });
  });

  describe('getBlockedAgents()', () => {
    it('should return empty array when no agents blocked', () => {
      expect(enforcer.getBlockedAgents()).toEqual([]);
    });

    it('should return list of blocked agents', () => {
      enforcer.block('agent1', 'Reason', []);
      enforcer.block('agent2', 'Reason', []);

      const blocked = enforcer.getBlockedAgents();
      expect(blocked).toHaveLength(2);
      expect(blocked).toContain('agent1');
      expect(blocked).toContain('agent2');
    });
  });

  describe('clearAll()', () => {
    it('should clear all blocks', () => {
      enforcer.block('agent1', 'Reason', []);
      enforcer.block('agent2', 'Reason', []);

      expect(enforcer.hasBlockedAgents()).toBe(true);

      enforcer.clearAll();

      expect(enforcer.hasBlockedAgents()).toBe(false);
      expect(enforcer.getBlockedAgents()).toEqual([]);
    });

    it('should require admin token when configured', () => {
      enforcer.setAdminToken('secret-token');
      enforcer.block('agent1', 'Reason', []);

      // Without token - should fail
      const failedClear = enforcer.clearAll();
      expect(failedClear).toBe(false);
      expect(enforcer.hasBlockedAgents()).toBe(true);

      // With wrong token - should fail
      const wrongTokenClear = enforcer.clearAll('wrong-token');
      expect(wrongTokenClear).toBe(false);
      expect(enforcer.hasBlockedAgents()).toBe(true);

      // With correct token - should succeed
      const successClear = enforcer.clearAll('secret-token');
      expect(successClear).toBe(true);
      expect(enforcer.hasBlockedAgents()).toBe(false);
    });

    it('should work without token when not configured', () => {
      enforcer.setAdminToken(null);
      enforcer.block('agent1', 'Reason', []);

      const result = enforcer.clearAll();
      expect(result).toBe(true);
      expect(enforcer.hasBlockedAgents()).toBe(false);
    });

    it('should log enriched clearAll event with agent names', () => {
      enforcer.block('agent-a', 'Reason', []);
      enforcer.block('agent-b', 'Reason', []);
      mockLogSecurityEvent.mockClear();

      enforcer.clearAll();

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
    it('should reject empty agent name in block()', () => {
      expect(() => enforcer.block('', 'Reason', [])).toThrow(
        'block: Agent name is required'
      );
    });

    it('should reject whitespace-only agent name in block()', () => {
      expect(() => enforcer.block('   ', 'Reason', [])).toThrow(
        'block: Agent name cannot be empty'
      );
    });

    it('should reject invalid characters in agent name', () => {
      expect(() => enforcer.block('agent<script>', 'Reason', [])).toThrow(
        'block: Agent name contains invalid characters'
      );
      expect(() => enforcer.block('agent/path', 'Reason', [])).toThrow(
        'block: Agent name contains invalid characters'
      );
    });

    it('should reject overly long agent names', () => {
      const longName = 'a'.repeat(257);
      expect(() => enforcer.block(longName, 'Reason', [])).toThrow(
        'block: Agent name exceeds maximum length'
      );
    });

    it('should reject empty agent name in unblock()', () => {
      expect(() => enforcer.unblock('')).toThrow(
        'unblock: Agent name is required'
      );
    });

    it('should reject empty agent name in check()', () => {
      expect(() => enforcer.check('')).toThrow(
        'check: Agent name is required'
      );
    });

    it('should trim whitespace from agent names', () => {
      enforcer.block('  test-agent  ', 'Reason', []);

      // Should find it with trimmed name
      const result = enforcer.check('test-agent');
      expect(result.blocked).toBe(true);

      // Should also find it with whitespace (will be trimmed)
      const result2 = enforcer.check('  test-agent  ');
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

    it('should track unblock count', () => {
      enforcer.block('agent1', 'Reason', []);
      enforcer.unblock('agent1');

      const metrics = enforcer.getMetrics();
      expect(metrics.currentBlockedCount).toBe(0);
      expect(metrics.totalBlocksSinceStartup).toBe(1);
      expect(metrics.totalUnblocksSinceStartup).toBe(1);
    });

    it('should track clearAll calls', () => {
      enforcer.block('agent1', 'Reason', []);
      enforcer.clearAll();
      enforcer.clearAll();

      const metrics = enforcer.getMetrics();
      expect(metrics.totalClearAllCalls).toBe(2);
    });

    it('should track block durations on unblock', async () => {
      enforcer.block('agent1', 'Reason', []);

      // Wait a tiny bit to ensure duration > 0
      await new Promise(resolve => setTimeout(resolve, 10));

      enforcer.unblock('agent1');

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
            triggeredPatterns: ['rm -rf'],
            blockedAt: '2026-01-01T00:00:00.000Z',
            verificationId: 'v-abc',
          },
        },
      });

      const fileOps = createMockFileOps({ readFileResult: persistedData });
      const instance = new DangerZoneEnforcer(fileOps, '/tmp/test-security');
      await instance.initialize();

      const result = instance.check('agent-x');
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('Previous session block');
      expect(result.verificationId).toBe('v-abc');
    });

    it('should start with empty blocks when file is missing', async () => {
      const fileOps = createMockFileOps({
        readFileError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      });
      const instance = new DangerZoneEnforcer(fileOps, '/tmp/test-security');
      await instance.initialize();

      expect(instance.hasBlockedAgents()).toBe(false);
    });

    it('should start with empty blocks on corrupt JSON', async () => {
      const fileOps = createMockFileOps({ readFileResult: 'NOT VALID JSON{{{' });
      const instance = new DangerZoneEnforcer(fileOps, '/tmp/test-security');
      await instance.initialize();

      expect(instance.hasBlockedAgents()).toBe(false);

      // Should log a security event about corruption
      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'DangerZoneEnforcer.initialize',
          details: expect.stringContaining('possible data corruption'),
        })
      );
    });

    it('should survive disk read errors', async () => {
      const fileOps = createMockFileOps({
        readFileError: new Error('Permission denied'),
      });
      const instance = new DangerZoneEnforcer(fileOps, '/tmp/test-security');
      await instance.initialize();

      // Should not throw, should start with empty blocks
      expect(instance.hasBlockedAgents()).toBe(false);
    });
  });

  describe('persistence - block survives new instance', () => {
    it('should persist block state that a new instance can restore', async () => {
      // Capture what was written to disk
      let writtenContent = '';
      const writeFileOps = createMockFileOps();
      writeFileOps.writeFile = jest.fn<(path: string, content: string) => Promise<void>>()
        .mockImplementation(async (_path: string, content: string) => {
          writtenContent = content;
        });

      const instance1 = new DangerZoneEnforcer(writeFileOps, '/tmp/test-security');
      instance1.block('agent-survive', 'Persist test', ['pattern-a'], 'verify-survive');

      // Wait for fire-and-forget persist
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(writtenContent).toBeTruthy();

      // Create new instance that reads what was written
      const readFileOps = createMockFileOps({ readFileResult: writtenContent });
      const instance2 = new DangerZoneEnforcer(readFileOps, '/tmp/test-security');
      await instance2.initialize();

      const result = instance2.check('agent-survive');
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('Persist test');
      expect(result.verificationId).toBe('verify-survive');
    });
  });

  describe('disk failure resilience', () => {
    it('should still enforce blocks in memory when disk write fails', async () => {
      const fileOps = createMockFileOps({
        writeFileError: new Error('Disk full'),
      });
      const instance = new DangerZoneEnforcer(fileOps, '/tmp/test-security');

      // Block should work even though disk write will fail
      instance.block('agent-disk-fail', 'Disk failure test', ['pattern']);

      // Wait for fire-and-forget persist to fail silently
      await new Promise(resolve => setTimeout(resolve, 50));

      // In-memory enforcement still works
      const result = instance.check('agent-disk-fail');
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('Disk failure test');
    });
  });

  describe('verification ID mismatch security event', () => {
    it('should log VERIFICATION_FAILED / HIGH on verification ID mismatch', () => {
      enforcer.block('test-agent', 'Blocked', ['pattern'], 'correct-id');
      mockLogSecurityEvent.mockClear();

      enforcer.unblock('test-agent', 'wrong-id');

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'VERIFICATION_FAILED',
          severity: 'HIGH',
          source: 'DangerZoneEnforcer.unblock',
          details: expect.stringContaining('verification ID mismatch'),
          additionalData: expect.objectContaining({
            agentName: 'test-agent',
            expectedVerificationId: 'correct-id',
            providedVerificationId: 'wrong-id',
            reason: 'verification_id_mismatch',
          }),
        })
      );
    });

    it('should NOT fire security event when unblocking a non-blocked agent', () => {
      mockLogSecurityEvent.mockClear();

      enforcer.unblock('never-blocked');

      expect(mockLogSecurityEvent).not.toHaveBeenCalled();
    });
  });

  describe('disk persist failure security event', () => {
    it('should log DANGER_ZONE_OPERATION / MEDIUM on disk persist failure', async () => {
      const fileOps = createMockFileOps({
        writeFileError: new Error('Disk full'),
      });
      const instance = new DangerZoneEnforcer(fileOps, '/tmp/test-security');
      instance.setAdminToken(null);

      instance.block('agent-disk', 'Reason', ['pattern']);

      // Wait for fire-and-forget persist to fail
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'DANGER_ZONE_OPERATION',
          severity: 'MEDIUM',
          source: 'DangerZoneEnforcer.persistAsync',
          details: expect.stringContaining('Failed to persist'),
          additionalData: expect.objectContaining({
            error: expect.stringContaining('Disk full'),
            activeBlocks: 1,
          }),
        })
      );
    });
  });

  describe('rolling window metrics', () => {
    it('should cap blockDurations at 1000 entries and still compute valid metrics', () => {
      // Block and unblock 1005 times to exceed the window
      for (let i = 0; i < 1005; i++) {
        const name = `agent-${i}`;
        enforcer.block(name, 'Reason', []);
        enforcer.unblock(name);
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
        ['rm -rf'],
        'v-audit',
        {
          stepNumber: 3,
          currentStepDescription: 'Execute shell command',
          currentStepOutcome: 'success',
          nextActionHint: 'rm -rf /tmp/data',
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
            triggeredPatterns: ['rm -rf'],
            verificationId: 'v-audit',
            totalActiveBlocks: 1,
            stepNumber: 3,
            currentStepDescription: 'Execute shell command',
            currentStepOutcome: 'success',
            nextActionHint: 'rm -rf /tmp/data',
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
      const additionalData = call![0].additionalData;

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
      const additionalData = call![0].additionalData;

      expect(additionalData.stepNumber).toBe(1);
      expect(additionalData.riskScore).toBe(88);
      expect(additionalData.goalDescription).toBeUndefined();
      expect(additionalData.goalId).toBeUndefined();
      expect(additionalData.currentStepDescription).toBeUndefined();
    });
  });

  describe('test isolation', () => {
    it('should have independent state per instance', () => {
      const enforcer1 = new DangerZoneEnforcer(mockFileOps, '/tmp/test-security');
      const enforcer2 = new DangerZoneEnforcer(mockFileOps, '/tmp/test-security');

      enforcer1.block('agent-1', 'Reason', []);

      // enforcer2 should NOT see enforcer1's block
      expect(enforcer2.check('agent-1').blocked).toBe(false);
      expect(enforcer1.check('agent-1').blocked).toBe(true);
    });
  });
});
