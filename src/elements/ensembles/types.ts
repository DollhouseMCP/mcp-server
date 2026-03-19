/**
 * Type definitions for Ensemble elements
 *
 * Ensembles are collections of elements that work together as a cohesive unit.
 * They support various activation strategies and conflict resolution mechanisms.
 *
 * NAMING CONVENTION: camelCase (following Agent/Memory pattern)
 * YAML Support: parseMetadata() accepts both snake_case and camelCase for user convenience
 */

import { IElementMetadata, IElement } from '../../types/elements/index.js';
import { ElementType } from '../../portfolio/types.js';

/**
 * Activation strategy determines how elements within an ensemble are activated
 *
 * Note: All strategies activate elements to work as a unified entity.
 * Elements are layered/combined rather than acting as separate entities.
 */
export type ActivationStrategy =
  | 'all'          // Activate all elements simultaneously as one unit
  | 'sequential'   // Activate elements one by one in dependency order
  | 'lazy'         // Activate elements only when needed
  | 'conditional'  // Activate based on rules/conditions
  | 'priority';    // Activate in priority order (highest first)

/**
 * Conflict resolution strategy for when multiple elements affect the same context
 */
export type ConflictResolutionStrategy =
  | 'last-write'   // Last element to write wins
  | 'first-write'  // First element to write wins
  | 'priority'     // Higher priority element wins
  | 'merge'        // Attempt to merge values (for objects)
  | 'error';       // Throw error on conflict

/**
 * Element role within an ensemble
 */
export type ElementRole =
  | 'primary'      // Main functionality provider
  | 'support'      // Augments primary elements
  | 'override'     // Can override other elements
  | 'monitor'      // Observes but doesn't interfere
  | 'core';        // Legacy alias for 'primary' — accepted for backwards compatibility

/**
 * Element activation mode
 */
export type ActivationMode =
  | 'always'       // Always activate when ensemble activates
  | 'on-demand'    // Activate only when explicitly requested
  | 'conditional'; // Activate based on condition

/**
 * Resource limits for ensemble execution
 *
 * All fields are optional when used as per-ensemble overrides.
 * Unspecified limits will fall back to global config, environment variables,
 * or defaults (in that order of priority).
 *
 * @see EnsembleLimitsConfig in constants.ts for configuration details
 * @see getEffectiveLimits() for limit resolution
 */
export interface ResourceLimits {
  /** Maximum number of elements in the ensemble (default: 50, max: 500) */
  maxActiveElements?: number;
  /** Maximum memory usage in MB (optional, not enforced at runtime) */
  maxMemoryMb?: number;
  /** Maximum activation time in milliseconds (default: 30000, max: 300000) */
  maxExecutionTimeMs?: number;
  /** Maximum depth of nested ensembles (default: 5, max: 10) */
  maxNestingDepth?: number;
  /** Maximum keys in shared context (default: 1000, max: 10000) */
  maxContextSize?: number;
  /** Maximum size of a context value in bytes (default: 10000, max: 1048576) */
  maxContextValueSize?: number;
  /** Maximum dependencies per element (default: 10, max: 50) */
  maxDependencies?: number;
  /** Maximum length of activation condition (default: 200, max: 1000) */
  maxConditionLength?: number;
}

/**
 * Ensemble-specific metadata extending base element metadata
 *
 * Uses camelCase convention (matching Agent/Memory elements)
 */
export interface EnsembleMetadata extends IElementMetadata {
  type?: ElementType.ENSEMBLE;                    // Type constraint for type safety
  activationStrategy: ActivationStrategy;          // How to activate elements
  conflictResolution: ConflictResolutionStrategy;  // How to resolve conflicts
  contextSharing?: 'none' | 'selective' | 'full';  // Context sharing mode
  resourceLimits?: ResourceLimits;                 // Resource constraints
  allowNested?: boolean;                           // Allow nested ensembles
  maxNestingDepth?: number;                        // Maximum nesting depth
  elements: EnsembleElement[];                     // Array of element references
}

/**
 * Element reference within an ensemble
 * Describes an element that is part of the ensemble
 *
 * NAMING CONVENTION: Uses element_name/element_type for consistency with MCP-AQL API.
 * YAML files accept both snake_case (element_name) and legacy names (name) for backwards compatibility.
 */
