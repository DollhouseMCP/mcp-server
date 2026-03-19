/**
 * Shared test data and scenarios
 *
 * This module provides common test data patterns, validation scenarios,
 * and reusable fixtures for CRUD+Activate testing.
 *
 * Key Design Principles:
 * - Reusable: Common patterns shared across all element types
 * - Realistic: Test data mirrors real-world usage
 * - Comprehensive: Coverage of edge cases and common scenarios
 */

/**
 * Common test names for consistent test identification
 */
export const TEST_NAMES = {
  minimal: (type: string) => `test-minimal-${type}`,
  complete: (type: string) => `test-complete-${type}`,
  invalid: (type: string) => `test-invalid-${type}`,
  editable: (type: string) => `test-editable-${type}`,
  deletable: (type: string) => `test-deletable-${type}`,
  validatable: (type: string) => `test-validatable-${type}`,
  activatable: (type: string) => `test-activatable-${type}`,
  nested: (type: string) => `test-nested-${type}`,
  withState: (type: string) => `test-state-${type}`,
  withRefs: (type: string) => `test-refs-${type}`,
};

/**
 * Common validation test scenarios
 *
 * These scenarios apply to most element types.
 */
export const VALIDATION_SCENARIOS = {
  /**
   * Empty name validation
   */
  emptyName: {
    description: 'Empty name should fail validation',
    field: 'name',
    value: '',
    expectedError: 'name',
  },

  /**
   * Missing description validation
   */
  emptyDescription: {
    description: 'Empty description should trigger warning',
    field: 'description',
    value: '',
    expectedError: 'description',
  },

  /**
   * Name with invalid characters
   */
  invalidNameChars: {
    description: 'Name with special characters should fail',
    field: 'name',
    value: 'test/invalid*name',
    expectedError: 'invalid',
  },

  /**
   * Excessively long name
   */
  longName: {
    description: 'Excessively long name should fail',
    field: 'name',
    value: 'a'.repeat(300),
    expectedError: 'length',
  },

  /**
   * Missing required metadata fields
   */
  missingMetadata: {
    description: 'Missing required metadata should fail',
    metadata: {},
    expectedError: 'required',
  },
};

/**
 * Common edit test scenarios
 */
export const EDIT_SCENARIOS = {
  /**
   * Update description
   */
  updateDescription: {
    description: 'Update element description',
    field: 'description',
    oldValue: 'Original description',
    newValue: 'Updated description',
  },

  /**
   * Update metadata field
   */
  updateMetadataField: (fieldName: string, oldValue: any, newValue: any) => ({
    description: `Update metadata.${fieldName}`,
    field: `metadata.${fieldName}`,
    oldValue,
    newValue,
  }),

  /**
   * Update array field (add item)
   */
  addArrayItem: (fieldName: string, item: any) => ({
    description: `Add item to ${fieldName}`,
    field: fieldName,
    operation: 'add',
    item,
  }),

  /**
   * Update array field (remove item)
   */
  removeArrayItem: (fieldName: string, index: number) => ({
    description: `Remove item from ${fieldName}`,
    field: fieldName,
    operation: 'remove',
    index,
  }),
};

/**
 * Common activation test scenarios
 */
export const ACTIVATION_SCENARIOS = {
  /**
   * Basic activation (no context)
   */
  basic: {
    description: 'Activate element without context',
    context: undefined,
    expectedOutcome: 'Element should activate successfully',
  },

  /**
   * Activation with context
   */
  withContext: (context: Record<string, any>) => ({
    description: 'Activate element with context',
    context,
    expectedOutcome: 'Element should activate with provided context',
  }),

  /**
   * Reactivation (already active)
   */
  reactivation: {
    description: 'Reactivate already active element',
    context: undefined,
    expectedOutcome: 'Element should handle reactivation gracefully',
  },

  /**
   * Activation of non-existent element
   */
  nonExistent: {
    description: 'Attempt to activate non-existent element',
    elementName: 'non-existent-element',
    expectedOutcome: 'Should fail with element not found error',
  },
};

/**
 * Common nesting test scenarios
 */
