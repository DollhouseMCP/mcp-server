/**
 * Type-safe context examples for ensemble conditional activation
 *
 * This file demonstrates how to use the ConditionContext interface
 * when writing activation conditions for ensemble elements.
 *
 * NOTE: Condition evaluation is not yet implemented. These examples
 * show the correct syntax for when evaluation is added in the future.
 *
 * @see {@link ConditionContext} for available context properties
 * @see docs/guides/ensembles.md#conditional-activation for full guide
 *
 * FIX: DMCP-SEC-006 - No security logging required
 * RATIONALE: This file contains ONLY documentation examples and constant declarations.
 * All exports are readonly example data (const objects and functions that return test fixtures).
 * No security-relevant operations are performed.
 * Security logging occurs in EnsembleManager.ts when ensembles are actually activated.
 *
 * VERIFICATION: All exports are const objects or test helper functions
 * @security-audit-suppress DMCP-SEC-006
 */

import type { ConditionContext } from './types.js';

// ============================================================================
// CONTEXT STRUCTURE
// ============================================================================

/**
 * Example context object structure
 *
 * This shows what a real ConditionContext looks like at runtime.
 * All properties are readonly and type-safe.
 */
const exampleContext: ConditionContext = {
  // Current element being evaluated
  element: {
    element_name: 'security-validator',
    element_type: 'skill',
    role: 'support',
    priority: 85,
    activation: 'conditional',
    dependencies: ['input-parser', 'rule-engine'],
    purpose: 'Validate security requirements before processing'
  },

  // Shared context values from other elements
  context: {
    environment: 'production',
    security_review: true,
    mode: 'strict',
    user_role: 'admin',
    request_count: 42,
    override_enabled: false
  },

  // Element that set each context value
  contextOwners: {
    environment: 'config-loader',
    security_review: 'security-checker',
    mode: 'mode-detector',
    user_role: 'auth-handler',
    request_count: 'request-tracker',
    override_enabled: 'override-manager'
  },

  // Activation state
  state: {
    activatedCount: 3,
    failedCount: 0,
    activatedElements: ['input-parser', 'rule-engine', 'config-loader'],
    failedElements: [],
    totalElements: 8
  },

  // Environment info (reserved for future use)
  environment: {},

  // Resource usage
  resources: {
    executionTimeMs: 1250,
    contextSize: 6,
    cachedInstances: 3
  }
};

// ============================================================================
// CONDITION EXAMPLES
// ============================================================================

/**
 * Example conditions using element properties
 *
 * These conditions reference the current element's metadata.
 */
const elementConditions = {
  // Check element priority
  highPriority: 'priority >= 80',
  criticalPriority: 'priority > 90',

  // Check element role
  isPrimary: "role == 'primary'",
  isSupport: "role == 'support'",

  // Check dependencies
  hasDependencies: 'dependencies.length > 0',
  noDependencies: 'dependencies.length == 0',

  // Combine multiple checks
  criticalPrimaryElement: "priority > 90 && role == 'primary'",
  supportWithDeps: "role == 'support' && dependencies.length > 0"
} as const;

/**
 * Example conditions using shared context
 *
 * These conditions reference values set by other elements.
 */
const contextConditions = {
  // Check environment
  isProduction: "context.environment == 'production'",
  isDevelopment: "context.environment == 'development'",

  // Check boolean flags
  securityReviewPassed: 'context.security_review == true',
  overrideEnabled: 'context.override_enabled == true',

  // Check numeric values
  highRequestCount: 'context.request_count > 100',
  lowRequestCount: 'context.request_count < 10',

  // Check string values
  strictMode: "context.mode == 'strict'",
  adminUser: "context.user_role == 'admin'",

  // Combine multiple context checks
  productionWithSecurity: "context.environment == 'production' && context.security_review == true",
  adminOverride: "context.user_role == 'admin' || context.override_enabled == true"
} as const;

/**
 * Example conditions using activation state
 *
 * These conditions depend on how many elements have been activated.
 */
const stateConditions = {
  // Check activation progress
  afterThreeElements: 'state.activatedCount > 3',
  firstElement: 'state.activatedCount == 0',
  lastElement: 'state.activatedCount == state.totalElements - 1',

  // Check for failures
  noFailures: 'state.failedCount == 0',
  hasFailures: 'state.failedCount > 0',
  tooManyFailures: 'state.failedCount > 2',

  // Percentage-based conditions
  halfwayDone: 'state.activatedCount >= state.totalElements / 2',
  mostlyDone: 'state.activatedCount >= state.totalElements * 0.8',

  // Combined with other checks
  lateStageNoCriticalFailures: 'state.activatedCount > 5 && state.failedCount < 2'
} as const;

/**
 * Example conditions using resource metrics
 *
 * These conditions gate activation based on resource usage.
 */
