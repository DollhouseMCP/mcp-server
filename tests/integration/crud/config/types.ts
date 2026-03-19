/**
 * TypeScript interfaces for element type test configurations
 *
 * This module defines the type system for the capability-based CRUD+Activate test framework.
 * It provides a generic, extensible configuration structure that supports all element types
 * without hardcoded type-specific logic.
 *
 * Key Design Principles:
 * - Capability-driven: Tests driven by element capabilities, not type checks
 * - Generic: No hardcoded type-specific logic
 * - Extensible: Easy to add new element types or capabilities
 * - Migration-ready: Designed to consume from schema definitions in the future
 */

import { ElementType } from '../../../../src/portfolio/types.js';

/**
 * Main configuration interface for element type testing
 *
 * This interface defines all test configuration needed to fully test an element type
 * including creation, validation, editing, deletion, and activation scenarios.
 */
export interface ElementTypeTestConfig {
  // ============================================================================
  // Identity
  // ============================================================================

  /**
   * The ElementType enum value for this element type
   */
  type: ElementType;

  /**
   * Human-readable display name for test descriptions
   * @example "Personas", "Skills", "Templates"
   */
  displayName: string;

  // ============================================================================
  // Test Data Generation
  // ============================================================================

  /**
   * Factory function to generate test element data
   * @param overrides - Optional field overrides for customization
   * @returns Element data ready for creation
   */
  factory: ElementFactory;

  /**
   * Collection of valid example elements for testing
   * Should include minimal, complete, and edge case examples
   */
  validExamples: ElementData[];

  /**
   * Collection of invalid example elements with expected error messages
   * Used for validation testing
   */
  invalidExamples: Array<{
    data: ElementData;
    expectedError: string;
  }>;

  // ============================================================================
  // Field Specifications
  // ============================================================================

  /**
   * List of required field names that must be present
   * @example ["name", "description", "metadata.activationStrategy"]
   */
  requiredFields: string[];

  /**
   * Configuration for editable fields
   * Defines which fields can be edited and their value types
   */
  editableFields: FieldConfig[];

  /**
   * Configuration for nested field structures (optional)
   * Maps nested field paths to their configurations
   * @example { "metadata.elements": { type: "array", ... } }
   */
  nestedFields?: Record<string, FieldConfig>;

  // ============================================================================
  // Capabilities (Drives Test Selection)
  // ============================================================================

  /**
   * Capability flags that determine which test suites to run
   * This is the core of the capability-based testing approach
   */
  capabilities: ElementCapabilities;

  // ============================================================================
  // Validation Rules
  // ============================================================================

  /**
   * Custom validation rules specific to this element type
   */
  validators: ValidationRule[];
}

/**
 * Element capabilities configuration
 *
 * These capability flags determine which conditional tests are executed.
 * If a capability is undefined, those tests are skipped.
 */
export interface ElementCapabilities {
  /**
   * Does this element type support activation/execution?
   * If defined, activation tests will be run
   */
  supportsActivation?: ActivationConfig;

  /**
   * Does this element type support nesting other elements?
   * If defined, nesting tests will be run
   */
  supportsNesting?: NestingConfig;

  /**
   * Does this element type use a separate state file?
   * If defined, state persistence tests will be run
   */
  hasStateFile?: StateConfig;

  /**
   * Does this element type support references to other elements?
   * If defined, reference tests will be run
   */
  supportsReferences?: ReferenceConfig;
}

/**
 * Configuration for activation capability
 */
export interface ActivationConfig {
  /**
   * How this element is activated
   * @example "behavior-change" for personas, "execution" for agents
   */
  activationStrategy: 'behavior-change' | 'execution' | 'rendering' | 'orchestration' | 'context-loading';

  /**
   * Does activation require context?
   */
  requiresContext: boolean;

  /**
   * Expected activation result type
   */
  expectedResultType: 'state-change' | 'output' | 'side-effect' | 'multi-element';