export const NESTING_SCENARIOS = {
  /**
   * Single level nesting
   */
  singleLevel: {
    description: 'Nest one element inside another',
    depth: 1,
    expectedOutcome: 'Nesting should succeed',
  },

  /**
   * Multiple level nesting
   */
  multiLevel: (depth: number) => ({
    description: `Nest elements ${depth} levels deep`,
    depth,
    expectedOutcome: `Should nest up to ${depth} levels`,
  }),

  /**
   * Circular dependency
   */
  circular: {
    description: 'Create circular dependency',
    expectedOutcome: 'Should detect and prevent circular dependency',
  },

  /**
   * Max depth exceeded
   */
  maxDepthExceeded: (maxDepth: number) => ({
    description: `Exceed max nesting depth of ${maxDepth}`,
    depth: maxDepth + 1,
    expectedOutcome: 'Should fail with max depth error',
  }),
};

/**
 * Common error messages
 */
export const ERROR_MESSAGES = {
  elementNotFound: (name: string) => `not found.*${name}`,
  invalidField: (field: string) => `invalid.*${field}`,
  requiredField: (field: string) => `required.*${field}`,
  circularDependency: 'circular',
  maxDepth: 'max.*depth',
  alreadyExists: 'already exists',
  validationFailed: 'validation.*failed',
};

/**
 * Common success messages
 */
export const SUCCESS_MESSAGES = {
  created: 'created',
  updated: 'updated',
  deleted: 'deleted',
  validated: 'valid',
  activated: 'activated',
  deactivated: 'deactivated',
};

/**
 * Common metadata patterns
 */
export const METADATA_PATTERNS = {
  /**
   * Minimal metadata (just required fields)
   */
  minimal: {},

  /**
   * Standard metadata (common fields)
   */
  standard: {
    tags: ['test'],
    version: '1.0.0',
  },

  /**
   * Complete metadata (all optional fields)
   */
  complete: {
    tags: ['test', 'integration'],
    version: '1.0.0',
    author: 'test-author',
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
  },
};

/**
 * Common field update patterns
 */
export const FIELD_UPDATES = {
  /**
   * Simple string update
   */
  stringUpdate: (oldValue: string) => ({
    old: oldValue,
    new: `${oldValue}-updated`,
  }),

  /**
   * Number increment
   */
  numberIncrement: (oldValue: number) => ({
    old: oldValue,
    new: oldValue + 1,
  }),

  /**
   * Boolean toggle
   */
  booleanToggle: (oldValue: boolean) => ({
    old: oldValue,
    new: !oldValue,
  }),

  /**
   * Array append
   */
  arrayAppend: <T>(oldArray: T[], newItem: T) => ({
    old: oldArray,
    new: [...oldArray, newItem],
  }),

  /**
   * Object merge
   */
  objectMerge: (oldObject: Record<string, any>, newFields: Record<string, any>) => ({
    old: oldObject,
    new: { ...oldObject, ...newFields },
  }),
};

/**
 * Test timeouts for different operations
 */
export const TEST_TIMEOUTS = {
  create: 5000,      // Element creation
  read: 2000,        // Element retrieval
  update: 5000,      // Element update
  delete: 3000,      // Element deletion
  validate: 3000,    // Element validation
  activate: 5000,    // Element activation
  complex: 10000,    // Complex multi-step operations
};

/**
 * Test retry configuration
 */
export const RETRY_CONFIG = {
  maxAttempts: 3,
  delayMs: 100,
  backoffMultiplier: 2,
};

/**
 * Generate unique test identifier
 *
 * Creates a unique identifier for test elements.
 *
 * @param prefix - Identifier prefix
 * @returns Unique identifier
 */
export function generateTestId(prefix: string = 'test'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Generate batch of unique test names
 *
 * Creates multiple unique names for batch testing.
 *
 * @param count - Number of names to generate
 * @param prefix - Name prefix
 * @returns Array of unique names
 */
export function generateTestNames(count: number, prefix: string = 'test'): string[] {
  const names: string[] = [];
  const baseId = Date.now();

  for (let i = 0; i < count; i++) {
    names.push(`${prefix}-${baseId}-${i}`);
  }

  return names;
}
