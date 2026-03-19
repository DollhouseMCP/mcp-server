/**
 * Unit tests for AutonomyEvaluator service
 *
 * Tests the continue/pause decision logic for the agentic loop.
 * Part of Epic #380 (Agentic Loop Completion).
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type {
  AutonomyContext,
  AgentAutonomyConfig,
  SafetyTierResult,
  VerificationChallenge,
} from '../../../../src/elements/agents/types.js';

// Typed mock functions for ESM module mocking
const mockDetermineSafetyTier = jest.fn<(...args: unknown[]) => SafetyTierResult>().mockReturnValue({
  tier: 'advisory',
  factors: ['Low risk action'],
  score: 10,
  threshold: 0,
});

const mockCreateVerificationChallenge = jest.fn<(...args: unknown[]) => VerificationChallenge>().mockReturnValue({
  challengeId: 'test-challenge-id',
  prompt: 'Enter verification code',
  displayCode: 'ABC123',
  challengeType: 'display_code',
  expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  reason: 'Test verification',
});

// Issue #142: Mock showVerificationDialog (OS dialog, fire-and-forget)
const mockShowVerificationDialog = jest.fn().mockReturnValue({ success: true, buttonClicked: 'OK' });

// Use unstable_mockModule for ESM mocking
jest.unstable_mockModule('../../../../src/elements/agents/safetyTierService.js', () => ({
  determineSafetyTier: mockDetermineSafetyTier,
  createVerificationChallenge: mockCreateVerificationChallenge,
  showVerificationDialog: mockShowVerificationDialog,
  DEFAULT_SAFETY_CONFIG: {},
}));

jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Issue #390: Mock autonomy config to return defaults (allows env-var tests to override)
jest.unstable_mockModule('../../../../src/config/autonomy-config.js', () => ({
  getAutonomyRiskThresholds: jest.fn().mockReturnValue({
    conservative: 25,
    moderate: 50,
    aggressive: 75,
  }),
  getAutonomyMaxStepsDefault: jest.fn().mockReturnValue(10),
}));

const mockLogSecurityEvent = jest.fn();
jest.unstable_mockModule('../../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: {
    logSecurityEvent: mockLogSecurityEvent,
  },
}));

// Import mocked config module for test overrides
const { getAutonomyRiskThresholds, getAutonomyMaxStepsDefault } = await import(
  '../../../../src/config/autonomy-config.js'
);
const mockGetThresholds = getAutonomyRiskThresholds as jest.Mock;
const mockGetMaxSteps = getAutonomyMaxStepsDefault as jest.Mock;

// Import mocked logger for error handling tests
const { logger: loggerModule } = await import('../../../../src/utils/logger.js');
const mockLoggerError = loggerModule.error as jest.Mock;
const mockLoggerInfo = loggerModule.info as jest.Mock;

// Dynamic import after mocking
const { evaluateAutonomy, wouldAutoApprove, DEFAULT_AUTONOMY_CONFIG, getAutonomyMetrics, resetAutonomyMetrics } = await import(
  '../../../../src/elements/agents/autonomyEvaluator.js'
);

describe('AutonomyEvaluator', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset metrics to avoid cross-test contamination (Issue #391)
    resetAutonomyMetrics();

    // Reset config mocks to defaults (Issue #390)
    mockGetThresholds.mockReturnValue({
      conservative: 25,
      moderate: 50,
      aggressive: 75,
    });
    mockGetMaxSteps.mockReturnValue(10);

    // Reset to default advisory tier
    mockDetermineSafetyTier.mockReturnValue({
      tier: 'advisory',
      factors: ['Low risk action'],
      score: 10,
      threshold: 0,
    });
  });

  describe('evaluateAutonomy', () => {
    const baseContext: AutonomyContext = {
      agentName: 'test-agent',
      stepCount: 0,
      currentStepDescription: 'Read file contents',
      currentStepOutcome: 'success',
    };

    /** Build an AutonomyContext with base defaults and overrides */
    const createContext = (overrides: Partial<AutonomyContext> = {}): AutonomyContext => ({
      ...baseContext,
      ...overrides,
    });

    describe('Step count limits', () => {
      it('should continue when step count is below limit', () => {
        const context: AutonomyContext = {
          ...baseContext,
          stepCount: 5,
          autonomyConfig: { maxAutonomousSteps: 10 },
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(true);
        expect(result.stepsRemaining).toBe(4); // 10 - 5 - 1
        expect(result.factors).toContain('Step 6 of 10 autonomous steps');
      });

      it('should pause when step count reaches limit', () => {
        const context: AutonomyContext = {
          ...baseContext,
          stepCount: 10,
          autonomyConfig: { maxAutonomousSteps: 10 },
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('Maximum autonomous steps reached');
        expect(result.stepsRemaining).toBe(0);
      });

      it('should allow unlimited steps when maxAutonomousSteps is 0', () => {
        const context: AutonomyContext = {
          ...baseContext,
          stepCount: 100,
          autonomyConfig: { maxAutonomousSteps: 0 },
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(true);
        expect(result.stepsRemaining).toBeUndefined();
        expect(result.factors).toContain('Unlimited autonomous steps configured');
      });

      it('should use default maxAutonomousSteps when not configured', () => {
        const context: AutonomyContext = {
          ...baseContext,
          stepCount: DEFAULT_AUTONOMY_CONFIG.maxAutonomousSteps - 1,
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(true);
        expect(result.stepsRemaining).toBe(0);
      });
    });

    describe('Step outcome handling', () => {
      it('should pause on step failure', () => {
        const context: AutonomyContext = {
          ...baseContext,
          currentStepOutcome: 'failure',
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('Previous step failed');
        expect(result.factors).toContain('Previous step failed');
      });

      it('should continue on step success', () => {
        const context: AutonomyContext = {
          ...baseContext,
          currentStepOutcome: 'success',
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(true);
      });

      it('should continue on partial success', () => {
        const context: AutonomyContext = {
          ...baseContext,
          currentStepOutcome: 'partial',
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(true);
      });
    });

    describe('Pattern matching for requiresApproval', () => {
      it('should pause when next action matches requiresApproval pattern', () => {
        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'delete user data',
          autonomyConfig: {
            requiresApproval: ['*delete*'],
          },
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('requires approval');
        expect(result.factors.some((f) => f.includes('requiresApproval'))).toBe(true);
      });

      it('should continue when next action does not match requiresApproval', () => {
        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'read user data',
          autonomyConfig: {
            requiresApproval: ['*delete*'],
          },
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(true);
      });

      it('should handle multiple requiresApproval patterns', () => {
        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'drop database',
          autonomyConfig: {
            requiresApproval: ['*delete*', '*drop*', '*truncate*'],
          },
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(false);
        expect(result.factors.some((f) => f.includes('*drop*'))).toBe(true);
      });
    });

    describe('Pattern matching for autoApprove', () => {
      it('should continue when next action matches autoApprove pattern', () => {
        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'read configuration file',
          autonomyConfig: {
            autoApprove: ['read*'],
          },
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(true);
        expect(result.factors.some((f) => f.includes('autoApprove'))).toBe(true);
      });

      it('should prioritize requiresApproval over autoApprove', () => {
        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'read and delete files',
          autonomyConfig: {
            requiresApproval: ['*delete*'],
            autoApprove: ['read*'],
          },
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('requires approval');
      });
    });

    describe('Safety tier integration', () => {
      it('should continue on advisory tier', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'advisory',
          factors: ['Low risk'],
        });

        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'list files',
          riskScore: 10,
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(true);
      });

      it('should pause on confirm tier with moderate tolerance', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'confirm',
          factors: ['Moderate risk action'],
        });

        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'modify configuration',
          riskScore: 40,
          autonomyConfig: { riskTolerance: 'moderate' },
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('confirmation');
        expect(result.nextStepRisk).toBe('confirm');
      });

      it('should auto-approve confirm tier with aggressive tolerance', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'confirm',
          factors: ['Moderate risk action'],
        });

        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'modify configuration',
          riskScore: 40,
          autonomyConfig: { riskTolerance: 'aggressive' },
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(true);
        expect(result.factors.some((f) => f.includes('auto-approving CONFIRM'))).toBe(true);
      });

      it('should require verification on verify tier', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'verify',
          factors: ['High risk action'],
        });

        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'execute system command',
          riskScore: 70,
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('verification');
        expect(result.verification).toBeDefined();
        expect(result.verification?.verificationId).toBe('test-challenge-id');
        // Issue #142: displayCode is intentionally stripped — shown via OS dialog only
        expect(result.verification?.displayCode).toBeUndefined();
        expect(result.verification?.prompt).toBe('Enter verification code');
        expect(result.nextStepRisk).toBe('verify');
      });

      it('should stop on danger_zone tier', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'danger_zone',
          factors: ['Dangerous operation detected'],
        });

        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'rm -rf /',
          riskScore: 95,
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(false);
        expect(result.stopped).toBe(true);
        expect(result.reason).toContain('blocked');
        expect(result.nextStepRisk).toBe('danger_zone');
      });

      it('should pass audit context to dangerZoneEnforcer.block() (Issue #404)', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'danger_zone',
          factors: ['Dangerous operation detected'],
        });

        const mockBlock = jest.fn();
        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'rm -rf /important',
          riskScore: 95,
          stepCount: 4,
          goalDescription: 'Automate cleanup tasks',
          goalId: 'goal-xyz',
          dangerZoneEnforcer: { block: mockBlock },
        };

        evaluateAutonomy(context);

        expect(mockBlock).toHaveBeenCalledWith(
          'test-agent',
          expect.any(String),
          expect.any(Array),
          // Issue #142: Now always creates a verification challenge for DZ blocks
          'test-challenge-id',
          expect.objectContaining({
            stepNumber: 4,
            currentStepDescription: 'Read file contents',
            currentStepOutcome: 'success',
            nextActionHint: 'rm -rf /important',
            riskScore: 95,
            goalDescription: 'Automate cleanup tasks',
            goalId: 'goal-xyz',
            safetyFactors: expect.arrayContaining(['Safety tier: danger_zone']),
          })
        );
      });

      it('should pass audit context even without goal info (Issue #404)', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'danger_zone',
          factors: ['Dangerous operation detected'],
        });

        const mockBlock = jest.fn();
        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'drop database',
          riskScore: 90,
          dangerZoneEnforcer: { block: mockBlock },
        };

        evaluateAutonomy(context);

        expect(mockBlock).toHaveBeenCalledWith(
          'test-agent',
          expect.any(String),
          expect.any(Array),
          // Issue #142: Now always creates a verification challenge for DZ blocks
          'test-challenge-id',
          expect.objectContaining({
            stepNumber: 0,
            goalDescription: undefined,
            goalId: undefined,
          })
        );
      });

      it('should include enriched fields in SecurityMonitor event (Issue #404)', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'danger_zone',
          factors: ['Dangerous operation detected'],
        });
        mockLogSecurityEvent.mockClear();

        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'rm -rf /',
          riskScore: 95,
          stepCount: 2,
          goalDescription: 'Automate tasks',
        };

        evaluateAutonomy(context);

        expect(mockLogSecurityEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'DANGER_ZONE_TRIGGERED',
            source: 'AutonomyEvaluator.evaluateAutonomy',
            additionalData: expect.objectContaining({
              stepCount: 2,
              riskScore: 95,
              currentStepDescription: 'Read file contents',
              goalDescription: 'Automate tasks',
            }),
          })
        );
      });
    });

    // =========================================================================
    // Issue #142: Verification Store + DisplayService integration tests
    // =========================================================================
    describe('Verification flow (Issue #142)', () => {
      it('should store verification code server-side when verify tier triggers', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'verify',
          factors: ['High risk action'],
        });

        const mockStoreSet = jest.fn();
        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'execute dangerous query',
          riskScore: 70,
          verificationStore: { set: mockStoreSet },
        };

        evaluateAutonomy(context);

        // VerificationStore.set() should have been called with the challenge code
        expect(mockStoreSet).toHaveBeenCalledWith(
          'test-challenge-id',
          expect.objectContaining({
            code: 'ABC123',
            reason: expect.any(String),
            expiresAt: expect.any(Number),
          })
        );
      });

      it('should show OS dialog via showVerificationDialog when verify tier triggers', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'verify',
          factors: ['High risk action'],
        });

        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'execute dangerous query',
          riskScore: 70,
        };

        evaluateAutonomy(context);

        expect(mockShowVerificationDialog).toHaveBeenCalledWith(
          'ABC123',
          expect.any(String),
          expect.objectContaining({ title: expect.any(String), icon: 'warning' })
        );
      });

      it('should NOT include displayCode in returned directive (verify tier)', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'verify',
          factors: ['High risk action'],
        });

        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'execute dangerous query',
          riskScore: 70,
        };

        const result = evaluateAutonomy(context);

        expect(result.verification).toBeDefined();
        expect(result.verification?.displayCode).toBeUndefined();
        expect(result.verification?.verificationId).toBe('test-challenge-id');
      });

      it('should store code and show dialog for danger_zone tier', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'danger_zone',
          factors: ['Dangerous operation detected'],
        });

        const mockStoreSet = jest.fn();
        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'rm -rf /',
          riskScore: 95,
          verificationStore: { set: mockStoreSet },
          dangerZoneEnforcer: { block: jest.fn() },
        };

        evaluateAutonomy(context);

        // Should store challenge code server-side
        expect(mockStoreSet).toHaveBeenCalledWith(
          'test-challenge-id',
          expect.objectContaining({
            code: 'ABC123',
            reason: expect.any(String),
          })
        );
        // Should show OS dialog
        expect(mockShowVerificationDialog).toHaveBeenCalled();
      });

      it('should include verification info in danger_zone directive for LLM guidance', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'danger_zone',
          factors: ['Dangerous operation detected'],
        });

        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'rm -rf /',
          riskScore: 95,
          dangerZoneEnforcer: { block: jest.fn() },
        };

        const result = evaluateAutonomy(context);

        expect(result.stopped).toBe(true);
        // Issue #142: Danger zone directives now include verification info (without displayCode)
        expect(result.verification).toBeDefined();
        expect(result.verification?.verificationId).toBe('test-challenge-id');
        expect(result.verification?.displayCode).toBeUndefined();
      });

      it('should gracefully handle missing verificationStore', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'verify',
          factors: ['High risk action'],
        });

        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'dangerous action',
          riskScore: 70,
          // No verificationStore provided
        };

        // Should not throw
        const result = evaluateAutonomy(context);
        expect(result.continue).toBe(false);
        expect(result.verification).toBeDefined();
      });

      it('should gracefully handle showVerificationDialog failure', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'verify',
          factors: ['High risk action'],
        });
        mockShowVerificationDialog.mockImplementation(() => {
          throw new Error('No display available');
        });

        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'dangerous action',
          riskScore: 70,
        };

        // Should not throw — dialog failure is non-fatal
        const result = evaluateAutonomy(context);
        expect(result.continue).toBe(false);
        expect(result.verification).toBeDefined();
      });
    });

    describe('Risk threshold checks', () => {
      beforeEach(() => {
        // Ensure advisory tier for risk threshold tests
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'advisory',
          factors: ['Low risk action'],
        });
      });

      it('should pause when risk exceeds conservative threshold', () => {
        const context: AutonomyContext = {
          ...baseContext,
          riskScore: 30,
          autonomyConfig: { riskTolerance: 'conservative' },
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('Risk score');
        expect(result.reason).toContain('exceeds');
      });

      it('should continue when risk is within moderate threshold', () => {
        const context: AutonomyContext = {
          ...baseContext,
          riskScore: 40,
          autonomyConfig: { riskTolerance: 'moderate' },
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(true);
      });

      it('should continue when risk is within aggressive threshold', () => {
        const context: AutonomyContext = {
          ...baseContext,
          riskScore: 70,
          autonomyConfig: { riskTolerance: 'aggressive' },
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(true);
      });
    });

    describe('Risk score edge cases (Issue #388)', () => {
      beforeEach(() => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'advisory',
          factors: ['Low risk action'],
        });
      });

      it('should treat NaN risk score as 0 and continue', () => {
        const context: AutonomyContext = {
          ...baseContext,
          riskScore: NaN,
          autonomyConfig: { riskTolerance: 'conservative' },
        };

        const result = evaluateAutonomy(context);

        // NaN → 0, which is within conservative threshold (25)
        expect(result.continue).toBe(true);
      });

      it('should clamp Infinity risk score to 100', () => {
        const context: AutonomyContext = {
          ...baseContext,
          riskScore: Infinity,
          autonomyConfig: { riskTolerance: 'aggressive' },
        };

        const result = evaluateAutonomy(context);

        // Infinity → 100, which exceeds aggressive threshold (75)
        expect(result.continue).toBe(false);
        expect(result.reason).toContain('Risk score');
      });

      it('should clamp negative Infinity risk score to 0', () => {
        const context: AutonomyContext = {
          ...baseContext,
          riskScore: -Infinity,
          autonomyConfig: { riskTolerance: 'conservative' },
        };

        const result = evaluateAutonomy(context);

        // -Infinity → 0, which is within conservative threshold
        expect(result.continue).toBe(true);
      });

      it('should clamp negative risk score to 0', () => {
        const context: AutonomyContext = {
          ...baseContext,
          riskScore: -50,
          autonomyConfig: { riskTolerance: 'conservative' },
        };

        const result = evaluateAutonomy(context);

        // -50 → 0, which is within conservative threshold (25)
        expect(result.continue).toBe(true);
      });

      it('should sanitize risk score before safety tier check (not just before threshold)', () => {
        // If validation only happened at Check 5, the safety tier check (Check 4)
        // would receive the raw invalid value. This test proves it's sanitized first.
        const context: AutonomyContext = {
          ...baseContext,
          nextActionHint: 'some action',
          riskScore: NaN,
        };

        evaluateAutonomy(context);

        // determineSafetyTier should receive 0 (sanitized), not NaN
        expect(mockDetermineSafetyTier).toHaveBeenCalledWith(
          0,
          expect.anything(),
          expect.anything(),
          expect.anything()
        );
      });
    });

    describe('Default configuration', () => {
      it('should use default config when no autonomy config provided', () => {
        const context: AutonomyContext = {
          ...baseContext,
          stepCount: 5,
        };

        const result = evaluateAutonomy(context);

        expect(result.continue).toBe(true);
        // Default is 10 steps, so 10 - 5 - 1 = 4 remaining
        expect(result.stepsRemaining).toBe(4);
      });
    });

    describe('Decision precedence (Issue #383)', () => {
      it('should prioritize step limit over failure outcome', () => {
        const result = evaluateAutonomy(createContext({
          stepCount: 10,
          currentStepOutcome: 'failure',
          autonomyConfig: { maxAutonomousSteps: 10 },
        }));

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('Maximum autonomous steps');
        expect(result.reason).not.toContain('failed');
      });

      it('should prioritize step limit over pattern match', () => {
        const result = evaluateAutonomy(createContext({
          stepCount: 10,
          nextActionHint: 'delete user data',
          autonomyConfig: {
            maxAutonomousSteps: 10,
            requiresApproval: ['*delete*'],
          },
        }));

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('Maximum autonomous steps');
        expect(result.reason).not.toContain('requires approval');
      });

      it('should prioritize failure outcome over pattern match', () => {
        const result = evaluateAutonomy(createContext({
          currentStepOutcome: 'failure',
          nextActionHint: 'delete user data',
          autonomyConfig: {
            requiresApproval: ['*delete*'],
          },
        }));

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('failed');
        expect(result.reason).not.toContain('requires approval');
      });

      it('should prioritize pattern match over safety tier', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'danger_zone',
          factors: ['Dangerous operation detected'],
        });

        const result = evaluateAutonomy(createContext({
          nextActionHint: 'delete user data',
          riskScore: 95,
          autonomyConfig: {
            requiresApproval: ['*delete*'],
          },
        }));

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('requires approval');
        expect(result.reason).not.toContain('blocked');
        expect(result.stopped).toBeUndefined();
      });

      it('should prioritize safety tier over risk threshold', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'confirm',
          factors: ['Moderate risk action'],
        });

        const result = evaluateAutonomy(createContext({
          nextActionHint: 'modify configuration',
          riskScore: 60,
          autonomyConfig: { riskTolerance: 'moderate' },
        }));

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('confirmation');
        expect(result.reason).not.toContain('Risk score');
      });
    });

    describe('Boundary conditions (Issue #383)', () => {
      beforeEach(() => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'advisory',
          factors: ['Low risk action'],
        });
      });

      it('should continue when step count is exactly one below limit', () => {
        const result = evaluateAutonomy(createContext({
          stepCount: 9,
          autonomyConfig: { maxAutonomousSteps: 10 },
        }));

        expect(result.continue).toBe(true);
        expect(result.stepsRemaining).toBe(0);
      });

      it('should pause when step count is well past limit', () => {
        const result = evaluateAutonomy(createContext({
          stepCount: 110,
          autonomyConfig: { maxAutonomousSteps: 10 },
        }));

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('Maximum autonomous steps');
      });

      it('should continue when risk score is exactly at threshold (strict >)', () => {
        const result = evaluateAutonomy(createContext({
          riskScore: 50,
          autonomyConfig: { riskTolerance: 'moderate' },
        }));

        // threshold check uses > not >=, so 50 === 50 → continue
        expect(result.continue).toBe(true);
      });

      it('should pause when risk score is one above threshold', () => {
        const result = evaluateAutonomy(createContext({
          riskScore: 51,
          autonomyConfig: { riskTolerance: 'moderate' },
        }));

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('Risk score');
      });

      it('should continue when risk score is zero with conservative tolerance', () => {
        const result = evaluateAutonomy(createContext({
          riskScore: 0,
          autonomyConfig: { riskTolerance: 'conservative' },
        }));

        expect(result.continue).toBe(true);
      });

      it('should pause when risk score is 100 with aggressive tolerance', () => {
        const result = evaluateAutonomy(createContext({
          riskScore: 100,
          autonomyConfig: { riskTolerance: 'aggressive' },
        }));

        // 100 > 75 → pause
        expect(result.continue).toBe(false);
        expect(result.reason).toContain('Risk score');
      });

      it('should allow step zero (first step)', () => {
        const result = evaluateAutonomy(createContext({
          stepCount: 0,
          autonomyConfig: { maxAutonomousSteps: 10 },
        }));

        expect(result.continue).toBe(true);
        expect(result.stepsRemaining).toBe(9);
      });
    });

    describe('Configuration edge cases (Issue #383)', () => {
      beforeEach(() => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'advisory',
          factors: ['Low risk action'],
        });
      });

      it('should use defaults for missing fields when only riskTolerance is set', () => {
        const result = evaluateAutonomy(createContext({
          stepCount: 5,
          autonomyConfig: { riskTolerance: 'conservative' },
        }));

        // maxAutonomousSteps defaults to 10
        expect(result.continue).toBe(true);
        expect(result.stepsRemaining).toBe(4);
      });

      it('should use defaults for missing fields when only maxAutonomousSteps is set', () => {
        const result = evaluateAutonomy(createContext({
          stepCount: 0,
          riskScore: 30,
          autonomyConfig: { maxAutonomousSteps: 5 },
        }));

        // riskTolerance defaults to moderate (threshold 50), 30 < 50 → continue
        expect(result.continue).toBe(true);
        expect(result.stepsRemaining).toBe(4);
      });

      it('should handle empty pattern arrays without matching', () => {
        const result = evaluateAutonomy(createContext({
          nextActionHint: 'delete everything',
          autonomyConfig: {
            requiresApproval: [],
            autoApprove: [],
          },
        }));

        // No patterns → falls through to safety tier (advisory) → continue
        expect(result.continue).toBe(true);
        expect(result.factors.some((f) => f.includes('No pattern match'))).toBe(true);
      });

      it('should fall back to moderate threshold for unknown riskTolerance', () => {
        // Safely within moderate threshold (50)
        const resultLow = evaluateAutonomy(createContext({
          riskScore: 30,
          autonomyConfig: { riskTolerance: 'nonexistent_value' as 'moderate' },
        }));
        expect(resultLow.continue).toBe(true);

        // Above moderate threshold (50)
        const resultHigh = evaluateAutonomy(createContext({
          riskScore: 60,
          autonomyConfig: { riskTolerance: 'nonexistent_value' as 'moderate' },
        }));
        expect(resultHigh.continue).toBe(false);
        expect(resultHigh.reason).toContain('exceeds');
      });
    });

    describe('Safety tier + tolerance combinations (Issue #383)', () => {
      it('should continue on advisory tier with conservative tolerance', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'advisory',
          factors: ['Low risk action'],
        });

        const result = evaluateAutonomy(createContext({
          nextActionHint: 'list files',
          riskScore: 10,
          autonomyConfig: { riskTolerance: 'conservative' },
        }));

        // Advisory always continues; risk 10 < conservative threshold 25
        expect(result.continue).toBe(true);
      });

      it('should pause on confirm tier with conservative tolerance', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'confirm',
          factors: ['Moderate risk action'],
        });

        const result = evaluateAutonomy(createContext({
          nextActionHint: 'edit config',
          riskScore: 20,
          autonomyConfig: { riskTolerance: 'conservative' },
        }));

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('confirmation');
        expect(result.nextStepRisk).toBe('confirm');
      });

      it('should require verification on verify tier even with aggressive tolerance', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'verify',
          factors: ['High risk action'],
        });

        const result = evaluateAutonomy(createContext({
          nextActionHint: 'execute system command',
          riskScore: 70,
          autonomyConfig: { riskTolerance: 'aggressive' },
        }));

        expect(result.continue).toBe(false);
        expect(result.reason).toContain('verification');
        expect(result.verification).toBeDefined();
        expect(result.nextStepRisk).toBe('verify');
      });

      it('should stop on danger_zone tier even with aggressive tolerance', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'danger_zone',
          factors: ['Dangerous operation detected'],
        });

        const result = evaluateAutonomy(createContext({
          nextActionHint: 'rm -rf /',
          riskScore: 95,
          autonomyConfig: { riskTolerance: 'aggressive' },
        }));

        expect(result.continue).toBe(false);
        expect(result.stopped).toBe(true);
        expect(result.nextStepRisk).toBe('danger_zone');
      });
    });

    describe('Context field handling (Issue #383)', () => {
      it('should run safety tier check using currentStepDescription when nextActionHint is absent', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'advisory',
          factors: ['Low risk action'],
        });

        // no nextActionHint — riskScore alone triggers Check 4
        const result = evaluateAutonomy(createContext({ riskScore: 10 }));

        expect(result.continue).toBe(true);
        // determineSafetyTier should receive currentStepDescription as fallback action
        expect(mockDetermineSafetyTier).toHaveBeenCalledWith(
          10,
          expect.anything(),
          'Read file contents', // baseContext.currentStepDescription
          expect.anything()
        );
        expect(result.factors.some((f) => f.includes('Safety tier: advisory'))).toBe(true);
      });

      it('should skip pattern and safety checks when both nextActionHint and riskScore are absent', () => {
        // no nextActionHint, no riskScore
        const result = evaluateAutonomy(createContext());

        expect(result.continue).toBe(true);
        expect(result.factors).toContain('All autonomy checks passed');
        // determineSafetyTier should NOT be called (Check 4 skipped)
        expect(mockDetermineSafetyTier).not.toHaveBeenCalled();
      });

      it('should truncate goalDescription to 200 chars in SecurityMonitor event', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'danger_zone',
          factors: ['Dangerous operation detected'],
        });
        mockLogSecurityEvent.mockClear();

        evaluateAutonomy(createContext({
          nextActionHint: 'rm -rf /',
          riskScore: 95,
          goalDescription: 'A'.repeat(300),
        }));

        expect(mockLogSecurityEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            additionalData: expect.objectContaining({
              goalDescription: 'A'.repeat(200),
            }),
          })
        );
      });
    });

    describe('Factors array (Issue #383)', () => {
      it('should include "All autonomy checks passed" when all checks pass', () => {
        const result = evaluateAutonomy(createContext({ stepCount: 0 }));

        expect(result.continue).toBe(true);
        expect(result.factors).toContain('All autonomy checks passed');
      });

      it('should include step limit factor when step limit is reached', () => {
        const result = evaluateAutonomy(createContext({
          stepCount: 10,
          autonomyConfig: { maxAutonomousSteps: 10 },
        }));

        expect(result.continue).toBe(false);
        expect(result.factors.some((f) => f.includes('exceeds maxAutonomousSteps'))).toBe(true);
      });

      it('should accumulate factors from passing checks before a failing check', () => {
        mockDetermineSafetyTier.mockReturnValue({
          tier: 'confirm',
          factors: ['Moderate risk action'],
        });

        const result = evaluateAutonomy(createContext({
          stepCount: 3,
          nextActionHint: 'modify system',
          riskScore: 40,
          autonomyConfig: {
            maxAutonomousSteps: 10,
            riskTolerance: 'moderate',
          },
        }));

        expect(result.continue).toBe(false);
        // Step count factor from Check 1 (passed)
        expect(result.factors.some((f) => f.includes('Step 4 of 10'))).toBe(true);
        // Pattern factor from Check 3 (passed — no match)
        expect(result.factors.some((f) => f.includes('No pattern match'))).toBe(true);
        // Safety tier factor from Check 4 (confirm → paused)
        expect(result.factors.some((f) => f.includes('Safety tier: confirm'))).toBe(true);
      });
    });
  });

  describe('wouldAutoApprove', () => {
    it('should return false for actions matching requiresApproval', () => {
      const config: AgentAutonomyConfig = {
        requiresApproval: ['*delete*', '*drop*'],
        autoApprove: ['read*'],
      };

      expect(wouldAutoApprove('delete user', config)).toBe(false);
      expect(wouldAutoApprove('drop table', config)).toBe(false);
    });

    it('should return true for actions matching autoApprove', () => {
      const config: AgentAutonomyConfig = {
        requiresApproval: ['*delete*'],
        autoApprove: ['read*', 'list*'],
      };

      expect(wouldAutoApprove('read file', config)).toBe(true);
      expect(wouldAutoApprove('list users', config)).toBe(true);
    });

    it('should return false by default for moderate tolerance', () => {
      const config: AgentAutonomyConfig = {
        riskTolerance: 'moderate',
      };

      expect(wouldAutoApprove('unknown action', config)).toBe(false);
    });

    it('should return true by default for aggressive tolerance', () => {
      const config: AgentAutonomyConfig = {
        riskTolerance: 'aggressive',
      };

      expect(wouldAutoApprove('unknown action', config)).toBe(true);
    });

    it('should use default config when none provided', () => {
      // Default is moderate tolerance, so should return false
      expect(wouldAutoApprove('unknown action')).toBe(false);
    });
  });

  describe('DEFAULT_AUTONOMY_CONFIG', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_AUTONOMY_CONFIG.riskTolerance).toBe('moderate');
      expect(DEFAULT_AUTONOMY_CONFIG.maxAutonomousSteps).toBe(10);
      expect(DEFAULT_AUTONOMY_CONFIG.requiresApproval).toEqual([]);
      expect(DEFAULT_AUTONOMY_CONFIG.autoApprove).toEqual([]);
      expect(DEFAULT_AUTONOMY_CONFIG.verificationTimeoutMinutes).toBe(5);
    });
  });

  describe('Configurable verification timeout (Issue #142)', () => {
    const baseCtx: AutonomyContext = {
      agentName: 'test-agent',
      stepCount: 0,
      currentStepDescription: 'Read file contents',
      currentStepOutcome: 'success',
    };

    it('should pass custom verificationTimeoutMinutes to createVerificationChallenge for DANGER_ZONE', () => {
      mockDetermineSafetyTier.mockReturnValue({
        tier: 'danger_zone',
        factors: ['Dangerous operation detected'],
      });

      const context: AutonomyContext = {
        ...baseCtx,
        nextActionHint: 'rm -rf /',
        riskScore: 95,
        autonomyConfig: { verificationTimeoutMinutes: 10 },
      };

      evaluateAutonomy(context);

      // createVerificationChallenge should have been called with 10 min timeout
      expect(mockCreateVerificationChallenge).toHaveBeenCalledWith(
        expect.any(String),
        'display_code',
        10
      );
    });

    it('should use default 5 minutes when verificationTimeoutMinutes is not configured', () => {
      mockDetermineSafetyTier.mockReturnValue({
        tier: 'danger_zone',
        factors: ['Dangerous operation detected'],
      });

      const context: AutonomyContext = {
        ...baseCtx,
        nextActionHint: 'rm -rf /',
        riskScore: 95,
        // No autonomyConfig — uses defaults
      };

      evaluateAutonomy(context);

      expect(mockCreateVerificationChallenge).toHaveBeenCalledWith(
        expect.any(String),
        'display_code',
        5
      );
    });

    it('should pass custom timeout to VERIFY tier challenge creation', () => {
      mockDetermineSafetyTier.mockReturnValue({
        tier: 'verify',
        factors: ['Verify required'],
        score: 60,
        threshold: 50,
      });

      const context: AutonomyContext = {
        ...baseCtx,
        nextActionHint: 'deploy to staging',
        riskScore: 60,
        autonomyConfig: { verificationTimeoutMinutes: 3 },
      };

      evaluateAutonomy(context);

      expect(mockCreateVerificationChallenge).toHaveBeenCalledWith(
        expect.any(String),
        'display_code',
        3
      );
    });
  });

  // =========================================================================
  // Issue #389: Safety tier evaluation error handling
  // =========================================================================
  describe('Safety tier error handling (Issue #389)', () => {
    const baseCtx2: AutonomyContext = {
      agentName: 'test-agent',
      stepCount: 0,
      currentStepDescription: 'Read file contents',
      currentStepOutcome: 'success',
    };

    it('should return conservative pause when determineSafetyTier throws', () => {
      mockDetermineSafetyTier.mockImplementation(() => {
        throw new Error('Safety package unavailable');
      });

      const context: AutonomyContext = {
        ...baseCtx2,
        nextActionHint: 'some action',
        riskScore: 10,
      };

      const result = evaluateAutonomy(context);

      expect(result.continue).toBe(false);
      expect(result.reason).toContain('Safety evaluation failed');
      expect(result.factors.some((f: string) => f.includes('Safety tier evaluation failed'))).toBe(true);
    });

    it('should log error when determineSafetyTier throws', () => {
      mockDetermineSafetyTier.mockImplementation(() => {
        throw new Error('Safety package unavailable');
      });
      mockLoggerError.mockClear();

      const context: AutonomyContext = {
        ...baseCtx2,
        nextActionHint: 'some action',
        riskScore: 10,
      };

      evaluateAutonomy(context);

      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('Safety tier evaluation failed'),
        expect.objectContaining({
          error: 'Safety package unavailable',
        })
      );
    });

    it('should log SAFETY_EVALUATION_FAILURE security event when determineSafetyTier throws', () => {
      mockDetermineSafetyTier.mockImplementation(() => {
        throw new Error('Safety module crash');
      });
      mockLogSecurityEvent.mockClear();

      const context: AutonomyContext = {
        ...baseCtx2,
        nextActionHint: 'some action',
        riskScore: 10,
      };

      evaluateAutonomy(context);

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SAFETY_EVALUATION_FAILURE',
          severity: 'HIGH',
          source: 'AutonomyEvaluator.checkSafetyTier',
          details: expect.stringContaining('Safety module crash'),
        })
      );
    });

    it('should handle non-Error thrown values gracefully', () => {
      mockDetermineSafetyTier.mockImplementation(() => {
        throw 'unexpected string error';
      });

      const context: AutonomyContext = {
        ...baseCtx2,
        nextActionHint: 'some action',
        riskScore: 10,
      };

      const result = evaluateAutonomy(context);

      expect(result.continue).toBe(false);
      expect(result.reason).toContain('Safety evaluation failed');
    });
  });

  // =========================================================================
  // Issue #390: Configurable risk thresholds via env vars
  // =========================================================================
  describe('Configurable risk thresholds (Issue #390)', () => {
    const baseCtx2: AutonomyContext = {
      agentName: 'test-agent',
      stepCount: 0,
      currentStepDescription: 'Read file contents',
      currentStepOutcome: 'success',
    };

    beforeEach(() => {
      mockDetermineSafetyTier.mockReturnValue({
        tier: 'advisory',
        factors: ['Low risk action'],
      });
    });

    it('should use thresholds from getAutonomyRiskThresholds()', () => {
      // Override to use a lower moderate threshold
      mockGetThresholds.mockReturnValue({
        conservative: 15,
        moderate: 30,
        aggressive: 60,
      });

      // Risk score 35 would pass default moderate (50) but fail custom (30)
      const context: AutonomyContext = {
        ...baseCtx2,
        riskScore: 35,
        autonomyConfig: { riskTolerance: 'moderate' },
      };

      const result = evaluateAutonomy(context);
      expect(result.continue).toBe(false);
      expect(result.reason).toContain('Risk score');
      expect(result.reason).toContain('exceeds');
    });

    it('should use maxAutonomousSteps from getAutonomyMaxStepsDefault() when no config', () => {
      mockGetMaxSteps.mockReturnValue(5);

      // Step 5 would pass default (10) but fail custom (5)
      const context: AutonomyContext = {
        ...baseCtx2,
        stepCount: 5,
      };

      const result = evaluateAutonomy(context);
      expect(result.continue).toBe(false);
      expect(result.reason).toContain('Maximum autonomous steps reached');
    });

    it('should prefer explicit config maxAutonomousSteps over env default', () => {
      mockGetMaxSteps.mockReturnValue(5);

      // Explicit config says 20, so step 10 should pass
      const context: AutonomyContext = {
        ...baseCtx2,
        stepCount: 10,
        autonomyConfig: { maxAutonomousSteps: 20 },
      };

      const result = evaluateAutonomy(context);
      expect(result.continue).toBe(true);
    });
  });

  // =========================================================================
  // Issue #391: Autonomy decision metrics
  // =========================================================================
  describe('Autonomy decision metrics (Issue #391)', () => {
    const baseCtx2: AutonomyContext = {
      agentName: 'test-agent',
      stepCount: 0,
      currentStepDescription: 'Read file contents',
      currentStepOutcome: 'success',
    };

    beforeEach(() => {
      resetAutonomyMetrics();
      mockDetermineSafetyTier.mockReturnValue({
        tier: 'advisory',
        factors: ['Low risk action'],
      });
    });

    it('should track total evaluations', () => {
      evaluateAutonomy({ ...baseCtx2 });
      evaluateAutonomy({ ...baseCtx2 });
      evaluateAutonomy({ ...baseCtx2 });

      const metrics = getAutonomyMetrics();
      expect(metrics.totalEvaluations).toBe(3);
    });

    it('should track continue vs pause counts', () => {
      // 2 continues
      evaluateAutonomy({ ...baseCtx2 });
      evaluateAutonomy({ ...baseCtx2 });

      // 1 pause (failure outcome)
      evaluateAutonomy({ ...baseCtx2, currentStepOutcome: 'failure' });

      const metrics = getAutonomyMetrics();
      expect(metrics.continueCount).toBe(2);
      expect(metrics.pauseCount).toBe(1);
    });

    it('should track pause reason distribution', () => {
      // Failure pause
      evaluateAutonomy({ ...baseCtx2, currentStepOutcome: 'failure' });

      // Step limit pause
      evaluateAutonomy({
        ...baseCtx2,
        stepCount: 10,
        autonomyConfig: { maxAutonomousSteps: 10 },
      });

      const metrics = getAutonomyMetrics();
      expect(metrics.pauseCount).toBe(2);
      expect(Object.keys(metrics.pauseReasons).length).toBe(2);
    });

    it('should track danger zone trigger count', () => {
      mockDetermineSafetyTier.mockReturnValue({
        tier: 'danger_zone',
        factors: ['Dangerous operation detected'],
      });

      evaluateAutonomy({
        ...baseCtx2,
        nextActionHint: 'rm -rf /',
        riskScore: 95,
      });

      const metrics = getAutonomyMetrics();
      expect(metrics.dangerZoneTriggered).toBe(1);
      expect(metrics.verificationRequired).toBe(1);
    });

    it('should track verification required count for verify tier', () => {
      mockDetermineSafetyTier.mockReturnValue({
        tier: 'verify',
        factors: ['High risk action'],
      });

      evaluateAutonomy({
        ...baseCtx2,
        nextActionHint: 'execute command',
        riskScore: 70,
      });

      const metrics = getAutonomyMetrics();
      expect(metrics.verificationRequired).toBe(1);
      expect(metrics.dangerZoneTriggered).toBe(0);
    });

    it('should track average step count at pause', () => {
      // Pause at step 3
      evaluateAutonomy({
        ...baseCtx2,
        stepCount: 3,
        currentStepOutcome: 'failure',
      });

      // Pause at step 7
      evaluateAutonomy({
        ...baseCtx2,
        stepCount: 7,
        currentStepOutcome: 'failure',
      });

      const metrics = getAutonomyMetrics();
      expect(metrics.averageStepCountAtPause).toBe(5); // (3 + 7) / 2
    });

    it('should return zero average step count when no pauses', () => {
      evaluateAutonomy({ ...baseCtx2 });

      const metrics = getAutonomyMetrics();
      expect(metrics.averageStepCountAtPause).toBe(0);
    });

    it('should return snapshot copy that does not mutate', () => {
      evaluateAutonomy({ ...baseCtx2 });
      const snap1 = getAutonomyMetrics();

      evaluateAutonomy({ ...baseCtx2 });
      const snap2 = getAutonomyMetrics();

      expect(snap1.totalEvaluations).toBe(1);
      expect(snap2.totalEvaluations).toBe(2);
    });

    it('should reset metrics cleanly', () => {
      evaluateAutonomy({ ...baseCtx2, currentStepOutcome: 'failure' });
      expect(getAutonomyMetrics().pauseCount).toBe(1);

      resetAutonomyMetrics();
      const metrics = getAutonomyMetrics();
      expect(metrics.totalEvaluations).toBe(0);
      expect(metrics.continueCount).toBe(0);
      expect(metrics.pauseCount).toBe(0);
      expect(metrics.dangerZoneTriggered).toBe(0);
      expect(metrics.verificationRequired).toBe(0);
      expect(metrics.averageStepCountAtPause).toBe(0);
      expect(Object.keys(metrics.pauseReasons)).toHaveLength(0);
    });

    it('should log metrics snapshot every 50 evaluations', () => {
      mockLoggerInfo.mockClear();

      // Run 50 evaluations
      for (let i = 0; i < 50; i++) {
        evaluateAutonomy({ ...baseCtx2 });
      }

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        'Autonomy evaluation metrics snapshot',
        expect.objectContaining({
          totalEvaluations: 50,
          continueCount: 50,
        })
      );
    });
  });
});