export interface EnsembleElement {
  element_name: string;            // Element name (not filename) - consistent with MCP-AQL API
  element_type: string;            // Element type (persona, skill, template, agent, memory, ensemble)
  role: ElementRole;               // Role within ensemble
  priority: number;                // Priority (higher = more important)
  activation: ActivationMode;      // When to activate this element
  condition?: string;              // Activation condition (for conditional mode)
  dependencies?: string[];         // Other element names this depends on
  purpose?: string;                // Description of this element's purpose
}

/**
 * Input format for ensemble element edits via edit_element.
 *
 * Issue #662: Unified collection editing — each item declares its intent:
 * - Existing element with updates → merge properties (incoming wins)
 * - New element → appended
 * - Element with `_remove: true` → dropped from collection
 * - Unlisted elements → preserved unchanged
 *
 * Accepts both `element_name`/`element_type` and shorthand `name`/`type`.
 */
export interface EnsembleElementInput {
  element_name?: string;           // Element name (preferred)
  name?: string;                   // Shorthand alias for element_name
  element_type?: string;           // Element type (preferred)
  type?: string;                   // Shorthand alias for element_type
  role?: ElementRole;
  priority?: number;
  activation?: ActivationMode;
  condition?: string;
  dependencies?: string[];
  purpose?: string;
  _remove?: boolean;               // Issue #662: mark for removal from collection
  [key: string]: unknown;          // Allow additional properties for forward compat
}

/**
 * Result of activating a single element
 */
export interface ElementActivationResult {
  elementName: string;             // Name of the element
  success: boolean;                // Whether activation succeeded
  duration: number;                // Time taken in milliseconds
  error?: Error;                   // Error if activation failed
  context?: Record<string, unknown>;   // Context provided by element
  isNestedEnsemble?: boolean;      // Whether this element is a nested ensemble
  nestingDepth?: number;           // Depth of nesting (0 = top level)
}

/**
 * Activation metrics for performance monitoring
 */
export interface EnsembleActivationMetrics {
  totalActivations: number;        // Total number of activations performed
  successfulActivations: number;   // Number of successful activations
  failedActivations: number;       // Number of failed activations
  averageDuration: number;         // Average activation time in ms
  minDuration: number;             // Fastest activation time
  maxDuration: number;             // Slowest activation time
  nestedEnsembleCount: number;     // Number of nested ensembles activated
  maxNestingDepth: number;         // Deepest nesting level encountered
  lastActivation?: Date;           // Timestamp of last activation
}

/**
 * Shared context that elements can read/write
 * Managed by the ensemble for inter-element communication
 */
export interface SharedContext {
  values: Map<string, unknown>;    // Context values
  owners: Map<string, string>;     // Element name that set each value
  timestamps: Map<string, Date>;   // When each value was set
}

/**
 * Conflict detected during context updates
 */
export interface ContextConflict {
  key: string;                     // Context key that conflicted
  currentValue: unknown;           // Current value
  currentOwner: string;            // Element that set current value
  newValue: unknown;               // New value being set
  newOwner: string;                // Element trying to set new value
  resolution?: unknown;            // Resolved value (if merge strategy used)
  resolvedBy: ConflictResolutionStrategy;  // Strategy used to resolve
}

/**
 * Result of ensemble activation
 */
export interface EnsembleActivationResult {
  success: boolean;                       // Overall success
  activatedElements: string[];            // Names of successfully activated elements
  failedElements: string[];               // Names of elements that failed
  conflicts: ContextConflict[];           // Context conflicts encountered
  totalDuration: number;                  // Total time in milliseconds
  elementResults: ElementActivationResult[];  // Individual element results
}

/**
 * Circular dependency information
 * Used when circular dependencies are detected in element dependencies
 */
export interface CircularDependency {
  path: string[];                  // Element names forming the cycle
  message: string;                 // Human-readable description
}

/**
 * Managers needed to load and activate elements
 * Uses proper IElementManager interface for type safety
 */
export interface ElementManagers {
  skillManager?: import('../../types/elements/IElementManager.js').IElementManager<IElement>;
  templateManager?: import('../../types/elements/IElementManager.js').IElementManager<IElement>;
  agentManager?: import('../../types/elements/IElementManager.js').IElementManager<IElement>;
  memoryManager?: import('../../types/elements/IElementManager.js').IElementManager<IElement>;
  personaManager?: any;    // PersonaManager has different interface (findPersona method)
  ensembleManager?: import('../../types/elements/IElementManager.js').IElementManager<IElement>;
}

