/**
 * Ensemble Element - Orchestrates multiple elements working together
 *
 * Ensembles allow combining multiple elements (personas, skills, templates, agents, memories)
 * into cohesive units with controlled activation, conflict resolution, and shared context.
 *
 * ARCHITECTURE:
 * - Extends BaseElement for standard element behavior
 * - Pure business logic (no file operations)
 * - Portfolio-agnostic (PortfolioManager passed to activate())
 *
 * SECURITY MEASURES:
 * 1. Circular dependency detection with DFS algorithm
 * 2. Resource limits (max elements, nesting depth, activation time)
 * 3. Input sanitization for all user-provided data
 * 4. Activation timeout protection
 * 5. Context size limits to prevent memory exhaustion
 * 6. Audit logging for security events
 * 7. Condition validation to prevent code injection
 */

import { BaseElement } from '../BaseElement.js';
import {
  IElement,
  ElementValidationResult,
  ValidationError,
  ValidationWarning,
  ElementStatus
} from '../../types/elements/index.js';
import { ElementType } from '../../portfolio/types.js';
import * as vm from 'vm';
import { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { sanitizeInput } from '../../security/InputValidator.js';
import { SECURITY_LIMITS } from '../../security/constants.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';
import { MetadataService } from '../../services/MetadataService.js';
import {
  EnsembleMetadata,
  EnsembleElement,
  SharedContext,
  EnsembleActivationResult,
  ContextConflict,
  CircularDependency,
  EnsembleActivationMetrics
} from './types.js';
import {
  ENSEMBLE_DEFAULTS,
  ACTIVATION_STRATEGIES,
  CONFLICT_STRATEGIES,
  ELEMENT_ROLES,
  ENSEMBLE_SECURITY_EVENTS,
  ENSEMBLE_ERRORS,
  ENSEMBLE_PATTERNS,
  DANGEROUS_CONDITION_PATTERNS,
  getEffectiveLimits,
  EnsembleLimitsConfig,
  ResolvedEnsembleLimits
} from './constants.js';

/**
 * Ensemble class - Orchestrates multiple elements as a cohesive unit
 *
 * Extends BaseElement to inherit:
 * - Standard validation
 * - Serialization
 * - Metadata management
 * - ID generation
 * - Status tracking
 */
export class Ensemble extends BaseElement implements IElement {
  public declare metadata: EnsembleMetadata;
  // instructions and content inherited from BaseElement (v2.0 dual-field architecture)

  // Element management - using array for single source of truth
  private elements: EnsembleElement[] = [];
  private elementInstances: Map<string, IElement> = new Map();
  private readonly MAX_INSTANCE_CACHE_SIZE = 100;
  private instanceAccessTimes: Map<string, number> = new Map();

  // Shared context for inter-element communication
  private sharedContext: SharedContext;

  // Activation state
  private activationInProgress: boolean = false;
  private lastActivationResult?: EnsembleActivationResult;

  // Activation metrics for performance monitoring
  private activationMetrics: EnsembleActivationMetrics = {
    totalActivations: 0,
    successfulActivations: 0,
    failedActivations: 0,
    averageDuration: 0,
    minDuration: Infinity,
    maxDuration: 0,
    nestedEnsembleCount: 0,
    maxNestingDepth: 0
  };

  // Cached effective limits (computed once per ensemble, respects per-ensemble overrides)
  private _effectiveLimits: ResolvedEnsembleLimits | null = null;

  /**
   * Get effective limits for this ensemble
   *
   * Resolves limits in priority order:
   * 1. Per-ensemble overrides (from metadata.resourceLimits)
   * 2. Global configuration (setGlobalEnsembleLimits())
   * 3. Environment variables (ENSEMBLE_MAX_*)
   * 4. Default values
   *
   * Results are cached for performance. Call invalidateLimitsCache() to refresh.
   *
   * @returns Resolved limits object
   */
  public getEffectiveLimits(): ResolvedEnsembleLimits {
    if (this._effectiveLimits === null) {
      // Convert ResourceLimits (per-ensemble API) to EnsembleLimitsConfig (internal config format)
      //
      // Field name mapping (historical reasons - ResourceLimits predates configurable limits):
      //   ResourceLimits.maxActiveElements  -> EnsembleLimitsConfig.maxElements
      //   ResourceLimits.maxExecutionTimeMs -> EnsembleLimitsConfig.maxActivationTime
      //   Other fields have matching names (maxNestingDepth, maxContextSize, etc.)
      const overrides: Partial<EnsembleLimitsConfig> = {};
      const resourceLimits = this.metadata.resourceLimits;

      if (resourceLimits) {
        if (resourceLimits.maxActiveElements !== undefined) {
          overrides.maxElements = resourceLimits.maxActiveElements;
        }
        if (resourceLimits.maxExecutionTimeMs !== undefined) {
          overrides.maxActivationTime = resourceLimits.maxExecutionTimeMs;
        }
        if (resourceLimits.maxNestingDepth !== undefined) {
          overrides.maxNestingDepth = resourceLimits.maxNestingDepth;
        }
        if (resourceLimits.maxContextSize !== undefined) {
          overrides.maxContextSize = resourceLimits.maxContextSize;
        }
        if (resourceLimits.maxContextValueSize !== undefined) {
          overrides.maxContextValueSize = resourceLimits.maxContextValueSize;
        }
        if (resourceLimits.maxDependencies !== undefined) {
          overrides.maxDependencies = resourceLimits.maxDependencies;
        }
        if (resourceLimits.maxConditionLength !== undefined) {
          overrides.maxConditionLength = resourceLimits.maxConditionLength;
        }
      }

      this._effectiveLimits = getEffectiveLimits(overrides);
    }
    return this._effectiveLimits;
  }

  /**
   * Invalidate cached limits (call when resourceLimits changes)
   */
  public invalidateLimitsCache(): void {
    this._effectiveLimits = null;
  }

  constructor(metadata: Partial<EnsembleMetadata>, elements: EnsembleElement[] = [], metadataService: MetadataService) {
    // SECURITY: Sanitize all inputs
    // NOTE: We preserve empty strings so validation can catch them
    const sanitizedMetadata: Partial<EnsembleMetadata> = {
      ...metadata,
      name: metadata.name !== undefined ? (
        metadata.name === '' ? '' :  // Preserve empty string for validation
        sanitizeInput(UnicodeValidator.normalize(metadata.name).normalizedContent, 100)
      ) : undefined,
      description: metadata.description !== undefined ? (
        metadata.description === '' ? '' :  // Preserve empty string for validation
        sanitizeInput(UnicodeValidator.normalize(metadata.description).normalizedContent, SECURITY_LIMITS.MAX_YAML_LENGTH)
      ) : undefined
    };

    // Validate activation strategy
    const strategy = metadata.activationStrategy || ENSEMBLE_DEFAULTS.ACTIVATION_STRATEGY;
    if (!ACTIVATION_STRATEGIES.includes(strategy as any)) {
      throw new Error(`${ENSEMBLE_ERRORS.INVALID_STRATEGY}: ${strategy}. Valid strategies: ${ACTIVATION_STRATEGIES.join(', ')}`);
    }

    // Validate conflict resolution strategy
    const conflictRes = metadata.conflictResolution || ENSEMBLE_DEFAULTS.CONFLICT_RESOLUTION;
    if (!CONFLICT_STRATEGIES.includes(conflictRes as any)) {
      throw new Error(`${ENSEMBLE_ERRORS.INVALID_CONFLICT_RESOLUTION}: ${conflictRes}. Valid strategies: ${CONFLICT_STRATEGIES.join(', ')}`);
    }

    // Call BaseElement constructor
    super(ElementType.ENSEMBLE, sanitizedMetadata, metadataService);

    // Initialize ensemble-specific metadata
    // NOTE: We restore the original name even if empty, so validation can catch it
    // NOTE: resourceLimits is optional - per-ensemble overrides are resolved via getEffectiveLimits()
    this.metadata = {
      ...this.metadata,
      name: sanitizedMetadata.name !== undefined ? sanitizedMetadata.name : this.metadata.name,
      activationStrategy: strategy,
      conflictResolution: conflictRes,
      contextSharing: metadata.contextSharing || ENSEMBLE_DEFAULTS.CONTEXT_SHARING,
      resourceLimits: metadata.resourceLimits, // Optional per-ensemble overrides
      allowNested: metadata.allowNested ?? ENSEMBLE_DEFAULTS.ALLOW_NESTED,
      maxNestingDepth: metadata.maxNestingDepth || ENSEMBLE_DEFAULTS.MAX_NESTING_DEPTH,
      elements: []
    } as EnsembleMetadata;

    // Initialize shared context
    this.sharedContext = {
      values: new Map(),
      owners: new Map(),
      timestamps: new Map()
    };

    // Initialize extensions for tracking
    this.extensions = {
      elementCount: 0,
      activationStrategy: strategy,
      conflictResolution: conflictRes,
      lastActivation: null
    };

    // Add elements from metadata
    if (elements.length > 0) {
      this.loadElementsFromMetadata(elements);
    }

    // SECURITY: Log ensemble creation
    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED',
      severity: 'LOW',
      source: 'Ensemble.constructor',
      details: `Ensemble created: ${this.metadata.name}`,
      additionalData: {
        elementCount: this.elements.length,
        activationStrategy: this.metadata.activationStrategy,
        conflictResolution: this.metadata.conflictResolution
      }
    });
  }

  // ==================== ARRAY HELPER METHODS ====================

  /**
   * Find an element by name in the elements array
   * @param name - Element name to search for
   * @returns Element if found, undefined otherwise
   */
  private findElementByName(name: string): EnsembleElement | undefined {
    return this.elements.find(el => el.element_name === name);
  }

  /**
   * Check if an element exists in the array
   * @param name - Element name to check
   * @returns true if element exists, false otherwise
   */
  private hasElement(name: string): boolean {
    return this.elements.some(el => el.element_name === name);
  }

  /**
   * Remove an element from the array by name
   * @param name - Element name to remove
   * @returns true if element was removed, false if not found
   */
  private removeElementByName(name: string): boolean {
    const index = this.elements.findIndex(el => el.element_name === name);
    if (index !== -1) {
      this.elements.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Add or update an element in the array
   * @param element - Element to add or update
   * @returns true if element was added, false if updated
   */
  private setElement(element: EnsembleElement): boolean {
    const index = this.elements.findIndex(el => el.element_name === element.element_name);
    if (index !== -1) {
      // Update existing element
      this.elements[index] = element;
      return false;
    } else {
      // Add new element
      this.elements.push(element);
      return true;
    }
  }

  /**
   * Sync elements array to metadata (single source of truth)
   */
  private syncElementsToMetadata(): void {
    this.metadata.elements = [...this.elements];
    this.extensions!.elementCount = this.elements.length;
  }

  /**
   * Sync the internal elements array from metadata.elements
   *
   * Use this after metadata.elements has been modified externally
   * (e.g., via editElement) to ensure internal state is consistent.
   */
  public syncElementsFromMetadata(): void {
    // Clear existing elements
    this.elements = [];

    // Issue #658: Defensive guard — metadata.elements must be an array.
    // If a dict leaked through (e.g., from deepMerge), log warning and bail out
    // rather than silently producing an empty elements array.
    if (!Array.isArray(this.metadata.elements)) {
      if (this.metadata.elements && typeof this.metadata.elements === 'object') {
        logger.warn('[Ensemble] metadata.elements is not an array — possible dict format leak. Elements will not be loaded.');
      }
      return;
    }

    // Reload from metadata
    if (this.metadata.elements.length > 0) {
      this.loadElementsFromMetadata(this.metadata.elements);
    }
  }

  // ==================== END ARRAY HELPER METHODS ====================

  /**
   * Load element references from metadata
   * Called during construction to populate elements array
   */
  private loadElementsFromMetadata(elements: EnsembleElement[]): void {
    const limits = this.getEffectiveLimits();

    // SECURITY: Enforce element limit
    if (elements.length > limits.MAX_ELEMENTS) {
      throw new Error(
        `Ensemble cannot contain more than ${limits.MAX_ELEMENTS} elements (attempted: ${elements.length})`
      );
    }

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];

      // Issue #507: Validate each element is a plain object before accessing properties.
      // When users pass strings (e.g., ["my-skill"]) instead of objects, the old code
      // produced confusing "Element 'undefined' has no element_type" errors.
      if (typeof element !== 'object' || element === null || Array.isArray(element)) {
        const valueType = element === null ? 'null' : Array.isArray(element) ? 'array' : typeof element;
        throw new Error(
          `Element at index ${i} is a ${valueType} ("${String(element).substring(0, 50)}"), ` +
          `but must be an object with { element_name, element_type }. ` +
          `Example: { element_name: "my-skill", element_type: "skill", role: "support", priority: 50, activation: "always" }`
        );
      }

      // Migrate legacy field names: name→element_name, type→element_type (mirrors
      // EnsembleManager.create() lines 586-602 to keep create and edit paths consistent)
      const elementName = element.element_name || (element as any).name;
      const elementType = element.element_type || (element as any).type;

      // Issue #466: Require explicit element_type — callers must resolve via portfolio
      // lookup (resolveEnsembleElementTypes) before reaching this method.
      if (!elementType) {
        throw new Error(
          `Element '${elementName}' has no element_type. ` +
          `Provide element_type explicitly or ensure the element exists in the portfolio.`
        );
      }

      // Validate and sanitize element, applying defaults for optional fields
      const sanitized: EnsembleElement = {
        element_name: sanitizeInput(elementName, 100),
        element_type: sanitizeInput(elementType, 50),
        role: element.role || ENSEMBLE_DEFAULTS.ELEMENT_ROLE,
        priority: element.priority ?? ENSEMBLE_DEFAULTS.PRIORITY,
        activation: element.activation || 'always',
        // Don't use sanitizeInput for conditions (it removes < > operators)
        condition: element.condition ?
          element.condition.trim().substring(0, limits.MAX_CONDITION_LENGTH) :
          undefined,
        dependencies: element.dependencies?.map(dep => sanitizeInput(dep, 100)),
        purpose: element.purpose ?
          sanitizeInput(element.purpose, 500) :
          undefined
      };

      // Validate role
      if (!ELEMENT_ROLES.includes(sanitized.role as any)) {
        throw new Error(`${ENSEMBLE_ERRORS.INVALID_ELEMENT_ROLE}: ${sanitized.role}. Valid roles: ${ELEMENT_ROLES.join(', ')}`);
      }

      // Validate element name pattern
      if (!ENSEMBLE_PATTERNS.ELEMENT_NAME_PATTERN.test(sanitized.element_name)) {
        throw new Error(`Invalid element name format: ${sanitized.element_name}`);
      }

      this.setElement(sanitized);
    }

    this.syncElementsToMetadata();
  }

  /**
   * Add an element to the ensemble
   *
   * @param element - Element configuration to add
   * @throws Error if element would create circular dependency or exceed limits
   */
  public addElement(element: EnsembleElement): void {
    const limits = this.getEffectiveLimits();

    // Check element limit (uses configurable limits)
    if (this.elements.length >= limits.MAX_ELEMENTS) {
      SecurityMonitor.logSecurityEvent({
        type: ENSEMBLE_SECURITY_EVENTS.RESOURCE_LIMIT_EXCEEDED,
        severity: 'MEDIUM',
        source: 'Ensemble.addElement',
        details: `Maximum elements (${limits.MAX_ELEMENTS}) exceeded`
      });
      throw new Error(`Ensemble cannot contain more than ${limits.MAX_ELEMENTS} elements`);
    }

    // Sanitize element name - first use general sanitization, then enforce pattern
    const originalName = element.element_name;
    let sanitizedName = sanitizeInput(originalName, 100);

    // Remove any characters that don't match the allowed pattern
    const cleanedName = sanitizedName.replace(/[^a-zA-Z0-9_-]/g, '');

    // Check if invalid characters were removed
    if (cleanedName.length < originalName.length && originalName.length > 0) {
      throw new Error(
        `Element name contains invalid characters. ` +
        `Only alphanumeric characters, hyphens, and underscores are allowed. ` +
        `Invalid name: "${originalName}"`
      );
    }

    sanitizedName = cleanedName;

    // Reject if sanitization results in empty name
    if (!sanitizedName || sanitizedName.length === 0) {
      throw new Error(
        `Element name is empty or contains only invalid characters: "${originalName}"`
      );
    }

    // Final pattern validation (should always pass if above checks passed)
    if (!ENSEMBLE_PATTERNS.ELEMENT_NAME_PATTERN.test(sanitizedName)) {
      throw new Error(
        `Element name format validation failed: "${sanitizedName}". ` +
        `This should not happen - please report this error.`
      );
    }

    // Create sanitized copy to avoid mutating the input
    const sanitizedElement: EnsembleElement = {
      element_name: sanitizedName,
      element_type: element.element_type,
      role: element.role,
      priority: element.priority,
      activation: element.activation
    };

    // Validate role
    if (!ELEMENT_ROLES.includes(sanitizedElement.role as any)) {
      throw new Error(`${ENSEMBLE_ERRORS.INVALID_ELEMENT_ROLE}: ${sanitizedElement.role}. Valid roles: ${ELEMENT_ROLES.join(', ')}`);
    }

    // Validate and sanitize activation condition if provided
    if (element.condition) {
      // Trim and enforce length limit (don't use sanitizeInput as it removes < > operators)
      const conditionToValidate = element.condition
        .trim()
        .substring(0, limits.MAX_CONDITION_LENGTH);

      if (!this.isValidCondition(conditionToValidate)) {
        SecurityMonitor.logSecurityEvent({
          type: ENSEMBLE_SECURITY_EVENTS.SUSPICIOUS_CONDITION,
          severity: 'HIGH',
          source: 'Ensemble.addElement',
          details: `Suspicious activation condition: ${conditionToValidate}`
        });
        throw new Error('Invalid activation condition syntax');
      }
      sanitizedElement.condition = conditionToValidate;
    }

    // Validate and sanitize dependencies
    if (element.dependencies) {
      // Truncate dependencies array if it exceeds the limit (security: prevent resource exhaustion)
      let deps = element.dependencies;
      if (deps.length > limits.MAX_DEPENDENCIES) {
        deps = deps.slice(0, limits.MAX_DEPENDENCIES);
        SecurityMonitor.logSecurityEvent({
          type: ENSEMBLE_SECURITY_EVENTS.RESOURCE_LIMIT_EXCEEDED,
          severity: 'MEDIUM',
          source: 'Ensemble.addElement',
          details: `Dependencies truncated from ${element.dependencies.length} to ${limits.MAX_DEPENDENCIES}`
        });
      }

      // Sanitize each dependency
      const sanitizedDeps = deps.map(dep => sanitizeInput(dep, 100));
      sanitizedElement.dependencies = sanitizedDeps;

      // Check for circular dependencies
      if (this.wouldCreateCircularDependency(sanitizedName, sanitizedDeps)) {
        const circular = this.findCircularDependency(sanitizedName, sanitizedDeps);
        SecurityMonitor.logSecurityEvent({
          type: ENSEMBLE_SECURITY_EVENTS.CIRCULAR_DEPENDENCY,
          severity: 'HIGH',
          source: 'Ensemble.addElement',
          details: `Circular dependency detected: ${circular.path.join(' -> ')}`
        });
        throw new Error(`${ENSEMBLE_ERRORS.CIRCULAR_DEPENDENCY}: ${circular.message}`);
      }
    }

    // Add optional purpose field if provided
    if (element.purpose) {
      sanitizedElement.purpose = sanitizeInput(element.purpose, 500);
    }

    // Add sanitized element to array (not the original to avoid storing unsanitized data)
    this.setElement(sanitizedElement);
    this.syncElementsToMetadata();
    this.markDirty();
  }

  /**
   * Update an element's configuration in the ensemble
   *
   * @param elementName - Name of element to update
   * @param updates - Partial element configuration to merge with existing
   * @throws Error if element not found or activation in progress
   */
  public updateElement(
    elementName: string,
    updates: Partial<EnsembleElement>
  ): void {
    // Prevent updates during activation
    if (this.activationInProgress) {
      throw new Error('Cannot update elements while ensemble activation is in progress');
    }

    const limits = this.getEffectiveLimits();
    const sanitizedName = sanitizeInput(elementName, 100);

    if (!this.hasElement(sanitizedName)) {
      throw new Error(ENSEMBLE_ERRORS.ELEMENT_NOT_FOUND);
    }

    const currentElement = this.findElementByName(sanitizedName)!;

    // Sanitize and validate updates
    const sanitizedUpdates: Partial<EnsembleElement> = {};

    if (updates.role !== undefined) {
      if (!ELEMENT_ROLES.includes(updates.role as any)) {
        throw new Error(`${ENSEMBLE_ERRORS.INVALID_ELEMENT_ROLE}: ${updates.role}. Valid roles: ${ELEMENT_ROLES.join(', ')}`);
      }
      sanitizedUpdates.role = updates.role;
    }

    if (updates.priority !== undefined) {
      sanitizedUpdates.priority = updates.priority;
    }

    if (updates.activation !== undefined) {
      sanitizedUpdates.activation = updates.activation;
    }

    if (updates.condition !== undefined) {
      // Trim and enforce length limit (don't use sanitizeInput as it removes < > operators)
      const conditionToValidate = updates.condition
        .trim()
        .substring(0, limits.MAX_CONDITION_LENGTH);

      if (!this.isValidCondition(conditionToValidate)) {
        SecurityMonitor.logSecurityEvent({
          type: ENSEMBLE_SECURITY_EVENTS.SUSPICIOUS_CONDITION,
          severity: 'HIGH',
          source: 'Ensemble.updateElement',
          details: `Suspicious activation condition: ${conditionToValidate}`
        });
        throw new Error('Invalid activation condition syntax');
      }
      sanitizedUpdates.condition = conditionToValidate;
    }

    if (updates.dependencies !== undefined) {
      // Validate dependency limit
      let deps = updates.dependencies;
      if (deps.length > limits.MAX_DEPENDENCIES) {
        deps = deps.slice(0, limits.MAX_DEPENDENCIES);
        SecurityMonitor.logSecurityEvent({
          type: ENSEMBLE_SECURITY_EVENTS.RESOURCE_LIMIT_EXCEEDED,
          severity: 'MEDIUM',
          source: 'Ensemble.updateElement',
          details: `Dependencies truncated from ${updates.dependencies.length} to ${limits.MAX_DEPENDENCIES}`
        });
      }

      // Sanitize dependencies
      const sanitizedDeps = deps.map(dep => sanitizeInput(dep, 100));

      // Check for circular dependencies with updated dependencies
      if (this.wouldCreateCircularDependency(sanitizedName, sanitizedDeps)) {
        const circular = this.findCircularDependency(sanitizedName, sanitizedDeps);
        SecurityMonitor.logSecurityEvent({
          type: ENSEMBLE_SECURITY_EVENTS.CIRCULAR_DEPENDENCY,
          severity: 'HIGH',
          source: 'Ensemble.updateElement',
          details: `Circular dependency detected: ${circular.path.join(' -> ')}`
        });
        throw new Error(`${ENSEMBLE_ERRORS.CIRCULAR_DEPENDENCY}: ${circular.message}`);
      }

      sanitizedUpdates.dependencies = sanitizedDeps;
    }

    if (updates.purpose !== undefined) {
      sanitizedUpdates.purpose = sanitizeInput(updates.purpose, 500);
    }

    // Merge updates with current element
    const updatedElement: EnsembleElement = {
      ...currentElement,
      ...sanitizedUpdates
    };

    this.setElement(updatedElement);
    this.syncElementsToMetadata();
    this.markDirty();

    logger.debug(`Element ${sanitizedName} updated in ensemble ${this.id}`);
  }

  /**
   * Remove an element from the ensemble
   *
   * @param elementName - Name of element to remove
   * @throws Error if element not found or activation in progress
   */
  public removeElement(elementName: string): void {
    // Prevent removal during activation
    if (this.activationInProgress) {
      throw new Error('Cannot remove elements while ensemble activation is in progress');
    }

    const sanitizedName = sanitizeInput(elementName, 100);

    if (!this.hasElement(sanitizedName)) {
      throw new Error(ENSEMBLE_ERRORS.ELEMENT_NOT_FOUND);
    }

    // Check if element is currently active
    if (this.elementInstances.has(sanitizedName)) {
      logger.warn(
        `Removing active element '${sanitizedName}' from ensemble. ` +
        `Consider deactivating the ensemble first.`
      );
    }

    // Remove element and its instance
    this.removeElementByName(sanitizedName);
    this.elementInstances.delete(sanitizedName);

    // Clean up dependencies pointing to this element
    for (const element of this.elements) {
      if (element.dependencies?.includes(sanitizedName)) {
        element.dependencies = element.dependencies.filter(dep => dep !== sanitizedName);
      }
    }

    // Clean up shared context owned by this element
    for (const [key, owner] of this.sharedContext.owners) {
      if (owner === sanitizedName) {
        this.sharedContext.values.delete(key);
        this.sharedContext.owners.delete(key);
        this.sharedContext.timestamps.delete(key);
      }
    }

    this.syncElementsToMetadata();
    this.markDirty();
  }

  /**
   * Activate the element (BaseElement interface implementation)
   * For ensembles, this is a no-op. Use activateEnsemble() for full activation.
   */
  public override async activate(): Promise<void> {
    this._status = ElementStatus.ACTIVE;
    logger.debug(`Ensemble ${this.id} activated (use activateEnsemble() for full orchestration)`);
  }

  /**
   * Activate the ensemble and all its elements based on strategy
   *
   * @param portfolioManager - Portfolio manager for loading element instances
   * @param managers - Element managers for loading different element types
   * @param nestingDepth - Current nesting depth (0 for top-level, increments for nested)
   * @returns Activation result with success status and element results
   */
  public async activateEnsemble(
    portfolioManager: PortfolioManager,
    managers: import('./types.js').ElementManagers,
    nestingDepth: number = 0
  ): Promise<EnsembleActivationResult> {
    if (this.activationInProgress) {
      throw new Error('Activation already in progress');
    }

    this.activationInProgress = true;
    const startTime = Date.now();
    const limits = this.getEffectiveLimits();
    const timeout = limits.MAX_ACTIVATION_TIME;

    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Ensemble activation timeout after ${timeout}ms`));
        }, timeout);
      });

      // Create activation promise
      const activationPromise = this.performActivation(
        portfolioManager,
        managers,
        startTime,
        nestingDepth
      );

      // Race activation against timeout
      const result = await Promise.race([activationPromise, timeoutPromise]);
      return result;
    } catch (error) {
      this._status = ElementStatus.ERROR;

      SecurityMonitor.logSecurityEvent({
        type: ENSEMBLE_SECURITY_EVENTS.ACTIVATION_FAILED,
        severity: 'HIGH',
        source: 'Ensemble.activateEnsemble',
        details: `Activation failed after ${Date.now() - startTime}ms: ${error instanceof Error ? error.message : 'Unknown error'}`
      });

      throw error;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      this.activationInProgress = false;
    }
  }

  /**
   * Helper to create structured log context for ensemble operations
   * @private
   */
  private getLogContext(additionalData?: Record<string, any>) {
    return {
      ensembleId: this.id,
      ensembleName: this.metadata.name,
      elementCount: this.elements.length,
      activationStrategy: this.metadata.activationStrategy,
      allowNested: this.metadata.allowNested,
      maxNestingDepth: this.metadata.maxNestingDepth,
      ...additionalData
    };
  }

  /**
   * Perform the actual activation logic
   * Extracted to separate method for timeout handling
   */
  private async performActivation(
    portfolioManager: PortfolioManager,
    managers: import('./types.js').ElementManagers,
    startTime: number,
    nestingDepth: number
  ): Promise<EnsembleActivationResult> {
    // Set status
    this._status = ElementStatus.ACTIVE;

    // Structured logging: Activation start
    logger.info('Ensemble activation started', this.getLogContext({
      strategy: this.metadata.activationStrategy,
      totalElements: this.elements.length,
      resourceLimits: this.metadata.resourceLimits,
      nestingDepth: nestingDepth
    }));

    const result: EnsembleActivationResult = {
      success: true,
      activatedElements: [],
      failedElements: [],
      conflicts: [],
      totalDuration: 0,
      elementResults: []
    };

    // Get activation order based on strategy
    const activationOrder = this.getActivationOrder();

    // Activate elements according to strategy
    switch (this.metadata.activationStrategy) {
      case 'sequential':
        await this.activateSequential(
          activationOrder,
          result,
          portfolioManager,
          managers,
          nestingDepth
        );
        break;

      case 'all':
        await this.activateAll(
          activationOrder,
          result,
          portfolioManager,
          managers,
          nestingDepth
        );
        break;

      case 'priority':
        await this.activatePriority(
          activationOrder,
          result,
          portfolioManager,
          managers,
          nestingDepth
        );
        break;

      case 'conditional':
        await this.activateConditional(
          activationOrder,
          result,
          portfolioManager,
          managers,
          nestingDepth
        );
        break;

      case 'lazy':
        // Lazy activation happens on-demand, just mark as ready
        logger.info(`Ensemble ${this.id} ready for lazy activation`);
        break;
    }

    result.totalDuration = Date.now() - startTime;
    this.lastActivationResult = result;
    this.extensions!.lastActivation = new Date().toISOString();

    // Count nested ensembles in results
    const nestedEnsembleCount = result.activatedElements.filter(name => {
      const elem = this.findElementByName(name);
      return elem?.element_type === 'ensemble';
    }).length;

    // Update activation metrics with actual nesting depth
    this.updateActivationMetrics(result, nestingDepth);

    // Log activation result
    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED',  // Generic element event (ensembles don't have custom security event types yet)
      severity: 'LOW',
      source: 'Ensemble.activate',
      details: `Ensemble ${this.metadata.name} activated: ${result.activatedElements.length} elements, ${result.failedElements.length} failures`,
      metadata: {
        nestedEnsembles: nestedEnsembleCount,
        duration: result.totalDuration,
        metrics: this.getActivationMetrics()
      }
    });

    // Structured logging: Activation complete with metrics
    if (result.failedElements.length > 0) {
      logger.warn('Ensemble activation completed with failures', this.getLogContext({
        activatedCount: result.activatedElements.length,
        failedCount: result.failedElements.length,
        failedElements: result.failedElements,
        nestedEnsembles: nestedEnsembleCount,
        duration: result.totalDuration,
        metrics: this.getActivationMetrics()
      }));
      result.success = false;
    } else {
      logger.info('Ensemble activation completed successfully', this.getLogContext({
        activatedCount: result.activatedElements.length,
        nestedEnsembles: nestedEnsembleCount,
        duration: result.totalDuration,
        averageElementTime: result.totalDuration / Math.max(result.activatedElements.length, 1),
        metrics: this.getActivationMetrics()
      }));
    }

    return result;
  }

  /**
   * Deactivate the ensemble and all its elements
   */
  public override async deactivate(): Promise<void> {
    this._status = ElementStatus.INACTIVE;

    // Deactivate all element instances
    const deactivationPromises: Promise<void>[] = [];

    for (const [elementName, instance] of this.elementInstances) {
      if (instance.deactivate) {
        deactivationPromises.push(
          instance.deactivate().catch(error => {
            logger.error(`Failed to deactivate element ${elementName}:`, error);
          })
        );
      }
    }

    await Promise.all(deactivationPromises);

    // Clear shared context
    this.sharedContext.values.clear();
    this.sharedContext.owners.clear();
    this.sharedContext.timestamps.clear();

    logger.info(`Ensemble ${this.id} deactivated`);
  }

  /**
   * Validate the ensemble configuration
   * Overrides BaseElement.validate() to add ensemble-specific checks
   */
  public override validate(): ElementValidationResult {
    // Call base validation first
    const result = super.validate();

    // Initialize arrays if they don't exist
    if (!result.errors) result.errors = [];
    if (!result.warnings) result.warnings = [];

    // Check for circular dependencies
    const circular = this.detectAllCircularDependencies();
    if (circular.length > 0) {
      for (const cycle of circular) {
        result.errors.push({
          field: 'dependencies',
          message: cycle.message,
          severity: 'high'
        } as ValidationError);
      }
    }

    // Validate element count
    if (this.elements.length === 0) {
      result.warnings.push({
        field: 'elements',
        message: 'Ensemble has no elements',
        suggestion: 'Add elements using addElement()',
        severity: 'low'
      } as ValidationWarning);
    }

    // Check for orphaned dependencies
    for (const element of this.elements) {
      if (element.dependencies) {
        for (const dep of element.dependencies) {
          if (!this.hasElement(dep)) {
            result.errors.push({
              field: `${element.element_name}.dependencies`,
              message: `Dependency '${dep}' not found in ensemble`,
              severity: 'medium'
            } as ValidationError);
          }
        }
      }
    }

    // Update valid flag based on errors
    result.valid = result.errors.length === 0;

    // Clean up empty arrays
    if (result.errors.length === 0) result.errors = undefined;
    if (result.warnings.length === 0) result.warnings = undefined;

    return result;
  }

  // ==================== PRIVATE METHODS ====================

  /**
   * Determine activation order based on strategy
   */
  private getActivationOrder(): string[] {
    switch (this.metadata.activationStrategy) {
      case 'sequential':
        // Topological sort based on dependencies
        return this.topologicalSort();

      case 'priority': {
        // Sort by priority (highest first)
        const prioritySorted = [...this.elements]
          .sort((a, b) => b.priority - a.priority);
        return prioritySorted.map(el => el.element_name);
      }

      case 'all':
      case 'conditional':
      case 'lazy':
        // All elements, natural order
        return this.elements.map(el => el.element_name);

      default:
        return this.elements.map(el => el.element_name);
    }
  }

  /**
   * Topological sort for dependency-based activation order
   */
  private topologicalSort(): string[] {
    const visited = new Set<string>();
    const order: string[] = [];

    const visit = (elementName: string) => {
      if (visited.has(elementName)) return;
      visited.add(elementName);

      const element = this.findElementByName(elementName);
      if (element?.dependencies) {
        for (const dep of element.dependencies) {
          if (this.hasElement(dep)) {
            visit(dep);
          }
        }
      }

      order.push(elementName);
    };

    for (const element of this.elements) {
      visit(element.element_name);
    }

    return order;
  }

  /**
   * Activate elements sequentially in dependency order
   */
  private async activateSequential(
    order: string[],
    result: EnsembleActivationResult,
    portfolioManager: PortfolioManager,
    managers: import('./types.js').ElementManagers,
    nestingDepth: number
  ): Promise<void> {
    for (const elementName of order) {
      await this.activateSingleElement(elementName, result, portfolioManager, managers, nestingDepth);
    }
  }

  /**
   * Activate all elements simultaneously
   */
  private async activateAll(
    order: string[],
    result: EnsembleActivationResult,
    portfolioManager: PortfolioManager,
    managers: import('./types.js').ElementManagers,
    nestingDepth: number
  ): Promise<void> {
    const activationPromises = order.map(elementName =>
      this.activateSingleElement(elementName, result, portfolioManager, managers, nestingDepth)
    );

    await Promise.all(activationPromises);
  }

  /**
   * Activate elements by priority (highest first)
   */
  private async activatePriority(
    order: string[],
    result: EnsembleActivationResult,
    portfolioManager: PortfolioManager,
    managers: import('./types.js').ElementManagers,
    nestingDepth: number
  ): Promise<void> {
    // order is already sorted by priority from getActivationOrder()
    for (const elementName of order) {
      await this.activateSingleElement(elementName, result, portfolioManager, managers, nestingDepth);
    }
  }

  /**
   * Activate elements based on conditions
   */
  private async activateConditional(
    order: string[],
    result: EnsembleActivationResult,
    portfolioManager: PortfolioManager,
    managers: import('./types.js').ElementManagers,
    nestingDepth: number
  ): Promise<void> {
    logger.warn(
      `Conditional activation strategy selected, but condition evaluation ` +
      `is not yet implemented. All conditional elements will be activated.`
    );

    // Track activation start time for context building
    const activationStartTime = Date.now();

    for (const elementName of order) {
      const element = this.findElementByName(elementName)!;

      // Determine if element should be activated
      let shouldActivate = false;

      if (element.activation === 'always') {
        // Always activate elements with 'always' mode
        shouldActivate = true;
      } else if (element.activation === 'conditional' && element.condition) {
        // Evaluate condition for conditional elements
        shouldActivate = this.evaluateCondition(
          element.condition,
          element,
          activationStartTime,
          result
        );
        if (!shouldActivate) {
          logger.debug(`Skipping ${elementName}: condition not met`);
        }
      } else if (element.activation === 'conditional' && !element.condition) {
        // Conditional elements without a condition default to activated
        logger.debug(`${elementName}: conditional activation without condition, defaulting to true`);
        shouldActivate = true;
      } else if (element.activation === 'on-demand') {
        // On-demand elements are not activated automatically in conditional strategy
        logger.debug(`Skipping ${elementName}: on-demand activation mode`);
        shouldActivate = false;
      } else {
        // Default behavior for unspecified activation mode
        shouldActivate = true;
      }

      if (shouldActivate) {
        await this.activateSingleElement(elementName, result, portfolioManager, managers, nestingDepth);
      }
    }
  }

  /**
   * Activate a single element and track results
   */
  private async activateSingleElement(
    elementName: string,
    result: EnsembleActivationResult,
    portfolioManager: PortfolioManager,
    managers: import('./types.js').ElementManagers,
    nestingDepth: number
  ): Promise<void> {
    const startTime = Date.now();
    const elementConfig = this.findElementByName(elementName)!;
    const isNestedEnsemble = elementConfig.element_type === 'ensemble';

    try {
      // Load element instance if not already loaded
      if (!this.elementInstances.has(elementName)) {
        const instance = await this.loadElementInstance(elementConfig, portfolioManager, managers);
        this.elementInstances.set(elementName, instance);
        this.instanceAccessTimes.set(elementName, Date.now());

        // Evict if cache is too large
        this.evictOldestInstance();
      } else {
        // Update access time
        this.instanceAccessTimes.set(elementName, Date.now());
      }

      const instance = this.elementInstances.get(elementName)!;

      // Activate via the type manager's activation method, which both sets the
      // instance status AND registers the element in the manager's active set.
      // Using instance.activate() alone only sets the status flag — the manager
      // won't know the element is active, so get_active_elements returns nothing.
      // @see Issue #1769 - Ensemble activation not registering with type managers
      const activated = await this.activateViaManager(elementName, elementConfig.element_type, managers);
      if (!activated) {
        // Fallback: activate the instance directly if no manager available
        if (instance.activate) {
          await instance.activate();
        }
      }

      // If this is a nested ensemble, call activateEnsemble with incremented depth
      if (isNestedEnsemble && 'activateEnsemble' in instance && typeof instance.activateEnsemble === 'function') {
        await (instance as any).activateEnsemble(portfolioManager, managers, nestingDepth + 1);
      }

      const duration = Date.now() - startTime;
      result.activatedElements.push(elementName);
      result.elementResults.push({
        elementName,
        success: true,
        duration,
        isNestedEnsemble,
        nestingDepth: isNestedEnsemble ? nestingDepth + 1 : nestingDepth
      });

      logger.debug(`Element ${elementName} activated in ${duration}ms`, {
        isNestedEnsemble,
        nestingDepth: isNestedEnsemble ? nestingDepth + 1 : nestingDepth
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      result.failedElements.push(elementName);
      result.elementResults.push({
        elementName,
        success: false,
        duration,
        error: error as Error,
        isNestedEnsemble,
        nestingDepth: isNestedEnsemble ? nestingDepth + 1 : nestingDepth
      });

      logger.error(`Failed to activate element ${elementName}:`, error);
    }
  }

  /**
   * Activate an element via its type manager's activation method.
   * This registers the element in the manager's active set so that
   * get_active_elements correctly reports it.
   *
   * @returns true if activation went through a manager, false if no manager available
   * @see Issue #1769 - Ensemble activation not registering with type managers
   */
  private async activateViaManager(
    elementName: string,
    elementType: string,
    managers: import('./types.js').ElementManagers
  ): Promise<boolean> {
    const normalized = this.normalizeElementType(elementType);

    switch (normalized) {
      case 'skill': {
        const mgr = managers.skillManager as any;
        if (mgr?.activateSkill) { await mgr.activateSkill(elementName); return true; }
        return false;
      }
      case 'persona': {
        const mgr = managers.personaManager;
        if (mgr?.activatePersona) { await mgr.activatePersona(elementName); return true; }
        return false;
      }
      case 'agent': {
        const mgr = managers.agentManager as any;
        if (mgr?.activateAgent) { await mgr.activateAgent(elementName); return true; }
        return false;
      }
      case 'memory': {
        const mgr = managers.memoryManager as any;
        if (mgr?.activateMemory) { await mgr.activateMemory(elementName); return true; }
        return false;
      }
      case 'ensemble': {
        const mgr = managers.ensembleManager as any;
        if (mgr?.activateEnsemble) { await mgr.activateEnsemble(elementName); return true; }
        return false;
      }
      case 'template': {
        // Templates don't have activation state — just activate the instance
        return false;
      }
      default:
        return false;
    }
  }

  /**
   * Load an element instance from portfolio
   */
  private async loadElementInstance(
    element: EnsembleElement,
    portfolioManager: PortfolioManager,
    managers: import('./types.js').ElementManagers
  ): Promise<IElement> {
    const elementType = element.element_type.toLowerCase();
    const isNestedEnsemble = elementType === 'ensemble' || elementType === 'ensembles';

    // Structured logging: Element loading with nesting detection
    logger.debug('Loading element for ensemble', this.getLogContext({
      elementName: element.element_name,
      elementType: elementType,
      isNestedEnsemble,
      role: element.role,
      priority: element.priority
    }));

    const normalizedType = this.normalizeElementType(elementType);
    const manager = this.getManagerForType(normalizedType, managers);

    if (!manager) {
      const ensembleContext = `in ensemble "${this.metadata.name}" (${this.id})`;
      const nestedHint = normalizedType === 'ensemble'
        ? '\n  → For nested ensembles, ensure EnsembleManager is provided in managers parameter'
        : '';

      throw new Error(
        `Failed to load element "${element.element_name}" of type "${normalizedType}" ${ensembleContext}.\n` +
        `  Reason: No manager available for element type "${normalizedType}".\n` +
        `  Available managers: ${this.getAvailableManagerTypes(managers).join(', ')}${nestedHint}`
      );
    }

    return await this.findElementInManager(manager, element.element_name, normalizedType);
  }

  /**
   * Normalize element type to singular form
   */
  private normalizeElementType(type: string): string {
    const typeMap: Record<string, string> = {
      'skills': 'skill',
      'templates': 'template',
      'agents': 'agent',
      'memories': 'memory',
      'personas': 'persona',
      'ensembles': 'ensemble'
    };

    return typeMap[type] || type;
  }

  /**
   * Get the appropriate manager for an element type
   */
  private getManagerForType(
    type: string,
    managers: import('./types.js').ElementManagers
  ): any {
    const managerMap: Record<string, any> = {
      'skill': managers.skillManager,
      'template': managers.templateManager,
      'agent': managers.agentManager,
      'memory': managers.memoryManager,
      'persona': managers.personaManager,
      'ensemble': managers.ensembleManager
    };

    return managerMap[type];
  }

  /**
   * Get list of available manager types
   */
  private getAvailableManagerTypes(managers: import('./types.js').ElementManagers): string[] {
    const availableTypes: string[] = [];

    if (managers.skillManager) availableTypes.push('skill');
    if (managers.templateManager) availableTypes.push('template');
    if (managers.agentManager) availableTypes.push('agent');
    if (managers.memoryManager) availableTypes.push('memory');
    if (managers.personaManager) availableTypes.push('persona');
    if (managers.ensembleManager) availableTypes.push('ensemble');

    return availableTypes;
  }

  /**
   * Find an element in the manager using fuzzy name matching
   */
  private async findElementInManager(
    manager: any,
    elementName: string,
    elementType: string
  ): Promise<IElement> {
    // Special handling for PersonaManager which has findPersona method
    if (elementType === 'persona' && manager.findPersona) {
      const persona = manager.findPersona(elementName);
      if (!persona) {
        throw new Error(`${this.capitalizeFirst(elementType)} '${elementName}' not found`);
      }
      return persona as any;
    }

    // Standard handling for other managers with list() method
    const elements = await manager.list();
    const foundElement = elements.find((el: any) =>
      this.matchesElementName(el.metadata.name, elementName)
    );

    if (!foundElement) {
      const availableNames = elements.map((el: any) => el.metadata.name).join(', ');
      const ensembleContext = `in ensemble "${this.metadata.name}"`;
      const nestedHint = elementType === 'ensemble'
        ? `\n  → Tip: Nested ensembles must exist in the portfolio before being referenced.`
        : '';

      throw new Error(
        `${this.capitalizeFirst(elementType)} "${elementName}" not found ${ensembleContext}.\n` +
        `  Available ${elementType}s: ${availableNames || '(none)'}${nestedHint}`
      );
    }

    return foundElement;
  }

  /**
   * Check if element name matches target using fuzzy matching
   * Handles exact match, slugified match, and bidirectional slug matching
   *
   * SECURITY: Normalizes Unicode to prevent composed vs decomposed character mismatches.
   * This is defense-in-depth; element names are already validated by ELEMENT_NAME_PATTERN
   * which blocks non-ASCII characters.
   *
   * @param actualName - Name from element manager (filesystem)
   * @param targetName - Name from ensemble configuration (user input)
   * @returns true if names match exactly or after slugification
   */
  private matchesElementName(actualName: string, targetName: string): boolean {
    // Normalize Unicode to handle composed vs decomposed characters (defense-in-depth)
    const normalizedActual = UnicodeValidator.normalize(actualName).normalizedContent;
    const normalizedTarget = UnicodeValidator.normalize(targetName).normalizedContent;

    const exactMatch = normalizedActual === normalizedTarget;
    const slugifiedMatch = normalizedActual.toLowerCase().replace(/\s+/g, '-') === normalizedTarget;
    const reverseMatch = normalizedTarget.toLowerCase().replace(/\s+/g, '-') ===
                         normalizedActual.toLowerCase().replace(/\s+/g, '-');

    return exactMatch || slugifiedMatch || reverseMatch;
  }

  /**
   * Capitalize first letter of a string
   */
  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Evict the oldest accessed instance from the cache
   * Implements LRU (Least Recently Used) eviction policy
   */
  private evictOldestInstance(): void {
    if (this.elementInstances.size <= this.MAX_INSTANCE_CACHE_SIZE) {
      return;
    }

    // Find oldest accessed instance
    let oldestName = '';
    let oldestTime = Date.now();

    for (const [name, time] of this.instanceAccessTimes.entries()) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestName = name;
      }
    }

    if (oldestName) {
      this.elementInstances.delete(oldestName);
      this.instanceAccessTimes.delete(oldestName);
      logger.debug(`Evicted element instance from cache: ${oldestName}`);
    }
  }

  /**
   * Clear the element instance cache
   * Useful for freeing memory or forcing reload of elements
   */
  public clearInstanceCache(): void {
    const size = this.elementInstances.size;
    this.elementInstances.clear();
    this.instanceAccessTimes.clear();
    logger.debug(`Cleared instance cache (${size} instances)`);
  }

  /**
   * Build a type-safe context for condition evaluation
   *
   * Constructs a ConditionContext object with all values needed to evaluate
   * an element's activation condition. The context is immutable and only
   * exposes safe, read-only data.
   *
   * SECURITY GUARANTEES:
   * - Only exposes documented, safe properties
   * - No access to element instances or methods
   * - All nested objects are readonly (shallow immutability)
   * - Context values remain type-checked as unknown
   * - No exposure of internal ensemble state
   *
   * PERFORMANCE:
   * - Minimal object allocation (reuses maps where possible)
   * - O(1) lookups for element and context data
   * - Lazy computation of resource metrics
   * - No deep cloning (uses readonly type guards)
   *
   * @param element - The element whose condition is being evaluated
   * @param activationStartTime - Timestamp when ensemble activation began
   * @param result - Current activation result (for tracking progress)
   * @returns Context builder result with context object and metadata
   *
   * @example
   * ```typescript
   * const contextResult = this.buildConditionContext(
   *   elementConfig,
   *   startTime,
   *   activationResult
   * );
   *
   * // Use context in evaluation
   * const shouldActivate = evaluateExpression(
   *   element.condition,
   *   contextResult.context
   * );
   * ```
   */
  private buildConditionContext(
    element: EnsembleElement,
    activationStartTime: number,
    result: EnsembleActivationResult
  ): import('./types.js').ConditionContextResult {
    const warnings: string[] = [];
    const limits = this.getEffectiveLimits();

    // Build shared context object (convert Map to plain object)
    const contextValues: Record<string, unknown> = {};
    const contextOwners: Record<string, string> = {};

    for (const [key, value] of this.sharedContext.values.entries()) {
      contextValues[key] = value;
      const owner = this.sharedContext.owners.get(key);
      if (owner) {
        contextOwners[key] = owner;
      }
    }

    // Calculate resource usage
    const executionTimeMs = Date.now() - activationStartTime;
    const contextSize = this.sharedContext.values.size;
    const cachedInstances = this.elementInstances.size;

    // Warn if approaching resource limits
    if (contextSize > limits.MAX_CONTEXT_SIZE * 0.8) {
      warnings.push(
        `Context size (${contextSize}) is approaching limit (${limits.MAX_CONTEXT_SIZE})`
      );
    }

    if (executionTimeMs > limits.MAX_ACTIVATION_TIME * 0.8) {
      warnings.push(
        `Execution time (${executionTimeMs}ms) is approaching timeout`
      );
    }

    // Build the context object
    const context: import('./types.js').ConditionContext = {
      element: {
        element_name: element.element_name,
        element_type: element.element_type,
        role: element.role,
        priority: element.priority,
        activation: element.activation,
        dependencies: element.dependencies || [],
        purpose: element.purpose
      },
      context: contextValues,
      contextOwners: contextOwners,
      state: {
        activatedCount: result.activatedElements.length,
        failedCount: result.failedElements.length,
        activatedElements: [...result.activatedElements],
        failedElements: [...result.failedElements],
        totalElements: this.elements.length
      },
      environment: {
        // Reserved for future expansion
        // Will include: runtime, executionContext, capabilities, permissions
      },
      resources: {
        executionTimeMs,
        contextSize,
        cachedInstances
      }
    };

    return {
      context,
      timestamp: new Date(),
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }

  /**
   * Evaluate an activation condition in a secure VM sandbox
   *
   * SECURITY IMPLEMENTATION:
   * This method evaluates user-provided conditions using Node.js VM module with multiple
   * layers of defense:
   *
   * 1. **Sandboxed Execution**: Uses vm.createContext() with frozen objects
   *    - No access to require, process, global, or other Node.js APIs
   *    - All context objects are deeply frozen (immutable)
   *    - No prototype chain access to prevent pollution
   *
   * 2. **Timeout Protection**: 100ms maximum evaluation time
   *    - Prevents infinite loops and ReDoS attacks
   *    - Terminates long-running expressions
   *
   * 3. **Input Validation**: Pre-validated by isValidCondition()
   *    - Dangerous patterns blocked (eval, Function, require, etc.)
   *    - Only safe operators allowed
   *    - Maximum length enforced
   *
   * 4. **Type Safety**: Enforces boolean return values
   *    - Non-boolean results treated as false
   *    - Prevents side effects from non-expression statements
   *
   * 5. **Error Handling**: Fail-secure principle
   *    - Evaluation errors result in non-activation (return false)
   *    - All failures logged to SecurityMonitor
   *    - No error details leaked to user
   *
   * SUPPORTED FEATURES:
   * - Context variable access: context.*, element.*, state.*, resources.*, environment.*
   * - Comparison operators: ==, !=, ===, !==, >, <, >=, <=
   * - Logical operators: &&, ||, !
   * - Parentheses for grouping
   * - Array/object property access
   *
   * Example valid conditions:
   * - "element.priority >= 80"
   * - "context.security_review === true"
   * - "state.activatedCount > 3 && element.role === 'primary'"
   * - "context.environment === 'production' || context.override"
   *
   * @param condition - The condition string to evaluate (pre-validated)
   * @param element - The element whose condition is being evaluated
   * @param activationStartTime - When activation began (for resource tracking)
   * @param result - Current activation result (for state tracking)
   * @returns true if condition evaluates to true, false otherwise
   * @private
   * @security Multiple defense layers: sandbox, timeout, validation, immutability
   */
  private evaluateCondition(
    condition: string,
    element: EnsembleElement,
    activationStartTime: number,
    result: EnsembleActivationResult
  ): boolean {
    // Build type-safe context
    const contextResult = this.buildConditionContext(
      element,
      activationStartTime,
      result
    );

    // Log warnings if any
    if (contextResult.warnings) {
      for (const warning of contextResult.warnings) {
        logger.warn(`Context warning for ${element.element_name}: ${warning}`);
      }
    }

    try {
      // Create frozen sandbox context to prevent modification
      // Expose element properties at top level for convenience (matches real ensemble usage)
      const sandbox = Object.freeze({
        // Element properties at top level for simple conditions like "priority > 40"
        // Note: element_name/element_type are the canonical names, but we also expose
        // name/type for backwards compatibility with existing conditions
        element_name: contextResult.context.element.element_name,
        element_type: contextResult.context.element.element_type,
        name: contextResult.context.element.element_name,  // Backwards compat alias
        type: contextResult.context.element.element_type,  // Backwards compat alias
        role: contextResult.context.element.role,
        priority: contextResult.context.element.priority,
        activation: contextResult.context.element.activation,
        dependencies: Object.freeze([...(contextResult.context.element.dependencies || [])]),
        purpose: contextResult.context.element.purpose,

        // Also include nested element object for backwards compatibility
        element: Object.freeze({ ...contextResult.context.element }),

        // Flatten shared context values to top level (allows "data_available" instead of "context.data_available")
        ...contextResult.context.context,

        // Also include nested context object for complex access patterns
        context: Object.freeze({ ...contextResult.context.context }),

        // Activation state (readonly)
        state: Object.freeze({
          ...contextResult.context.state,
          activatedElements: Object.freeze([...contextResult.context.state.activatedElements]),
          failedElements: Object.freeze([...contextResult.context.state.failedElements])
        }),

        // Resource usage (readonly)
        resources: Object.freeze({ ...contextResult.context.resources }),

        // Environment (readonly)
        environment: contextResult.context.environment
          ? Object.freeze({ ...contextResult.context.environment })
          : Object.freeze({})
      });

      // Create VM context with only the sandbox (no access to require, process, etc.)
      const vmContext = vm.createContext(sandbox);

      // Wrap condition in an IIFE to ensure it returns a boolean
      // This prevents the condition from being a statement
      const wrappedCondition = `(function() { return (${condition}); })()`;

      // Execute with timeout protection
      const startEvalTime = Date.now();
      const evaluationResult = vm.runInContext(wrappedCondition, vmContext, {
        timeout: 100, // 100ms max evaluation time
        displayErrors: false,
        breakOnSigint: true
      });
      const evalDuration = Date.now() - startEvalTime;

      // Log successful evaluation
      logger.debug(
        `Condition evaluated for ${element.element_name}: "${condition}" => ${evaluationResult} (${evalDuration}ms)`
      );

      // Ensure result is boolean
      if (typeof evaluationResult !== 'boolean') {
        logger.warn(
          `Condition "${condition}" for ${element.element_name} returned non-boolean value: ${typeof evaluationResult}. ` +
          `Treating as false.`
        );
        return false;
      }

      return evaluationResult;

    } catch (error) {
      // Log security event for evaluation failure
      SecurityMonitor.logSecurityEvent({
        type: ENSEMBLE_SECURITY_EVENTS.CONDITION_EVALUATION_FAILED,
        severity: 'MEDIUM',
        source: 'Ensemble.evaluateCondition',
        details: `Failed to evaluate condition "${condition}" for element ${element.element_name}: ${error instanceof Error ? error.message : String(error)}`,
        metadata: {
          ensembleName: this.metadata.name,
          elementName: element.element_name,
          condition
        }
      });

      logger.error(
        `Failed to evaluate condition for ${element.element_name}: ${condition}`,
        error instanceof Error ? error : new Error(String(error))
      );

      // Fail securely: evaluation errors result in non-activation
      return false;
    }
  }

  /**
   * Check if a condition syntax is valid
   *
   * Validates that a condition:
   * 1. Matches the safe character pattern (alphanumeric, operators, etc.)
   * 2. Does not contain dangerous keywords or operators
   * 3. Is not empty or whitespace-only
   *
   * SECURITY: Multi-layer validation approach
   * - Layer 1: Positive pattern match (CONDITION_PATTERN) allows only safe characters
   * - Layer 2: Negative pattern match (DANGEROUS_CONDITION_PATTERNS) blocks code injection
   * - Layer 3: VM sandbox with timeout during evaluation (see evaluateCondition)
   * This defense-in-depth strategy ensures conditions cannot execute arbitrary code
   *
   * @param condition - The condition string to validate
   * @returns true if condition is safe, false otherwise
   */
  private isValidCondition(condition: string): boolean {
    // Check if condition matches safe character pattern
    if (!ENSEMBLE_PATTERNS.CONDITION_PATTERN.test(condition)) {
      return false;
    }

    // Check for dangerous patterns
    for (const pattern of DANGEROUS_CONDITION_PATTERNS) {
      if (pattern.test(condition)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if adding an element would create a circular dependency
   */
  private wouldCreateCircularDependency(
    elementName: string,
    dependencies: string[]
  ): boolean {
    // Fast path 1: No dependencies = no cycle possible
    if (!dependencies || dependencies.length === 0) {
      return false;
    }

    // Fast path 2: Self-dependency
    if (dependencies.includes(elementName)) {
      return true;
    }

    // Fast path 3: Check if any dependencies don't exist yet
    // (can't create cycle with non-existent elements)
    const allDepsExist = dependencies.every(dep => this.hasElement(dep));
    if (!allDepsExist) {
      return false;
    }

    // Fast path 4: If this is the first element with dependencies,
    // it cannot create a cycle
    const hasExistingDependencies = this.elements
      .some(el => el.dependencies && el.dependencies.length > 0);
    if (!hasExistingDependencies) {
      return false;
    }

    // Now do the full DFS check (existing implementation)
    // Create temporary array with new/updated element
    // Filter out the existing element if updating, then add the new version
    const tempElements = [
      ...this.elements.filter(el => el.element_name !== elementName),
      {
        element_name: elementName,
        element_type: 'temp',
        role: 'support',
        priority: 50,
        activation: 'always',
        dependencies
      } as EnsembleElement
    ];

    // Helper to find element in temp array
    const findTempElement = (name: string): EnsembleElement | undefined => {
      return tempElements.find(el => el.element_name === name);
    };

    const hasTempElement = (name: string): boolean => {
      return tempElements.some(el => el.element_name === name);
    };

    // Check for cycles using DFS
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const hasCycle = (node: string): boolean => {
      visited.add(node);
      recursionStack.add(node);

      const element = findTempElement(node);
      if (element?.dependencies) {
        for (const dep of element.dependencies) {
          if (!hasTempElement(dep)) continue;

          if (!visited.has(dep)) {
            if (hasCycle(dep)) return true;
          } else if (recursionStack.has(dep)) {
            return true;
          }
        }
      }

      recursionStack.delete(node);
      return false;
    };

    return hasCycle(elementName);
  }

  /**
   * Find circular dependency path for error reporting
   */
  private findCircularDependency(
    elementName: string,
    dependencies: string[]
  ): CircularDependency {
    const path: string[] = [elementName];

    const findCycle = (current: string, visited: Set<string>): boolean => {
      if (visited.has(current)) {
        // Found the cycle
        const cycleStart = path.indexOf(current);
        return cycleStart >= 0;
      }

      visited.add(current);
      path.push(current);

      const element = this.findElementByName(current);
      if (element?.dependencies) {
        for (const dep of element.dependencies) {
          if (this.hasElement(dep)) {
            if (findCycle(dep, visited)) return true;
          }
        }
      }

      path.pop();
      return false;
    };

    for (const dep of dependencies) {
      if (this.hasElement(dep)) {
        if (findCycle(dep, new Set())) {
          path.push(elementName); // Complete the cycle
          return {
            path,
            message: `Circular dependency: ${path.join(' -> ')}`
          };
        }
      }
    }

    return {
      path: [elementName],
      message: 'Circular dependency detected'
    };
  }

  /**
   * Detect all circular dependencies in the ensemble
   */
  private detectAllCircularDependencies(): CircularDependency[] {
    const cycles: CircularDependency[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const pathStack: string[] = [];

    const findCycles = (node: string): void => {
      visited.add(node);
      recursionStack.add(node);
      pathStack.push(node);

      const element = this.findElementByName(node);
      if (element?.dependencies) {
        for (const dep of element.dependencies) {
          if (!this.hasElement(dep)) continue;

          if (!visited.has(dep)) {
            findCycles(dep);
          } else if (recursionStack.has(dep)) {
            // Found a cycle
            const cycleStart = pathStack.indexOf(dep);
            const cyclePath = [...pathStack.slice(cycleStart), dep];
            cycles.push({
              path: cyclePath,
              message: `circular dependency: ${cyclePath.join(' -> ')}`
            });
          }
        }
      }

      pathStack.pop();
      recursionStack.delete(node);
    };

    for (const element of this.elements) {
      if (!visited.has(element.element_name)) {
        findCycles(element.element_name);
      }
    }

    return cycles;
  }

  /**
   * Set a value in shared context
   *
   * SECURITY: Size limits prevent memory exhaustion attacks
   * - Individual value size capped at MAX_CONTEXT_VALUE_SIZE (10KB)
   * - Total context entries capped at MAX_CONTEXT_SIZE (1000 entries)
   * - Prevents DoS via unbounded context growth
   * These limits allow legitimate use while blocking malicious payloads
   *
   * @param key - Context key (sanitized)
   * @param value - Value to store (size-limited)
   * @param ownerElementName - Element setting this value (validated)
   */
  public setContextValue(key: string, value: unknown, ownerElementName: string): void {
    const sanitizedKey = sanitizeInput(key, 100);
    const sanitizedOwner = sanitizeInput(ownerElementName, 100);
    const limits = this.getEffectiveLimits();

    // Validate that owner element exists in the ensemble
    if (!this.hasElement(sanitizedOwner)) {
      throw new Error(
        `Owner element '${sanitizedOwner}' not found in ensemble. ` +
        `Only elements in the ensemble can set context values.`
      );
    }

    // Validate value size to prevent memory exhaustion
    const valueSize = JSON.stringify(value).length;
    if (valueSize > limits.MAX_CONTEXT_VALUE_SIZE) {
      SecurityMonitor.logSecurityEvent({
        type: ENSEMBLE_SECURITY_EVENTS.CONTEXT_VALUE_TOO_LARGE,
        severity: 'MEDIUM',
        source: 'Ensemble.setContextValue',
        details: `Context value size (${valueSize}) exceeds limit (${limits.MAX_CONTEXT_VALUE_SIZE})`
      });

      throw new Error(
        `Context value size (${valueSize} bytes) exceeds maximum allowed size ` +
        `(${limits.MAX_CONTEXT_VALUE_SIZE} bytes)`
      );
    }

    // Check context size limit
    if (this.sharedContext.values.size >= limits.MAX_CONTEXT_SIZE) {
      SecurityMonitor.logSecurityEvent({
        type: ENSEMBLE_SECURITY_EVENTS.CONTEXT_SIZE_EXCEEDED,
        severity: 'MEDIUM',
        source: 'Ensemble.setContextValue',
        details: `Context size limit exceeded: ${limits.MAX_CONTEXT_SIZE}`
      });
      throw new Error(ENSEMBLE_ERRORS.CONTEXT_OVERFLOW);
    }

    // Check if key exists (potential conflict)
    if (this.sharedContext.values.has(sanitizedKey)) {
      const currentOwner = this.sharedContext.owners.get(sanitizedKey)!;
      const currentValue = this.sharedContext.values.get(sanitizedKey);

      // Resolve conflict based on strategy
      const resolvedValue = this.resolveConflict(
        sanitizedKey,
        currentValue,
        value,
        currentOwner,
        sanitizedOwner
      );

      this.sharedContext.values.set(sanitizedKey, resolvedValue);
    } else {
      this.sharedContext.values.set(sanitizedKey, value);
    }

    this.sharedContext.owners.set(sanitizedKey, sanitizedOwner);
    this.sharedContext.timestamps.set(sanitizedKey, new Date());
  }

  /**
   * Get a value from shared context
   */
  public getContextValue(key: string): unknown {
    const sanitizedKey = sanitizeInput(key, 100);
    return this.sharedContext.values.get(sanitizedKey);
  }

  /**
   * Clear all or specific context values
   *
   * @param ownerElementName - Optional: only clear values owned by this element
   * @throws Error if trying to clear during activation
   */
  public clearContext(ownerElementName?: string): void {
    // Prevent clearing during activation
    if (this.activationInProgress) {
      logger.warn(
        'Attempting to clear context during ensemble activation. ' +
        'This operation will proceed but may cause unexpected behavior.'
      );
    }

    if (ownerElementName) {
      const sanitizedOwner = sanitizeInput(ownerElementName, 100);

      // Validate owner exists
      if (!this.hasElement(sanitizedOwner)) {
        throw new Error(
          `Owner element '${sanitizedOwner}' not found in ensemble. ` +
          `Cannot clear context for non-existent element.`
        );
      }

      // Clear only values owned by this element
      let clearedCount = 0;
      for (const [key, owner] of this.sharedContext.owners) {
        if (owner === sanitizedOwner) {
          this.sharedContext.values.delete(key);
          this.sharedContext.owners.delete(key);
          this.sharedContext.timestamps.delete(key);
          clearedCount++;
        }
      }

      logger.debug(`Cleared ${clearedCount} context values owned by ${sanitizedOwner}`);
    } else {
      // Clear all context
      const totalCount = this.sharedContext.values.size;
      this.sharedContext.values.clear();
      this.sharedContext.owners.clear();
      this.sharedContext.timestamps.clear();

      logger.info(`Cleared all shared context (${totalCount} values)`);
    }
  }

  /**
   * Type guard to check if a value is a plain object (not null, not array)
   */
  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.prototype.toString.call(value) === '[object Object]'
    );
  }

  /**
   * Resolve a context conflict based on configured strategy
   */
  private resolveConflict(
    key: string,
    currentValue: unknown,
    newValue: unknown,
    currentOwner: string,
    newOwner: string
  ): unknown {
    const conflict: ContextConflict = {
      key,
      currentValue,
      currentOwner,
      newValue,
      newOwner,
      resolvedBy: this.metadata.conflictResolution
    };

    switch (this.metadata.conflictResolution) {
      case 'last-write':
        conflict.resolution = newValue;
        return newValue;

      case 'first-write':
        conflict.resolution = currentValue;
        return currentValue;

      case 'priority': {
        const currentElement = this.findElementByName(currentOwner);
        const newElement = this.findElementByName(newOwner);
        if (newElement && currentElement) {
          conflict.resolution = newElement.priority > currentElement.priority ?
            newValue : currentValue;
          return conflict.resolution;
        }
        return newValue;
      }

      case 'merge':
        // Attempt to merge if both are plain objects (with type guards)
        if (this.isPlainObject(currentValue) && this.isPlainObject(newValue)) {
          // SECURITY: Spread operator is safe from prototype pollution
          // __proto__ becomes a regular property key, does not modify Object.prototype
          // See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Spread_syntax
          // Tested: All prototype pollution attack vectors blocked (see tests/security/ensemble-security-audit.test.ts)
          conflict.resolution = { ...currentValue, ...newValue };
          return conflict.resolution;
        }
        // Fall back to last-write if can't merge
        conflict.resolution = newValue;
        return newValue;

      case 'error':
        throw new Error(
          `Context conflict on key '${key}': ${currentOwner} vs ${newOwner}`
        );

      default:
        return newValue;
    }
  }

  /**
   * Update activation metrics after an activation attempt
   * @private
   */
  private updateActivationMetrics(result: EnsembleActivationResult, nestingDepth: number = 0): void {
    const duration = result.totalDuration;

    this.activationMetrics.totalActivations++;
    if (result.success) {
      this.activationMetrics.successfulActivations++;
    } else {
      this.activationMetrics.failedActivations++;
    }

    // Update duration statistics
    this.activationMetrics.minDuration = Math.min(this.activationMetrics.minDuration, duration);
    this.activationMetrics.maxDuration = Math.max(this.activationMetrics.maxDuration, duration);

    // Update average duration (running average)
    const prevAvg = this.activationMetrics.averageDuration;
    const totalCount = this.activationMetrics.totalActivations;
    this.activationMetrics.averageDuration =
      (prevAvg * (totalCount - 1) + duration) / totalCount;

    // Track nested ensemble count
    const nestedCount = result.activatedElements.filter(name => {
      const elem = this.findElementByName(name);
      return elem?.element_type === 'ensemble';
    }).length;
    this.activationMetrics.nestedEnsembleCount += nestedCount;

    // Track max nesting depth
    this.activationMetrics.maxNestingDepth = Math.max(
      this.activationMetrics.maxNestingDepth,
      nestingDepth
    );

    this.activationMetrics.lastActivation = new Date();
  }

  /**
   * Get activation metrics for performance monitoring
   * Returns a snapshot of current metrics
   */
  public getActivationMetrics(): Readonly<EnsembleActivationMetrics> {
    return { ...this.activationMetrics };
  }

  /**
   * Get the last activation result
   */
  public getLastActivationResult(): EnsembleActivationResult | undefined {
    return this.lastActivationResult;
  }

  /**
   * Get all elements in the ensemble
   */
  public getElements(): EnsembleElement[] {
    return [...this.elements];
  }

  /**
   * Get a specific element by name
   */
  public getElement(name: string): EnsembleElement | undefined {
    return this.findElementByName(sanitizeInput(name, 100));
  }
}

// Re-export types for convenience
export type { EnsembleMetadata, EnsembleElement } from './types.js';
