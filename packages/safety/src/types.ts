/**
 * Type definitions for @dollhousemcp/safety
 *
 * Tiered safety infrastructure for MCP servers.
 *
 * @since v1.0.0
 */

/**
 * Safety tier levels for agent execution
 */
export type SafetyTier = 'advisory' | 'confirm' | 'verify' | 'danger_zone';

/**
 * Verification challenge types for human verification
 */
export type VerificationChallengeType = 'authenticator' | 'display_code' | 'passphrase';

/**
 * Safety configuration for tiered safety system
 */
export interface SafetyConfig {
  thresholds: {
    advisory: number;
    confirm: number;
    verify: number;
    dangerZone: number;
  };
  dangerZone: {
    enabled: boolean;
    requiresVerify: boolean;
    requiresAuthenticator: boolean;
    patterns: string[];
  };
  agentChain: {
    maxAutonomousDepth: number;
    requireOriginatingHuman: boolean;
  };
  verificationMethods: VerificationChallengeType[];
}

/**
 * Verification challenge returned when human verification is required
 *
 * For VERIFY and DANGER_ZONE tiers, the LLM cannot proceed without
 * human verification. This challenge must be resolved via verification.
 */
export interface VerificationChallenge {
  /** Unique identifier for this challenge */
  challengeId: string;
  /** Type of verification required */
  challengeType: VerificationChallengeType;
  /** Human-readable prompt (e.g., "Enter your 6-digit authenticator code") */
  prompt: string;
  /** ISO 8601 timestamp when this challenge expires */
  expiresAt: string;
  /** Reason why verification is required */
  reason: string;
  /** For display_code type: the code shown to the user (LLM cannot see this) */
  displayCode?: string;
}

/**
 * Confirmation request for CONFIRM tier operations
 *
 * Simple confirmation that the LLM can potentially auto-fill.
 * Used for moderate-risk operations where a pause is beneficial
 * but strict verification isn't required.
 */
export interface ConfirmationRequest {
  /** Reason why confirmation is requested */
  reason: string;
  /** Risk factors that led to this confirmation request */
  riskFactors: string[];
  /** Suggested response to proceed (e.g., "proceed", "yes") */
  suggestedResponse: string;
}

/**
 * Danger zone operation details
 *
 * Returned when an operation is blocked by default due to
 * danger zone classification. Includes instructions for how
 * operators can enable the operation if genuinely needed.
 */
export interface DangerZoneOperation {
  /** Type of dangerous operation detected */
  operationType: string;
  /** Whether the operation is currently blocked */
  blocked: boolean;
  /** Human-readable explanation of why this is dangerous */
  reason: string;
  /** Instructions for how to enable this operation in settings */
  howToEnable?: string;
  /** If enabled, verification is still required */
  verificationRequired?: VerificationChallenge;
}

/**
 * Agent execution context for tracking agent chains
 *
 * When agents spawn other agents, this context tracks the chain
 * to ensure verification requests bubble up to the original human.
 */
export interface ExecutionContext {
  /** Chain of agent names leading to this execution */
  agentChain: string[];
  /** Current depth in the agent chain (0 = direct human invocation) */
  depth: number;
  /** Maximum depth before requiring human check-in */
  maxAutonomousDepth: number;
  /** Whether this execution was escalated due to depth */
  depthEscalation: boolean;
  /** Whether this execution requires human check-in */
  requiresHumanCheckin: boolean;
}

/**
 * Safety tier determination result
 */
export interface SafetyTierResult {
  /** Determined safety tier */
  tier: SafetyTier;
  /** Risk score that contributed to the determination */
  riskScore: number;
  /** Factors that contributed to the tier determination */
  factors: string[];
  /** Whether the tier was escalated due to agent chain depth */
  escalatedDueToDepth: boolean;
  /** Original tier before any escalation */
  originalTier?: SafetyTier;
}

/**
 * Stored challenge for verification
 */
export interface StoredChallenge {
  /** Verification code expected */
  code: string;
  /** Expiration timestamp (ms since epoch) */
  expiresAt: number;
  /** Reason for verification */
  reason: string;
}

/**
 * Audit event types for safety operations
 */
export type SafetyAuditEventType =
  | 'TIER_DETERMINED'
  | 'VERIFICATION_REQUIRED'
  | 'VERIFICATION_SUCCESS'
  | 'VERIFICATION_FAILED'
  | 'DANGER_ZONE_TRIGGERED'
  | 'DANGER_ZONE_OPERATION';

/**
 * Safety audit event
 */
export interface SafetyAuditEvent {
  type: SafetyAuditEventType;
  tier: SafetyTier;
  timestamp: string;
  details: Record<string, unknown>;
}

/**
 * Audit logger interface
 */
export interface AuditLogger {
  log(event: SafetyAuditEvent): void;
}
