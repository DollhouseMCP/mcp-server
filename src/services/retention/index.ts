/**
 * Retention Policy Module (Issue #51)
 *
 * Generic retention management for all element types.
 * Designed to support 50+ element types with type-specific strategies.
 *
 * Usage:
 * 1. Register strategies for element types that need retention
 * 2. Configure global and per-type retention settings
 * 3. Call enforce() to clean up expired items (respects safety settings)
 *
 * @module retention
 */

// Core service
export { RetentionPolicyService } from './RetentionPolicyService.js';

// Types and interfaces (use 'export type' for TypeScript interfaces)
export type {
  IRetentionStrategy,
  IRetainableItem,
  ElementRetentionConfig,
  RetentionEnforcementResult,
  RetentionSummary,
  RetentionCheckResult,
  RetentionReason,
  RetentionEnforcementMode,
  EnforcementOptions,
} from './types.js';

// Constants
export { RETENTION_DEFAULTS } from './types.js';

// Strategies
export { MemoryRetentionStrategy } from './strategies/MemoryRetentionStrategy.js';