/**
 * Type-safe context for condition evaluation
 *
 * This interface defines all values accessible to conditional expressions.
 * It ensures type safety and prevents accidental exposure of sensitive data.
 *
 * SECURITY CONSIDERATIONS:
 * - Only exposes safe, read-only element metadata
 * - Prevents access to element instances or methods
 * - Context values are type-checked but treated as unknown for safety
 * - No access to internal ensemble state beyond what's documented
 *
 * USAGE IN CONDITIONS:
 * Conditions can reference these properties using dot notation:
 *
 * @example
 * ```typescript
 * // Element properties
 * "priority >= 80"
 * "role == 'primary'"
 * "dependencies.length > 0"
 *
 * // Shared context
 * "context.environment == 'production'"
 * "context.security_review == true"
 *
 * // Activation state
 * "activatedCount > 5"
 * "failedCount == 0"
 *
 * // Element metadata
 * "element.element_name == 'critical-handler'"
 * "element.element_type == 'skill'"
 * ```
 *
 * @see {@link buildConditionContext} for context construction
 * @see docs/guides/ensembles.md#conditional-activation for examples
 */
export interface ConditionContext {
  /**
   * Current element being evaluated
   * Contains the element configuration from the ensemble
   */
  readonly element: {
    /** Element name (not filename) - consistent with MCP-AQL API */
    readonly element_name: string;
    /** Element type (persona, skill, template, agent, memory) - consistent with MCP-AQL API */
    readonly element_type: string;
    /** Element role in the ensemble */
    readonly role: ElementRole;
    /** Element priority (0-100, higher = more important) */
    readonly priority: number;
    /** Activation mode */
    readonly activation: ActivationMode;
    /** Array of dependency element names */
    readonly dependencies: ReadonlyArray<string>;
    /** Optional purpose description */
    readonly purpose?: string;
  };

  /**
   * Shared context values set by other elements
   *
   * Values are type-checked at runtime but exposed as unknown for safety.
   * Conditions should use type-safe comparisons:
   * - Use == and != for equality
   * - Use typeof checks when needed
   * - Avoid accessing nested properties without validation
   *
   * @example
   * ```typescript
   * // Safe comparisons
   * context.mode == 'debug'
   * context.count > 0
   * context.enabled == true
   * ```
   */
  readonly context: Readonly<Record<string, unknown>>;

  /**
   * Information about the element that set each context value
   *
   * Maps context keys to the element name that set them.
   * Useful for determining data provenance in conditions.
   *
   * @example
   * ```typescript
   * // Check if specific element set a value
   * contextOwners.security_review == 'security-checker'
   * ```
   */
  readonly contextOwners: Readonly<Record<string, string>>;

  /**
   * Activation state of the ensemble
   *
   * Tracks progress through the activation sequence.
   * Useful for conditions that depend on activation order.
   */
  readonly state: {
    /** Number of elements successfully activated so far */
    readonly activatedCount: number;
    /** Number of elements that failed activation */
    readonly failedCount: number;
    /** Names of successfully activated elements */
    readonly activatedElements: ReadonlyArray<string>;
    /** Names of failed elements */
    readonly failedElements: ReadonlyArray<string>;
    /** Total elements in the ensemble */
    readonly totalElements: number;
  };

  /**
   * Environment information (future expansion)
   *
   * Reserved for future use. Will include:
   * - Runtime environment (node, browser)
   * - Execution context (cli, api, test)
   * - System capabilities
   * - User permissions/roles
   *
   * Currently returns empty object.
   */
  readonly environment: Readonly<Record<string, unknown>>;

  /**
   * Resource usage information
   *
   * Provides visibility into resource consumption for conditions
   * that need to gate activation based on resource availability.
   *
   * @example
   * ```typescript
   * // Only activate if under resource limits
   * resources.executionTimeMs < 10000
   * resources.contextSize < 500
   * ```
   */
  readonly resources: {
    /** Milliseconds elapsed since activation started */
    readonly executionTimeMs: number;
    /** Number of keys in shared context */
    readonly contextSize: number;
    /** Number of cached element instances */
    readonly cachedInstances: number;
  };
}

/**
 * Result of building a condition context
 *
 * Includes both the context object and metadata about the build process.
 * Used for debugging and validation.
 */
export interface ConditionContextResult {
  /** The constructed context object */
  context: ConditionContext;
  /** Timestamp when context was built */
  timestamp: Date;
  /** Warnings encountered during context construction */
  warnings?: string[];
}
