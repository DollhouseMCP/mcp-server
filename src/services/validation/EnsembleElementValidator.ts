/**
 * EnsembleElementValidator - Specialized validator for Ensemble elements
 *
 * Extends GenericElementValidator to add Ensemble-specific validation:
 * - Element type validation against valid types
 * - Circular dependency detection
 * - Nested ensemble depth validation
 * - Activation strategy validation
 * - Conflict resolution validation
 */

import { ElementType } from '../../portfolio/types.js';
import { GenericElementValidator } from './GenericElementValidator.js';
import { ValidationResult, ValidatorHelpers, ElementValidationOptions } from './ElementValidator.js';
import { ValidationService } from './ValidationService.js';
import { TriggerValidationService } from './TriggerValidationService.js';
import { MetadataService } from '../MetadataService.js';
import {
  ACTIVATION_STRATEGIES,
  CONFLICT_STRATEGIES,
  ELEMENT_ROLES,
  ACTIVATION_MODES,
  ENSEMBLE_LIMITS,
  ENSEMBLE_DEFAULTS
} from '../../elements/ensembles/constants.js';

const VALID_ELEMENT_TYPES: ElementType[] = [
  ElementType.PERSONA,
  ElementType.SKILL,
  ElementType.TEMPLATE,
  ElementType.AGENT,
  ElementType.MEMORY,
  ElementType.ENSEMBLE
];

/**
 * Map singular type names to their plural ElementType equivalents
 * Allows users to specify 'skill' instead of 'skills', etc.
 */
const SINGULAR_TO_PLURAL_TYPE_MAP: Record<string, ElementType> = {
  'persona': ElementType.PERSONA,
  'skill': ElementType.SKILL,
  'template': ElementType.TEMPLATE,
  'agent': ElementType.AGENT,
  'memory': ElementType.MEMORY,
  'ensemble': ElementType.ENSEMBLE,
  // Also include plural forms for direct lookup
  'personas': ElementType.PERSONA,
  'skills': ElementType.SKILL,
  'templates': ElementType.TEMPLATE,
  'agents': ElementType.AGENT,
  'memories': ElementType.MEMORY,
  'ensembles': ElementType.ENSEMBLE
};

/**
 * Normalize element type to ElementType enum value
 * Accepts both singular ('skill') and plural ('skills') forms
 */
function normalizeElementType(type: string): ElementType | null {
  const normalized = type.toLowerCase();
  return SINGULAR_TO_PLURAL_TYPE_MAP[normalized] || null;
}

interface EnsembleElement {
  // Support both new (element_name/element_type) and legacy (name/type) field names
  element_name?: string;
  element_type?: string;
  name?: string;  // Legacy - deprecated
  type?: string;  // Legacy - deprecated
  role?: string;
  activation?: string;
  condition?: string;
  dependencies?: string[];
  purpose?: string;
}

export class EnsembleElementValidator extends GenericElementValidator {
  constructor(
    validationService: ValidationService,
    triggerValidationService: TriggerValidationService,
    metadataService: MetadataService
  ) {
    super(ElementType.ENSEMBLE, validationService, triggerValidationService, metadataService);
  }

  /**
   * Override validateCreate to add ensemble-specific validation
   */
  override async validateCreate(
    data: unknown,
    options?: ElementValidationOptions
  ): Promise<ValidationResult> {
    // First run generic validation
    const baseResult = await super.validateCreate(data, options);
    const errors = [...baseResult.errors];
    const warnings = [...baseResult.warnings];
    const suggestions = [...(baseResult.suggestions || [])];

    if (!data || typeof data !== 'object') {
      return baseResult;
    }

    const record = data as Record<string, unknown>;

    // Validate activation strategy
    if (record.activationStrategy || record.activation_strategy) {
      const strategy = record.activationStrategy || record.activation_strategy;
      const strategyResult = this.validateActivationStrategy(strategy);
      if (!strategyResult.isValid) {
        errors.push(...strategyResult.errors);
      }
    }

    // Validate conflict resolution
    if (record.conflictResolution || record.conflict_resolution) {
      const resolution = record.conflictResolution || record.conflict_resolution;
      const resolutionResult = this.validateConflictResolution(resolution);
      if (!resolutionResult.isValid) {
        errors.push(...resolutionResult.errors);
      }
    }

    // Validate context sharing
    if (record.contextSharing || record.context_sharing) {
      const sharing = record.contextSharing || record.context_sharing;
      const sharingResult = this.validateContextSharing(sharing);
      if (!sharingResult.isValid) {
        errors.push(...sharingResult.errors);
      }
    }

    // Validate ensemble elements
    if (record.elements) {
      // Use ternary to properly handle falsy values (|| treats false/0 as falsy)
      const allowNested = record.allowNested !== undefined ? record.allowNested : record.allow_nested;
      const maxNestingDepth = record.maxNestingDepth !== undefined ? record.maxNestingDepth : record.max_nesting_depth;
      const elementsResult = await this.validateEnsembleElements(
        record.elements,
        allowNested,
        maxNestingDepth
      );
      if (!elementsResult.isValid) {
        errors.push(...elementsResult.errors);
      }
      warnings.push(...elementsResult.warnings);
    }

    // Validate resource limits if present
    if (record.resourceLimits || record.resource_limits) {
      const limits = record.resourceLimits || record.resource_limits;
      const limitsResult = this.validateResourceLimits(limits);
      if (!limitsResult.isValid) {
        errors.push(...limitsResult.errors);
      }
      warnings.push(...limitsResult.warnings);
    }

    // Ensemble-specific suggestions
    if (!record.elements || (Array.isArray(record.elements) && record.elements.length === 0)) {
      warnings.push('Ensemble has no elements defined');
    }

    if (!record.conflictResolution && !record.conflict_resolution) {
      suggestions.push('Consider specifying a conflict resolution strategy');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      suggestions: suggestions.length > 0 ? suggestions : undefined
    };
  }

