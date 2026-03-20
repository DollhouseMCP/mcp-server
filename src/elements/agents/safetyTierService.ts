/**
 * Safety Tier Service
 *
 * Wrapper around @dollhousemcp/safety that adds DollhouseMCP-specific
 * integrations (logger, SecurityMonitor).
 *
 * Part of the Tiered Safety System (RFC #97).
 *
 * @since v2.0.0
 */

// Re-export core types and functions from the standalone package
export {
  matchesDangerZonePattern,
  hasCriticalSecurityViolations,
  generateDisplayCode,
  createConfirmationRequest,
  createExecutionContext,
  VerificationStore,
  showVerificationDialog,
  isDialogAvailable,
  defaultAuditLogger,
  consoleAuditLogger,
  createAuditLogger,
  DEFAULT_SAFETY_CONFIG,
} from '@dollhousemcp/safety';

export type {
  SafetyTier,
  VerificationChallengeType,
  SafetyConfig,
  VerificationChallenge,
  ConfirmationRequest,
  DangerZoneOperation,
  ExecutionContext,
  SafetyTierResult,
  StoredChallenge,
  SafetyAuditEvent,
  SafetyAuditEventType,
  AuditLogger,
  DialogOptions,
  DialogResult,
} from '@dollhousemcp/safety';

// Import for wrapping with DollhouseMCP integrations
import {
  determineSafetyTier as baseDetermineSafetyTier,
  createVerificationChallenge as baseCreateVerificationChallenge,
  createDangerZoneOperation as baseCreateDangerZoneOperation,
  DEFAULT_SAFETY_CONFIG,
} from '@dollhousemcp/safety';

import type {
  SafetyConfig,
  SafetyTierResult,
  ExecutionContext,
  VerificationChallengeType,
  VerificationChallenge,
  DangerZoneOperation,
} from '@dollhousemcp/safety';

import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';

/**
 * Determine the safety tier based on risk score, security warnings, and goal content
 *
 * Wrapper that adds SecurityMonitor logging for danger zone triggers.
 */
export function determineSafetyTier(
  riskScore: number,
  securityWarnings: string[],
  goal: string,
  config: SafetyConfig = DEFAULT_SAFETY_CONFIG,
  executionContext?: ExecutionContext
): SafetyTierResult {
  const result = baseDetermineSafetyTier(
    riskScore,
    securityWarnings,
    goal,
    config,
    executionContext
  );

  // Add DollhouseMCP-specific security monitoring
  if (result.tier === 'danger_zone') {
    const dangerPattern = result.factors.find((f) =>
      f.startsWith('Matches danger zone pattern:')
    );
    if (dangerPattern) {
      SecurityMonitor.logSecurityEvent({
        type: 'DANGER_ZONE_TRIGGERED',
        severity: 'HIGH',
        source: 'SafetyTierService.determineSafetyTier',
        details: `Goal matched danger zone pattern: ${dangerPattern}`,
        additionalData: { goal: goal.substring(0, 100), matchedPattern: dangerPattern, riskScore, factors: result.factors },
      });
    }
  }

  return result;
}

/**
 * Create a verification challenge for VERIFY or DANGER_ZONE tiers
 *
 * Wrapper that adds DollhouseMCP logger integration.
 */
export function createVerificationChallenge(
  reason: string,
  challengeType: VerificationChallengeType = 'display_code',
  expirationMinutes: number = 5
): VerificationChallenge {
  const challenge = baseCreateVerificationChallenge(
    reason,
    challengeType,
    expirationMinutes
  );

  logger.info('Verification challenge created', {
    challengeId: challenge.challengeId,
    challengeType,
    reason,
    expiresAt: challenge.expiresAt,
  });

  return challenge;
}

/**
 * Create a danger zone operation record
 *
 * Wrapper that adds SecurityMonitor logging.
 */
export function createDangerZoneOperation(
  operationType: string,
  reason: string,
  dangerZoneEnabled: boolean,
  config: SafetyConfig = DEFAULT_SAFETY_CONFIG
): DangerZoneOperation {
  const operation = baseCreateDangerZoneOperation(
    operationType,
    reason,
    dangerZoneEnabled,
    config
  );

  SecurityMonitor.logSecurityEvent({
    type: 'DANGER_ZONE_OPERATION',
    severity: operation.blocked ? 'HIGH' : 'MEDIUM',
    source: 'SafetyTierService.createDangerZoneOperation',
    details: `Danger zone operation ${operation.blocked ? 'blocked' : 'allowed with verification'}: ${operationType}`,
    additionalData: { operationType, reason, blocked: operation.blocked },
  });

  return operation;
}
