/**
 * Tiered Safety Service
 *
 * Determines safety tiers based on risk assessment and security warnings.
 * Extracted from DollhouseMCP for standalone use in any MCP server.
 *
 * @since v1.0.0
 */

import { randomBytes } from 'crypto';
import {
  SafetyTier,
  SafetyConfig,
  VerificationChallengeType,
  SafetyTierResult,
  VerificationChallenge,
  ConfirmationRequest,
  DangerZoneOperation,
  ExecutionContext,
  AuditLogger,
} from './types.js';
import { DEFAULT_SAFETY_CONFIG } from './config.js';
import { defaultAuditLogger } from './AuditLogger.js';

// ============================================================================
// Constants
// ============================================================================

/** Default length for generated display verification codes */
export const DEFAULT_DISPLAY_CODE_LENGTH = 6;

/** Default expiration time for verification challenges in minutes */
export const DEFAULT_VERIFICATION_EXPIRATION_MINUTES = 5;

/** Maximum length of goal to include in audit logs (to prevent log bloat) */
export const GOAL_TRUNCATION_LENGTH = 100;

// ============================================================================
// Regex Pattern Cache (Performance Optimization)
// ============================================================================

/**
 * Cache for compiled danger zone regex patterns.
 * Maps pattern strings to compiled RegExp objects (or null if invalid).
 * This avoids recompiling the same patterns on every call.
 */
const dangerZoneRegexCache = new Map<string, RegExp | null>();

/**
 * Get or compile a regex pattern from the cache.
 * Invalid patterns are cached as null to avoid repeated compilation attempts.
 */
function getCachedRegex(pattern: string): RegExp | null {
  if (dangerZoneRegexCache.has(pattern)) {
    return dangerZoneRegexCache.get(pattern) ?? null;
  }

  try {
    const regex = new RegExp(pattern, 'i');
    dangerZoneRegexCache.set(pattern, regex);
    return regex;
  } catch (error) {
    console.warn(
      `[TieredSafetyService] Invalid danger zone pattern: ${pattern}`,
      error
    );
    dangerZoneRegexCache.set(pattern, null);
    return null;
  }
}

/**
 * Clear the regex pattern cache (useful for testing or config reloads)
 */