  /**
   * Validate activation strategy
   */
  private validateActivationStrategy(strategy: unknown): ValidationResult {
    if (typeof strategy !== 'string') {
      return ValidatorHelpers.fail(['Activation strategy must be a string']);
    }

    if (!ACTIVATION_STRATEGIES.includes(strategy as any)) {
      return ValidatorHelpers.fail([
        `Invalid activation strategy '${strategy}'. Valid options: ${ACTIVATION_STRATEGIES.join(', ')}`
      ]);
    }

    return ValidatorHelpers.pass();
  }

  /**
   * Validate conflict resolution strategy
   */
  private validateConflictResolution(resolution: unknown): ValidationResult {
    if (typeof resolution !== 'string') {
      return ValidatorHelpers.fail(['Conflict resolution must be a string']);
    }

    if (!CONFLICT_STRATEGIES.includes(resolution as any)) {
      return ValidatorHelpers.fail([
        `Invalid conflict resolution '${resolution}'. Valid options: ${CONFLICT_STRATEGIES.join(', ')}`
      ]);
    }

    return ValidatorHelpers.pass();
  }

  /**
   * Validate context sharing mode
   */
  private validateContextSharing(sharing: unknown): ValidationResult {
    if (typeof sharing !== 'string') {
      return ValidatorHelpers.fail(['Context sharing must be a string']);
    }

    if (!['none', 'selective', 'full'].includes(sharing as any)) {
      return ValidatorHelpers.fail([
        `Invalid context sharing mode '${sharing}'. Valid options: ${['none', 'selective', 'full'].join(', ')}`
      ]);
    }

    return ValidatorHelpers.pass();
  }

