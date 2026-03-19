/**
 * Tests for safetyTierService wrapper
 *
 * These tests verify that the DollhouseMCP-specific wrapper functions
 * properly integrate with SecurityMonitor and logger while delegating
 * core logic to @dollhousemcp/safety.
 *
 * @see Issue #121 - Add unit tests for safetyTierService
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { logger } from '../../../../src/utils/logger.js';
import {
  determineSafetyTier,
  createVerificationChallenge,
  createDangerZoneOperation,
} from '../../../../src/elements/agents/safetyTierService.js';

describe('safetyTierService wrapper', () => {
  let securityMonitorSpy: jest.SpiedFunction<typeof SecurityMonitor.logSecurityEvent>;
  let loggerInfoSpy: jest.SpiedFunction<typeof logger.info>;

  beforeEach(() => {
    securityMonitorSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});
    loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('determineSafetyTier', () => {
    it('should log to SecurityMonitor when danger_zone tier with matching pattern', () => {
      // 'rm -rf /' triggers danger_zone with a pattern match
      const result = determineSafetyTier(20, [], 'rm -rf /');

      expect(result.tier).toBe('danger_zone');
      expect(securityMonitorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'DANGER_ZONE_TRIGGERED',
          severity: 'HIGH',
          source: 'SafetyTierService.determineSafetyTier',
        })
      );
    });

    it('should not log to SecurityMonitor for non-danger_zone tiers', () => {
      // Low risk score, safe goal = advisory tier
      const result = determineSafetyTier(10, [], 'read a file');

      expect(result.tier).toBe('advisory');
      expect(securityMonitorSpy).not.toHaveBeenCalled();
    });

    it('should include matched pattern and riskScore in log additionalData', () => {
      determineSafetyTier(20, [], 'rm -rf /');

      expect(securityMonitorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.stringContaining('Matches danger zone pattern:'),
          additionalData: expect.objectContaining({
            matchedPattern: expect.stringContaining('Matches danger zone pattern:'),
            riskScore: 20,
          }),
        })
      );
    });

    it('should not log when danger_zone is triggered by high risk score without pattern', () => {
      // Very high risk score triggers danger_zone, but no pattern match
      const result = determineSafetyTier(95, [], 'safe looking goal');

      expect(result.tier).toBe('danger_zone');
      // Should NOT log because there's no "Matches danger zone pattern:" factor
      expect(securityMonitorSpy).not.toHaveBeenCalled();
    });

    it('should truncate long goals in log additionalData', () => {
      const longGoal = 'rm -rf / ' + 'x'.repeat(200);
      determineSafetyTier(20, [], longGoal);

      expect(securityMonitorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          additionalData: expect.objectContaining({
            goal: expect.any(String),
          }),
        })
      );

      // Verify goal is truncated to 100 chars
      const call = securityMonitorSpy.mock.calls[0][0];
      expect(call.additionalData?.goal.length).toBeLessThanOrEqual(100);
    });
  });

  describe('createVerificationChallenge', () => {
    it('should log challenge creation via logger.info', () => {
      const challenge = createVerificationChallenge('Test reason', 'display_code', 5);

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        'Verification challenge created',
        expect.objectContaining({
          challengeId: challenge.challengeId,
          challengeType: 'display_code',
          reason: 'Test reason',
          expiresAt: challenge.expiresAt,
        })
      );
    });

    it('should log with correct challenge type for authenticator', () => {
      createVerificationChallenge('Auth reason', 'authenticator');

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        'Verification challenge created',
        expect.objectContaining({
          challengeType: 'authenticator',
        })
      );
    });

    it('should return valid challenge from base function', () => {
      const challenge = createVerificationChallenge('Test', 'display_code', 10);

      expect(challenge).toHaveProperty('challengeId');
      expect(challenge).toHaveProperty('displayCode');
      expect(challenge).toHaveProperty('expiresAt');
      expect(challenge.challengeType).toBe('display_code');
    });
  });

  describe('createDangerZoneOperation', () => {
    it('should log with HIGH severity when operation is blocked', () => {
      const operation = createDangerZoneOperation('rm -rf', 'Destructive', false);

      expect(operation.blocked).toBe(true);
      expect(securityMonitorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'DANGER_ZONE_OPERATION',
          severity: 'HIGH',
          source: 'SafetyTierService.createDangerZoneOperation',
          details: expect.stringContaining('blocked'),
        })
      );
    });

    it('should log with MEDIUM severity when operation is allowed', () => {
      const operation = createDangerZoneOperation('rm -rf', 'Destructive', true);

      expect(operation.blocked).toBe(false);
      expect(securityMonitorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'DANGER_ZONE_OPERATION',
          severity: 'MEDIUM',
          details: expect.stringContaining('allowed with verification'),
        })
      );
    });

    it('should include operation details in additionalData', () => {
      createDangerZoneOperation('DROP TABLE', 'SQL danger', false);

      expect(securityMonitorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          additionalData: {
            operationType: 'DROP TABLE',
            reason: 'SQL danger',
            blocked: true,
          },
        })
      );
    });
  });
});