const resourceConditions = {
  // Check execution time
  fastExecution: 'resources.executionTimeMs < 5000',
  slowExecution: 'resources.executionTimeMs > 10000',

  // Check context size
  smallContext: 'resources.contextSize < 100',
  largeContext: 'resources.contextSize > 500',

  // Check cached instances
  fewInstances: 'resources.cachedInstances < 10',
  manyInstances: 'resources.cachedInstances > 50',

  // Combined resource checks
  resourcesAvailable: 'resources.executionTimeMs < 20000 && resources.contextSize < 800',
  approachingLimits: 'resources.executionTimeMs > 25000 || resources.contextSize > 900'
} as const;

/**
 * Example conditions using context ownership
 *
 * These conditions check which element set a context value.
 */
const ownershipConditions = {
  // Check value source
  securityCheckerApproved: "contextOwners.security_review == 'security-checker'",
  configLoaderSet: "contextOwners.environment == 'config-loader'",

  // Combine with value checks
  trustedSecurityReview: "context.security_review == true && contextOwners.security_review == 'security-checker'",
  authenticatedAdmin: "context.user_role == 'admin' && contextOwners.user_role == 'auth-handler'"
} as const;

/**
 * Complex real-world condition examples
 *
 * These combine multiple context properties for realistic scenarios.
 */
const complexConditions = {
  // Security-gated activation
  securityRequirementsMet: `
    context.security_review == true &&
    context.user_role == 'admin' &&
    context.environment == 'production' &&
    state.failedCount == 0
  `.trim(),

  // Progressive activation
  progressiveActivation: `
    state.activatedCount > 3 &&
    state.failedCount < 2 &&
    resources.executionTimeMs < 15000
  `.trim(),

  // Conditional override
  allowedOverride: `
    (context.user_role == 'admin' || context.override_enabled == true) &&
    priority > 70 &&
    state.failedCount == 0
  `.trim(),

  // Performance-based gating
  performanceGated: `
    resources.executionTimeMs < 20000 &&
    resources.contextSize < 800 &&
    state.activatedCount < state.totalElements * 0.9
  `.trim(),

  // Role-based activation
  roleBased: `
    (role == 'primary' && priority > 80) ||
    (role == 'support' && state.activatedCount > 5) ||
    (role == 'monitor')
  `.trim()
} as const;

// ============================================================================
// TYPE-SAFE CONTEXT USAGE
// ============================================================================

/**
 * Demonstrates how to safely access context properties
 *
 * All properties are readonly and properly typed.
 * TypeScript will catch typos and invalid property access.
 */
function demonstrateTypeSafety(ctx: ConditionContext): void {
  // ✓ Valid property access - TypeScript allows
  const _elementName = ctx.element.element_name;
  const _priority = ctx.element.priority;
  const _envValue = ctx.context.environment;
  const _activatedCount = ctx.state.activatedCount;

  // ✗ Invalid property access - TypeScript errors
  // const invalid = ctx.element.invalidProperty;     // Error: Property doesn't exist
  // ctx.element.element_name = 'new-name';           // Error: readonly property
  // ctx.state.activatedCount = 10;                   // Error: readonly property

  // Type guards for unknown context values
  if (typeof ctx.context.environment === 'string') {
    // TypeScript knows environment is a string here
    const _upper = ctx.context.environment.toUpperCase();
  }

  if (typeof ctx.context.request_count === 'number') {
    // TypeScript knows request_count is a number here
    const _doubled = ctx.context.request_count * 2;
  }
}

/**
 * Example of building context in tests
 *
 * Shows how to construct a valid ConditionContext for testing.
 */
function createTestContext(): ConditionContext {
  return {
    element: {
      element_name: 'test-element',
      element_type: 'skill',
      role: 'support',
      priority: 50,
      activation: 'conditional',
      dependencies: []
    },
    context: {},
    contextOwners: {},
    state: {
      activatedCount: 0,
      failedCount: 0,
      activatedElements: [],
      failedElements: [],
      totalElements: 5
    },
    environment: {},
    resources: {
      executionTimeMs: 0,
      contextSize: 0,
      cachedInstances: 0
    }
  };
}

// ============================================================================
// DOCUMENTATION EXPORTS
// ============================================================================

/**
 * All example conditions organized by category
 *
 * Import and reference these in documentation and tests.
 */
export const CONDITIONS = {
  element: elementConditions,
  context: contextConditions,
  state: stateConditions,
  resources: resourceConditions,
  ownership: ownershipConditions,
  complex: complexConditions
} as const;

/**
 * Example context for documentation and testing
 */
export { exampleContext, createTestContext };

/**
 * Type-safe context demonstration
 */
export { demonstrateTypeSafety };