export function clearDangerZonePatternCache(): void {
  dangerZoneRegexCache.clear();
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Check if a goal matches any danger zone patterns
 */
export function matchesDangerZonePattern(
  goal: string,
  patterns: string[]
): { matches: boolean; matchedPattern?: string } {
  for (const pattern of patterns) {
    const regex = getCachedRegex(pattern);
    if (regex && regex.test(goal)) {
      return { matches: true, matchedPattern: pattern };
    }
  }
  return { matches: false };
}

/**
 * Check if security warnings contain critical violations
 */
export function hasCriticalSecurityViolations(warnings: string[]): boolean {
  const criticalPatterns = [
    'code injection',
    'credential',
    'destructive action',
    'system() call',
    'exec() call',
    'eval() call',
  ];

  return warnings.some((warning) =>
    criticalPatterns.some((pattern) =>
      warning.toLowerCase().includes(pattern.toLowerCase())
    )
  );
}

/**
 * Determine the safety tier based on risk score, security warnings, and goal content
 */
export function determineSafetyTier(
  riskScore: number,
  securityWarnings: string[],
  goal: string,
  config: SafetyConfig = DEFAULT_SAFETY_CONFIG,
  executionContext?: ExecutionContext,
  logger: AuditLogger = defaultAuditLogger
): SafetyTierResult {
  const factors: string[] = [];
  let tier: SafetyTier;
  let escalatedDueToDepth = false;
  let originalTier: SafetyTier | undefined;

  // Step 1: Check for danger zone patterns first (hard-coded dangerous operations)
  const dangerZoneMatch = matchesDangerZonePattern(
    goal,
    config.dangerZone.patterns
  );
  if (dangerZoneMatch.matches) {
    factors.push(
      `Matches danger zone pattern: ${dangerZoneMatch.matchedPattern}`
    );
    tier = 'danger_zone';

    logger.log({
      type: 'DANGER_ZONE_TRIGGERED',
      tier: 'danger_zone',
      timestamp: new Date().toISOString(),
      details: {
        pattern: dangerZoneMatch.matchedPattern,
        goal: goal.substring(0, GOAL_TRUNCATION_LENGTH),
      },
    });

    return { tier, riskScore, factors, escalatedDueToDepth };
  }

  // Step 2: Check for critical security violations
  if (hasCriticalSecurityViolations(securityWarnings)) {
    factors.push('Critical security violations detected');
    factors.push(
      ...securityWarnings.filter((w) =>
        ['code injection', 'credential', 'destructive'].some((p) =>
          w.toLowerCase().includes(p)
        )
      )
    );
    tier = 'verify';

    // May escalate to danger_zone if combined with high risk score
    if (riskScore >= config.thresholds.dangerZone) {
      originalTier = tier;
      tier = 'danger_zone';
      factors.push(
        `Risk score ${riskScore} >= ${config.thresholds.dangerZone} (danger zone threshold)`
      );
    }

    return { tier, riskScore, factors, escalatedDueToDepth, originalTier };
  }

  // Step 3: Score-based tier determination
  if (riskScore >= config.thresholds.dangerZone) {
    tier = 'danger_zone';
    factors.push(
      `Risk score ${riskScore} >= ${config.thresholds.dangerZone} (danger zone threshold)`
    );
  } else if (riskScore >= config.thresholds.verify) {
    tier = 'verify';
    factors.push(
      `Risk score ${riskScore} >= ${config.thresholds.verify} (verify threshold)`
    );
  } else if (riskScore >= config.thresholds.confirm) {
    tier = 'confirm';
    factors.push(
      `Risk score ${riskScore} >= ${config.thresholds.confirm} (confirm threshold)`
    );
  } else {
    tier = 'advisory';
    factors.push(
      `Risk score ${riskScore} <= ${config.thresholds.advisory} (advisory threshold)`
    );
  }

  // Step 4: Depth-based escalation
  if (
    executionContext &&
    executionContext.depth >= config.agentChain.maxAutonomousDepth
  ) {
    originalTier = tier;
    escalatedDueToDepth = true;
    factors.push(
      `Agent chain depth ${executionContext.depth} >= max autonomous depth ${config.agentChain.maxAutonomousDepth}`
    );

    // Escalate by one level
    if (tier === 'advisory') {
      tier = 'confirm';
    } else if (tier === 'confirm') {
      tier = 'verify';
    } else if (tier === 'verify') {
      tier = 'danger_zone';
    }
    // danger_zone stays danger_zone
  }

  // Add security warnings as factors if any
  if (securityWarnings.length > 0) {
    factors.push(
      `${securityWarnings.length} security warning(s): ${securityWarnings.join(', ')}`
    );
  }

  logger.log({
    type: 'TIER_DETERMINED',
    tier,
    timestamp: new Date().toISOString(),
    details: {
      riskScore,
      factors,
      escalatedDueToDepth,
      originalTier,
    },
  });

  return { tier, riskScore, factors, escalatedDueToDepth, originalTier };
}

/**
 * Generate a display code for verification
 * This is a simple code that gets displayed to the user but the LLM cannot see
 */
export function generateDisplayCode(
  length: number = DEFAULT_DISPLAY_CODE_LENGTH
): string {
  const chars = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // Exclude I, O for clarity
  const bytes = randomBytes(length);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('');
}

/**
 * Create a verification challenge for VERIFY or DANGER_ZONE tiers
 */
export function createVerificationChallenge(
  reason: string,
  challengeType: VerificationChallengeType = 'display_code',
  expirationMinutes: number = DEFAULT_VERIFICATION_EXPIRATION_MINUTES,
  logger: AuditLogger = defaultAuditLogger
): VerificationChallenge {
  const randomPart = randomBytes(6).toString('hex');
  const challengeId = `challenge_${Date.now()}_${randomPart}`;
  const expiresAt = new Date(
    Date.now() + expirationMinutes * 60 * 1000
  ).toISOString();

  let prompt: string;
  let displayCode: string | undefined;

  switch (challengeType) {
    case 'authenticator':
      prompt = 'Enter your 6-digit authenticator code to proceed';
      break;
    case 'display_code':
      displayCode = generateDisplayCode();
      prompt = `Enter the verification code displayed on your screen to proceed`;
      // Note: displayCode is set but should be shown via console.log separately
      // The LLM receives the challenge but cannot see the displayCode output
      break;
    case 'passphrase':
      prompt = 'Enter your passphrase to proceed';
      break;
    default:
      prompt = 'Complete verification to proceed';
  }

  logger.log({
    type: 'VERIFICATION_REQUIRED',
    tier: 'verify',
    timestamp: new Date().toISOString(),
    details: {
      challengeId,
      challengeType,
      reason,
      expiresAt,
    },
  });

  return {
    challengeId,
    challengeType,
    prompt,
    expiresAt,
    reason,
    displayCode,
  };
}

/**
 * Create a confirmation request for CONFIRM tier
 */
export function createConfirmationRequest(
  reason: string,
  riskFactors: string[]
): ConfirmationRequest {
  return {
    reason,
    riskFactors,
    suggestedResponse: 'proceed',
  };
}

/**
 * Create a danger zone operation record
 */
export function createDangerZoneOperation(
  operationType: string,
  reason: string,
  dangerZoneEnabled: boolean,
  config: SafetyConfig = DEFAULT_SAFETY_CONFIG,
  logger: AuditLogger = defaultAuditLogger
): DangerZoneOperation {
  const blocked = !dangerZoneEnabled;

  let howToEnable: string | undefined;
  let verificationRequired: VerificationChallenge | undefined;

  if (blocked) {
    howToEnable =
      'Enable danger zone operations in your safety configuration: safety.dangerZone.enabled = true';
  } else if (config.dangerZone.requiresVerify) {
    verificationRequired = createVerificationChallenge(
      `Danger zone operation: ${operationType}`,
      config.dangerZone.requiresAuthenticator ? 'authenticator' : 'display_code',
      5,
      logger
    );
  }

  logger.log({
    type: 'DANGER_ZONE_OPERATION',
    tier: 'danger_zone',
    timestamp: new Date().toISOString(),
    details: {
      operationType,
      reason,
      blocked,
    },
  });

  return {
    operationType,
    blocked,
    reason,
    howToEnable,
    verificationRequired,
  };
}

/**
 * Create execution context for agent chain tracking
 */
export function createExecutionContext(
  agentName: string,
  parentContext?: ExecutionContext,
  config: SafetyConfig = DEFAULT_SAFETY_CONFIG
): ExecutionContext {
  const agentChain = parentContext
    ? [...parentContext.agentChain, agentName]
    : [agentName];

  const depth = agentChain.length - 1; // 0 for direct invocation
  const maxAutonomousDepth = config.agentChain.maxAutonomousDepth;
  const depthEscalation = depth >= maxAutonomousDepth;
  const requiresHumanCheckin = depthEscalation;

  return {
    agentChain,
    depth,
    maxAutonomousDepth,
    depthEscalation,
    requiresHumanCheckin,
  };
}