  /**
   * Validate ensemble elements array
   */
  private async validateEnsembleElements(
    elements: unknown,
    allowNested: unknown,
    maxNestingDepth: unknown
  ): Promise<ValidationResult> {
    if (!Array.isArray(elements)) {
      return ValidatorHelpers.fail(['Elements must be an array']);
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    if (elements.length === 0) {
      warnings.push('Ensemble has no elements');
      return { isValid: true, errors, warnings };
    }

    if (elements.length > ENSEMBLE_LIMITS.MAX_ELEMENTS) {
      errors.push(`Ensemble cannot have more than ${ENSEMBLE_LIMITS.MAX_ELEMENTS} elements`);
    }

    // Track element names for circular dependency detection
    const elementNames = new Set<string>();
    const dependencies = new Map<string, Set<string>>();

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (!element || typeof element !== 'object') {
        errors.push(`Element at index ${i} must be an object`);
        continue;
      }

      const elem = element as EnsembleElement;

      // Support both element_name (new) and name (legacy) field names
      const elemName = elem.element_name || elem.name;

      // Validate element name
      if (!elemName) {
        errors.push(`Element at index ${i} is missing required 'element_name' (or 'name') field`);
        continue;
      }

      if (elementNames.has(elemName)) {
        errors.push(`Duplicate element name '${elemName}' at index ${i}`);
      }
      elementNames.add(elemName);

      // Support both element_type (new) and type (legacy) field names
      const elemType = elem.element_type || elem.type;

      // Validate element type - accept both singular and plural forms
      const normalizedElemType = elemType ? normalizeElementType(elemType) : null;
      if (!elemType) {
        errors.push(`Element '${elemName}' is missing required 'element_type' (or 'type') field`);
      } else {
        if (!normalizedElemType) {
          errors.push(
            `Element '${elemName}' has invalid type '${elemType}'. Valid types: ${VALID_ELEMENT_TYPES.join(', ')}`
          );
        }
      }

      // Check for nested ensembles - normalize type for comparison
      if (normalizedElemType === ElementType.ENSEMBLE) {
        if (allowNested !== true) {
          errors.push(`Nested ensemble '${elemName}' not allowed (set allowNested: true to enable)`);
        } else {
          // Validate nesting depth
          const depth = typeof maxNestingDepth === 'number' ? maxNestingDepth : ENSEMBLE_LIMITS.MAX_NESTING_DEPTH;
          if (depth <= 0) {
            errors.push(`Maximum nesting depth exceeded for ensemble '${elemName}'`);
          }
        }
      }

      // Validate element role
      if (elem.role && !ELEMENT_ROLES.includes(elem.role as any)) {
        errors.push(
          `Element '${elemName}' has invalid role '${elem.role}'. Valid roles: ${ELEMENT_ROLES.join(', ')}`
        );
      } else if (!elem.role) {
        // Issue #365: Warn when role defaults are applied
        warnings.push(
          `Element '${elemName}' has no role specified, will default to '${ENSEMBLE_DEFAULTS.ELEMENT_ROLE}'. Valid roles: ${ELEMENT_ROLES.join(', ')}`
        );
      }

      // Validate activation mode
      if (elem.activation && !ACTIVATION_MODES.includes(elem.activation as any)) {
        errors.push(
          `Element '${elemName}' has invalid activation '${elem.activation}'. Valid modes: ${ACTIVATION_MODES.join(', ')}`
        );
      }

      // Validate condition if activation is conditional
      if (elem.activation === 'conditional' && !elem.condition) {
        errors.push(`Element '${elemName}' has conditional activation but no condition specified`);
      }

      // Track dependencies for circular detection
      if (elem.dependencies && Array.isArray(elem.dependencies)) {
        dependencies.set(elemName, new Set(elem.dependencies));

        // Check that dependencies exist
        for (const dep of elem.dependencies) {
          const depExists = elementNames.has(dep) || elements.some(e => {
            const el = e as EnsembleElement;
            return (el.element_name || el.name) === dep;
          });
          if (!depExists) {
            warnings.push(`Element '${elemName}' depends on unknown element '${dep}'`);
          }
        }

        if (elem.dependencies.length > ENSEMBLE_LIMITS.MAX_DEPENDENCIES) {
          errors.push(
            `Element '${elemName}' has too many dependencies (${elem.dependencies.length} > ${ENSEMBLE_LIMITS.MAX_DEPENDENCIES})`
          );
        }
      }
    }

    // Detect circular dependencies
    const circularDeps = this.detectCircularDependencies(dependencies);
    if (circularDeps.length > 0) {
      errors.push(`Circular dependencies detected: ${circularDeps.join(' -> ')}`);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Detect circular dependencies in element graph
   */
  private detectCircularDependencies(dependencies: Map<string, Set<string>>): string[] {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const hasCycle = (node: string): boolean => {
      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const deps = dependencies.get(node);
      if (deps) {
        for (const dep of deps) {
          if (!visited.has(dep)) {
            if (hasCycle(dep)) {
              return true;
            }
          } else if (recursionStack.has(dep)) {
            // Found cycle
            return true;
          }
        }
      }

      recursionStack.delete(node);
      path.pop();
      return false;
    };

    for (const node of dependencies.keys()) {
      if (!visited.has(node)) {
        if (hasCycle(node)) {
          // Return the cycle path
          const cycleStart = path.findIndex(n => path.lastIndexOf(n) !== path.indexOf(n));
          if (cycleStart >= 0) {
            return path.slice(cycleStart);
          }
          return path;
        }
      }
    }

    return [];
  }

  /**
   * Validate resource limits
   */
  private validateResourceLimits(limits: unknown): ValidationResult {
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
      return ValidatorHelpers.fail(['Resource limits must be an object']);
    }

    const limitsObj = limits as Record<string, unknown>;
    const warnings: string[] = [];

    // Validate memory limit
    if (limitsObj.memoryMB !== undefined) {
      if (typeof limitsObj.memoryMB !== 'number' || limitsObj.memoryMB <= 0) {
        return ValidatorHelpers.fail(['Memory limit must be a positive number']);
      }
      if (limitsObj.memoryMB > 1024) {
        warnings.push(`High memory limit (${limitsObj.memoryMB}MB) may impact performance`);
      }
    }

    // Validate execution time
    if (limitsObj.executionTimeMs !== undefined) {
      if (typeof limitsObj.executionTimeMs !== 'number' || limitsObj.executionTimeMs <= 0) {
        return ValidatorHelpers.fail(['Execution time limit must be a positive number']);
      }
      if (limitsObj.executionTimeMs > 60000) {
        warnings.push(`Long execution time limit (${limitsObj.executionTimeMs}ms) may cause timeouts`);
      }
    }

    // Validate concurrent activations
    if (limitsObj.maxConcurrent !== undefined) {
      if (typeof limitsObj.maxConcurrent !== 'number' || limitsObj.maxConcurrent <= 0) {
        return ValidatorHelpers.fail(['Max concurrent must be a positive number']);
      }
      if (limitsObj.maxConcurrent > 10) {
        warnings.push(`High concurrent limit (${limitsObj.maxConcurrent}) may cause resource contention`);
      }
    }

    return {
      isValid: true,
      errors: [],
      warnings
    };
  }
}