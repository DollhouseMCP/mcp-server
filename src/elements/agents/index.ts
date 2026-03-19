/**
 * Agent element exports
 */

export { Agent } from './Agent.js';
export { AgentManager } from './AgentManager.js';
export * from './types.js';
export * from './constants.js';
// Note: safetyTierService types are re-exported from types.js
// Only export functions from safetyTierService to avoid duplicates
export {
  determineSafetyTier,
  createVerificationChallenge,
  createDangerZoneOperation,
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
} from './safetyTierService.js';
export * from './autonomyEvaluator.js';

// Rule Engine Configuration
export type { RuleEngineConfig } from './ruleEngineConfig.js';
export { DEFAULT_RULE_ENGINE_CONFIG, validateRuleEngineConfig } from './ruleEngineConfig.js';

// Goal Templates
export type { GoalTemplate } from './goalTemplates.js';
export {
  GOAL_TEMPLATES,
  applyGoalTemplate,
  calculateEisenhowerQuadrant,
  recommendGoalTemplate,
  validateGoalAgainstTemplate
} from './goalTemplates.js';

// V1 to V2 Converter
export type { ConversionResult } from './v1ToV2Converter.js';
export {
  isV1Agent,
  convertV1ToV2,
} from './v1ToV2Converter.js';