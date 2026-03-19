/**
 * @dollhousemcp/safety
 *
 * Tiered safety infrastructure for MCP servers.
 *
 * Provides:
 * - Safety tier determination based on risk scores and security warnings
 * - Verification challenge generation and storage
 * - Cross-platform OS dialogs for LLM-proof verification
 * - Audit logging for safety events
 *
 * Zero external dependencies. Works with Node.js >= 20.
 *
 * @since v1.0.0
 * @license AGPL-3.0
 */

// Type exports
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
} from './types.js';

// Configuration exports
export { DEFAULT_SAFETY_CONFIG } from './config.js';

// Service exports
export {
  matchesDangerZonePattern,
  hasCriticalSecurityViolations,
  determineSafetyTier,
  generateDisplayCode,
  createVerificationChallenge,
  createConfirmationRequest,
  createDangerZoneOperation,
  createExecutionContext,
} from './TieredSafetyService.js';

// Verification store
export { VerificationStore } from './VerificationStore.js';

// Display service
export {
  showVerificationDialog,
  isDialogAvailable,
  type DialogOptions,
  type DialogResult,
} from './DisplayService.js';

// Audit logging
export {
  defaultAuditLogger,
  consoleAuditLogger,
  createAuditLogger,
} from './AuditLogger.js';