  /**
   * Sample activation contexts for testing
   */
  testContexts?: ActivationContext[];
}

/**
 * Context data for activation testing
 */
export interface ActivationContext {
  description: string;
  context?: Record<string, any>;
  expectedOutcome: string;
}

/**
 * Configuration for nesting capability
 */
export interface NestingConfig {
  /**
   * Maximum nesting depth allowed
   */
  maxDepth: number;

  /**
   * Element types that can be nested
   */
  allowedTypes: ElementType[];

  /**
   * Should circular dependencies be detected?
   */
  detectCircular: boolean;

  /**
   * Field path where nested elements are stored
   * @example "metadata.elements"
   */
  nestingField: string;
}

/**
 * Configuration for state file capability
 */
export interface StateConfig {
  /**
   * File extension for state files
   * @example ".state.yaml"
   */
  fileExtension: string;

  /**
   * Schema for state file (for validation)
   */
  stateSchema?: Record<string, any>;

  /**
   * Should state be cleaned up on deletion?
   */
  cleanupOnDelete: boolean;
}

/**
 * Configuration for reference capability
 */
export interface ReferenceConfig {
  /**
   * Types of references supported
   */
  referenceTypes: ReferenceType[];

  /**
   * Are bidirectional references supported?
   */
  bidirectional: boolean;

  /**
   * Field path where references are stored
   * @example "metadata.dependencies"
   */
  referenceField: string;
}

/**
 * Types of element references
 */
export enum ReferenceType {
  INTERNAL = 'internal',    // Reference to another element
  EXTERNAL = 'external',    // External resource
  DEPENDENCY = 'dependency' // Required dependency
}

/**
 * Configuration for a single field
 */
export interface FieldConfig {
  /**
   * Field path (dot notation for nested fields)
   * @example "metadata.activationStrategy"
   */
  path: string;

  /**
   * Display name for test descriptions
   */
  displayName: string;

  /**
   * Expected value type
   */
  type: FieldType;

  /**
   * Is this field required?
   */
  required: boolean;

  /**
   * Valid test values for this field
   */
  validValues?: any[];

  /**
   * Invalid test values for this field
   */
  invalidValues?: Array<{
    value: any;
    expectedError: string;
  }>;

  /**
   * Custom validator function (optional)
   */
  validator?: (value: any) => { valid: boolean; error?: string };
}

/**
 * Field value types
 */
export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'enum'
  | 'date'
  | 'custom';

/**
 * Validation rule definition
 */
export interface ValidationRule {
  /**
   * Rule identifier
   */
  name: string;

  /**
   * Human-readable description
   */
  description: string;

  /**
   * Validation function
   * @param data - Element data to validate
   * @returns Validation result
   */
  validate: (data: ElementData) => ValidationRuleResult;

  /**
   * Severity level
   */
  severity: 'error' | 'warning' | 'info';
}

/**
 * Result of a validation rule
 */
export interface ValidationRuleResult {
  valid: boolean;
  message?: string;
}

/**
 * Factory function type for generating test elements
 */
export type ElementFactory = (overrides?: Partial<ElementData>) => ElementData;

/**
 * Generic element data structure
 *
 * This is a flexible structure that works for any element type.
 * Specific element types will have their own metadata structures.
 */
export interface ElementData {
  name: string;
  description: string;
  content?: string;
  metadata?: Record<string, any>;
  [key: string]: any;
}

/**
 * Test result assertion helpers
 */
export interface TestAssertions {
  /**
   * Assert that an MCP tool call succeeded
   */
  assertSuccess: (result: any) => void;

  /**
   * Assert that an MCP tool call failed
   */
  assertFailure: (result: any, expectedError?: string) => void;

  /**
   * Assert element exists with expected data
   */
  assertElementExists: (elementName: string, expectedData?: Partial<ElementData>) => Promise<void>;

  /**
   * Assert element does not exist
   */
  assertElementNotExists: (elementName: string) => Promise<void>;
}
