/**
 * Tests for TieredSafetyService
 */

import {
  matchesDangerZonePattern,
  hasCriticalSecurityViolations,
  determineSafetyTier,
  generateDisplayCode,
  createVerificationChallenge,
  createConfirmationRequest,
  createDangerZoneOperation,
  createExecutionContext,
} from '../src/TieredSafetyService.js';
import { DEFAULT_SAFETY_CONFIG } from '../src/config.js';
import { SafetyConfig } from '../src/types.js';

describe('TieredSafetyService', () => {
  describe('matchesDangerZonePattern', () => {
    it('should detect rm -rf pattern', () => {
      const result = matchesDangerZonePattern('rm -rf /', DEFAULT_SAFETY_CONFIG.dangerZone.patterns);
      expect(result.matches).toBe(true);
      expect(result.matchedPattern).toContain('rm');
    });

    it('should detect DROP TABLE pattern', () => {
      const result = matchesDangerZonePattern(
        'DROP TABLE users',
        DEFAULT_SAFETY_CONFIG.dangerZone.patterns
      );
      expect(result.matches).toBe(true);
      expect(result.matchedPattern).toContain('DROP');
    });

    it('should detect eval() pattern', () => {
      const result = matchesDangerZonePattern(
        'eval(userInput)',
        DEFAULT_SAFETY_CONFIG.dangerZone.patterns
      );
      expect(result.matches).toBe(true);
      expect(result.matchedPattern).toContain('eval');
    });

    it('should not match safe operations', () => {
      const result = matchesDangerZonePattern(
        'read file and analyze content',
        DEFAULT_SAFETY_CONFIG.dangerZone.patterns
      );
      expect(result.matches).toBe(false);
    });
  });

  describe('hasCriticalSecurityViolations', () => {
    it('should detect code injection warnings', () => {
      const result = hasCriticalSecurityViolations(['Potential code injection detected']);
      expect(result).toBe(true);
    });

    it('should detect credential warnings', () => {
      const result = hasCriticalSecurityViolations(['Credential exposure risk']);
      expect(result).toBe(true);
    });

    it('should detect destructive action warnings', () => {
      const result = hasCriticalSecurityViolations(['Destructive action detected']);
      expect(result).toBe(true);
    });

    it('should not flag non-critical warnings', () => {
      const result = hasCriticalSecurityViolations(['Minor security concern']);
      expect(result).toBe(false);
    });

    it('should handle empty warnings', () => {
      const result = hasCriticalSecurityViolations([]);
      expect(result).toBe(false);
    });
  });

  describe('determineSafetyTier', () => {
    it('should return advisory for low risk scores', () => {
      const result = determineSafetyTier(20, [], 'safe operation');
      expect(result.tier).toBe('advisory');
      expect(result.riskScore).toBe(20);
    });

    it('should return confirm for moderate risk scores', () => {
      const result = determineSafetyTier(40, [], 'moderate operation');
      expect(result.tier).toBe('confirm');
      expect(result.riskScore).toBe(40);
    });

    it('should return verify for high risk scores', () => {
      const result = determineSafetyTier(70, [], 'risky operation');
      expect(result.tier).toBe('verify');
      expect(result.riskScore).toBe(70);
    });

    it('should return danger_zone for very high risk scores', () => {
      const result = determineSafetyTier(90, [], 'very risky operation');
      expect(result.tier).toBe('danger_zone');
      expect(result.riskScore).toBe(90);
    });

    it('should return danger_zone for danger zone patterns', () => {
      const result = determineSafetyTier(20, [], 'rm -rf /');
      expect(result.tier).toBe('danger_zone');
      expect(result.factors.some((f) => f.includes('danger zone pattern'))).toBe(true);
    });

    it('should escalate to verify for critical security violations', () => {
      const result = determineSafetyTier(30, ['Potential code injection'], 'operation');
      expect(result.tier).toBe('verify');
    });

    it('should escalate due to agent chain depth', () => {
      const executionContext = {
        agentChain: ['agent1', 'agent2', 'agent3'],
        depth: 2,
        maxAutonomousDepth: 2,
        depthEscalation: true,
        requiresHumanCheckin: true,
      };

      const result = determineSafetyTier(20, [], 'operation', DEFAULT_SAFETY_CONFIG, executionContext);
      expect(result.tier).toBe('confirm'); // Escalated from advisory
      expect(result.escalatedDueToDepth).toBe(true);
      expect(result.originalTier).toBe('advisory');
    });

    it('should include security warnings in factors', () => {
      const warnings = ['Warning 1', 'Warning 2'];
      const result = determineSafetyTier(20, warnings, 'operation');
      expect(result.factors.some((f) => f.includes('2 security warning(s)'))).toBe(true);
    });
  });

  describe('generateDisplayCode', () => {
    it('should generate code of correct length', () => {
      const code = generateDisplayCode(6);
      expect(code).toHaveLength(6);
    });

    it('should generate different codes', () => {
      const code1 = generateDisplayCode();
      const code2 = generateDisplayCode();
      expect(code1).not.toBe(code2);
    });

    it('should only use allowed characters', () => {
      const code = generateDisplayCode(100);
      expect(code).toMatch(/^[0-9A-HJ-NP-Z]+$/); // Excludes I and O
    });
  });

  describe('createVerificationChallenge', () => {
    it('should create authenticator challenge', () => {
      const challenge = createVerificationChallenge('Test reason', 'authenticator');
      expect(challenge.challengeType).toBe('authenticator');
      expect(challenge.prompt).toContain('authenticator code');
      expect(challenge.reason).toBe('Test reason');
      expect(challenge.displayCode).toBeUndefined();
    });

    it('should create display_code challenge', () => {
      const challenge = createVerificationChallenge('Test reason', 'display_code');
      expect(challenge.challengeType).toBe('display_code');
      expect(challenge.prompt).toContain('verification code');
      expect(challenge.displayCode).toBeDefined();
      expect(challenge.displayCode).toHaveLength(6);
    });

    it('should create passphrase challenge', () => {
      const challenge = createVerificationChallenge('Test reason', 'passphrase');
      expect(challenge.challengeType).toBe('passphrase');
      expect(challenge.prompt).toContain('passphrase');
      expect(challenge.displayCode).toBeUndefined();
    });

    it('should set expiration time', () => {
      const challenge = createVerificationChallenge('Test reason', 'display_code', 10);
      const expiresAt = new Date(challenge.expiresAt);
      const now = new Date();
      const diffMinutes = (expiresAt.getTime() - now.getTime()) / (60 * 1000);
      expect(diffMinutes).toBeGreaterThan(9);
      expect(diffMinutes).toBeLessThan(11);
    });

    it('should generate unique challenge IDs', () => {
      const challenge1 = createVerificationChallenge('Reason 1');
      const challenge2 = createVerificationChallenge('Reason 2');
      expect(challenge1.challengeId).not.toBe(challenge2.challengeId);
    });
  });

  describe('createConfirmationRequest', () => {
    it('should create confirmation request', () => {
      const request = createConfirmationRequest('Test reason', ['Factor 1', 'Factor 2']);
      expect(request.reason).toBe('Test reason');
      expect(request.riskFactors).toEqual(['Factor 1', 'Factor 2']);
      expect(request.suggestedResponse).toBe('proceed');
    });
  });

  describe('createDangerZoneOperation', () => {
    it('should create blocked danger zone operation', () => {
      const operation = createDangerZoneOperation('rm -rf', 'Destructive operation', false);
      expect(operation.operationType).toBe('rm -rf');
      expect(operation.blocked).toBe(true);
      expect(operation.reason).toBe('Destructive operation');
      expect(operation.howToEnable).toBeDefined();
      expect(operation.verificationRequired).toBeUndefined();
    });

    it('should create allowed danger zone operation with verification', () => {
      const operation = createDangerZoneOperation('rm -rf', 'Destructive operation', true);
      expect(operation.blocked).toBe(false);
      expect(operation.howToEnable).toBeUndefined();
      expect(operation.verificationRequired).toBeDefined();
      expect(operation.verificationRequired?.challengeType).toBe('authenticator');
    });

    it('should use display_code when authenticator not required', () => {
      const config: SafetyConfig = {
        ...DEFAULT_SAFETY_CONFIG,
        dangerZone: {
          ...DEFAULT_SAFETY_CONFIG.dangerZone,
          requiresAuthenticator: false,
        },
      };

      const operation = createDangerZoneOperation('operation', 'reason', true, config);
      expect(operation.verificationRequired?.challengeType).toBe('display_code');
    });
  });

  describe('createExecutionContext', () => {
    it('should create context for direct invocation', () => {
      const context = createExecutionContext('agent1');
      expect(context.agentChain).toEqual(['agent1']);
      expect(context.depth).toBe(0);
      expect(context.depthEscalation).toBe(false);
      expect(context.requiresHumanCheckin).toBe(false);
    });

    it('should create context for nested invocation', () => {
      const parentContext = {
        agentChain: ['agent1', 'agent2'],
        depth: 1,
        maxAutonomousDepth: 2,
        depthEscalation: false,
        requiresHumanCheckin: false,
      };

      const context = createExecutionContext('agent3', parentContext);
      expect(context.agentChain).toEqual(['agent1', 'agent2', 'agent3']);
      expect(context.depth).toBe(2);
    });

    it('should detect depth escalation', () => {
      const parentContext = {
        agentChain: ['agent1', 'agent2'],
        depth: 1,
        maxAutonomousDepth: 2,
        depthEscalation: false,
        requiresHumanCheckin: false,
      };

      const context = createExecutionContext('agent3', parentContext);
      expect(context.depthEscalation).toBe(true);
      expect(context.requiresHumanCheckin).toBe(true);
    });
  });
});
