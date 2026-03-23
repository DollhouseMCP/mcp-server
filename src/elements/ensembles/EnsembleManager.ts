/**
 * EnsembleManager - Implementation of IElementManager for Ensemble elements
 *
 * Handles CRUD operations and lifecycle management for ensembles implementing IElement
 *
 * ARCHITECTURE:
 * - Extends BaseElementManager for unified element management
 * - Follows template method pattern (parseMetadata, createElement hooks)
 * - Pure manager layer - delegates business logic to Ensemble class
 * - Uses DI for dependencies (PortfolioManager, FileLockManager)
 *
 * SECURITY:
 * - Uses FileLockManager for atomic file operations
 * - Path validation prevents directory traversal attacks
 * - Input sanitization for all user data
 * - Security event logging for audit trails
 * - SecureYamlParser for safe YAML parsing
 */

import { Ensemble, EnsembleMetadata, EnsembleElement } from './Ensemble.js';
import { ElementValidationResult } from '../../types/elements/IElement.js';
import { ElementType } from '../../portfolio/types.js';
import { toSingularLabel } from '../../utils/elementTypeNormalization.js';
import { BaseElementManager } from '../base/BaseElementManager.js';
import { FileLockManager } from '../../security/fileLockManager.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';
import {
  ENSEMBLE_DEFAULTS,
  ENSEMBLE_LIMITS,
  ENSEMBLE_SECURITY_EVENTS,
  ENSEMBLE_ERRORS,
  ACTIVATION_STRATEGIES,
  CONFLICT_STRATEGIES,
  ELEMENT_ROLES,
  ACTIVATION_MODES
} from './constants.js';
import type { ActivationStrategy, ConflictResolutionStrategy, ElementRole, ActivationMode } from './types.js';
import { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { ValidationRegistry } from '../../services/validation/ValidationRegistry.js';
import { ValidationService } from '../../services/validation/ValidationService.js';
import { SerializationService } from '../../services/SerializationService.js';
import { MetadataService } from '../../services/MetadataService.js';
import { FileOperationsService } from '../../services/FileOperationsService.js';
import { FileWatchService } from '../../services/FileWatchService.js';
import { ElementMessages } from '../../utils/elementMessages.js';
import { VALIDATION_PATTERNS, SECURITY_LIMITS } from '../../security/constants.js';
import { sanitizeGatekeeperPolicy } from '../../handlers/mcp-aql/policies/ElementPolicies.js';

// Issue #83: Centralized active element limits (configurable via env vars)
import { getActiveElementLimitConfig, getMaxActiveLimit } from '../../config/active-element-limits.js';

// Issue #466: Shared element type resolver — re-exported for backward compatibility
import { resolveElementTypes } from '../../utils/elementTypeResolver.js';
export { resolveElementTypes, type ElementManagersForResolution } from '../../utils/elementTypeResolver.js';

/** @deprecated Use resolveElementTypes from '../../utils/elementTypeResolver.js' */
export const resolveEnsembleElementTypes = resolveElementTypes;

/**
 * EnsembleManager - Manages ensemble element lifecycle
 *
 * Extends BaseElementManager to provide ensemble-specific operations:
 * - YAML parsing with both snake_case and camelCase support
 * - Ensemble creation and validation
 * - Element reference management
 * - Import/export in multiple formats
 */
export class EnsembleManager extends BaseElementManager<Ensemble> {
  private readonly ensemblesDir: string;
  private validationService: ValidationService;
  private serializationService: SerializationService;
  private activeEnsembleNames: Set<string> = new Set();

  constructor(
    portfolioManager: PortfolioManager,
    fileLockManager: FileLockManager,
    fileOperationsService: FileOperationsService,
    validationRegistry: ValidationRegistry,
    serializationService: SerializationService,
    private metadataService: MetadataService,
    fileWatchService?: FileWatchService,
    memoryBudget?: import('../../cache/CacheMemoryBudget.js').CacheMemoryBudget,
    backupService?: import('../../services/BackupService.js').BackupService
  ) {
    super(ElementType.ENSEMBLE, portfolioManager, fileLockManager, { fileWatchService, memoryBudget, backupService }, fileOperationsService, validationRegistry);
    this.ensemblesDir = this.elementDir;
    this.validationService = validationRegistry.getValidationService();
    this.serializationService = serializationService;
  }

  protected override getElementLabel(): string {
    return 'ensemble';
  }

  /**
   * Parse metadata from YAML frontmatter
   *
   * NAMING CONVENTION SUPPORT:
   * - TypeScript interfaces use camelCase (activationStrategy, conflictResolution)
   * - YAML files can use snake_case (activation_strategy, conflict_resolution)
   * - This method maps snake_case → camelCase for user convenience
   *
   * @param data - Raw YAML data from frontmatter
   * @returns Validated EnsembleMetadata
   */
  protected override async parseMetadata(data: any): Promise<EnsembleMetadata> {
    // REFACTORED: Use validateMetadataField for field-aware error messages (#365)
    const nameResult = this.validationService.validateMetadataField('name', data.name, {
      required: true,
      maxLength: SECURITY_LIMITS.MAX_NAME_LENGTH
    });
    if (!nameResult.isValid) {
      throw new Error(`Validation failed: ${nameResult.errors?.join(', ')}`);
    }
    const name = nameResult.sanitizedValue;

    if (!name) {
      throw new Error('Ensemble metadata must include a name');
    }

    // REFACTORED: Use validateMetadataField for field-aware error messages (#365)
    let description: string | undefined;
    if (data.description) {
      const descResult = this.validationService.validateMetadataField('description', data.description, {
        required: false,
        maxLength: SECURITY_LIMITS.MAX_DESCRIPTION_LENGTH,
        pattern: VALIDATION_PATTERNS.SAFE_DESCRIPTION
      });
      if (!descResult.isValid) {
        throw new Error(`Validation failed: ${descResult.errors?.join(', ')}`);
      }
      description = descResult.sanitizedValue;
    }

    // REFACTORED: Use ValidationService for activation strategy (support both snake_case and camelCase)
    const activationStrategyRaw = data.activation_strategy || data.activationStrategy || ENSEMBLE_DEFAULTS.ACTIVATION_STRATEGY;
    const activationStrategyResult = this.validationService.validateAndSanitizeInput(String(activationStrategyRaw), {
      maxLength: SECURITY_LIMITS.MAX_ENUM_FIELD_LENGTH,
      allowSpaces: false
    });
    if (!activationStrategyResult.isValid) {
      throw new Error(`Invalid activation strategy: ${activationStrategyResult.errors?.join(', ')}`);
    }
    const activationStrategy = activationStrategyResult.sanitizedValue!;

    // KEEP: Enum validation logic (add AFTER ValidationService sanitization)
    if (!ACTIVATION_STRATEGIES.includes(activationStrategy as any)) {
      throw new Error(`${ENSEMBLE_ERRORS.INVALID_STRATEGY}: ${activationStrategy}`);
    }

    // REFACTORED: Use ValidationService for conflict resolution strategy
    const conflictResolutionRaw = data.conflict_resolution || data.conflictResolution || ENSEMBLE_DEFAULTS.CONFLICT_RESOLUTION;
    const conflictResolutionResult = this.validationService.validateAndSanitizeInput(String(conflictResolutionRaw), {
      maxLength: SECURITY_LIMITS.MAX_ENUM_FIELD_LENGTH,
      allowSpaces: false
    });
    if (!conflictResolutionResult.isValid) {
      throw new Error(`Invalid conflict resolution strategy: ${conflictResolutionResult.errors?.join(', ')}`);
    }
    const conflictResolution = conflictResolutionResult.sanitizedValue!;

    // KEEP: Enum validation logic (add AFTER ValidationService sanitization)
    if (!CONFLICT_STRATEGIES.includes(conflictResolution as any)) {
      throw new Error(`${ENSEMBLE_ERRORS.INVALID_CONFLICT_RESOLUTION}: ${conflictResolution}`);
    }

    // REFACTORED: Use ValidationService for context sharing mode
    const contextSharingRaw = data.context_sharing || data.contextSharing || ENSEMBLE_DEFAULTS.CONTEXT_SHARING;

    // FIX: Handle boolean values (true -> 'full', false -> 'none')
    let contextSharingValue: string;
    if (typeof contextSharingRaw === 'boolean') {
      contextSharingValue = contextSharingRaw ? 'full' : 'none';
    } else {
      contextSharingValue = String(contextSharingRaw);
    }

    const contextSharingResult = this.validationService.validateAndSanitizeInput(contextSharingValue, {
      maxLength: SECURITY_LIMITS.MAX_ENUM_FIELD_LENGTH,
      allowSpaces: false
    });
    if (!contextSharingResult.isValid) {
      throw new Error(`Invalid context sharing mode: ${contextSharingResult.errors?.join(', ')}`);
    }
    const contextSharing = contextSharingResult.sanitizedValue!;

    // KEEP: Enum validation logic (add AFTER ValidationService sanitization)
    if (!['none', 'selective', 'full'].includes(contextSharing)) {
      throw new Error(`Invalid context sharing mode: ${contextSharing}`);
    }

    // Parse resource limits (support snake_case)
    const resourceLimitsRaw = data.resource_limits || data.resourceLimits;
    let resourceLimits;

    if (resourceLimitsRaw) {
      resourceLimits = {
        maxActiveElements: resourceLimitsRaw.max_active_elements || resourceLimitsRaw.maxActiveElements || ENSEMBLE_LIMITS.MAX_ELEMENTS,
        maxMemoryMb: resourceLimitsRaw.max_memory_mb || resourceLimitsRaw.maxMemoryMb,
        maxExecutionTimeMs: resourceLimitsRaw.max_execution_time_ms || resourceLimitsRaw.maxExecutionTimeMs || ENSEMBLE_LIMITS.MAX_ACTIVATION_TIME
      };
    }

    // Parse elements array
    const elementsRaw = data.elements || [];
    if (!Array.isArray(elementsRaw)) {
      throw new Error('Ensemble elements must be an array');
    }

    const elements: EnsembleElement[] = elementsRaw.map((elem: any, index: number) => {
      // REFACTORED: Use ValidationService for element name
      // Support both element_name (new standard) and name (legacy) for backwards compatibility
      const rawElementName = elem.element_name || elem.name;
      if (!rawElementName) {
        throw new Error(`Element at index ${index} must have element_name (or name for backwards compatibility)`);
      }
      // Log deprecation warning if using legacy 'name' field
      if (elem.name && !elem.element_name) {
        logger.warn(`Ensemble element at index ${index} uses deprecated 'name' field. Use 'element_name' instead.`);
      }
      const elementNameResult = this.validationService.validateAndSanitizeInput(
        String(rawElementName),
        { maxLength: SECURITY_LIMITS.MAX_NAME_LENGTH, allowSpaces: true }
      );
      if (!elementNameResult.isValid) {
        throw new Error(`Invalid element name at index ${index}: ${elementNameResult.errors?.join(', ')}`);
      }
      const elementName = elementNameResult.sanitizedValue!;

      // REFACTORED: Use ValidationService for element type
      // Support both element_type (new standard) and type (legacy) for backwards compatibility
      const rawElementType = elem.element_type || elem.type || 'skill';
      // Log deprecation warning if using legacy 'type' field
      if (elem.type && !elem.element_type) {
        logger.warn(`Ensemble element at index ${index} uses deprecated 'type' field. Use 'element_type' instead.`);
      }
      const elementTypeResult = this.validationService.validateAndSanitizeInput(
        String(rawElementType),
        { maxLength: SECURITY_LIMITS.MAX_TAG_LENGTH, allowSpaces: false }
      );
      if (!elementTypeResult.isValid) {
        throw new Error(`Invalid element type at index ${index}: ${elementTypeResult.errors?.join(', ')}`);
      }
      const elementType = elementTypeResult.sanitizedValue!;

      // REFACTORED: Use ValidationService for element role
      const elementRoleResult = this.validationService.validateAndSanitizeInput(
        String(elem.role || ENSEMBLE_DEFAULTS.ELEMENT_ROLE),
        { maxLength: SECURITY_LIMITS.MAX_ENUM_FIELD_LENGTH, allowSpaces: false }
      );
      if (!elementRoleResult.isValid) {
        throw new Error(`Invalid element role at index ${index}: ${elementRoleResult.errors?.join(', ')}`);
      }
      const elementRole = elementRoleResult.sanitizedValue!;

      // KEEP: Enum validation logic (add AFTER ValidationService sanitization)
      if (!ELEMENT_ROLES.includes(elementRole as any)) {
        throw new Error(`${ENSEMBLE_ERRORS.INVALID_ELEMENT_ROLE}: ${elementRole}`);
      }

      // REFACTORED: Use ValidationService for element activation
      const elementActivationResult = this.validationService.validateAndSanitizeInput(
        String(elem.activation || 'always'),
        { maxLength: SECURITY_LIMITS.MAX_ENUM_FIELD_LENGTH, allowSpaces: false }
      );
      if (!elementActivationResult.isValid) {
        throw new Error(`Invalid element activation at index ${index}: ${elementActivationResult.errors?.join(', ')}`);
      }
      const elementActivation = elementActivationResult.sanitizedValue!;

      // KEEP: Enum validation logic (add AFTER ValidationService sanitization)
      if (!ACTIVATION_MODES.includes(elementActivation as any)) {
        throw new Error(`${ENSEMBLE_ERRORS.INVALID_ACTIVATION_MODE}: ${elementActivation}`);
      }

      // Parse priority (0-100, default 50)
      let priority = elem.priority ?? ENSEMBLE_DEFAULTS.PRIORITY;
      if (typeof priority === 'string') {
        priority = parseInt(priority, 10);
      }
      priority = Math.max(0, Math.min(100, priority));

      // REFACTORED: Use ValidationService for condition (if conditional activation)
      // Conditions need special handling - they can contain operators like ==, !=, &&, ||
      // So we use a custom pattern that allows these characters
      let condition: string | undefined;
      if (elementActivation === 'conditional' && elem.condition) {
        const conditionResult = this.validationService.validateAndSanitizeInput(
          String(elem.condition),
          {
            maxLength: ENSEMBLE_LIMITS.MAX_CONDITION_LENGTH,
            allowSpaces: true,
            customPattern: /^[a-zA-Z0-9\s\-_.=!&|<>()]+$/  // Allow comparison/logical operators
          }
        );
        if (!conditionResult.isValid) {
          throw new Error(`Invalid condition at index ${index}: ${conditionResult.errors?.join(', ')}`);
        }
        condition = conditionResult.sanitizedValue;
      }

      // REFACTORED: Use ValidationService for dependencies
      let dependencies: string[] | undefined;
      if (elem.dependencies && Array.isArray(elem.dependencies)) {
        const validatedDependencies: string[] = [];
        for (const dep of elem.dependencies.slice(0, ENSEMBLE_LIMITS.MAX_DEPENDENCIES)) {
          const depResult = this.validationService.validateAndSanitizeInput(String(dep), {
            maxLength: SECURITY_LIMITS.MAX_NAME_LENGTH,
            allowSpaces: true
          });
          if (!depResult.isValid) {
            throw new Error(`Invalid dependency "${dep}" at index ${index}: ${depResult.errors?.join(', ')}`);
          }
          validatedDependencies.push(depResult.sanitizedValue!);
        }
        dependencies = validatedDependencies;
      }

      // REFACTORED: Use ValidationService for purpose
      let purpose: string | undefined;
      if (elem.purpose) {
        const purposeResult = this.validationService.validateAndSanitizeInput(String(elem.purpose), {
          maxLength: SECURITY_LIMITS.MAX_DESCRIPTION_LENGTH,
          allowSpaces: true,
          fieldType: 'description'  // Allow full description punctuation (commas, em-dashes, etc.)
        });
        if (!purposeResult.isValid) {
          throw new Error(`Invalid purpose at index ${index}: ${purposeResult.errors?.join(', ')}`);
        }
        purpose = purposeResult.sanitizedValue;
      }

      return {
        element_name: elementName,
        element_type: elementType,
        role: elementRole as ElementRole,
        priority,
        activation: elementActivation as ActivationMode,
        condition,
        dependencies,
        purpose
      };
    });

    // Validate element count
    if (elements.length > ENSEMBLE_LIMITS.MAX_ELEMENTS) {
      throw new Error(ENSEMBLE_ERRORS.TOO_MANY_ELEMENTS);
    }

    // Parse nesting configuration
    const allowNested = data.allow_nested !== undefined ?
      Boolean(data.allow_nested) :
      (data.allowNested !== undefined ? Boolean(data.allowNested) : ENSEMBLE_DEFAULTS.ALLOW_NESTED);

    const maxNestingDepth = data.max_nesting_depth || data.maxNestingDepth || ENSEMBLE_DEFAULTS.MAX_NESTING_DEPTH;

    // REFACTORED: Use ValidationService for tags array
    let tags: string[] = [];
    if (Array.isArray(data.tags)) {
      for (const tag of data.tags) {
        const tagResult = this.validationService.validateAndSanitizeInput(String(tag), {
          maxLength: SECURITY_LIMITS.MAX_TAG_LENGTH,
          allowSpaces: true
        });
        if (!tagResult.isValid) {
          throw new Error(`Invalid tag "${tag}": ${tagResult.errors?.join(', ')}`);
        }
        tags.push(tagResult.sanitizedValue!);
      }
    }

    // Build metadata object (camelCase)
    const metadata: EnsembleMetadata = {
      name,
      description: description || '',
      version: data.version || '1.0.0',
      author: data.author,
      created: data.created,
      modified: data.modified || new Date().toISOString(),
      tags,
      activationStrategy: activationStrategy as ActivationStrategy,
      conflictResolution: conflictResolution as ConflictResolutionStrategy,
      contextSharing: contextSharing as 'none' | 'selective' | 'full',
      resourceLimits,
      allowNested,
      maxNestingDepth,
      elements,
      gatekeeper: sanitizeGatekeeperPolicy(data.gatekeeper, name, 'ensemble'),  // Issue #524
    };

    return metadata;
  }

  /**
   * Create an Ensemble instance from parsed metadata
   *
   * @param metadata - Validated ensemble metadata
   * @param content - Markdown content (ensemble instructions/documentation)
   * @returns New Ensemble instance
   */
  protected override createElement(metadata: EnsembleMetadata, _content: string): Ensemble {
    delete (metadata as any).format_version;  // Fix #912: Strip marker from runtime metadata
    const ensemble = new Ensemble(metadata, metadata.elements, this.metadataService);
    // Extract instructions from metadata if present (v2 dual-field)
    if (metadata.instructions) {
      ensemble.instructions = metadata.instructions;
      delete metadata.instructions;
    }
    return ensemble;
  }

  /**
   * Serialize an ensemble to file content
   *
   * Format: Markdown with YAML frontmatter
   * - Frontmatter: Ensemble metadata + element references
   * - Content: Instructions/documentation for the ensemble
   *
   * @param element - Ensemble to serialize
   * @returns File content (markdown with frontmatter)
   */
  protected override async serializeElement(element: Ensemble): Promise<string> {
    const metadata = element.metadata;

    // Build frontmatter data (using camelCase)
    const frontmatter: any = {
      name: metadata.name,
      type: toSingularLabel(ElementType.ENSEMBLE),
      format_version: 'v2',  // Fix #912: Explicit format marker
      unique_id: element.id,
      description: metadata.description,
      version: metadata.version,
      author: metadata.author,
      created: metadata.created,
      modified: new Date().toISOString(),
      tags: metadata.tags || [],
      activationStrategy: metadata.activationStrategy,
      conflictResolution: metadata.conflictResolution,
      contextSharing: metadata.contextSharing,
      allowNested: metadata.allowNested,
      maxNestingDepth: metadata.maxNestingDepth
    };

    // v2.0 dual-field: write instructions to YAML frontmatter if present
    if (element.instructions) {
      frontmatter.instructions = element.instructions;
    }

    // Include resource limits if specified
    if (metadata.resourceLimits) {
      frontmatter.resourceLimits = metadata.resourceLimits;
    }

    // Issue #524 — Gatekeeper policy (all element types)
    if (metadata.gatekeeper) {
      frontmatter.gatekeeper = metadata.gatekeeper;
    }

    // Include elements array (using element_name/element_type for API consistency)
    frontmatter.elements = metadata.elements.map(elem => {
      const elemData: any = {
        element_name: elem.element_name,
        element_type: elem.element_type,
        role: elem.role,
        priority: elem.priority,
        activation: elem.activation
      };

      if (elem.condition) {
        elemData.condition = elem.condition;
      }

      if (elem.dependencies && elem.dependencies.length > 0) {
        elemData.dependencies = elem.dependencies;
      }

      if (elem.purpose) {
        elemData.purpose = elem.purpose;
      }

      return elemData;
    });

    // Use SerializationService for frontmatter creation
    // Use CORE_SCHEMA to support numbers (priority) and booleans (allowNested)
    const body = element.content || this.buildDefaultBody(element);
    return this.serializationService.createFrontmatter(frontmatter, body, {
      method: 'manual',
      schema: 'json',  // Fix #914: standardize on JSON schema across all managers
      cleanMetadata: true,  // Fix #913: standardize across all managers
      cleaningStrategy: 'remove-both',
      sortKeys: true,
      lineWidth: 100,
      skipInvalid: false  // Don't skip invalid - we want to catch errors
    });
  }

  private buildDefaultBody(element: Ensemble): string {
    const name = (element.metadata.name ?? '').trim();
    const description = (element.metadata.description ?? '').trim();
    const lines: string[] = [];
    if (name) {
      lines.push(`# ${name}`);
      lines.push('');
    }
    if (description) {
      lines.push(description);
    }
    return lines.join('\n');
  }

  /**
   * Get file extension for ensemble files
   */
  override getFileExtension(): string {
    return '.md';
  }

  /**
   * Import an ensemble from external format
   *
   * Supports:
   * - YAML: Frontmatter-style metadata with optional markdown content
   * - JSON: Direct ensemble structure
   * - Markdown: YAML frontmatter + markdown content
   *
   * @param data - String containing ensemble data
   * @param format - Format of the data (json, yaml, markdown)
   * @returns Promise resolving to imported Ensemble
   */
  override async importElement(
    data: string,
    format: 'json' | 'yaml' | 'markdown' = 'markdown'
  ): Promise<Ensemble> {
    try {
      let parsed: any;

      if (format === 'json') {
        parsed = this.serializationService.parseJson(data, {
          source: 'EnsembleManager.importElement'
        });
      } else {
        // Parse YAML/Markdown using SerializationService
        const result = this.serializationService.parseFrontmatter(data, {
          maxYamlSize: 50000, // 50KB limit for ensemble files
          validateContent: true,
          source: 'EnsembleManager.importElement'
        });

        parsed = result.data;
        // Content is parsed but not used in ensemble creation
      }

      // Parse metadata
      const metadata = await this.parseMetadata(parsed);

      // Create ensemble
      const ensemble = new Ensemble(metadata, metadata.elements, this.metadataService);

      // Log successful import
      SecurityMonitor.logSecurityEvent({
        type: ENSEMBLE_SECURITY_EVENTS.IMPORTED,
        severity: 'LOW',
        source: 'EnsembleManager.importElement',
        details: `Imported ensemble: ${metadata.name} with ${metadata.elements.length} elements`
      });

      return ensemble;

    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: ENSEMBLE_SECURITY_EVENTS.IMPORTED,
        severity: 'MEDIUM',
        source: 'EnsembleManager.importElement',
        details: `Failed to import ensemble: ${error}`
      });
      throw new Error(`Failed to import ensemble: ${error}`);
    }
  }

  /**
   * Export an ensemble to external format
   *
   * @param element - Ensemble to export
   * @param format - Output format (json, yaml, markdown)
   * @returns Promise resolving to serialized string
   */
  override async exportElement(
    element: Ensemble,
    format: 'json' | 'yaml' | 'markdown' = 'markdown'
  ): Promise<string> {
    if (format === 'json') {
      return element.serializeToJSON();
    }

    // For YAML and Markdown, use the same format (frontmatter + content)
    return this.serializeElement(element);
  }

  /**
   * Create a new ensemble with metadata
   *
   * @param metadata - Partial metadata for the ensemble
   * @returns Promise resolving to new Ensemble instance
   */
  async create(metadata: Partial<EnsembleMetadata> & { instructions?: string; content?: string }): Promise<Ensemble> {
    // Use specialized validator for input validation
    // Note: element_type resolution is handled by the handler layer before calling create().
    // Elements should already have element_type set when they arrive here.
    const validationResult = await this.validator.validateCreate({
      name: metadata.name,
      description: metadata.description,
      elements: metadata.elements || [],
      allowNested: metadata.allowNested,
      maxNestingDepth: metadata.maxNestingDepth
    });

    if (!validationResult.isValid) {
      throw new Error(`Validation failed: ${validationResult.errors.join(', ')}`);
    }

    // Log warnings if any
    if (validationResult.warnings && validationResult.warnings.length > 0) {
      logger.warn(`Ensemble creation warnings: ${validationResult.warnings.join(', ')}`);
    }

    // Ensure required fields
    if (!metadata.name) {
      throw new Error('Ensemble must have a name');
    }

    let rawElements = metadata.elements || [];

    // Migrate legacy element fields (name -> element_name, type -> element_type)
    // This ensures backwards compatibility with API calls using old field names
    const migratedElements: EnsembleElement[] = rawElements.map((elem: any, index: number) => {
      // Support both element_name (new standard) and name (legacy)
      const elementName = elem.element_name || elem.name;
      if (!elementName) {
        throw new Error(`Element at index ${index} must have element_name (or name for backwards compatibility)`);
      }
      // Log deprecation warning if using legacy 'name' field
      if (elem.name && !elem.element_name) {
        logger.warn(`Ensemble element at index ${index} uses deprecated 'name' field. Use 'element_name' instead.`);
      }

      // Support both element_type (new standard) and type (legacy)
      // Issue #466: No longer defaults to 'skill' — callers must provide type
      // or pass managers for portfolio resolution
      const elementType = elem.element_type || elem.type;
      if (!elementType) {
        throw new Error(
          `Element '${elementName}' at index ${index} has no element_type. ` +
          `Provide element_type explicitly or ensure the element exists in the portfolio.`
        );
      }
      // Log deprecation warning if using legacy 'type' field
      if (elem.type && !elem.element_type) {
        logger.warn(`Ensemble element at index ${index} uses deprecated 'type' field. Use 'element_type' instead.`);
      }

      return {
        element_name: elementName,
        element_type: elementType,
        role: elem.role || ENSEMBLE_DEFAULTS.ELEMENT_ROLE,
        priority: elem.priority ?? ENSEMBLE_DEFAULTS.PRIORITY,
        activation: elem.activation || 'always',
        condition: elem.condition,
        dependencies: elem.dependencies,
        purpose: elem.purpose
      } as EnsembleElement;
    });

    // Set defaults for optional fields
    const fullMetadata: EnsembleMetadata = {
      name: metadata.name,
      description: metadata.description || '',
      version: metadata.version || '1.0.0',
      author: metadata.author,
      created: metadata.created || new Date().toISOString(),
      modified: metadata.modified || new Date().toISOString(),
      tags: metadata.tags || [],
      activationStrategy: metadata.activationStrategy || (metadata as any).activation_strategy || ENSEMBLE_DEFAULTS.ACTIVATION_STRATEGY,
      conflictResolution: metadata.conflictResolution || (metadata as any).conflict_resolution || ENSEMBLE_DEFAULTS.CONFLICT_RESOLUTION,
      contextSharing: metadata.contextSharing || ENSEMBLE_DEFAULTS.CONTEXT_SHARING,
      resourceLimits: metadata.resourceLimits,
      allowNested: metadata.allowNested ?? ENSEMBLE_DEFAULTS.ALLOW_NESTED,
      maxNestingDepth: metadata.maxNestingDepth || ENSEMBLE_DEFAULTS.MAX_NESTING_DEPTH,
      elements: migratedElements,
      // Issue #524 — Gatekeeper policy (symmetric with buildMetadata deserialization)
      gatekeeper: sanitizeGatekeeperPolicy((metadata as any).gatekeeper, metadata.name!, 'ensemble'),
    };

    // Use inherited getElementFilename() for consistent filename normalization
    const filename = this.getElementFilename(fullMetadata.name);

    // Issue #613: Check metadata name uniqueness (not just filename)
    const existingEnsembles = await this.list();
    const duplicate = existingEnsembles.find(e =>
      e.metadata.name.toLowerCase() === fullMetadata.name.toLowerCase()
    );
    if (duplicate) {
      throw new Error(`An ensemble named "${fullMetadata.name}" already exists`);
    }

    // Create ensemble
    const ensemble = new Ensemble(fullMetadata, fullMetadata.elements, this.metadataService);

    // Set instructions and content if provided (v2.0 dual-field architecture)
    if (metadata.instructions) {
      ensemble.instructions = metadata.instructions;
    }
    if (metadata.content) {
      ensemble.content = metadata.content;
    }

    // Save to disk
    await this.save(ensemble, filename);
    // Note: No reload() here — save() caches the element correctly.
    // See Issue #491 for why PersonaManager's reload-after-create was removed.

    // Log creation
    SecurityMonitor.logSecurityEvent({
      type: ENSEMBLE_SECURITY_EVENTS.SAVED,
      severity: 'LOW',
      source: 'EnsembleManager.create',
      details: `Created ensemble: ${fullMetadata.name}`
    });

    return ensemble;
  }

  /**
   * Validate an ensemble
   * Delegates to ensemble's own validate method
   *
   * @param element - Ensemble to validate
   * @returns Validation result
   */
  override validate(element: Ensemble): ElementValidationResult {
    return element.validate();
  }

  /**
   * Override save to validate before persisting
   */
  override async save(element: Ensemble, filePath: string): Promise<void> {
    // Validate ensemble before saving
    const validationResult = this.validate(element);
    if (!validationResult.valid) {
      const errors = validationResult.errors?.map(e => e.message).join(', ') || 'Unknown validation error';
      throw new Error(`Cannot save invalid ensemble: ${errors}`);
    }

    // Call base implementation
    await super.save(element, filePath);
  }

  /**
   * Override delete to add ensemble-specific logging
   */
  override async delete(filePath: string): Promise<void> {
    SecurityMonitor.logSecurityEvent({
      type: ENSEMBLE_SECURITY_EVENTS.DELETED,
      severity: 'MEDIUM',
      source: 'EnsembleManager.delete',
      details: `Deleting ensemble: ${filePath}`
    });

    await super.delete(filePath);

    SecurityMonitor.logSecurityEvent({
      type: ENSEMBLE_SECURITY_EVENTS.DELETED,
      severity: 'LOW',
      source: 'EnsembleManager.delete',
      details: `Successfully deleted ensemble: ${filePath}`
    });
  }

  /**
   * Override list to apply active status based on activeEnsembleNames set
   */
  override async list(): Promise<Ensemble[]> {
    const ensembles = await super.list();

    // Apply ACTIVE status to ensembles in the activeEnsembleNames set
    for (const ensemble of ensembles) {
      if (this.activeEnsembleNames.has(ensemble.metadata.name)) {
        // Call activate() to set status to ACTIVE
        await ensemble.activate();
      }
    }

    return ensembles;
  }

  /**
   * Activate an ensemble by name or identifier
   *
   * Issue #24 (LOW PRIORITY): Performance optimization using findByName()
   * Issue #24 (LOW PRIORITY): Consistent error messages using ElementMessages
   * Issue #24 (LOW PRIORITY): Cleanup trigger for memory leak prevention
   *
   * @param identifier - Ensemble name or identifier
   * @returns Activation result with success status and message
   */
  async activateEnsemble(identifier: string): Promise<{ success: boolean; message: string; ensemble?: Ensemble }> {
    // PERFORMANCE FIX: Use findByName() instead of list()
    const ensemble = await this.findByName(identifier);

    if (!ensemble) {
      return {
        success: false,
        // CONSISTENCY FIX: Use standardized error message format
        message: ElementMessages.notFound(ElementType.ENSEMBLE, identifier)
      };
    }

    // MEMORY LEAK FIX: Check if cleanup is needed before adding
    this.checkAndCleanupActiveSet();

    this.activeEnsembleNames.add(ensemble.metadata.name);

    // Set ensemble status to active
    await ensemble.activate();

    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED',
      severity: 'LOW',
      source: 'EnsembleManager.activateEnsemble',
      details: `Ensemble activated: ${ensemble.metadata.name}`
    });

    return {
      success: true,
      // CONSISTENCY FIX: Use standardized success message format
      message: ElementMessages.activated(ElementType.ENSEMBLE, ensemble.metadata.name),
      ensemble
    };
  }

  /**
   * Deactivate an ensemble by name or identifier
   *
   * Issue #24 (LOW PRIORITY): Performance optimization using findByName()
   * Issue #24 (LOW PRIORITY): Consistent error messages using ElementMessages
   *
   * @param identifier - Ensemble name or identifier
   * @returns Deactivation result with success status and message
   */
  async deactivateEnsemble(identifier: string): Promise<{ success: boolean; message: string }> {
    // PERFORMANCE FIX: Use findByName() instead of list()
    const ensemble = await this.findByName(identifier);

    if (!ensemble) {
      return {
        success: false,
        // CONSISTENCY FIX: Use standardized error message format
        message: ElementMessages.notFound(ElementType.ENSEMBLE, identifier)
      };
    }

    this.activeEnsembleNames.delete(ensemble.metadata.name);

    // Set ensemble status to inactive
    await ensemble.deactivate();

    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED',
      severity: 'LOW',
      source: 'EnsembleManager.deactivateEnsemble',
      details: `Ensemble deactivated: ${ensemble.metadata.name}`
    });

    return {
      success: true,
      // CONSISTENCY FIX: Use standardized success message format
      message: ElementMessages.deactivated(ElementType.ENSEMBLE, ensemble.metadata.name)
    };
  }

  /**
   * Get all active ensembles
   *
   * @returns List of active ensembles
   */
  async getActiveEnsembles(): Promise<Ensemble[]> {
    const results: Ensemble[] = [];
    for (const name of this.activeEnsembleNames) {
      const ensemble = await this.findByName(name);
      if (ensemble) results.push(ensemble);
    }
    return results;
  }

  /**
   * Check if active set cleanup is needed and perform cleanup if necessary
   * Issue #24 (LOW PRIORITY): Memory leak prevention
   * @private
   */
  private checkAndCleanupActiveSet(): void {
    const { max, cleanupThreshold } = getActiveElementLimitConfig('ensembles');

    // Below threshold — no action needed
    if (this.activeEnsembleNames.size < cleanupThreshold) {
      return;
    }

    // At or above max — warn before cleanup
    if (this.activeEnsembleNames.size >= max) {
      logger.warn(
        `Active ensembles limit reached (${max}). ` +
        `Consider deactivating unused ensembles or setting DOLLHOUSE_MAX_ACTIVE_ENSEMBLES to a higher value.`
      );

      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_CREATED',
        severity: 'MEDIUM',
        source: 'EnsembleManager.checkAndCleanupActiveSet',
        details: `Active ensembles limit reached: ${this.activeEnsembleNames.size}/${max}`
      });
    }

    // At or above threshold — proactively clean stale entries
    void this.cleanupStaleActiveEnsembles();
  }

  /**
   * Clean up stale entries from active ensembles set
   * Issue #24 (LOW PRIORITY): Memory leak prevention
   * @private
   */
  private async cleanupStaleActiveEnsembles(): Promise<void> {
    try {
      const startSize = this.activeEnsembleNames.size;
      const ensembles = await this.list();
      const existingEnsembleNames = new Set(ensembles.map(e => e.metadata.name));

      const staleNames: string[] = [];
      for (const activeName of this.activeEnsembleNames) {
        if (!existingEnsembleNames.has(activeName)) {
          this.activeEnsembleNames.delete(activeName);
          staleNames.push(activeName);
        }
      }

      const endSize = this.activeEnsembleNames.size;
      const removed = startSize - endSize;

      if (removed > 0) {
        logger.info(
          `Cleaned up ${removed} stale active ensemble reference(s). ` +
          `Active ensembles: ${endSize}/${getMaxActiveLimit('ensembles')}`
        );

        SecurityMonitor.logSecurityEvent({
          type: 'ELEMENT_DELETED',
          severity: 'LOW',
          source: 'EnsembleManager.cleanupStaleActiveEnsembles',
          details: `Removed ${removed} stale active ensemble references`,
          additionalData: {
            removedCount: removed,
            activeCount: endSize,
            staleNames: staleNames.join(', ')
          }
        });
      }
    } catch (error) {
      logger.error('Failed to cleanup stale active ensembles:', error);

      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_DELETED',
        severity: 'LOW',
        source: 'EnsembleManager.cleanupStaleActiveEnsembles',
        details: `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
}
